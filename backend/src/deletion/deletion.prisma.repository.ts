import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import {
  coolingDeadline,
  DELETION_KEPT_NOTE,
  redactPayload,
  toDeletionState,
  type DeletionRequestRow
} from './deletion.policy'
import {
  FAMILY_DELETION_COOLING_DAYS,
  REDACTED_TEXT,
  type CancelDeletionInput,
  type DeletionPort,
  type ExecutedDeletion,
  type ExecuteDueInput,
  type FamilyDeletionState,
  type FamilyDeletionSummary,
  type RequestDeletionInput
} from './deletion.repository'

/** 事务里的 Prisma 客户端（与 `$transaction(async (tx) => …)` 的回调参数一致）。 */
type Tx = Prisma.TransactionClient

/** 只取状态机需要的列 —— `summary` 原样返回，由 `parseSummary()` 校验。 */
const REQUEST_SELECT = {
  id: true,
  status: true,
  requestedAt: true,
  scheduledFor: true,
  cancelledAt: true,
  executedAt: true,
  summary: true
} as const

/** 摘要 → JSON 列（形状由 `FamilyDeletionSummary` 固定，不是随手对象）。 */
function summaryJson(summary: FamilyDeletionSummary): Prisma.InputJsonValue {
  return summary as unknown as Prisma.InputJsonValue
}

/**
 * 家庭数据删除的 **Prisma 适配器**（W7-D，2026-10-27）—— `DeletionPort` 的真实现。
 *
 * ── 四件事必须落在**同一个事务**里 ─────────────────────────────────────────
 *   ① 申请 / 撤销的**串行化**（`SELECT … FOR UPDATE` 锁孩子行）；
 *   ② 执行时的「到期行列锁」（`FOR UPDATE SKIP LOCKED`）；
 *   ③ 九张表的匿名化与 `FamilyDeletionRequest.status = executed`；
 *   ④ 审计行（`family.deletion_executed`）与摘要。
 *   任何一步单独提交，都可能留下「部分已匿名化、请求仍 pending」的半状态 ——
 *   再跑一次会得到一份更小的摘要，而第一次的摘要已经丢了。
 *
 * ── 为什么用**孩子行**做锁对象 ─────────────────────────────────────────────
 *   同一孩子的两位家长可能同时点「申请删除」；锁孩子行让第二个请求在第一个
 *   提交后才读到 pending，从而**幂等返回同一条请求**，而不是插出第二条冷却期。
 *   数据库侧还有 `FamilyDeletionRequest_one_pending_per_child` 部分唯一索引兜底
 *   （应用层逻辑被改坏时，唯一索引会当场拒绝）。
 *
 * ── 匿名化 ≠ 删除（边界写清楚）─────────────────────────────────────────────
 *   保留：流水数值（`pointsDelta` / `balanceAfter`）、余额、金额快照、审计追加行。
 *   抹掉：孩子的昵称与年龄段 / 兴趣、成员的 PIN 与限制、规则与版本的标题与条件、
 *         习惯 / 心愿的标题与条件、流水里的标题 / 条件 / 备注、审批 payload 里的
 *         描述性文本、同意的 IP / UA 哈希、通知标题与正文。
 *   保留流水是 02 §5.7 I5 的要求（账本 append-only / 可对账）—— 摘要会把
 *   「保留了多少条」写出来，让这个边界**可被检查**，而不是被含糊掉。
 */
@Injectable()
export class PrismaDeletionRepository implements DeletionPort {
  constructor(private readonly prisma: PrismaService) {}

  async readState(childId: string, now: Date): Promise<FamilyDeletionState> {
    const row = await this.prisma.familyDeletionRequest.findFirst({
      where: { childId },
      orderBy: [{ requestedAt: 'desc' }, { createdAt: 'desc' }],
      select: REQUEST_SELECT
    })
    return toDeletionState(childId, row as DeletionRequestRow | null, now)
  }

  async requestDeletion(input: RequestDeletionInput): Promise<FamilyDeletionState> {
    const { childId, operator, now } = input

    return await this.prisma.$transaction(async (tx) => {
      const child = await this.lockChild(tx, childId)
      if (child === null) throw childNotFound(childId)

      const latest = await tx.familyDeletionRequest.findFirst({
        where: { childId },
        orderBy: [{ requestedAt: 'desc' }, { createdAt: 'desc' }],
        select: REQUEST_SELECT
      })

      if (latest?.status === 'executed') {
        throw new ConflictException({
          code: 'FAMILY_DELETION_ALREADY_EXECUTED',
          message: '这个家庭的数据已经删除，不能再次申请（删除不可逆，也不可重复执行）。'
        })
      }

      // ★ 已软删的孩子 ⇒ 404（与 ReadPort 同一口径）：它不是「可以再删一次」，
      //   而是「这个档案已经不在了」。
      if (child.status !== 'active') throw childNotFound(childId)

      // 幂等：已在冷却期 ⇒ 回同一条请求，不写第二行、不写第二条审计。
      if (latest?.status === 'pending') {
        return toDeletionState(childId, latest as DeletionRequestRow, now)
      }

      const scheduledFor = coolingDeadline(now)
      const created = await tx.familyDeletionRequest.create({
        data: {
          childId,
          requestedByUserId: operator.userId,
          status: 'pending',
          requestedAt: now,
          scheduledFor
        },
        select: REQUEST_SELECT
      })

      await tx.auditLog.create({
        data: {
          childId,
          actorUserId: operator.userId,
          actorRole: 'guardian',
          action: 'family.deletion_requested',
          targetType: 'FamilyDeletionRequest',
          targetId: created.id,
          // 申请不改变任何业务行 ⇒ `before` 为 null 不是「没记」，是「没有改」。
          before: Prisma.JsonNull,
          after: {
            coolingDays: FAMILY_DELETION_COOLING_DAYS,
            scheduledFor: scheduledFor.toISOString()
          }
        }
      })

      return toDeletionState(childId, created as DeletionRequestRow, now)
    })
  }

  async cancelDeletion(input: CancelDeletionInput): Promise<FamilyDeletionState> {
    const { childId, operator, now } = input

    return await this.prisma.$transaction(async (tx) => {
      // ★ 撤销**不检查孩子是否 active**：删除已执行时状态是 deleted，
      //   此时要回的是 409 ALREADY_EXECUTED（比 404 更能解释发生了什么）。
      await this.lockChild(tx, childId)

      const pending = await tx.familyDeletionRequest.findFirst({
        where: { childId, status: 'pending' },
        orderBy: [{ requestedAt: 'desc' }, { createdAt: 'desc' }],
        select: REQUEST_SELECT
      })

      if (pending === null) {
        const executed = await tx.familyDeletionRequest.findFirst({
          where: { childId, status: 'executed' },
          select: { id: true }
        })
        if (executed !== null) {
          throw new ConflictException({
            code: 'FAMILY_DELETION_ALREADY_EXECUTED',
            message: '这个家庭的数据已经删除，没有可以撤销的请求（删除不可逆）。'
          })
        }
        throw new ConflictException({
          code: 'FAMILY_DELETION_NOT_PENDING',
          message: '当前没有待执行的删除请求（可能已撤销，或从未申请过）。'
        })
      }

      // ★ 撤销与执行之间只有一条边界：**行锁 + status 条件**。
      //   worker 若已把这行领走并执行，本事务会等它提交，然后读到 executed ⇒ 409。
      const cancelled = await tx.familyDeletionRequest.update({
        where: { id: pending.id },
        data: { status: 'cancelled', cancelledAt: now },
        select: REQUEST_SELECT
      })

      await tx.auditLog.create({
        data: {
          childId,
          actorUserId: operator.userId,
          actorRole: 'guardian',
          action: 'family.deletion_cancelled',
          targetType: 'FamilyDeletionRequest',
          targetId: cancelled.id,
          before: { status: 'pending' },
          after: { status: 'cancelled', cancelledAt: now.toISOString() }
        }
      })

      return toDeletionState(childId, cancelled as DeletionRequestRow, now)
    })
  }

  async executeDue(input: ExecuteDueInput): Promise<ExecutedDeletion[]> {
    const { now, limit } = input

    return await this.prisma.$transaction(
      async (tx) => {
        // `FOR UPDATE SKIP LOCKED`：多个 worker 并发时各自领不同的行；
        // 领不到的行留给下一轮，而不是排队等锁（等锁会把一次 tick 拖成 N 次超时）。
        const due = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "FamilyDeletionRequest"
           WHERE status = 'pending' AND "scheduledFor" <= ${now}
           ORDER BY "scheduledFor" ASC
           LIMIT ${limit}
           FOR UPDATE SKIP LOCKED
        `

        const executed: ExecutedDeletion[] = []
        for (const { id } of due) {
          const request = await tx.familyDeletionRequest.findUnique({
            where: { id },
            select: { childId: true, requestedByUserId: true, status: true }
          })
          // 状态在锁内不可能变（本事务持有行锁）；null 只可能来自被并发删除 ——
          // 本表没有删除路径，故按「跳过」处理而不是抛错。
          if (request === null || request.status !== 'pending') continue

          const summary = await this.anonymize(tx, request.childId, request.requestedByUserId, now)

          await tx.familyDeletionRequest.update({
            where: { id },
            data: { status: 'executed', executedAt: now, summary: summaryJson(summary) }
          })

          await tx.auditLog.create({
            data: {
              childId: request.childId,
              actorUserId: request.requestedByUserId,
              actorRole: 'guardian',
              action: 'family.deletion_executed',
              targetType: 'Child',
              targetId: request.childId,
              before: Prisma.JsonNull,
              after: summaryJson(summary)
            }
          })

          executed.push({ requestId: id, childId: request.childId, summary })
        }

        return executed
      },
      // 九张表 + 审计在同一事务里；默认 5s 在真实数据量下不够。
      { timeout: 30_000 }
    )
  }


  /** 锁住孩子行（不存在的孩子返回 null —— 这是正常分支，不是异常）。 */
  private async lockChild(tx: Tx, childId: string): Promise<{ id: string; status: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status::text AS status FROM "Child" WHERE id = ${childId} FOR UPDATE
    `
    return rows[0] ?? null
  }

  /**
   * 就地匿名化（同一事务内）。返回**实际改写行数** —— 0 也如实记录。
   *
   * ★ 顺序无关紧要（全部在一个事务里，失败整体回滚），但写成「身份 → 内容 →
   *   痕迹」三段，是为了让读者一眼看出哪些是「身份」、哪些是「描述」。
   */
  private async anonymize(
    tx: Tx,
    childId: string,
    requesterUserId: string,
    now: Date
  ): Promise<FamilyDeletionSummary> {
    const child = await tx.child.findUnique({
      where: { id: childId },
      select: { pointsBalance: true }
    })
    const pointsBalance = child?.pointsBalance ?? 0

    // ── ① 身份：孩子 + 成员位 ──────────────────────────────────────────────
    const childCount = (
      await tx.child.updateMany({
        where: { id: childId },
        data: {
          name: REDACTED_TEXT,
          ageBand: null,
          focusAreas: [],
          status: 'deleted',
          deletedAt: now
        }
      })
    ).count

    // 成员位：清 PIN / 限制；除申请人外一律置为 removed。
    // ★ 保留申请人的 active 成员位，是为了让他还能读到「已执行」的收据
    //   （屏障一要求 active；否则删除完成后连执行摘要都看不到）。
    const memberCredentials: Prisma.ChildMemberUpdateManyMutationInput = {
      pinHash: null,
      pinSetAt: null,
      pinFailedCount: 0,
      pinLockedUntil: null,
      restrictions: {}
    }
    const removedMembers = (
      await tx.childMember.updateMany({
        where: { childId, userId: { not: requesterUserId } },
        data: { ...memberCredentials, status: 'removed', removedAt: now }
      })
    ).count
    const requesterMembers = (
      await tx.childMember.updateMany({
        where: { childId, userId: requesterUserId },
        data: memberCredentials
      })
    ).count

    // ── ② 内容：规则 / 版本 / 习惯 / 心愿 / 流水 / 审批 / 通知 ──────────────
    const rules = (
      await tx.pointRule.updateMany({
        where: { childId },
        data: { title: REDACTED_TEXT, condition: REDACTED_TEXT, status: 'deleted', deletedAt: now }
      })
    ).count

    const ruleIds = (await tx.pointRule.findMany({ where: { childId }, select: { id: true } })).map(
      (row) => row.id
    )
    const ruleVersions =
      ruleIds.length === 0
        ? 0
        : (
            await tx.pointRuleVersion.updateMany({
              where: { ruleId: { in: ruleIds } },
              // ★ 列级 UPDATE 权限（prisma/sql/900 里单独授予这三列）；
              //   表级 UPDATE 仍然被 REVOKE —— 版本行只能被「抹字」，不能被改分数。
              data: { title: REDACTED_TEXT, condition: REDACTED_TEXT, changeNote: null }
            })
          ).count

    const habits = (
      await tx.habit.updateMany({
        where: { childId },
        data: { title: REDACTED_TEXT, condition: REDACTED_TEXT, status: 'deleted', deletedAt: now }
      })
    ).count

    const wishes = (
      await tx.wish.updateMany({
        where: { childId },
        data: { title: REDACTED_TEXT, status: 'deleted', deletedAt: now }
      })
    ).count

    // 流水只抹文本，**数值一个不动**。`conditionSnapshot` 先按非空抹，
    // 以保住「原本就没有条件」这个信息（null 不该被写成一段假文本）。
    await tx.pointRecord.updateMany({
      where: { childId, conditionSnapshot: { not: null } },
      data: { conditionSnapshot: REDACTED_TEXT }
    })
    const records = (
      await tx.pointRecord.updateMany({
        where: { childId },
        data: { titleSnapshot: REDACTED_TEXT, note: '' }
      })
    ).count

    // 审批：payload 递归抹描述性文本（保留 key / 数值 / id），decisionNote 置空。
    const approvals = await tx.approvalRequest.findMany({
      where: { childId },
      select: { id: true, payload: true }
    })
    for (const approval of approvals) {
      await tx.approvalRequest.update({
        where: { id: approval.id },
        data: {
          payload: redactPayload(approval.payload) as Prisma.InputJsonValue,
          decisionNote: null
        }
      })
    }

    const notifications = (
      await tx.notification.updateMany({
        where: { childId },
        data: { title: REDACTED_TEXT, body: '' }
      })
    ).count

    // ── ③ 痕迹：同意记录里的 IP / UA 哈希 ──────────────────────────────────
    const consents = (
      await tx.guardianConsent.updateMany({
        where: { childId },
        data: { ipHash: null, userAgentHash: null }
      })
    ).count

    return {
      coolingDays: FAMILY_DELETION_COOLING_DAYS,
      redacted: {
        child: childCount,
        members: removedMembers + requesterMembers,
        rules,
        ruleVersions,
        habits,
        wishes,
        records,
        approvals: approvals.length,
        consents,
        notifications
      },
      kept: { records, pointsBalance },
      note: DELETION_KEPT_NOTE
    }
  }
}

function childNotFound(childId: string): NotFoundException {
  return new NotFoundException({
    code: 'CHILD_NOT_FOUND',
    message: `孩子 ${childId} 不存在或已删除 —— 不能对其申请家庭数据删除。`
  })
}

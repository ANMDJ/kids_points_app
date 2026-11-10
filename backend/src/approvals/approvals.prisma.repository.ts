import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from '@nestjs/common'
import type {
  ApprovalRequest,
  ApprovalStatus,
  AutoReason,
  MemberRole,
  Prisma
} from '@prisma/client'

import {
  AUDIT_ACTION_SELF_APPROVED,
  AUDIT_ACTION_WITHDRAWN,
  withdrawDenial
} from '../contracts/approval-policy'
import type { ActionType, Role } from '../contracts/permission-matrix'
import { pickCoverStyle } from '../contracts/wish-cover-style'
import {
  parseApprovalPayload,
  type AddWishPayload,
  type ApprovalPayload,
  type BonusPayload,
  type RedeemPayload
} from './approval-payload'
import {
  buildRecordDraft,
  LedgerDeniedError,
  LedgerShapeError,
  resolveAppendCreatedAt,
  type PointRecordDraft
} from '../ledger/ledger.gate'
import { PrismaService } from '../prisma/prisma.service'
import {
  NOTIFICATIONS_OUTBOX,
  type NotificationsOutboxPort
} from '../notifications/notifications.outbox'
import type {
  ApprovalListRow,
  ApprovalRow,
  ApprovalsPort,
  CreateApprovalInput,
  DecideApprovalInput,
  ListApprovalsInput,
  ListMyApprovalsInput,
  WithdrawApprovalInput
} from './approvals.repository'

/**
 * 审批端口的 **Prisma 适配器**（W3-A，2026-10-18）—— `ApprovalsPort` 的真实现。
 *
 * ── 它回答的问题（一句话）─────────────────────────────────────────────────
 *   一条**已经判定该批**的请求，怎么在**一个事务**里变成
 *   「`ApprovalRequest` 终态 ＋ `PointRecord` 流水 ＋ `Child.pointsBalance` ＋ 审计」，
 *   并且让**任何一步失败都不留下中间态**（`02` §4.3 / §4.5 硬约束 5）。
 *
 * ── 事务里的顺序（每一步都有理由，别随手挪）────────────────────────────────
 *   ① `SELECT … FOR UPDATE` 锁 `ApprovalRequest` 行 ⇒ 双击「同意」只有一个赢家；
 *   ② 状态守卫（`pending`）＋ TTL 惰性过期（过期也要留下历史，不是静默失败）；
 *   ③ 锁 `Child` 余额行 ⇒ 同一孩子的写入排队；
 *   ④ **判定全在 `ledger.gate`**：本文件只用 `buildRecordDraft()` 生成草稿，
 *      绝不自己算 `balanceAfter` / 自己拼标题（两套判定必然漂移）；
 *   ⑤ 余额 CAS ⇒ 陈旧余额当场 409（与 `ledger.prisma.repository.ts` 同一手法）；
 *   ⑥ 写流水（`createdAt` 由库钟 ＋ 严格递增决定，见 `resolveAppendCreatedAt`）；
 *   ⑦ 条件更新请求终态（`WHERE status = 'pending'`）⇒ 乐观锁；
 *   ⑧ 写 `AuditLog`（与上面同一事务 ⇒ 不会出现\"批了但没人记得谁批的\"）。
 *
 *   ★ 回调式 `$transaction` 在抛异常时**整体回滚**。所以凡是\"要留下的终态\"
 *     （`invalidated` / `expired`）都**不抛异常**，而是把行**返回**给 service，
 *     由它翻成 HTTP 409（见 `ApprovalsService.assertTerminalWithoutExecution`）。
 *     在事务里抛 409 会把刚写下的 `invalidated` 一起回滚 ⇒ 客户端重试永远看到
 *     `pending`（死循环）—— 这是本文件最容易写错的一处。
 *
 * ── 范围（W3-C 收尾后的真实状态）──────────────────────────────────────────
 *   · 执行器四项：`redeem` / `request_redeem` / `request_points_bonus` / `add_wish`。
 *     `redeem` 的 payload 快照 = `{ wishId, titleSnapshot, costSnapshot }`（`02` §4.3：
 *     家长 3 小时后同意时，扣分必须等于**孩子申请时看到的**价格，不是现价）；
 *     加分快照金额/事由/可选规则或习惯；`add_wish` 快照标题/成本/表情。
 *   · 其余动作**没有执行器**：建请求时即 400 `APPROVAL_ACTION_NOT_EXECUTABLE`，
 *     而不是先落一条永远批不动的 `pending`（那是死胡同）。
 *   · `autoReason` 五种全部可复现：`WISH_DELETED` / `INSUFFICIENT_POINTS`（兑换）、
 *     `RULE_DELETED` / `HABIT_GONE`（加分依据消失）、`MEMBER_REMOVED`（申请人被移出）。
 *   · `expireDue()` 是后台扫描的入口；`expireIfDue()` 仍保留为读/决时的惰性兜底
 *     （扫描没跑到时也不会让过期审批被批准）。
 *
 * ── W3-B（2026-10-18）：两个改动都在\"别让一家碰另一家\"上 ─────────────────────
 *   ① **租户隔离**：`findById` / `decide` / `withdraw` 的 `childId` 是**查询条件**
 *      （`WHERE id = ? AND childId = ?`），不是读出来再比较。跨孩子的 id 与
 *      \"不存在\"返回同一个 404 —— 否则任何一位 guardian 拿到别家的审批 id 就能
 *      批准并扣那一家的分（屏障一只验\"你对**请求头里的孩子**是不是成员\"）。
 *   ② **撤回**：`withdraw()` 只做 `pending → withdrawn`，**不写流水、不动余额**；
 *      判定与 service 共用 `withdrawDenial()`（角色 → 本人 → 状态），
 *      并在**行锁下**再验一次（读与写之间可能有人刚好批准）。
 *
 * ── W6-C（2026-10-24）：提醒的 outbox 与审批同事务 ─────────────────────────
 *   `createPending` 在写完审批行与审计后，调用 `NOTIFICATIONS_OUTBOX` 写
 *   `Notification` + `PushRetryJob`；`decide` 在 `approved` / `rejected` 的审计之后同样。
 *   **不调用任何第三方**：外部推送由 worker 在事务外发送，网关失败不回滚账本。
 *   ★ 事务回滚 = 审批与提醒一起消失，不会留下「批了但没人知道」的中间态。
 */
@Injectable()
export class PrismaApprovalsRepository implements ApprovalsPort {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATIONS_OUTBOX) private readonly outbox: NotificationsOutboxPort
  ) {}

  /** `02` §4.3：TTL 默认 72h（到期由扫描任务置 `expired`；本文件惰性判定）。 */
  static readonly TTL_MS = 72 * 60 * 60 * 1000

  /**
   * 建一条 `pending`（**不执行**）。
   *
   * payload 在**此刻**快照（`02` §4.3）—— 心愿之后改价/删除都不影响这条请求的扣分口径；
   * 前提消失只在**批准那一刻**判（→ `invalidated`），不在建请求时判。
   */
  async createPending(input: CreateApprovalInput): Promise<ApprovalRow> {
    const role = toMemberRole(input.requesterRole)
    assertExecutable(input.action)

    return this.prisma.$transaction(async (tx) => {
      const payload = await this.snapshotPayload(tx, input)
      const now = new Date()
      const row = await tx.approvalRequest.create({
        data: {
          childId: input.childId,
          requesterUserId: input.requesterUserId,
          requesterRole: role,
          actionType: input.action,
          payload: jsonOf(payload),
          status: 'pending',
          expiresAt: new Date(now.getTime() + PrismaApprovalsRepository.TTL_MS)
        }
      })
      await writeAudit(tx, {
        childId: input.childId,
        actorUserId: input.requesterUserId,
        actorRole: role,
        action: 'approval.requested',
        targetId: row.id,
        after: { status: 'pending', payload: jsonOf(payload) }
      })
      // ★ W6-C：提醒与审批同生共死。只写本地两行，不发送。
      await this.outbox.enqueueApprovalSubmitted(
        tx,
        {
          approvalId: row.id,
          childId: row.childId,
          requesterUserId: row.requesterUserId,
          action: input.action
        },
        now
      )
      return toRow(row)
    })
  }

  /**
   * 建请求 ＋ **同一事务内**直接批准（`02` §4.5 形态②，`autoApprove: true`）。
   *
   * 先落 `pending` 再改终态，而不是直接 `INSERT status='approved'`：
   *   · 执行需要请求 id（幂等键 `approval:<id>`）—— 没有 id 就没有\"这一笔只可能一次\"；
   *   · 失败路径（积分不足）要留下 `invalidated` 的**完整行**（含 payload 快照），
   *     直接插 `approved` 再回滚会让客户端以为\"请求根本没建\"。
   * 对外仍然原子：事务提交前，别人看不到任何中间态。
   */
  async createSelfApproved(input: CreateApprovalInput): Promise<ApprovalRow> {
    const role = toMemberRole(input.requesterRole)
    assertExecutable(input.action)

    return this.prisma.$transaction(async (tx) => {
      const payload = await this.snapshotPayload(tx, input)
      const now = new Date()
      const row = await tx.approvalRequest.create({
        data: {
          childId: input.childId,
          requesterUserId: input.requesterUserId,
          requesterRole: role,
          actionType: input.action,
          payload: jsonOf(payload),
          status: 'pending',
          expiresAt: new Date(now.getTime() + PrismaApprovalsRepository.TTL_MS)
        }
      })

      const outcome = await this.executeAction(tx, {
        approvalId: row.id,
        action: input.action,
        childId: input.childId,
        payload,
        requesterUserId: input.requesterUserId,
        operatorUserId: input.requesterUserId,
        operatorRole: role,
        now
      })

      if (outcome.kind === 'invalidated') {
        const after = await tx.approvalRequest.update({
          where: { id: row.id },
          data: {
            status: 'invalidated',
            autoReason: outcome.reason,
            decidedByUserId: input.requesterUserId,
            decidedAt: now
          }
        })
        await writeAudit(tx, {
          childId: input.childId,
          actorUserId: input.requesterUserId,
          actorRole: role,
          action: 'approval.invalidated',
          targetId: row.id,
          before: { status: 'pending' },
          after: { status: 'invalidated', autoReason: outcome.reason }
        })
        return toRow(after)
      }

      const after = await tx.approvalRequest.update({
        where: { id: row.id },
        data: {
          status: 'approved',
          decidedByUserId: input.requesterUserId,
          decidedAt: now,
          executedRecordId: outcome.recordId
        }
      })
      // ★ 硬约束 6：自批的审计名与\"他人批准\"不同，判据是批准人 == 申请人。
      await writeAudit(tx, {
        childId: input.childId,
        actorUserId: input.requesterUserId,
        actorRole: role,
        action: AUDIT_ACTION_SELF_APPROVED,
        targetId: row.id,
        before: { status: 'pending' },
        after: { status: 'approved', executedRecordId: outcome.recordId }
      })
      return toRow(after)
    })
  }

  /**
   * 读一条（**不**在这里惰性过期：读接口不应改数据；过期在 `decide` / `withdraw` 时判定）。
   * ★ `childId` 进 `WHERE`（W3-B）：另一家的审批与「不存在」必须长得一模一样。
   * ★ P1-3：详情页与列表共用 `ApprovalListRow`（payload + 三个时间戳）。
   */
  async findById(id: string, childId: string): Promise<ApprovalListRow | null> {
    const row = await this.prisma.approvalRequest.findFirst({ where: { id, childId } })
    return row === null ? null : toListRow(row)
  }

  /**
   * 收件箱列表（W5-D）—— 键集翻页，与 `/records` 同一套「`(createdAt, id)` 降序」。
   *
   * ── 为什么不复用 `findMany({ skip })` ──────────────────────────────────────
   *   收件箱顶部每来一条新申请，`skip` 就会把上一页的最后一行再发一次；
   *   游标钉在行上，新行只会出现在第一页之前。
   *
   * ── `take: limit + 1` 的用途 ───────────────────────────────────────────────
   *   多取一行**只**用于判断「还有下一页」，随后被 service 丢掉；这样不必
   *   额外发一条 `count`（count 与翻页不是同一时刻的视图，会自相矛盾）。
   *
   * ★ `status` 是**数据库条件**（`all` 除外），不是读出来再过滤：
   *   对一个孩子来说审批会越攒越多，读全量再筛会把「收件箱」变成全表扫描。
   */
  async listForChild(input: ListApprovalsInput): Promise<ApprovalListRow[]> {
    return this.listScoped({ childId: input.childId }, input)
  }

  /**
   * 「我的申请」（W5-J）：`childId` 与 `requesterUserId` **同时**进 WHERE。
   *
   * ★ 两个条件都不能省：`childId` 挡住跨孩子，`requesterUserId` 挡住同一
   *   家庭里的其他成员（家长也能查自己提过什么）。漏掉任何一个，这个端点
   *   就会从「我的申请」变成「某家的申请」。
   */
  async listForRequester(input: ListMyApprovalsInput): Promise<ApprovalListRow[]> {
    return this.listScoped(
      { childId: input.childId, requesterUserId: input.requesterUserId },
      input
    )
  }

  /**
   * 收件箱 / 我的申请共用的查询：状态条件 + 键集游标 + 排序只在这里写一次。
   *
   * `scope` 是**收口条件**（childId，或 childId + requesterUserId），
   * 调用方只决定「看谁的行」，不决定「怎么翻页」。
   */
  private async listScoped(
    scope: Prisma.ApprovalRequestWhereInput,
    input: ListApprovalsInput
  ): Promise<ApprovalListRow[]> {
    const status = input.status ?? 'pending'
    const rows = await this.prisma.approvalRequest.findMany({
      where: {
        ...scope,
        ...(status === 'all' ? {} : { status: status as ApprovalStatus }),
        ...(input.cursor === undefined
          ? {}
          : {
              // 同一毫秒的多行靠 id 定序；两个条件必须写在**同一个 OR** 里，
              // 否则会退化成「比这个时间早 **或** id 比它小」—— 跨毫秒乱序。
              OR: [
                { createdAt: { lt: input.cursor.createdAt } },
                { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } }
              ]
            })
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1
    })
    return rows.map(toListRow)
  }


  /**
   * 批准 / 拒绝 —— **乐观锁** ＋ 同事务执行（`02` §4.4 / §4.5）。
   *
   * 三处并发要点：
   *   ① 双击「同意」：`FOR UPDATE` ＋ `WHERE status='pending'` ⇒ 第二个请求 409，
   *      流水**只写一条**（`idempotencyKey` 是第二道保险）；
   *   ② 家长同意与孩子撤回并发：谁先拿到行锁谁赢，输家看到终态 → 409，绝不覆盖；
   *   ③ 余额并发：锁 `Child` 行 ＋ CAS ⇒ 不会出现两笔扣分都基于同一份余额。
   */
  async decide(input: DecideApprovalInput): Promise<ApprovalRow> {
    const now = new Date()
    // TTL 惰性过期**先独立提交**：若在事务里抛 409，刚写下的 `expired` 会被回滚。
    await this.expireIfDue(input.id, input.childId, now)

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ApprovalRequest"
        WHERE "id" = ${input.id} AND "childId" = ${input.childId} FOR UPDATE`
      if (locked.length === 0) {
        throw approvalNotFound(input.id)
      }
      const row = await tx.approvalRequest.findFirst({
        where: { id: input.id, childId: input.childId }
      })
      if (row === null) {
        // 行锁拿到了、按 (id, childId) 却读不到 —— 只可能是我们在同一事务里删了它（不该发生）。
        throw approvalNotFound(input.id)
      }

      if (row.status === 'expired') {
        throw new ConflictException({
          code: 'APPROVAL_EXPIRED',
          // 与 service 的 `assertTerminalWithoutExecution` 保持同一错误体形状：
          // 同一个 code 不该因为“走了哪条分支”而有时带 status、有时不带（客户端没法统一处理）。
          status: 'expired',
          message: '这条审批已超过有效期（72h TTL），不能再批准、拒绝或撤回（02 §4.3）。'
        })
      }
      if (row.status !== 'pending') {
        throw new ConflictException({
          code: 'ALREADY_DECIDED',
          message:
            `这条审批已是终态：${row.status}（02 §4.4 乐观锁只认 status = 'pending'）。` +
            '★ 绝不覆盖别人已经做出的决定。'
        })
      }

      // 竞态兜底：过期扫描可能刚好没抢到；这里让\"过期\"同样留下历史再返回。
      if (row.expiresAt.getTime() <= now.getTime()) {
        return this.markExpiredInTx(tx, row)
      }

      if (input.outcome === 'rejected') {
        const updated = await tx.approvalRequest.updateMany({
          where: { id: input.id, status: 'pending' },
          data: {
            status: 'rejected',
            decidedByUserId: input.decidedByUserId,
            decidedAt: now
          }
        })
        if (updated.count !== 1) throw alreadyDecided()
        const after = await tx.approvalRequest.findUniqueOrThrow({ where: { id: input.id } })
        await writeAudit(tx, {
          childId: row.childId,
          actorUserId: input.decidedByUserId,
          actorRole: toMemberRole(input.decidedByRole),
          action: 'approval.rejected',
          targetId: row.id,
          before: { status: 'pending' },
          after: { status: 'rejected', decidedByUserId: input.decidedByUserId }
        })
        await this.outbox.enqueueApprovalStatusChanged(
          tx,
          {
            approvalId: row.id,
            childId: row.childId,
            recipientUserId: row.requesterUserId,
            action: row.actionType as ActionType,
            status: 'rejected',
            decidedByUserId: input.decidedByUserId
          },
          now
        )
        return toRow(after)
      }

      // ── 批准：先执行，再落终态（顺序反了会留下\"批了却没扣分\"的假账）──────────
      assertExecutable(row.actionType as ActionType)
      const payload = parseApprovalPayload(row.actionType as ActionType, row.payload)
      const deciderRole = toMemberRole(input.decidedByRole)
      const outcome = await this.executeAction(tx, {
        approvalId: row.id,
        action: row.actionType as ActionType,
        childId: row.childId,
        payload,
        requesterUserId: row.requesterUserId,
        operatorUserId: input.decidedByUserId,
        operatorRole: deciderRole,
        now
      })

      if (outcome.kind === 'invalidated') {
        // ★ 前提消失 **不是** \"家长拒绝\"：`invalidated` ＋ `autoReason` 必须留下，
        //   否则 UI 只能显示\"审批无效\"，家长莫名背锅（02 §4.2）。
        const updated = await tx.approvalRequest.updateMany({
          where: { id: input.id, status: 'pending' },
          data: {
            status: 'invalidated',
            autoReason: outcome.reason,
            decidedByUserId: input.decidedByUserId,
            decidedAt: now
          }
        })
        if (updated.count !== 1) throw alreadyDecided()
        const after = await tx.approvalRequest.findUniqueOrThrow({ where: { id: input.id } })
        await writeAudit(tx, {
          childId: row.childId,
          actorUserId: input.decidedByUserId,
          actorRole: deciderRole,
          action: 'approval.invalidated',
          targetId: row.id,
          before: { status: 'pending' },
          after: {
            status: 'invalidated',
            autoReason: outcome.reason,
            decidedByUserId: input.decidedByUserId
          }
        })
        return toRow(after)
      }

      const updated = await tx.approvalRequest.updateMany({
        where: { id: input.id, status: 'pending' },
        data: {
          status: 'approved',
          decidedByUserId: input.decidedByUserId,
          decidedAt: now,
          executedRecordId: outcome.recordId
        }
      })
      if (updated.count !== 1) {
        // ★ 抛 ⇒ 整个事务回滚 ⇒ 刚写的流水/余额一起撤销：不会出现\"批了两次、扣了两笔\"。
        throw alreadyDecided()
      }
      const after = await tx.approvalRequest.findUniqueOrThrow({ where: { id: input.id } })
      const selfApproved = input.decidedByUserId === row.requesterUserId
      await writeAudit(tx, {
        childId: row.childId,
        actorUserId: input.decidedByUserId,
        actorRole: deciderRole,
        action: selfApproved ? AUDIT_ACTION_SELF_APPROVED : 'approval.approved',
        targetId: row.id,
        before: { status: 'pending' },
        after: { status: 'approved', executedRecordId: outcome.recordId }
      })
      await this.outbox.enqueueApprovalStatusChanged(
        tx,
        {
          approvalId: row.id,
          childId: row.childId,
          recipientUserId: row.requesterUserId,
          action: row.actionType as ActionType,
          status: 'approved',
          decidedByUserId: input.decidedByUserId
        },
        now
      )
      return toRow(after)
    })
  }

  /**
   * 申请人撤回（`02` §4.1）：`pending → withdrawn`，**不写流水、不动余额**。
   *
   * ★ 与 `decide` 同一个并发姿势：`FOR UPDATE` → 行锁下重验 → 条件 UPDATE。
   *   否则「读的时候还是 pending、写的时候已经被批准」会把一笔**已扣分**的兑换
   *   改成撤回 —— 状态与账本互相矛盾（比 409 糟得多）。
   *
   * ★ `decidedByUserId` / `decidedAt` **保持 null**：撤回不是「谁的批准决定」，
   *   写进去会让「谁批的」统计把撤回也算成一次批准。时间线由 `updatedAt`
   *   ＋ 审计行的 `createdAt` 记录。
   */
  async withdraw(input: WithdrawApprovalInput): Promise<ApprovalRow> {
    const now = new Date()
    // 与 decide 相同的理由：过期的历史必须**独立提交**，不能在事务里被 409 回滚。
    await this.expireIfDue(input.id, input.childId, now)

    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ApprovalRequest"
        WHERE "id" = ${input.id} AND "childId" = ${input.childId} FOR UPDATE`
      if (locked.length === 0) throw approvalNotFound(input.id)

      const row = await tx.approvalRequest.findFirst({
        where: { id: input.id, childId: input.childId }
      })
      if (row === null) throw approvalNotFound(input.id)

      if (row.status === 'expired') throw expiredApproval()
      // 竞态兜底：expireIfDue 与这里之间又过了期 —— 让过期留下历史再交给 service 翻 409。
      if (row.expiresAt.getTime() <= now.getTime()) {
        return this.markExpiredInTx(tx, row)
      }

      // ★ 判定只有一处：service 与这里都调 `withdrawDenial()`。
      switch (withdrawDenial(row, { userId: input.requesterUserId, role: input.requesterRole })) {
        case null:
          break
        case 'WITHDRAW_FORBIDDEN_ROLE':
          throw new ForbiddenException({
            code: 'FORBIDDEN',
            message: `角色 ${input.requesterRole} 没有撤回资格（矩阵 withdraw_request）。`
          })
        case 'NOT_REQUESTER':
          throw new ForbiddenException({
            code: 'NOT_REQUESTER',
            message: '只有申请人本人可以撤回这条审批（02 §4.1）。'
          })
        case 'ALREADY_DECIDED':
          // 已终态：绝不覆盖（尤其是 approved —— 流水已经写了，不能倒着改状态）。
          throw alreadyDecided()
      }

      const updated = await tx.approvalRequest.updateMany({
        where: { id: input.id, childId: input.childId, status: 'pending' },
        data: { status: 'withdrawn' }
      })
      if (updated.count !== 1) throw alreadyDecided()

      const after = await tx.approvalRequest.findUniqueOrThrow({ where: { id: input.id } })
      await writeAudit(tx, {
        childId: row.childId,
        actorUserId: input.requesterUserId,
        actorRole: toMemberRole(input.requesterRole),
        action: AUDIT_ACTION_WITHDRAWN,
        targetId: row.id,
        before: { status: 'pending' },
        after: { status: 'withdrawn' }
      })
      return toRow(after)
    })
  }

  /**
   * 事务内把一行 `pending` 置为 `expired` 并写审计，返回过期后的行。
   *
   * ★ 调用方必须已持有该行的 `FOR UPDATE` 锁；`count !== 1` 说明状态在眼皮底下变了
   *   （不该发生）—— 抛 409 让整个事务回滚，绝不假装过期成功。
   */
  private async markExpiredInTx(
    tx: Prisma.TransactionClient,
    row: ApprovalRequest
  ): Promise<ApprovalRow> {
    const updated = await tx.approvalRequest.updateMany({
      where: { id: row.id, childId: row.childId, status: 'pending' },
      data: { status: 'expired' }
    })
    if (updated.count !== 1) throw alreadyDecided()
    const after = await tx.approvalRequest.findUniqueOrThrow({ where: { id: row.id } })
    await writeAudit(tx, {
      childId: row.childId,
      actorUserId: null,
      actorRole: null,
      action: 'approval.expired',
      targetId: row.id,
      before: { status: 'pending' },
      after: { status: 'expired' }
    })
    return toRow(after)
  }


  /**
   * 建请求时的 payload 快照（`02` §4.3）：**只读目标对象，不读余额**。
   *
   * ★ 余额不在申请时冻结：孩子申请时够分、家长 3 小时后同意时可能已花掉 ——
   *   那正是 `invalidated: INSUFFICIENT_POINTS` 要表达的事（比\"偷偷扣成负数\"诚实）。
   *
   * ★ 每个动作只接受自己的参数（`rejectParams`）：多余字段 → 400，而不是静默忽略。
   *   静默忽略会让客户端以为\"我传的金额生效了\"，而审批里存的是另一个数。
   */
  private async snapshotPayload(
    tx: Prisma.TransactionClient,
    input: CreateApprovalInput
  ): Promise<ApprovalPayload> {
    switch (input.action) {
      case 'redeem':
      case 'request_redeem':
        rejectParams(input, ['targetId'])
        return this.snapshotRedeemPayload(tx, input)

      case 'request_points_bonus':
        rejectParams(input, ['amount', 'reason', 'ruleId', 'habitId'])
        return this.snapshotBonusPayload(tx, input)

      case 'add_wish':
        rejectParams(input, ['title', 'cost', 'emoji'])
        return snapshotAddWishPayload(input)

      default:
        // `createPending` / `createSelfApproved` 已先 `assertExecutable`；走到这里说明
        // 「可执行名单」与 `snapshotPayload` 的分支漂了 —— 响亮失败，不落半条快照。
        throw new InternalServerErrorException({
          code: 'UNSUPPORTED_APPROVAL_ACTION',
          message: `动作 ${input.action} 没有 payload 快照分支 —— 可执行名单与快照实现已经漂移。`
        })
    }
  }

  /** 兑换 / 申请兑换：只读心愿、不读余额；别人的心愿一律回答\"不存在\"。 */
  private async snapshotRedeemPayload(
    tx: Prisma.TransactionClient,
    input: CreateApprovalInput
  ): Promise<RedeemPayload> {
    const targetId = input.targetId
    if (targetId === undefined || targetId.trim() === '') {
      throw new BadRequestException({
        code: 'APPROVAL_TARGET_REQUIRED',
        message: '兑换审批必须带 targetId（要兑换的心愿 id）—— 没有它就没有可快照的成本。'
      })
    }
    const wish = await tx.wish.findUnique({
      where: { id: targetId },
      select: { id: true, childId: true, title: true, cost: true, status: true, redeemed: true }
    })
    // ★ 别人的心愿一律回答\"不存在\"：403/404 的差别会泄露\"那个孩子有这个心愿\"。
    if (wish === null || wish.childId !== input.childId || wish.status !== 'active') {
      throw new NotFoundException({
        code: 'WISH_NOT_FOUND',
        message: `心愿 ${targetId} 不存在或已删除（也可能不属于这个孩子 —— 一律按不存在回答）。`
      })
    }
    if (wish.redeemed) {
      throw new ConflictException({
        code: 'WISH_ALREADY_REDEEMED',
        message: `心愿 ${targetId} 已经兑换过了 —— 再建一条审批会重复扣分。`
      })
    }
    if (!Number.isInteger(wish.cost) || wish.cost <= 0) {
      // 库里的成本不合法是**我们的数据问题**（500），不是用户输入错误（400）。
      throw new InternalServerErrorException({
        code: 'INVALID_WISH_COST',
        message: `心愿 ${wish.id} 的成本不是正整数（${String(wish.cost)}）—— 无法生成可对账的扣分。`
      })
    }
    return { wishId: wish.id, titleSnapshot: wish.title, costSnapshot: wish.cost }
  }

  /**
   * `request_points_bonus` 的快照：金额 + 事由 + 可选依据（规则 / 习惯）。
   *
   * ★ `ruleId` / `habitId` 在这里就查一次（属于这个孩子、仍 `active`），
   *   但**批准那一刻还要再查**：跨时间前提可能已经消失 →
   *   `invalidated: RULE_DELETED` / `HABIT_GONE`（`02` §4.2）。
   */
  private async snapshotBonusPayload(
    tx: Prisma.TransactionClient,
    input: CreateApprovalInput
  ): Promise<BonusPayload> {
    const amount = input.amount
    if (amount === undefined) {
      throw new BadRequestException({
        code: 'APPROVAL_AMOUNT_REQUIRED',
        message: '加分申请必须带 amount（正整数，单笔 ≤ 50）—— 没有金额就无法生成可对账的流水。'
      })
    }
    if (!Number.isInteger(amount) || amount <= 0 || amount > 50) {
      throw new BadRequestException({
        code: 'INVALID_APPROVAL_AMOUNT',
        message: `加分金额必须是 1..50 的整数（收到 ${JSON.stringify(amount)}）—— 02 §6 / Q15。`
      })
    }

    if (input.ruleId !== undefined && input.habitId !== undefined) {
      throw new BadRequestException({
        code: 'AMBIGUOUS_BONUS_SOURCE',
        message:
          '加分申请不能同时引用规则和习惯 —— 依据必须唯一，否则批准时无法判断该复查哪一个。'
      })
    }

    const reason = (input.reason ?? '').trim()
    if (reason.length > 200) {
      throw new BadRequestException({
        code: 'APPROVAL_REASON_TOO_LONG',
        message: `加分事由最多 200 字（收到 ${reason.length} 字）。`
      })
    }

    let ruleTitleSnapshot: string | null = null
    if (input.ruleId !== undefined) {
      const ruleId = requireRefId(input.ruleId, 'RULE_ID_REQUIRED')
      const rule = await tx.pointRule.findFirst({
        where: { id: ruleId, childId: input.childId, status: 'active' },
        select: { title: true }
      })
      if (rule === null) {
        throw new NotFoundException({
          code: 'RULE_NOT_FOUND',
          message: `规则 ${ruleId} 不存在或已删除（也可能不属于这个孩子 —— 一律按不存在回答）。`
        })
      }
      ruleTitleSnapshot = rule.title
    }

    let habitTitleSnapshot: string | null = null
    if (input.habitId !== undefined) {
      const habitId = requireRefId(input.habitId, 'HABIT_ID_REQUIRED')
      const habit = await tx.habit.findFirst({
        where: { id: habitId, childId: input.childId, status: 'active' },
        select: { title: true }
      })
      if (habit === null) {
        throw new NotFoundException({
          code: 'HABIT_NOT_FOUND',
          message: `习惯 ${habitId} 不存在或已删除（也可能不属于这个孩子 —— 一律按不存在回答）。`
        })
      }
      habitTitleSnapshot = habit.title
    }

    return {
      amount,
      reason,
      ruleId: input.ruleId?.trim() ?? null,
      ruleTitleSnapshot,
      habitId: input.habitId?.trim() ?? null,
      habitTitleSnapshot
    }
  }


  /**
   * 执行一条**已判定该批**的审批（`02` §4.3 / §4.5）。
   *
   * 三件事按顺序做，顺序是语义的一部分：
   *   ① **申请人还在这个家里吗** —— 成员位被移出 ⇒ `invalidated: MEMBER_REMOVED`
   *      （不该再给已离开的成员发分 / 落心愿）；
   *   ② 动作自己的前提复查（心愿 / 规则 / 习惯）—— 消失 ⇒ 对应 `autoReason`；
   *   ③ 执行（写账本或创建心愿）。
   *
   * ★ 返回判别式联合而不是抛异常：`invalidated` 是**要提交的历史**，
   *   在事务里抛 409 会把它回滚掉（见文件头第 ★ 段）。
   */
  private async executeAction(
    tx: Prisma.TransactionClient,
    args: {
      approvalId: string
      action: ActionType
      childId: string
      payload: ApprovalPayload
      requesterUserId: string
      operatorUserId: string
      operatorRole: MemberRole
      now: Date
    }
  ): Promise<ExecutionOutcome> {
    const member = await tx.childMember.findUnique({
      where: { childId_userId: { childId: args.childId, userId: args.requesterUserId } },
      select: { status: true }
    })
    if (member === null || member.status !== 'active') {
      return { kind: 'invalidated', reason: 'MEMBER_REMOVED' }
    }

    switch (args.action) {
      case 'redeem':
      case 'request_redeem':
        return this.executeRedeem(tx, {
          approvalId: args.approvalId,
          childId: args.childId,
          payload: args.payload as RedeemPayload,
          operatorUserId: args.operatorUserId,
          operatorRole: args.operatorRole,
          now: args.now
        })

      case 'request_points_bonus':
        return this.executeBonus(tx, {
          approvalId: args.approvalId,
          childId: args.childId,
          payload: args.payload as BonusPayload,
          operatorUserId: args.operatorUserId,
          operatorRole: args.operatorRole,
          now: args.now
        })

      case 'add_wish':
        return this.executeAddWish(tx, {
          childId: args.childId,
          payload: args.payload as AddWishPayload
        })

      default:
        throw new InternalServerErrorException({
          code: 'UNSUPPORTED_APPROVAL_ACTION',
          message: `动作 ${args.action} 没有执行器 —— 可执行名单与执行实现已经漂移。`
        })
    }
  }

  /**
   * 执行兑换：**写流水 ＋ 扣余额 ＋ 标记心愿已兑换**（调用方已在事务里）。
   *
   * 返回判别式联合而不是抛异常：\"积分不够 / 心愿没了\"是**正常业务分支**，
   * 调用方要把请求落成 `invalidated` 并**提交**（见文件头第 ★ 段）。
   *
   * ★ 扣的是 **payload 里的 `costSnapshot`**，不是 `wish.cost` 现价：
   *   孩子申请时看到 30 分，家长同意时心愿改成 50 分 —— 按 30 扣（`02` §4.3），
   *   否则孩子会\"莫名其妙多扣 20 分\"，而账本上永远解释不清。
   */
  private async executeRedeem(
    tx: Prisma.TransactionClient,
    args: {
      approvalId: string
      childId: string
      payload: RedeemPayload
      operatorUserId: string
      operatorRole: MemberRole
      now: Date
    }
  ): Promise<ExecutionOutcome> {
    const currentBalance = await this.lockBalance(tx, args.childId)

    // 前提复查（批准那一刻，而不是申请那一刻）：软删 / 已兑换 ⇒ invalidated。
    const wish = await tx.wish.findUnique({
      where: { id: args.payload.wishId },
      select: { id: true, childId: true, status: true, redeemed: true }
    })
    if (
      wish === null ||
      wish.childId !== args.childId ||
      wish.status !== 'active' ||
      wish.redeemed
    ) {
      return { kind: 'invalidated', reason: 'WISH_DELETED' }
    }

    let draft
    try {
      // ★ 判定只在 `ledger.gate`：这里给\"事实\"（快照、操作人、当前余额），不给结论。
      draft = buildRecordDraft({
        childId: args.childId,
        ruleVersionRow: null,
        titleSnapshot: args.payload.titleSnapshot,
        pointsDelta: -args.payload.costSnapshot,
        category: 'exchange',
        source: 'approval',
        operator: { userId: args.operatorUserId, role: args.operatorRole },
        wishId: args.payload.wishId,
        costSnapshot: args.payload.costSnapshot,
        // 幂等键在**同一孩子**范围内唯一：同一条审批永远只能产生一笔流水。
        idempotencyKey: `approval:${args.approvalId}`,
        currentBalance,
        now: args.now
      })
    } catch (err) {
      if (err instanceof LedgerDeniedError && err.code === 'INSUFFICIENT_POINTS') {
        return { kind: 'invalidated', reason: 'INSUFFICIENT_POINTS' }
      }
      // 其余拒绝（ZERO_DELTA 等）说明 payload 与类别不自洽 —— 我们的 bug，不是用户操作。
      if (err instanceof LedgerDeniedError) {
        throw new ConflictException({ code: err.code, message: err.message })
      }
      if (err instanceof LedgerShapeError) {
        throw new InternalServerErrorException({ code: err.code, message: err.message })
      }
      throw err
    }


    const recordId = await this.appendDraft(tx, args.childId, draft)

    // 心愿\"已兑换\"与流水必须同一事务：否则会出现\"扣了分但心愿还能再兑换\"。
    const wishUpdated = await tx.wish.updateMany({
      where: { id: args.payload.wishId, status: 'active', redeemed: false },
      data: { redeemed: true, redeemedAt: args.now }
    })
    if (wishUpdated.count !== 1) {
      throw new ConflictException({
        code: 'WISH_STATE_CHANGED',
        message: `心愿 ${args.payload.wishId} 的状态刚被改过（已兑换/已删除）—— 这笔扣分已回滚，请刷新后再试。`
      })
    }

    return { kind: 'executed', recordId }
  }

  /**
   * 执行加分申请：先复查依据，再写一条 `+amount` 的 `adjust/approval` 流水。
   *
   * ★ 流水不带 `ruleId`：本内核的 I3/I4 要求 `(ruleId, ruleVersion)` **成对**且命中版本行，
   *   而加分申请是「人对一笔金额的批准」，不是规则版本执行。依据只快照在
   *   `ApprovalRequest.payload` 与标题里，足以解释这笔分从何而来。
   */
  private async executeBonus(
    tx: Prisma.TransactionClient,
    args: {
      approvalId: string
      childId: string
      payload: BonusPayload
      operatorUserId: string
      operatorRole: MemberRole
      now: Date
    }
  ): Promise<ExecutionOutcome> {
    const payload = args.payload

    if (payload.ruleId !== null) {
      const rule = await tx.pointRule.findFirst({
        where: { id: payload.ruleId, childId: args.childId, status: 'active' },
        select: { id: true }
      })
      if (rule === null) return { kind: 'invalidated', reason: 'RULE_DELETED' }
    }
    if (payload.habitId !== null) {
      const habit = await tx.habit.findFirst({
        where: { id: payload.habitId, childId: args.childId, status: 'active' },
        select: { id: true }
      })
      if (habit === null) return { kind: 'invalidated', reason: 'HABIT_GONE' }
    }

    const currentBalance = await this.lockBalance(tx, args.childId)
    const title =
      payload.reason.trim() !== ''
        ? payload.reason
        : (payload.ruleTitleSnapshot ?? payload.habitTitleSnapshot ?? '申请加分')

    let draft
    try {
      draft = buildRecordDraft({
        childId: args.childId,
        ruleVersionRow: null,
        titleSnapshot: title,
        pointsDelta: payload.amount,
        category: 'adjust',
        source: 'approval',
        operator: { userId: args.operatorUserId, role: args.operatorRole },
        habitId: payload.habitId,
        idempotencyKey: `approval:${args.approvalId}`,
        currentBalance,
        now: args.now
      })
    } catch (err) {
      if (err instanceof LedgerDeniedError) {
        throw new ConflictException({ code: err.code, message: err.message })
      }
      if (err instanceof LedgerShapeError) {
        throw new InternalServerErrorException({ code: err.code, message: err.message })
      }
      throw err
    }

    const recordId = await this.appendDraft(tx, args.childId, draft)
    return { kind: 'executed', recordId }
  }

  /**
   * 执行 `add_wish`：**创建**心愿（不是兑换）。
   *
   * ★ 没有 `PointRecord`（这只审批不产生积分变动），所以 `executedRecordId` 为 `null`；
   *   `executedRecordId` 是「批准并执行后产出的流水」的字段，硬塞一个心愿 id 会破坏
   *   `@unique` 外键语义。客户端的 `ApprovalRequest.status=approved` 已经表示执行成功。
   */
  private async executeAddWish(
    tx: Prisma.TransactionClient,
    args: { childId: string; payload: AddWishPayload }
  ): Promise<ExecutionOutcome> {
    // ★ 配色与 `POST /wishes` 走**同一个** `pickCoverStyle`（03 E16）：
    //   若这里硬写 'A'，孩子申请批准出来的心愿会全部同色 —— 直写与审批两条入口
    //   必须落出同一个形状，否则「同一件事两个样子」又回来了。
    const active = await tx.wish.findMany({
      where: { childId: args.childId, status: 'active' },
      select: { coverStyle: true }
    })
    const taken = active.map((row) => row.coverStyle)

    const created = await tx.wish.create({
      data: {
        childId: args.childId,
        title: args.payload.title,
        cost: args.payload.cost,
        emoji: args.payload.emoji,
        coverStyle: pickCoverStyle(taken, ''),
        status: 'active'
      }
    })
    const coverStyle = pickCoverStyle(taken, created.id)
    if (coverStyle !== created.coverStyle) {
      await tx.wish.update({ where: { id: created.id }, data: { coverStyle } })
    }
    return { kind: 'executed', recordId: null }
  }

  /** 锁孩子余额行（同一孩子的写入排队），返回当前余额。 */
  private async lockBalance(tx: Prisma.TransactionClient, childId: string): Promise<number> {
    const locked = await tx.$queryRaw<{ pointsBalance: number }[]>`
      SELECT "pointsBalance" FROM "Child" WHERE "id" = ${childId} FOR UPDATE`
    if (locked.length === 0) {
      throw new NotFoundException({
        code: 'APPROVAL_CHILD_NOT_FOUND',
        message: `孩子 ${childId} 不存在 —— 这条审批无处执行（拒绝，而不是造一条无主流水）。`
      })
    }
    return locked[0].pointsBalance
  }

  /**
   * 写一条账本记录并同步余额（调用方已持有孩子行锁）。
   *
   * 与 `ledger.prisma.repository.ts` 完全同一套定序手法（两处必须一致，否则 I2 会裂）：
   * `createdAt` 由库钟 + 严格递增决定；余额用 CAS（`WHERE pointsBalance = 期望前值`）。
   */
  private async appendDraft(
    tx: Prisma.TransactionClient,
    childId: string,
    draft: PointRecordDraft
  ): Promise<string> {
    const [clock] = await tx.$queryRaw<{ ts: Date }[]>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS ts`
    const [latest] = await tx.$queryRaw<{ latest: Date | null }[]>`
      SELECT MAX("createdAt") AS latest FROM "PointRecord" WHERE "childId" = ${childId}`
    const createdAt = resolveAppendCreatedAt({
      dbNow: clock.ts,
      latestCreatedAt: latest.latest
    })

    const record = await tx.pointRecord.create({
      data: { ...draft, createdAt },
      select: { id: true }
    })

    const expectedBefore = draft.balanceAfter - draft.pointsDelta
    const updated = await tx.child.updateMany({
      where: { id: childId, pointsBalance: expectedBefore },
      data: { pointsBalance: draft.balanceAfter }
    })
    if (updated.count !== 1) {
      throw new ConflictException({
        code: 'APPROVAL_BALANCE_CHANGED',
        message:
          `余额已被别的写入改过：按 ${expectedBefore} 分算 ⇒ ` +
          '拒绝落库（这笔的 balanceAfter 已经不成立了）。重试请重新读余额。'
      })
    }

    return record.id
  }

  /**
   * TTL 惰性过期（`02` §4.3）—— 读/决的时候顺手判。
   *
   * 用单条条件 UPDATE 抢\"过期权\"（`WHERE status='pending' AND expiresAt <= now`）：
   * 并发两个请求只有一个 `count=1`，审计不会重复。**独立提交**，不在 decide 事务里
   * 抛异常（否则过期这条历史会被回滚）。
   */
  private async expireIfDue(id: string, childId: string, now: Date): Promise<void> {
    const updated = await this.prisma.approvalRequest.updateMany({
      // ★ `childId` 也是条件（W3-B）：否则一个跨孩子的请求会把别家的 `pending` 提前置过期。
      where: { id, childId, status: 'pending', expiresAt: { lte: now } },
      data: { status: 'expired' }
    })
    if (updated.count !== 1) return
    const row = await this.prisma.approvalRequest.findFirst({
      where: { id, childId },
      select: { childId: true }
    })
    if (row === null) return
    await this.prisma.auditLog.create({
      data: {
        childId: row.childId,
        actorUserId: null,
        actorRole: null,
        action: 'approval.expired',
        targetType: 'ApprovalRequest',
        targetId: id,
        after: { status: 'expired' }
      }
    })
  }

  /**
   * TTL 后台扫描（`02` §4.3）：把到期的 `pending` 批量置为 `expired`。
   *
   * ★ `FOR UPDATE SKIP LOCKED`：多个实例同时扫描时各拿各的，不会互相阻塞；
   *   每行再用 `WHERE status='pending'` 条件更新，与惰性过期/decide 抢同一行时只有一个赢家。
   * ★ 审计与状态**同一事务**：不会出现「行过期了但没人记得为什么」。
   */
  async expireDue(now: Date, limit = 100): Promise<number> {
    const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; childId: string }[]>`
        SELECT "id", "childId" FROM "ApprovalRequest"
        WHERE "status" = 'pending' AND "expiresAt" <= ${now}
        ORDER BY "expiresAt" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED`

      let expired = 0
      for (const row of rows) {
        const updated = await tx.approvalRequest.updateMany({
          where: { id: row.id, childId: row.childId, status: 'pending', expiresAt: { lte: now } },
          data: { status: 'expired' }
        })
        if (updated.count !== 1) continue
        await writeAudit(tx, {
          childId: row.childId,
          actorUserId: null,
          actorRole: null,
          action: 'approval.expired',
          targetId: row.id,
          before: { status: 'pending' },
          after: { status: 'expired' }
        })
        expired += 1
      }
      return expired
    })
  }
}


/** 执行结果：\"做成了\" 与 \"前提消失\" 是两条正常分支（后者要落 `invalidated`）。 */
type ExecutionOutcome =
  /** `recordId` 为 `null` 表示执行成功但**不产生流水**（如 `add_wish`）。 */
  | { kind: 'executed'; recordId: string | null }
  | { kind: 'invalidated'; reason: AutoReason }

/**
 * 目前**有执行器**的动作（W3-C 起四项）。
 *
 * | 动作 | 批准时做什么 | 会产生流水吗 |
 * |---|---|---|
 * | `redeem` | 按 `costSnapshot` 扣分 + 心愿置已兑换 | 是（`exchange`） |
 * | `request_redeem` | 与 `redeem` 同一执行路径（孩子申请兑换的矩阵动作） | 是（`exchange`） |
 * | `request_points_bonus` | 按快照金额加分 | 是（`adjust`） |
 * | `add_wish` | 创建心愿 | 否（`executedRecordId = null`） |
 *
 * ★ 不在名单里的动作在建请求时就 400 —— 先落一条永远批不动的 `pending` 是死胡同，
 *   而\"看起来提交成功\"比\"明确不支持\"更伤（用户会等一个永远不会来的批准）。
 */
const EXECUTABLE_ACTIONS = ['redeem', 'request_redeem', 'request_points_bonus', 'add_wish'] as const

function assertExecutable(action: ActionType): void {
  if (!(EXECUTABLE_ACTIONS as readonly string[]).includes(action)) {
    throw new BadRequestException({
      code: 'APPROVAL_ACTION_NOT_EXECUTABLE',
      message:
        `动作 ${action} 还没有执行器（W3-C 支持：${EXECUTABLE_ACTIONS.join(' / ')}）。` +
        '★ 现在建请求会留下一条永远批不动的 pending —— 所以在这里拒绝，而不是假装受理。'
    })
  }
}

/** `Role | 'viewer'` → DB 的 `MemberRole`；viewer 不该走到写入路径（守卫已拦）。 */
function toMemberRole(role: Role | 'viewer'): MemberRole {
  if (role === 'viewer') {
    throw new InternalServerErrorException({
      code: 'INVALID_REQUESTER_ROLE',
      message: 'viewer 没有审批写入资格（02 §2 矩阵无此列）—— 拒绝写入，绝不落成 guardian。'
    })
  }
  return role
}

function toRow(row: ApprovalRequest): ApprovalRow {
  return {
    id: row.id,
    childId: row.childId,
    action: row.actionType as ActionType,
    requesterUserId: row.requesterUserId,
    // P1-3：详情页的「谁提的」。建请求时的快照列，读侧原样交出去。
    requesterRole: row.requesterRole,
    status: row.status,
    decidedByUserId: row.decidedByUserId,
    executedRecordId: row.executedRecordId,
    autoReason: row.autoReason
  }
}

/**
 * 列表行的映射：判定字段复用 `toRow`（**同一份**状态 / `autoReason` 口径），
 * 再补上列表需要的 `payload` 与三个时间戳。
 *
 * ★ `payload` 原样交出去，解析在 service（`summarizeApprovalPayload`）：
 *   仓储不该决定「列表该显示什么」，也不该因为一行坏数据把整页抛 500。
 */
function toListRow(row: ApprovalRequest): ApprovalListRow {
  return {
    ...toRow(row),
    payload: row.payload,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    expiresAt: row.expiresAt
  }
}

/** 写入 `payload` 列的形状（`InputJsonObject` 不接受无索引签名的 interface）。 */
function jsonOf(payload: ApprovalPayload): Prisma.InputJsonObject {
  if ('wishId' in payload) {
    return {
      wishId: payload.wishId,
      titleSnapshot: payload.titleSnapshot,
      costSnapshot: payload.costSnapshot
    }
  }
  if ('amount' in payload) {
    return {
      amount: payload.amount,
      reason: payload.reason,
      ruleId: payload.ruleId,
      ruleTitleSnapshot: payload.ruleTitleSnapshot,
      habitId: payload.habitId,
      habitTitleSnapshot: payload.habitTitleSnapshot
    }
  }
  return {
    title: payload.title,
    cost: payload.cost,
    emoji: payload.emoji
  }
}

/**
 * 建请求时的 `add_wish` 快照（无 IO，只做形状与业务边界校验）。
 *
 * ★ 这里**不查**是否重名：同名心愿是允许的（孩子可以想要两个一样的）；
 *   真正的唯一性由 `Wish.id` 保证。
 */
function snapshotAddWishPayload(input: CreateApprovalInput): AddWishPayload {
  const title = (input.title ?? '').trim()
  if (title === '') {
    throw new BadRequestException({
      code: 'APPROVAL_TITLE_REQUIRED',
      message: '新建心愿必须带 title（1..100 字）—— 没有标题的审批无法说明要建什么。'
    })
  }
  if (title.length > 100) {
    throw new BadRequestException({
      code: 'APPROVAL_TITLE_TOO_LONG',
      message: `心愿标题最多 100 字（收到 ${title.length} 字）。`
    })
  }
  const cost = input.cost
  if (cost === undefined) {
    throw new BadRequestException({
      code: 'APPROVAL_COST_REQUIRED',
      message: '新建心愿必须带 cost（正整数）—— 否则孩子无法知道要攒多少分。'
    })
  }
  if (!Number.isInteger(cost) || cost <= 0 || cost > 100_000) {
    throw new BadRequestException({
      code: 'INVALID_APPROVAL_COST',
      message: `心愿成本必须是 1..100000 的整数（收到 ${JSON.stringify(cost)}）。`
    })
  }
  const emoji = (input.emoji ?? '🎁').trim()
  if (emoji === '' || emoji.length > 8) {
    throw new BadRequestException({
      code: 'INVALID_APPROVAL_EMOJI',
      message: `心愿表情必须是 1..8 个字符（收到 ${JSON.stringify(emoji)}）。`
    })
  }
  return { title, cost, emoji }
}

/** 本动作允许的参数集合；其余参数出现 ⇒ 400（不静默忽略）。 */
const APPROVAL_PARAM_KEYS = [
  'targetId',
  'amount',
  'reason',
  'ruleId',
  'habitId',
  'title',
  'cost',
  'emoji'
] as const

type ApprovalParamKey = (typeof APPROVAL_PARAM_KEYS)[number]

function rejectParams(input: CreateApprovalInput, allowed: readonly ApprovalParamKey[]): void {
  const extras = APPROVAL_PARAM_KEYS.filter(
    (key) => !allowed.includes(key) && input[key] !== undefined
  )
  if (extras.length > 0) {
    throw new BadRequestException({
      code: 'APPROVAL_PARAM_NOT_APPLICABLE',
      message:
        `动作 ${input.action} 不接受参数：${extras.join(', ')} —— ` +
        '静默忽略会让客户端以为这些参数生效了（02 §4.3 的形状封闭）。'
    })
  }
}

/** 引用 id 必须非空（DTO 的 `@IsString()` 允许空串，业务上不允许）。 */
function requireRefId(value: string, code: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new BadRequestException({ code, message: '引用 id 不能为空 —— 没有它就无法复查依据。' })
  }
  return trimmed
}

function alreadyDecided(): ConflictException {
  return new ConflictException({
    code: 'ALREADY_DECIDED',
    message:
      '这条审批已被决过（状态刚被改了）—— 乐观锁未命中。' +
      '★ 绝不覆盖终态：双击\"同意\"的第二次必须 409，而不是再扣一次分（02 §4.4 / §9.10）。'
  })
}

/**
 * 「没有这条」的唯一回答。
 * ★ 跨孩子的 id **必须**与不存在完全相同（W3-B）：否则 403/404 的差别会告诉
 *   一位家长「另一家存在这条审批、只是不属于你」——存在性本身就是信息。
 */
function approvalNotFound(id: string): NotFoundException {
  return new NotFoundException({
    code: 'APPROVAL_NOT_FOUND',
    message: `没有这条审批请求：${id}`
  })
}

/** 过期（与 service 的 `assertTerminalWithoutExecution` 保持同一错误体形状）。 */
function expiredApproval(): ConflictException {
  return new ConflictException({
    code: 'APPROVAL_EXPIRED',
    status: 'expired',
    message: '这条审批已超过有效期（72h TTL），不能再批准、拒绝或撤回（02 §4.3）。'
  })
}

/** 审计写入 —— 与业务写入**同一事务**（`02` §4.3：批了就必须查得到谁批的）。 */
async function writeAudit(
  tx: Prisma.TransactionClient,
  args: {
    childId: string
    actorUserId: string | null
    actorRole: MemberRole | null
    action: string
    targetId: string
    before?: Prisma.InputJsonObject
    after?: Prisma.InputJsonObject
  }
): Promise<void> {
  await tx.auditLog.create({
    data: {
      childId: args.childId,
      actorUserId: args.actorUserId,
      actorRole: args.actorRole,
      action: args.action,
      targetType: 'ApprovalRequest',
      targetId: args.targetId,
      before: args.before,
      after: args.after
    }
  })
}


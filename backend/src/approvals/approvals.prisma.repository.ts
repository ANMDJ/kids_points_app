import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from '@nestjs/common'
import type { ApprovalRequest, AutoReason, MemberRole, Prisma } from '@prisma/client'

import {
  AUDIT_ACTION_SELF_APPROVED,
  AUDIT_ACTION_WITHDRAWN,
  withdrawDenial
} from '../contracts/approval-policy'
import type { ActionType, Role } from '../contracts/permission-matrix'
import {
  buildRecordDraft,
  LedgerDeniedError,
  LedgerShapeError,
  resolveAppendCreatedAt
} from '../ledger/ledger.gate'
import { PrismaService } from '../prisma/prisma.service'
import type {
  ApprovalRow,
  ApprovalsPort,
  CreateApprovalInput,
  DecideApprovalInput,
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
 * ── 范围（诚实标注，别把 W3-A 读成\"审批全落地\"）────────────────────────────
 *   · 已落地：`redeem`（兑换心愿）—— `FR-08` / `02` §9.25–§9.27 的主路径。
 *     payload 快照 = `{ wishId, titleSnapshot, costSnapshot }`（`02` §4.3：
 *     家长 3 小时后同意时，扣分必须等于**孩子申请时看到的**价格，不是现价）。
 *   · `request_points_bonus` / `add_rule` / `add_habit` / `redeem_wish` 等
 *     **没有执行器**：建请求时即 400 `APPROVAL_ACTION_NOT_EXECUTABLE`，
 *     而不是先落一条永远批不动的 `pending`（那是死胡同）。
 *   · `expired` 的**扫描任务**尚未落地（`02` §4.3 的 72h TTL）：本文件按需惰性过期
 *     （读/决/撤回时判定），不假装有后台 job。
 *
 * ── W3-B（2026-10-18）：两个改动都在\"别让一家碰另一家\"上 ─────────────────────
 *   ① **租户隔离**：`findById` / `decide` / `withdraw` 的 `childId` 是**查询条件**
 *      （`WHERE id = ? AND childId = ?`），不是读出来再比较。跨孩子的 id 与
 *      \"不存在\"返回同一个 404 —— 否则任何一位 guardian 拿到别家的审批 id 就能
 *      批准并扣那一家的分（屏障一只验\"你对**请求头里的孩子**是不是成员\"）。
 *   ② **撤回**：`withdraw()` 只做 `pending → withdrawn`，**不写流水、不动余额**；
 *      判定与 service 共用 `withdrawDenial()`（角色 → 本人 → 状态），
 *      并在**行锁下**再验一次（读与写之间可能有人刚好批准）。
 */
@Injectable()
export class PrismaApprovalsRepository implements ApprovalsPort {
  constructor(private readonly prisma: PrismaService) {}

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
      const payload = await this.snapshotRedeemPayload(tx, input)
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
      const payload = await this.snapshotRedeemPayload(tx, input)
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

      const outcome = await this.executeRedeem(tx, {
        approvalId: row.id,
        childId: input.childId,
        payload,
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
   */
  async findById(id: string, childId: string): Promise<ApprovalRow | null> {
    const row = await this.prisma.approvalRequest.findFirst({ where: { id, childId } })
    return row === null ? null : toRow(row)
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
        return toRow(after)
      }

      // ── 批准：先执行，再落终态（顺序反了会留下\"批了却没扣分\"的假账）──────────
      const payload = parseRedeemPayload(row.payload)
      assertExecutable(row.actionType as ActionType)
      const deciderRole = toMemberRole(input.decidedByRole)
      const outcome = await this.executeRedeem(tx, {
        approvalId: row.id,
        childId: row.childId,
        payload,
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
   * 建请求时的 payload 快照（`02` §4.3）：**只读心愿、不读余额**。
   *
   * ★ 余额不在申请时冻结：孩子申请时够分、家长 3 小时后同意时可能已花掉 ——
   *   那正是 `invalidated: INSUFFICIENT_POINTS` 要表达的事（比\"偷偷扣成负数\"诚实）。
   */
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
    const locked = await tx.$queryRaw<{ pointsBalance: number }[]>`
      SELECT "pointsBalance" FROM "Child" WHERE "id" = ${args.childId} FOR UPDATE`
    if (locked.length === 0) {
      throw new NotFoundException({
        code: 'APPROVAL_CHILD_NOT_FOUND',
        message: `孩子 ${args.childId} 不存在 —— 这条审批无处执行（拒绝，而不是造一条无主流水）。`
      })
    }
    const currentBalance = locked[0].pointsBalance

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


    // 与 `ledger.prisma.repository.ts` 完全同一套定序手法（两处必须一致，否则 I2 会裂）。
    const [clock] = await tx.$queryRaw<{ ts: Date }[]>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS ts`
    const [latest] = await tx.$queryRaw<{ latest: Date | null }[]>`
      SELECT MAX("createdAt") AS latest FROM "PointRecord" WHERE "childId" = ${args.childId}`
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
      where: { id: args.childId, pointsBalance: expectedBefore },
      data: { pointsBalance: draft.balanceAfter }
    })
    if (updated.count !== 1) {
      throw new ConflictException({
        code: 'APPROVAL_BALANCE_CHANGED',
        message:
          `余额已被别的写入改过：按 ${expectedBefore} 分算，库里现在是 ${currentBalance} 分 ⇒ ` +
          '拒绝落库（这笔的 balanceAfter 已经不成立了）。重试请重新读余额。'
      })
    }

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

    return { kind: 'executed', recordId: record.id }
  }

  /**
   * TTL 惰性过期（`02` §4.3）—— 扫描任务落地前，**读/决的时候顺手判**。
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
}


// ── 模块内的小工具（不导出：端口契约里没有\"实现细节\"的位置）──────────────────────

/** 兑换审批的快照形状（`02` §4.3）。读回来时**逐字段校验**，不信任 JSON 列。 */
interface RedeemPayload {
  wishId: string
  titleSnapshot: string
  costSnapshot: number
}

/** 执行结果：\"做成了\" 与 \"前提消失\" 是两条正常分支（后者要落 `invalidated`）。 */
type ExecutionOutcome =
  | { kind: 'executed'; recordId: string }
  | { kind: 'invalidated'; reason: AutoReason }

/**
 * 目前**有执行器**的动作（W3-A）。
 * ★ 不在名单里的动作在建请求时就 400 —— 先落一条永远批不动的 `pending` 是死胡同，
 *   而\"看起来提交成功\"比\"明确不支持\"更伤（用户会等一个永远不会来的批准）。
 */
const EXECUTABLE_ACTIONS = ['redeem'] as const

function assertExecutable(action: ActionType): void {
  if (!(EXECUTABLE_ACTIONS as readonly string[]).includes(action)) {
    throw new BadRequestException({
      code: 'APPROVAL_ACTION_NOT_EXECUTABLE',
      message:
        `动作 ${action} 还没有执行器（W3-A 只落地 redeem 兑换）。` +
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
    status: row.status,
    decidedByUserId: row.decidedByUserId,
    executedRecordId: row.executedRecordId,
    autoReason: row.autoReason
  }
}

/** 写入 `payload` 列的形状（`InputJsonObject` 不接受无索引签名的 interface）。 */
function jsonOf(payload: RedeemPayload): Prisma.InputJsonObject {
  return {
    wishId: payload.wishId,
    titleSnapshot: payload.titleSnapshot,
    costSnapshot: payload.costSnapshot
  }
}

/** 读 `payload` 列：**逐字段**校验（枚举外的值 / 缺字段 ⇒ 500，不猜）。 */
function parseRedeemPayload(payload: Prisma.JsonValue): RedeemPayload {
  const bad = (): never => {
    throw new InternalServerErrorException({
      code: 'INVALID_APPROVAL_PAYLOAD',
      message:
        '审批 payload 形状不对（应含 wishId / titleSnapshot / costSnapshot）—— ' +
        '这是库里的坏数据，拒绝据此扣分（那会造出一笔解释不清的流水）。'
    })
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return bad()
  const record = payload as Record<string, Prisma.JsonValue>
  const { wishId, titleSnapshot, costSnapshot } = record
  if (
    typeof wishId !== 'string' ||
    wishId === '' ||
    typeof titleSnapshot !== 'string' ||
    titleSnapshot === '' ||
    typeof costSnapshot !== 'number' ||
    !Number.isInteger(costSnapshot) ||
    costSnapshot <= 0
  ) {
    return bad()
  }
  return { wishId, titleSnapshot, costSnapshot }
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


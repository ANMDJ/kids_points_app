import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common'

import {
  AUDIT_ACTION_SELF_APPROVED,
  canDecide,
  canReview,
  decideRequestOutcome,
  isSelfApproved,
  withdrawDenial
} from '../contracts/approval-policy'
import { resolveVerdict } from '../contracts/permission-matrix'
import type { Actor } from '../permissions/actor'
import { decodeApprovalCursor } from './approval.cursor'
import { toInboxPage, type ApprovalInboxPageDto } from './approval-inbox.mapper'
import {
  APPROVALS_REPOSITORY,
  type ApprovalRow,
  type ApprovalsPort
} from './approvals.repository'
import type { CreateApprovalRequestDto } from './dto/create-approval-request.dto'
import type { DecideApprovalRequestDto } from './dto/decide-approval-request.dto'
import type { ListApprovalsQueryDto } from './dto/list-approvals.query'

/** 收件箱默认每页条数（`ListApprovalsQueryDto` 的上界是 100）。 */
const DEFAULT_PAGE_SIZE = 20

/** service 的返回：状态码由判定结果决定（202 待批 / 201 自批已执行），故显式带出来。 */
export interface ServiceResult {
  statusCode: number
  body: unknown
}

/** 响应体（只暴露契约需要的字段；不把整行 Prisma 记录漏给客户端）。 */
function toBody(row: ApprovalRow): Record<string, unknown> {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    requesterUserId: row.requesterUserId,
    decidedByUserId: row.decidedByUserId,
    executedRecordId: row.executedRecordId,
    // `02` §4.2：`invalidated` 必须能说出**是哪条前提消失了**，否则 UI 只能写
    // 「审批无效」，与「家长拒绝」长得一样（家长莫名背锅）。其余状态恒为 null。
    autoReason: row.autoReason ?? null
  }
}

/**
 * 审批的**唯一业务装配点** —— 「谁可以批准」的判定**全部**来自
 * `src/contracts/approval-policy.ts`（`02` §4.5「唯一实现点」）。
 *
 * ★ 本文件**不许**出现任何 `role === 'guardian'` / `role !== 'child'` 这类判定：
 *   一旦出现，就等于在矩阵之外开了第二处权限定义 —— 两份真相必然漂移（§2 / D9 的教训）。
 *   `approvals-http.test.ts` 里有一条用例专门钉住这一点（把矩阵的行改掉，本文件的
 *   行为必须跟着变；否则说明判定被抄了一份）。
 *
 * ⚠️ 诚实标注（2026-10-18，W3-A / W3-B）：`ApprovalsPort` 在**有库时**是
 *   `PrismaApprovalsRepository`（同事务写流水/余额/审计）；**无库时**仍是显式 501。
 *   本文件只产出「应当是什么结果」与「谁有资格做」，**不做任何持久化**。
 */
@Injectable()
export class ApprovalsService {
  // 显式 `@Inject`：**不依赖 `emitDecoratorMetadata`**。
  // 这既让 tsx / esbuild 这类不产出 metadata 的加载器不至于静默注入失败，
  // 也让令牌改名时编译期就能发现（字符串令牌写错是运行时才炸）。
  constructor(@Inject(APPROVALS_REPOSITORY) private readonly port: ApprovalsPort) {}

  /**
   * `GET /approvals` —— 家长收件箱（W5-D）。
   *
   * ── 权限为什么不在本方法里判 ────────────────────────────────────────────────
   *   端点挂的是 `@RequireAction('review_approvals')`（guardian ALLOW / child DENY），
   *   判定由 `PermissionsGuard` 消费矩阵完成。在这里再写一次 `actor.role === 'guardian'`
   *   就等于开了第二处权限定义 —— 与本文件头注释的硬约束冲突。
   *   因此本方法只拿到 `childId`（屏障一的结论），不接收 actor。
   *
   * ── 为什么「孩子能不能看自己的申请」不在这个端点 ────────────────────────────
   *   本端点回答「**待我批准**的申请」，这是家长视图；孩子查自己的申请是另一个
   *   语义（且需要 `requesterUserId = 本人` 的收口）。混在一起会让「孩子看到全家的
   *   审批」成为一次参数失误。孩子的视图是 `GET /approvals/mine`（W5-J），
   *   见 [listMine]。
   *
   * ★ 游标解析放在 service（而不是 DTO）：DTO 只管形状，语义错误要能带
   *   `INVALID_APPROVAL_CURSOR` 这个**可分辨**的 code。
   */
  async list(query: ListApprovalsQueryDto, childId: string): Promise<ApprovalInboxPageDto> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE
    const cursor = query.cursor === undefined ? undefined : decodeApprovalCursor(query.cursor)
    const rows = await this.port.listForChild({
      childId,
      status: query.status,
      limit,
      cursor
    })
    return toInboxPage(rows, limit)
  }

  /**
   * `GET /approvals/mine` —— **我提交的**申请（W5-J）。
   *
   * ── 为什么需要它 ────────────────────────────────────────────────────────────
   *   孩子提交「兑换 / 加分 / 新增心愿」后，之前只能看到那一次 POST 的返回体；
   *   一旦离开页面（或重启小程序），就再也找不到自己提过什么，更没法撤回。
   *   家长收件箱 (`GET /approvals`) 对孩子是 403（`review_approvals` = DENY），
   *   所以这不是「少一个按钮」，而是**没有读路径**。
   *
   * ── 收口条件 ────────────────────────────────────────────────────────────────
   *   `childId`（屏障一）＋ `requesterUserId`（**会话里的 actor**，不是 query）。
   *   两个条件同时进 WHERE；任何人都不可能通过改参数看到别人提了什么。
   *
   * ── 为什么权限不复用 `review_approvals` ──────────────────────────────────────
   *   那个动作的 child 是 DENY，而且语义是「批准」。本端点用
   *   `view_own_approvals`（两个角色 ALLOW），判定仍只来自矩阵。
   */
  async listMine(
    query: ListApprovalsQueryDto,
    actor: Actor,
    childId: string
  ): Promise<ApprovalInboxPageDto> {
    const limit = query.limit ?? DEFAULT_PAGE_SIZE
    const cursor = query.cursor === undefined ? undefined : decodeApprovalCursor(query.cursor)
    const rows = await this.port.listForRequester({
      childId,
      requesterUserId: actor.userId,
      status: query.status,
      limit,
      cursor
    })
    return toInboxPage(rows, limit)
  }

  /**
   * `POST /approvals` —— 建一条审批请求（`02` §9.3 / §9.25 / §9.26 / §9.27）。
   *
   * `childId` 来自**屏障一**（`MembershipGuard` 验过的 `x-kp-child-id`），
   * **不来自请求体** —— 审批必须挂在"校验过的那个孩子"上，否则会出现
   * 「权限校验的是 A、落库挂到 B」的越权（见 `CreateApprovalInput.childId`）。
   */
  async createRequest(
    dto: CreateApprovalRequestDto,
    actor: Actor,
    childId: string
  ): Promise<ServiceResult> {
    /**
     * ★ 先看**目标动作**在矩阵里的判定：`DENY` 的动作**连申请都不许提**。
     *
     * 为什么这层不能省：`POST /approvals` 的屏障二只验 `request_approval`
     * （两个角色都是 ALLOW），而 `dto.action` 是任意 25 个动作之一。
     * 不查目标动作，孩子就能「为 `add_rule` 提一条审批」并让家长批准 ——
     * 矩阵的 `add_rule.child = DENY` 被绕过了。判定仍只来自矩阵（不新增名单）。
     */
    if (resolveVerdict(dto.action, actor.role) === 'DENY') {
      throw new ForbiddenException({
        code: 'ACTION_NOT_ALLOWED',
        message:
          `角色 ${actor.role} 不能发起动作 ${dto.action}（矩阵 DENY）—— ` +
          '更不能把它包装成一条审批请求。'
      })
    }

    const outcome = decideRequestOutcome({
      action: dto.action,
      requesterRole: actor.role,
      autoApprove: dto.autoApprove
    })

    /**
     * 端口入参在**分支之前**拼一次：两个分支（pending / self-approved）必须拿到
     * **同一份**快照参数，否则「勾选自动审批」与「两步确认」会落出两种 payload。
     * ★ 这里只搬运形状；「哪些参数对哪个动作有效」由端口判定（`snapshotPayload`）。
     */
    const input = {
      childId,
      action: dto.action,
      targetId: dto.targetId,
      requesterUserId: actor.userId,
      requesterRole: actor.role,
      amount: dto.amount,
      reason: dto.reason,
      ruleId: dto.ruleId,
      habitId: dto.habitId,
      title: dto.title,
      cost: dto.cost,
      emoji: dto.emoji
    }

    switch (outcome.kind) {
      case 'REJECTED':
        // ★ 硬约束 4：显式要求自批却没资格 → **400 并点名**。
        //   绝不静默降级成 `pending`：那会让客户端以为已批，而库里那条没人看见。
        //   注意这里**在落库之前**就返回 —— 拒掉的请求不产生任何行（用例断言 port 未被调用）。
        throw new BadRequestException({
          code: outcome.code,
          message:
            `动作 ${dto.action} 对角色 ${actor.role} 不允许自批（02 §4.5 硬约束 2/4）：` +
            '自批资格 = 该动作需要审批 且 该角色具备批准资格（矩阵 review_approvals = ALLOW）。'
        })

      case 'PENDING': {
        const row = await this.port.createPending(input)
        this.assertTerminalWithoutExecution(row)
        return { statusCode: HttpStatus.ACCEPTED, body: toBody(row) }
      }

      case 'SELF_APPROVED': {
        // ★ 硬约束 5：与「他人批准」**同一套**执行路径（端口承诺同一事务 + 同一流水）。
        const row = await this.port.createSelfApproved(input)
        // 自批也要面对「前提在落库那一刻已经消失」：端口会落成 `invalidated`
        // （积分不足等），这里必须 409 而不是回 201 —— 回 201 等于谎报"已兑换"。
        this.assertTerminalWithoutExecution(row)
        return {
          statusCode: HttpStatus.CREATED,
          body: {
            ...toBody(row),
            // ★ 硬约束 6：审计可辨 —— 判据是「批准人 == 申请人」，不新增字段。
            selfApproved: isSelfApproved(row),
            auditAction: isSelfApproved(row) ? AUDIT_ACTION_SELF_APPROVED : null
          }
        }
      }
    }

    // 穷尽性保险：`RequestOutcome` 将来若加分支，这里会编译报错（而不是静默返回 undefined）。
    throw new Error(`未处理的判定结果：${JSON.stringify(outcome)}`)
  }

  /**
   * `POST /approvals/:id/decide` —— 批准 / 拒绝（两步式自批也走这里，§4.4 / §4.5）。
   *
   * `childId` 来自**屏障一**验过的会话上下文：审批属于哪个孩子是**键的一半**，
   * 不是事后过滤。跨孩子的 id 与「不存在」返回同一个 404（W3-B）。
   */
  async decide(
    id: string,
    dto: DecideApprovalRequestDto,
    actor: Actor,
    childId: string
  ): Promise<ServiceResult> {
    const row = await this.port.findById(id, childId)
    if (row === null) {
      throw new NotFoundException({ code: 'APPROVAL_NOT_FOUND', message: `没有这条审批请求：${id}` })
    }

    if (!canDecide(row, actor.role)) {
      // 分开两种原因（都是 `canDecide` 为 false，但客户端要的处置完全不同）：
      //   · 没批准资格 → 403（孩子 / viewer 不该走到这里）
      //   · 已决 / 非法态 → 409（双击「同意」的第二次，§4.4 乐观锁口径 / §9.10）
      if (!canReview(actor.role)) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: `角色 ${actor.role} 没有批准资格（矩阵 review_approvals）。`
        })
      }
      // ★ 先判角色，再判过期：没资格的人不该因为“这条过期了”而得到 409。
      this.assertNotExpired(row)
      throw new ConflictException({
        code: 'ALREADY_DECIDED',
        message: `这条审批已是终态：${row.status}（02 §4.4 乐观锁只认 status = 'pending'）。`
      })
    }

    const decided = await this.port.decide({
      id,
      childId,
      outcome: dto.decision,
      decidedByUserId: actor.userId,
      decidedByRole: actor.role
    })
    this.assertTerminalWithoutExecution(decided)
    const selfApproved = isSelfApproved(decided)
    return {
      statusCode: HttpStatus.OK,
      body: {
        ...toBody(decided),
        selfApproved,
        auditAction: selfApproved ? AUDIT_ACTION_SELF_APPROVED : null
      }
    }
  }

  /**
   * `POST /approvals/:id/withdraw` —— 申请人撤回（`02` §4.1 的 `withdrawn` 终态）。
   *
   * ── 三条不能被「宽松实现」掉的语义 ────────────────────────────────────────
   *   ① **只有申请人本人**：另一位 guardian 也不能替孩子撤回（那是「拒绝」，有它自己的语义）；
   *      非本人一律 403 `NOT_REQUESTER`，且**不**顺带告诉他这条是否已批（存在性也是信息）。
   *   ② **只有 `pending`**：已批准/已拒绝/已撤回 ⇒ 409 `ALREADY_DECIDED`（§9.7）。
   *   ③ **不写账本**：撤回是「取消申请」，不是「冲正」——余额与流水必须一动不动；
   *      批准后想撤销属于另一条路径（§4.1 没有 `approved → withdrawn`）。
   *
   * 判定只在 `withdrawDenial()`（service 与端口消费同一份）；TTL 惰性过期由端口完成，
   * 它返回 `expired` 行时这里翻成 409 `APPROVAL_EXPIRED`（与 decide 同一口径）。
   */
  async withdraw(id: string, actor: Actor, childId: string): Promise<ServiceResult> {
    const row = await this.port.findById(id, childId)
    if (row === null) {
      throw new NotFoundException({ code: 'APPROVAL_NOT_FOUND', message: `没有这条审批请求：${id}` })
    }
    this.assertCanWithdraw(row, actor)

    const withdrawn = await this.port.withdraw({
      id,
      childId,
      requesterUserId: actor.userId,
      requesterRole: actor.role
    })
    this.assertTerminalWithoutExecution(withdrawn)
    return { statusCode: HttpStatus.OK, body: toBody(withdrawn) }
  }

  /**
   * `expired` 无论**第一次**判定还是**重试**都必须得到 `APPROVAL_EXPIRED`。
   *
   * 若不先看它，重试会落到「状态不是 pending」分支 → `ALREADY_DECIDED` ——
   * 同一个事实两种错误码，客户端没法统一提示「过期了，重提一条吧」。
   */
  private assertNotExpired(row: ApprovalRow): void {
    if (row.status !== 'expired') return
    throw new ConflictException({
      code: 'APPROVAL_EXPIRED',
      message: '这条审批已超过有效期（02 §4.3 的 72h TTL），不能再批准、拒绝或撤回。',
      approvalId: row.id,
      status: row.status
    })
  }

  /** 撤回判定的 HTTP 映射（原因来自 `withdrawDenial()`，本文件不另写一套条件）。 */
  private assertCanWithdraw(row: ApprovalRow, actor: Actor): void {
    switch (withdrawDenial(row, actor)) {
      case null:
        return
      case 'WITHDRAW_FORBIDDEN_ROLE':
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: `角色 ${actor.role} 没有撤回资格（矩阵 withdraw_request）。`
        })
      case 'NOT_REQUESTER':
        throw new ForbiddenException({
          code: 'NOT_REQUESTER',
          message:
            '只有申请人本人可以撤回这条审批。' +
            '★ 另一位家长想表达不同意请用 decide(rejected) —— 两种语义不能混（02 §4.2）。'
        })
      case 'ALREADY_DECIDED':
        // 先区分“过期”与“别的终态”：同一个 409，code 不同（客户端要给不同提示）。
        this.assertNotExpired(row)
        throw new ConflictException({
          code: 'ALREADY_DECIDED',
          message: `这条审批已是终态：${row.status}，不能再撤回（02 §4.4 只认 status = 'pending'）。`
        })
    }
  }

  /**
   * 把「**已提交但没执行**」的终态翻成 409。
   *
   * ── 为什么由 service 翻，而不是端口自己抛（这条别改回去）──────────────────
   *   `invalidated` / `expired` 是**要留下的历史**：家长点「同意」时心愿已被删，
   *   这条请求必须永远显示「因心愿已删而无效」，而不是保持 `pending` 等人再点一次。
   *   若端口在事务里 `throw`，事务会回滚 —— 那条 `invalidated` 就没了，客户端下次
   *   重试还会看到 `pending`（死循环）。所以端口**先提交终态、再把行返回**，
   *   由这一层翻成 HTTP 409。判据只看状态，不重复业务判定（§4.2 / §4.4）。
   */
  private assertTerminalWithoutExecution(row: ApprovalRow): void {
    if (row.status === 'invalidated') {
      throw new ConflictException({
        code: 'APPROVAL_INVALIDATED',
        message:
          `这条审批的前提已消失（${row.autoReason ?? 'unknown'}），请求已置为 invalidated —— ` +
          '不是被谁拒绝，请不要重试（02 §4.2）。',
        approvalId: row.id,
        status: row.status,
        autoReason: row.autoReason ?? null
      })
    }
    if (row.status === 'expired') {
      throw new ConflictException({
        code: 'APPROVAL_EXPIRED',
        message: `这条审批已超过有效期（02 §4.3 的 72h TTL），不能再批准、拒绝或撤回。`,
        approvalId: row.id,
        status: row.status
      })
    }
  }
}

import { Injectable, NotImplementedException } from '@nestjs/common'

import type { ActionType, Role } from '../contracts/permission-matrix'

/**
 * 审批的**持久化端口**（端口 / 适配器里的「端口」）。
 *
 * ── 为什么要有这一层（而不是让 service 直接拿 PrismaService）──────────────
 *   ① `02` §4.5 硬约束 5 要求「自批与**他人批准**走同一套重校验 ＋ 同一事务 ＋ 同一流水」
 *      —— 这件事只有**知道事务的人**能做，故把它收成一个明确的端口方法
 *      （`createSelfApproved` 承诺的就是「同一事务」，而不是调用方自己拼两步）；
 *   ② 端口的默认实现是**显式 501**（见文件末尾）：W1 之前它**不许**假装成功。
 *      这样「审批写入还没落地」是一个**可执行断言**，而不是注释里的一句话。
 *
 * ⚠️ 目前的真实状态（W3-A / W3-B，2026-10-18）：**有库时**由 `PrismaApprovalsRepository`
 *    实现（同事务写 `ApprovalRequest` + `PointRecord` + 余额 + `AuditLog`；撤回只改状态）；
 *    本类只用于**无库装配**（`npm test` / 未配 DATABASE_URL 的进程）—— 显式 501，
 *    绝不假装写入成功。判据只有一处：`prisma/database-enabled.ts` 的 `hasDatabaseUrl()`。
 *
 * ★ **每个读写都带 `childId`**（W3-B）：这条审批属于哪个孩子是**键的一半**，
 *   不是事后过滤器。跨孩子的 id 一律按「不存在」回答（404），绝不泄露另一家的审批存在。
 */

/** Nest 注入令牌（用 unique symbol 避免字符串撞名）。 */
export const APPROVALS_REPOSITORY = Symbol('APPROVALS_REPOSITORY')

/** 一条审批请求的**读模型**（只含策略与响应需要的字段，不假装是完整 Prisma 模型）。 */
export interface ApprovalRow {
  id: string
  /**
   * 这条审批**属于哪个孩子**（`ApprovalRequest.childId`）。
   * ★ 它是**键的一半**（W3-B）：读 / 决 / 撤回都必须拿它与会话里的 `x-kp-child-id` 对齐；
   *   跨孩子一律返回「不存在」，否则一家家长能批另一家的账。
   */
  childId: string
  action: ActionType
  requesterUserId: string
  /** `pending` / `approved` / `rejected` / `withdrawn` / `invalidated` / `expired`（§4.1）。 */
  status: string
  /** 未决时 `null` —— `isSelfApproved()` 的输入（自批 = 与 `requesterUserId` 相等）。 */
  decidedByUserId: string | null
  /** 批准执行后产生的账本记录（`02` §4.3 的 `executedRecordId`，单向表达）。 */
  executedRecordId: string | null
  /**
   * 仅 `invalidated` 时有值（`02` §4.2）：**前提消失**的系统理由。
   * 与 `rejected`（人的决定）必须分得开 —— UI 上「家长不同意」与「心愿已被删」
   * 是两句完全不同的话，混在一起家长就\"莫名其妙背锅\"。
   * 可选出现在的端口里：W2 的读模型没有它，W3 的真实现有。
   */
  autoReason?: string | null
}

/** 建请求的入参（**只含**落库需要的字段）。 */
export interface CreateApprovalInput {
  /**
   * 这条审批**属于哪个孩子**（屏障一的结论，**不是**请求体里的值）。
   *
   * ★ 为什么必须由上层传下来：`ApprovalRequest.childId` 是外键，而端口只拿到
   *   身份（`requesterUserId`）。让孩子 id 由适配器\"猜\"（比如从 targetId 反查）
   *   会在\"心愿属于另一个孩子\"时把请求挂错人 —— 权限校验过的是 A 孩子，
   *   落库却挂到 B 孩子，是最糟的一类越权。所以判据只在上层（`x-kp-child-id`
   *   经屏障一），这里原样落库。
   */
  childId: string
  action: ActionType
  targetId?: string
  requesterUserId: string
  requesterRole: Role | 'viewer'

  /* ── 动作参数（W3-C）────────────────────────────────────────────────
   * 这些字段是「**建请求时**」的输入，端口负责在**同一事务**里把它们快照进
   * `ApprovalRequest.payload`。哪些字段对哪个动作有效，由 `snapshotPayload()` 判定
   * （多余字段 ⇒ 400 `APPROVAL_PARAM_NOT_APPLICABLE`，不静默忽略）。
   */

  /** `request_points_bonus`：申请加分的金额（恒为正，单笔 ≤ 50）。 */
  amount?: number
  /** `request_points_bonus`：加分事由。 */
  reason?: string
  /** `request_points_bonus`：依据的规则（可选；批准时复查）。 */
  ruleId?: string
  /** `request_points_bonus`：依据的习惯（可选；批准时复查）。 */
  habitId?: string
  /** `add_wish`：心愿标题。 */
  title?: string
  /** `add_wish`：兑换成本。 */
  cost?: number
  /** `add_wish`：表情。 */
  emoji?: string
}

export interface DecideApprovalInput {
  id: string
  /** 会话里的孩子上下文（屏障一验过）—— 与行上的 `childId` 不等 ⇒ 按不存在处理。 */
  childId: string
  outcome: 'approved' | 'rejected'
  decidedByUserId: string
  /**
   * 批准人的**会话角色**（身份层给的，不是请求头报的）。
   * ★ 为什么要传：`PointRecord.operatorRole` 必须记\"真实操作人\"（A4）——
   *   端口自己去 `ChildMember` 再查一遍会多一份真相，而两份迟早不一致。
   */
  decidedByRole: Role | 'viewer'
}

/**
 * 撤回（`02` §4.1 的 `withdrawn`）的入参。
 *
 * ★ 申请人身份与孩子上下文都由上层传下来：端口**不猜**「谁在撤回」——
 *   它只负责在**行锁下**再验一遍（与 service 消费同一个 `withdrawDenial()`）。
 */
export interface WithdrawApprovalInput {
  id: string
  childId: string
  requesterUserId: string
  requesterRole: Role | 'viewer'
}

/**
 * 收件箱列表里的**一行**（W5-D）。
 *
 * ★ 为什么单独一个类型、而不是给 `ApprovalRow` 加四个必填字段：
 *   `ApprovalRow` 是 create / decide / withdraw 共用的**判定输入**，那些路径
 *   不需要 `payload` / 时间戳。把它们塞进去会让 `approvals-http.test.ts` 的
 *   内存替身凭空多出四个字段（它们与判定无关），用例就被迫维护无关噪音。
 *   列表是**读视图**，它需要多几列 —— 用子类型显式说出「多在哪」。
 */
export interface ApprovalListRow extends ApprovalRow {
  /** 动作参数的**快照**（形状由动作决定，见 `approval-payload.ts`）。 */
  payload: unknown
  createdAt: Date
  /** 未决 / 系统终态（`expired`）时为 `null`。 */
  decidedAt: Date | null
  expiresAt: Date
}

/** `GET /approvals` 的状态筛选值（`all` = 不筛）。 */
export const APPROVAL_STATUS_FILTERS = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
  'invalidated',
  'expired',
  'all'
] as const

export type ApprovalStatusFilter = (typeof APPROVAL_STATUS_FILTERS)[number]

/** 列表入参。`childId` 仍来自**会话**（屏障一的结论），不是 query。 */
export interface ListApprovalsInput {
  childId: string
  /** 省略 = `pending`（收件箱的默认视图就是「待我处理」）。 */
  status?: ApprovalStatusFilter
  /** 1..200；适配器返回**至多 `limit + 1`** 行，多出的那行只用于判断 `hasMore`。 */
  limit: number
  /** 上一页最后一行的位置（`nextCursor` 解码后）。 */
  cursor?: { createdAt: Date; id: string }
}

/**
 * 「我的申请」列表入参（W5-J）。
 *
 * ★ `requesterUserId` **只来自会话**（`actor.userId`），绝不是 query 参数：
 *   允许客户端传一个 user id 就等于开放「看别人提了什么」的接口。
 *   适配器把它和 `childId` **一起**放进 WHERE —— 两道收口缺一不可。
 */
export interface ListMyApprovalsInput extends ListApprovalsInput {
  requesterUserId: string
}

export interface ApprovalsPort {
  /** 建一条 `pending`，**不执行**任何业务（等家庭里另一位 guardian 来批，或本人二次确认）。 */
  createPending(input: CreateApprovalInput): Promise<ApprovalRow>

  /**
   * 建请求 + **同一事务内**直接批准（`02` §4.5 形态②）。
   * 落库后 `decidedByUserId === requesterUserId`（自批的唯一判据，不新增字段）。
   */
  createSelfApproved(input: CreateApprovalInput): Promise<ApprovalRow>

  /**
   * 取一条（未找到返回 `null`，**不抛异常** —— 「没有这条」是正常分支，404 由上层决定）。
   * ★ `childId` 是**查询条件**（W3-B）：另一家的审批与「不存在」必须长得一模一样。
   */
  findById(id: string, childId: string): Promise<ApprovalRow | null>

  /**
   * 收件箱列表（W5-D）：按 `(createdAt desc, id desc)` 键集翻页。
   *
   * ★ 为什么 `childId` 是**查询条件**而不是事后过滤：与 `findById` 同一条理由
   *   （W3-B）—— 列表是最容易「顺手把别家数据带出来」的地方。
   * ★ `status` 省略 ⇒ `pending`；`all` ⇒ 不筛。
   */
  listForChild(input: ListApprovalsInput): Promise<ApprovalListRow[]>

  /**
   * 「我的申请」（W5-J）：同一个孩子内，进一步按**申请人**收口。
   *
   * ★ 为什么单独一个端口方法，而不是给 `listForChild` 加一个可选 userId：
   *   可选参数意味着「忘了传」会静默退化成「全家的申请」—— 这正是最不该
   *   靠自觉的边界。方法名把语义钉死，类型也要求 `requesterUserId` 必填。
   */
  listForRequester(input: ListMyApprovalsInput): Promise<ApprovalListRow[]>

  /**
   * 批准 / 拒绝，**乐观锁**：`UPDATE … WHERE id = ? AND childId = ? AND status = 'pending'`（§4.4）。
   * 未命中（已被决过 / 已过期 / 不是这个孩子）⇒ 409 或 404，**绝不覆盖**终端态。
   */
  decide(input: DecideApprovalInput): Promise<ApprovalRow>

  /**
   * 申请人撤回（`02` §4.1）：`pending → withdrawn`，**不写流水、不动余额**。
   * 只有申请人本人可撤回；已终态 ⇒ 409；TTL 已过 ⇒ 先惰性置 `expired` 再 409。
   */
  withdraw(input: WithdrawApprovalInput): Promise<ApprovalRow>

  /**
   * TTL 扫描（`02` §4.3）：把 `pending` 且 `expiresAt <= now` 的行批量置为 `expired`。
   *
   * ★ 返回「本次真正改了几行」，供后台任务日志与用例断言。
   *   实现必须用**单条条件 UPDATE**（或 `FOR UPDATE SKIP LOCKED`）抢过期权，
   *   并发扫描/惰性过期只有一个赢家，审计不会重复。
   */
  expireDue(now: Date, limit?: number): Promise<number>
}

/**
 * 默认实现：**一律 501**。
 *
 * 这不是占位符里最省事的写法，而是**刻意的 fail-closed**：
 * 若这里返回任何编造的成功响应，客户端会以为兑换已经批了，而库里什么都没有 ——
 * 那正是本仓库最不能接受的「假绿」。501 让「写入路径未落地」**响亮可见**。
 */
@Injectable()
export class NotImplementedApprovalsRepository implements ApprovalsPort {
  private fail(method: keyof ApprovalsPort): never {
    throw new NotImplementedException({
      code: 'APPROVALS_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        `审批写入路径在本装配里不可用（无数据库）：${String(method)} 没有实现。` +
        '无库时一律 501（fail-closed），绝不返回编造的成功响应。' +
        '有 DATABASE_URL 的进程走 PrismaApprovalsRepository（同事务写流水 + 审计）。'
    })
  }

  createPending(input: CreateApprovalInput): Promise<ApprovalRow> {
    void input
    return Promise.resolve(this.fail('createPending'))
  }

  createSelfApproved(input: CreateApprovalInput): Promise<ApprovalRow> {
    void input
    return Promise.resolve(this.fail('createSelfApproved'))
  }

  findById(id: string, childId: string): Promise<ApprovalRow | null> {
    void id
    void childId
    return Promise.resolve(this.fail('findById'))
  }

  listForChild(input: ListApprovalsInput): Promise<ApprovalListRow[]> {
    void input
    return Promise.resolve(this.fail('listForChild'))
  }

  listForRequester(input: ListMyApprovalsInput): Promise<ApprovalListRow[]> {
    void input
    return Promise.resolve(this.fail('listForRequester'))
  }

  decide(input: DecideApprovalInput): Promise<ApprovalRow> {
    void input
    return Promise.resolve(this.fail('decide'))
  }

  withdraw(input: WithdrawApprovalInput): Promise<ApprovalRow> {
    void input
    return Promise.resolve(this.fail('withdraw'))
  }

  expireDue(now: Date, limit?: number): Promise<number> {
    void now
    void limit
    return Promise.resolve(this.fail('expireDue'))
  }
}

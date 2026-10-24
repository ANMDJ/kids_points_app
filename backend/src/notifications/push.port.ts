import type { ActionType } from '../contracts/permission-matrix'

/**
 * 推送端口的注入令牌（`unique symbol`，与 `APPROVALS_REPOSITORY` 同一手法）。
 *
 * ★ 这是一条**渠道无关**的预留接口（W5-K，2026-10-23）：
 *   审批业务只认识「发一条消息」，不认识微信订阅消息 / APNs / FCM / 个推。
 *   接第三方时新增一个实现本端口的 adapter，在 `NotificationsModule` 里换绑即可，
 *   **审批 service / controller / 账本事务一行都不用改**。
 *
 * ⚠️ 诚实边界：本端口**默认是 no-op**（`NoopPushAdapter`），
 *   所以「有端口」不等于「能收到推送」——
 *   W6-A（2026-10-24）补上了其中的第 ② 项：设备 token 有了写入口
 *   （`POST /device-tokens`）与真实适配器 `WebhookPushAdapter`（配置
 *   `PUSH_WEBHOOK_URL` 后生效）。仍然缺的是第 ① 项：
 *   **APNs / FCM / 微信订阅消息的凭据与签名**都没有，所以「配好网关」之前，
 *   线上仍是一条 `provider_not_configured`。
 */
export const PUSH_PORT = Symbol('PUSH_PORT')

/**
 * **原始发送端口**（W6-B，2026-10-24）：只发一次，失败不重试。
 *
 * ── 两个令牌，两种语义 ────────────────────────────────────────────────────
 *   `PUSH_PORT`          业务入口（`NotificationsService`）：发一次 + 失败**入队**
 *   `PUSH_DELIVERY_PORT` worker 入口：只发一次，失败由 worker 自己结算
 *
 * ★ 为什么不让 worker 也用 `PUSH_PORT`：那会在每次重试失败时再入一次队
 *   （唯一约束会挡住，但它同时会刷新 `lastAttempt` 相关计数，且让「谁负责重试」
 *   变成两个地方）。职责分开之后，「入队」只发生在业务路径，「结算」只发生在 worker。
 */
export const PUSH_DELIVERY_PORT = Symbol('PUSH_DELIVERY_PORT')

/**
 * 单次推送适配器调用的等待上限（毫秒）。
 *
 * ★ 调用方（`NotificationsService`）与 worker 共用同一个数字：
 *   两处若各写一个，「业务路径 1s、重试路径 10s」这种漂移会让同一条推送
 *   在两条路径上表现不同，而排查时只会看到「有时很快失败、有时很慢」。
 *   它必须**大于** `PUSH_WEBHOOK_TIMEOUT_MS`（默认 800ms），否则适配器还没超时
 *   就已被上层判死，网关上真正发生了什么永远不会被记录。
 */
export const PUSH_SEND_TIMEOUT_MS = 1000

/** 审批结论（只推「人做出的判定」；`expired` / `invalidated` 是系统判定，暂不推）。 */
export type ApprovalPushStatus = 'approved' | 'rejected'

/**
 * 「审批结论变了」的推送消息。
 *
 * 字段只带**收件人与判定所需的最小信息**：
 *   · 不把 `payload`（心愿标题 / 加分理由）塞进来 —— 第三方推送通道会留存内容，
 *     而通知栏只需要「去 App 看」。要展示摘要时由客户端拉服务端。
 *   · `recipientUserId` 恒为**申请人**：家长批准 / 拒绝孩子的申请后，孩子需要知道结果。
 *     申请人自批（创建时 `autoApprove`）不推送 —— 自己批准自己，推给自己是噪音。
 */
export interface ApprovalStatusChangedPush {
  readonly type: 'approval.status_changed'
  readonly approvalId: string
  readonly childId: string
  /** 收件人：申请人（`ApprovalRequest.requesterUserId`）。 */
  readonly recipientUserId: string
  readonly action: ActionType
  readonly status: ApprovalPushStatus
  readonly decidedByUserId: string | null
  /** 发出时刻（ISO 8601）。审批行上没有 `decidedAt` 读数，故取通知层的时刻。 */
  readonly occurredAt: string
}

/**
 * 「有新申请待确认」的推送消息（W5-M，2026-10-23）。
 *
 * ── 为什么收件人是**家长列表**而不是单个 id ────────────────────────────────
 *   审批的收件人取决于「谁提的」：孩子提交 ⇒ 这个孩子的每一位 active 家长；
 *   家长自己提交（需另一位家长确认）⇒ **除他以外**的家长。
 *   所以 `ApprovalSubmittedPush` 仍然是**单收件人**形状（渠道层只认一个人），
 *   由 `NotificationsService` 解析成员位后**每人一条**。
 *
 * ── 与 `ApprovalStatusChangedPush` 的对称性 ───────────────────────────────
 *   两者都只在 `childId` 内、只带跳转所需的 id；都不带金额 / 标题 / 理由。
 *   区别只有一个：`recipientUserId` 的**来源**（申请人 vs 家长集合）。
 */
export interface ApprovalSubmittedPush {
  readonly type: 'approval.submitted'
  readonly approvalId: string
  readonly childId: string
  /** 收件人：一位 active 家长（`ChildMember.role = 'guardian'`）。 */
  readonly recipientUserId: string
  readonly action: ActionType
  /** 提交人（`ApprovalRequest.requesterUserId`）；与收件人**必然不同**。 */
  readonly submittedByUserId: string
  /** 提交时刻（ISO 8601）。审批行没有 `createdAt` 的端口读数，故取通知层时刻。 */
  readonly occurredAt: string
}

/**
 * `ApprovalsService.createRequest()` 交给通知层的**事件**（W5-M）。
 *
 * ★ 这里没有 `recipientUserId`：谁该收到「待确认」是**家庭结构**的事实
 *   （成员位），不是审批行上的字段。让审批 service 自己查成员位会在
 *   `ApprovalsModule` 里再复制一份「谁是家长」的查询；交给通知层则只有一处。
 */
export interface ApprovalSubmittedEvent {
  readonly approvalId: string
  readonly childId: string
  /** 提交人：**排除**在收件人之外（自己不需要被提醒自己提过）。 */
  readonly requesterUserId: string
  readonly action: ActionType
  readonly occurredAt: string
}

/** 审批相关的两种推送；后续通知类型在此扩展。 */
export type PushMessage = ApprovalStatusChangedPush | ApprovalSubmittedPush

/**
 * 判别式守卫：渠道适配器拿到 `PushMessage` 时必须先分清是哪一种，
 * 否则会在另一种消息上读不存在的字段（TS 会拦住，但运行时日志里只有 `undefined`）。
 * 用例里也用它代替 `as`：`as` 会把「类型写错」变成一条永远绿的行。
 */
export function isApprovalStatusChangedPush(
  message: PushMessage
): message is ApprovalStatusChangedPush {
  return message.type === 'approval.status_changed'
}

export function isApprovalSubmittedPush(
  message: PushMessage
): message is ApprovalSubmittedPush {
  return message.type === 'approval.submitted'
}

export type PushFailureReason =
  /** 没有配置任何第三方渠道（当前默认实现的唯一返回）。 */
  | 'provider_not_configured'
  /** 渠道已配置，但这个用户没有任何可用设备 token。 */
  | 'no_device_token'
  /** 渠道调用失败（网络 / 凭据 / 超时）；**不得把异常抛给调用方**。 */
  | 'provider_error'

/**
 * 推送结果。
 *
 * ★ `delivered: false` 是**正常返回值**，不是异常：
 *   推送失败只意味着「晚一点知道」，绝不能回滚一笔已经成立的审批 / 账本写入
 *   （`01` §4 / `02` §9.23）。因此调用方只记录结果，不据此改变业务状态码。
 */
export type PushResult =
  | { readonly delivered: true; readonly providerMessageId: string | null }
  | { readonly delivered: false; readonly reason: PushFailureReason; readonly detail?: string }

/**
 * 推送适配器契约。
 *
 * ★ 实现约束：
 *   ① `send` **必须快速返回**，不得在审批请求里同步等第三方做成「慢但成功」；
 *      `WebhookPushAdapter`（W6-A）是**有界**的例外：单次 HTTP 调用上限 800ms，
 *      且调用方另有 `PUSH_SEND_TIMEOUT_MS`（1s）兜底。**重试**由 W6-B 的
 *      `PushRetryJob` + `PushRetryWorker` 承担（失败入队、指数退避、TTL 上限），
 *      所以 `send` 自己**仍然不许**在请求路径里重试；
 *   ② 任何失败都要么返回 `delivered: false`，要么抛错 —— 两者都会被
 *      `NotificationsService` 兜住并记日志（抛错不会传播到 HTTP 响应）；
 *   ③ 实现**不得**写业务表 / 账本（推送是事务之外的事，`01` §4）。
 */
export interface PushPort {
  send(message: PushMessage): Promise<PushResult>
}

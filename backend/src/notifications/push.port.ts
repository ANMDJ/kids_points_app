import type { ActionType } from '../contracts/permission-matrix'

/**
 * 推送端口的注入令牌（`unique symbol`，与 `APPROVALS_REPOSITORY` 同一手法）。
 *
 * ★ 这是一条**渠道无关**的预留接口（W5-K，2026-10-23）：
 *   审批业务只认识「发一条消息」，不认识微信订阅消息 / APNs / FCM / 个推。
 *   接第三方时新增一个实现本端口的 adapter，在 `NotificationsModule` 里换绑即可，
 *   **审批 service / controller / 账本事务一行都不用改**。
 *
 * ⚠️ 诚实边界：本端口**当前默认是 no-op**（`NoopPushAdapter`），
 *   所以「有端口」不等于「能收到推送」—— 真正触达用户还需要
 *   ① 第三方 SDK 与凭据（L3）、② 设备 token 上报接口（`DeviceToken` 表已存在但无写入）。
 */
export const PUSH_PORT = Symbol('PUSH_PORT')

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

/** 目前只有审批结论一种推送；保留联合类型，后续通知类型在此扩展。 */
export type PushMessage = ApprovalStatusChangedPush

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
 *   ① `send` **必须快速返回**（真实渠道应入队 / 异步投递），不得在审批请求里同步等第三方；
 *   ② 任何失败都要么返回 `delivered: false`，要么抛错 —— 两者都会被
 *      `NotificationsService` 兜住并记日志（抛错不会传播到 HTTP 响应）；
 *   ③ 实现**不得**写业务表 / 账本（推送是事务之外的事，`01` §4）。
 */
export interface PushPort {
  send(message: PushMessage): Promise<PushResult>
}

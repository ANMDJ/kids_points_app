import type { KeysetPosition } from '../common/keyset-cursor'

/**
 * 站内通知的**行 / 契约形状**（W5-L，2026-10-23）。
 *
 * ── 为什么站内通知要单独定形状 ────────────────────────────────────────────
 *   `28-w5k-handoff.md` §5.2 把「先做站内通知」列为最省事的方向：`Notification`
 *   表 W0 就建好了，且**不依赖任何第三方凭据**（L3 未到位）。但表里有 8 列，
 *   直接把它当 HTTP 契约会有两个问题：
 *     ① `payload` 是裸 `Json`，客户端拿到的是一个**没有形状声明**的对象；
 *     ② `recipientUserId` / `recipientRole` 是**收件人标识**，不该出现在响应里
 *        （客户端已经知道\"我是谁\"，下发只会诱导前端自己算权限）。
 *   所以端口只回下面这几个字段，`service` 再把 `Date` 翻成 ISO 串。
 *
 * ── 一条刻意的「不下发结论」────────────────────────────────────────────────
 *   响应里只有 `readAt`，**没有** `isUnread`。未读是一个派生值
 *   （`readAt === null`），两端各算一次比服务端下发两个可能互相矛盾的字段安全
 *   （与 `members.types.ts` 的 `isSelf` 相反：那个只有服务端知道，这个客户端自己就有）。
 */
export interface NotificationRow {
  id: string
  /** 类型标识，如 `approval.approved` / `approval.rejected`（库内原样，不做驼峰化）。 */
  type: string
  title: string
  body: string
  /** 只放**回到对应页面所需的 id**，不放金额 / 心愿标题（`28` §2.6 的理由同样适用于站内）。 */
  payload: unknown
  readAt: Date | null
  createdAt: Date
}

export interface ListNotificationsInput {
  /** 由身份 Guard 从会话解析 —— **绝不**取 query。 */
  childId: string
  /** 收件人 = 会话 actor（**绝不**取 query）：改参数看不到别人的通知。 */
  recipientUserId: string
  /** 1–100，由 DTO 校验；端口必须**如实**限制返回条数。 */
  limit: number
  /** 键集游标：只返回**严格早于**这一行 `(createdAt, id)` 的通知。 */
  before?: KeysetPosition
}

export interface NotificationPageRow {
  rows: NotificationRow[]
  /** 由适配器用 `limit + 1` 判定，**不靠**「本页正好满」猜。 */
  hasMore: boolean
  /** 未读数：与列表**同一次查询**得出（红点不会比列表晚一拍）。 */
  unreadCount: number
}

export interface AppendNotificationInput {
  childId: string
  /** 收件人：审批里恒为申请人（`ApprovalRequest.requesterUserId`）。 */
  recipientUserId: string
  type: string
  title: string
  body: string
  payload?: Record<string, unknown>
}

/**
 * 「标记已读」的结果。
 *
 * ★ `not_found` 与「已读」必须分开：找不到（不存在 / 不是发给我的）是 404，
 *   已经读过是**幂等成功**（回原来的 `readAt`，不写第二次）。
 */
export type MarkNotificationReadResult =
  | { kind: 'ok'; id: string; readAt: Date }
  | { kind: 'not_found' }

export interface NotificationDto {
  id: string
  type: string
  title: string
  body: string
  payload: unknown
  /** 未读 ⇒ null；已读 ⇒ ISO-8601（客户端据此渲染红点 / 灰化）。 */
  readAt: string | null
  createdAt: string
}

export interface NotificationsListResponse {
  items: NotificationDto[]
  /** 原样回传给下一次请求；`null` = 没有下一页。 */
  nextCursor: string | null
  hasMore: boolean
  unreadCount: number
}

export interface MarkNotificationReadResponse {
  id: string
  readAt: string
}

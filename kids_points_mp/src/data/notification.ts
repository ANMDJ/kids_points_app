/**
 * 站内通知的**界面模型**（W5-L）。
 *
 * 与 Flutter `NotificationDto` 同构，但只保留界面真正要画的东西：
 * 线格式里的 `payload` 是不透明夹带，这里把它解成 [NotificationItem.approvalId]
 * —— 页面不必知道「payload 长什么样」，也就不会在两个地方各写一遍解析。
 *
 * 未读**只有一种事实源**：`readAt === null`（服务端下发）。不要引入
 * `unread: boolean` 之类的第二份状态：标记已读后两份状态迟早不一致。
 */
export interface NotificationItem {
  id: string
  /** 类型标识（`approval.approved` / `approval.rejected` …）。**不**枚举：新类型也要能列出来。 */
  type: string
  title: string
  body: string
  /** 点开这条通知要打开的审批 id；不是审批类 / payload 读不懂 ⇒ null。 */
  approvalId: string | null
  /** 未读 ⇒ null；已读 ⇒ 具体时间。 */
  readAt: number | null
  createdAt: number
}

/**
 * `GET /notifications` 的一页（已映射成界面模型）。
 *
 * `unreadCount` 是**整份**未读数（不是本页），红点用它。
 */
export interface NotificationsPage {
  items: NotificationItem[]
  hasMore: boolean
  nextCursor: string | null
  unreadCount: number
}

/** 未读 = 服务端没给 `readAt`。 */
export function isNotificationUnread(item: NotificationItem): boolean {
  return item.readAt === null
}

/**
 * 「有人提交了申请，等你处理」的提醒（`approval.submitted`，W5-M）。
 *
 * 与审批**结论**（`approval.approved` / `approval.rejected`）区分开：两者都带
 * `approvalId`，但一个要去「审批」页答复，一个去「我的申请」看结果 ——
 * 只看 payload 分不出来，必须看 `type`。
 */
export function isApprovalSubmittedNotification(
  item: NotificationItem
): boolean {
  return item.type === 'approval.submitted'
}

/**
 * 从 `payload` 里取 `approvalId`（宽松读取）。
 *
 * payload 为 null / 数组 / 标量、或 `approvalId` 不是非空字符串 ⇒ null。
 * 这里**不抛错**：一条消息的跳转目标读不懂，不该让整页消失。
 */
export function notificationApprovalId(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const value = (payload as Record<string, unknown>).approvalId
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 未读角标文案：0 条返回空串（不画），超过 99 显示 `99+`
 * （三位数会把「消息」两个字挤掉，而具体是 100 还是 900 对用户没差别）。
 */
export function notificationBadgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return ''
  const n = Math.floor(count)
  return n > 99 ? '99+' : `${n}`
}

function two(value: number): string {
  return `${value}`.padStart(2, '0')
}

/**
 * 通知时间按**本地时区**展示（服务端下发 UTC）；精确到分钟就够了 ——
 * 站内消息不用于对账，多一个秒位只会让行更挤。
 */
export function formatNotificationTime(time: number): string {
  const date = new Date(time)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${two(
    date.getHours()
  )}:${two(date.getMinutes())}`
}

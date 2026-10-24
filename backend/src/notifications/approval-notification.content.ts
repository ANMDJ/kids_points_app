import type { ActionType } from '../contracts/permission-matrix'
import type { ApprovalStatusChangedPush, ApprovalSubmittedPush } from './push.port'

/**
 * 审批通知的**文案与消息构造**（W6-C，2026-10-24）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 *   W5-K / W5-M 时这些函数住在 `NotificationsService` 里，因为当时通知是
 *   「业务事务提交后同步发送」。W6-C 把入队搬进审批事务之后，写通知的是
 *   `NotificationsOutbox`，而 `NotificationsService` 只剩读接口 —— 文案必须
 *   从 service 里搬出来，否则 outbox 会反过来依赖一个只读服务。
 *
 * ── 一条口径 ──────────────────────────────────────────────────────────────
 *   文案只放**事实**：申请类型 + 结论；金额 / 心愿标题留在账本里，
 *   `payload` 只带跳转所需的 id。第三方通道会留存内容，通知栏只需要
 *   「去 App 看」。
 */

/** `ApprovalRequest.action` → 用户在通知里看到的那个名词。 */
export function approvalLabel(action: ActionType): string {
  switch (action) {
    case 'redeem':
    case 'request_redeem':
      return '兑换申请'
    case 'request_points_bonus':
      return '加分申请'
    case 'add_wish':
      return '心愿申请'
    default:
      return '申请'
  }
}

/** 审批结论通知的文案（`approved` / `rejected`）。 */
export function approvalNotificationContent(message: ApprovalStatusChangedPush): {
  type: string
  title: string
  body: string
} {
  const label = approvalLabel(message.action)
  if (message.status === 'approved') {
    return {
      type: 'approval.approved',
      title: `${label}已通过`,
      body: `家长已同意你的${label}，积分与心愿已按约定结算。`
    }
  }
  return {
    type: 'approval.rejected',
    title: `${label}未通过`,
    body: `家长没有同意这次${label}，积分没有变动。`
  }
}

/**
 * 「新申请待确认」的文案 —— **发给家长**，与结论通知同一套纪律。
 *
 * ★ 文案不写「孩子提交了」：家长自己提交（需另一位家长确认）时同样走这条路径，
 *   写死「孩子」会让另一位家长收到一句错话。收件人知道家里是谁在提。
 */
export function approvalSubmittedContent(action: ActionType): {
  type: string
  title: string
  body: string
} {
  const label = approvalLabel(action)
  return {
    type: 'approval.submitted',
    title: `新的${label}待确认`,
    body: `家里有新提交的${label}，打开收件箱即可同意或拒绝。`
  }
}

/** 构造「审批结论变了」的消息（渠道无关，worker 原样发送）。 */
export function buildApprovalStatusChangedMessage(input: {
  approvalId: string
  childId: string
  recipientUserId: string
  action: ActionType
  status: 'approved' | 'rejected'
  decidedByUserId: string | null
  occurredAt: string
}): ApprovalStatusChangedPush {
  return {
    type: 'approval.status_changed',
    approvalId: input.approvalId,
    childId: input.childId,
    recipientUserId: input.recipientUserId,
    action: input.action,
    status: input.status,
    decidedByUserId: input.decidedByUserId,
    occurredAt: input.occurredAt
  }
}

/** 构造「有新申请待确认」的消息（单收件人；收件人集合由 outbox 展开）。 */
export function buildApprovalSubmittedMessage(input: {
  approvalId: string
  childId: string
  recipientUserId: string
  action: ActionType
  submittedByUserId: string
  occurredAt: string
}): ApprovalSubmittedPush {
  return {
    type: 'approval.submitted',
    approvalId: input.approvalId,
    childId: input.childId,
    recipientUserId: input.recipientUserId,
    action: input.action,
    submittedByUserId: input.submittedByUserId,
    occurredAt: input.occurredAt
  }
}

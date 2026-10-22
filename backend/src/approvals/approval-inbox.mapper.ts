import type { ActionType } from '../contracts/permission-matrix'
import { summarizeApprovalPayload, type ApprovalSummary } from './approval-payload'
import { encodeApprovalCursor } from './approval.cursor'
import type { ApprovalListRow } from './approvals.repository'

/**
 * 收件箱的响应体（W5-D）。
 *
 * ── 为什么 `summary` 可以单独为 `null` ──────────────────────────────────────
 *   列表是**跨时间**的读视图：一条昨天建的审批，它的 payload 可能因为历史
 *   版本的 bug 而形状不对。整页 500 会让家长连「拒绝」都点不了（拒绝不需要
 *   读 payload），所以坏行照样出现在列表里，只是 `summary: null`。
 *   客户端必须把它显示成「内容无法识别」并**禁用批准**（看不到批的是什么）。
 *
 * ── 为什么带 `expiresAt` ────────────────────────────────────────────────────
 *   `pending` 有 72h TTL（`02` §4.3）。客户端要能说「还剩 2 小时」，
 *   而不是等家长点下去才收到 409 `APPROVAL_EXPIRED`。
 */
export interface ApprovalInboxItemDto {
  id: string
  action: ActionType
  status: string
  requesterUserId: string
  decidedByUserId: string | null
  executedRecordId: string | null
  autoReason: string | null
  createdAt: string
  decidedAt: string | null
  expiresAt: string
  summary: ApprovalSummary | null
}

export interface ApprovalInboxPageDto {
  items: ApprovalInboxItemDto[]
  /**
   * 还有下一页吗？
   * ★ 它是**本次查询时刻**的答案：翻页期间新来的申请不影响已发出的游标
   *   （新行只会出现在第一页之前）。
   */
  hasMore: boolean
  /** 下一页游标；`hasMore === false` 时恒为 `null`（客户端不必自己判断）。 */
  nextCursor: string | null
}

/** 单行映射。`autoReason` 只对 `invalidated` 有意义，其余恒为 `null`（与 decide 响应同一口径）。 */
export function toInboxItem(row: ApprovalListRow): ApprovalInboxItemDto {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    requesterUserId: row.requesterUserId,
    decidedByUserId: row.decidedByUserId,
    executedRecordId: row.executedRecordId,
    autoReason: row.autoReason ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    summary: summarizeApprovalPayload(row.action, row.payload)
  }
}

/**
 * 一页结果。
 *
 * ★ 适配器按 `limit + 1` 取行 —— 多出的那一行**只**用来判断 `hasMore`，
 *   然后必须丢掉；把它发出去会让客户端多显示一条本该在下一页的记录
 *   （并且下一页还会再发它一次）。
 */
export function toInboxPage(rows: ApprovalListRow[], limit: number): ApprovalInboxPageDto {
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.length === 0 ? undefined : page[page.length - 1]
  return {
    items: page.map(toInboxItem),
    hasMore,
    nextCursor:
      hasMore && last !== undefined
        ? encodeApprovalCursor({ createdAt: last.createdAt, id: last.id })
        : null
  }
}

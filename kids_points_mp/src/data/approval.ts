/**
 * 家长审批收件箱（W5-D）的本地模型 —— 对应 Flutter `lib/models/approval.dart`。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────────────
 *   `read_dto.ts` 只负责「线格式像不像」，本文件负责「怎么讲给用户听」：
 *   状态名、剩余有效期、这一条现在能不能批。文案只有这一份 —— 页面不许
 *   自己拼「待处理 / 已批准」之类的字符串，否则两端迟早会对同一个状态说两种话。
 *
 * ── 为什么 `status` 不收成枚举 ──────────────────────────────────────────────
 *   与 `ApprovalDto` 同一口径：后端将来加状态时，客户端要能**如实**显示
 *   「状态未知（xxx）」并禁用操作，而不是在解析层崩掉（那时连提示都给不出）。
 */

/** 审批 payload 的结构化摘要（服务端 `summary`）。 */
export type ApprovalSummary =
  | {
      kind: 'redeem'
      wishId: string
      /** 建申请时快照下来的心愿名 —— 心愿后来被删也说得清「申请的是什么」。 */
      title: string
      cost: number
    }
  | {
      kind: 'bonus'
      amount: number
      reason: string
      ruleId: string | null
      habitId: string | null
      /** 依据的标题快照（`basisTitle`），没有依据时为 null。 */
      basisTitle: string | null
    }
  | { kind: 'add_wish'; title: string; cost: number; emoji: string }

/** 一行标题，例如「兑换心愿」。 */
export function approvalHeadline(summary: ApprovalSummary): string {
  switch (summary.kind) {
    case 'redeem':
      return '兑换心愿'
    case 'bonus':
      return '加分申请'
    case 'add_wish':
      return '新增心愿'
  }
}

/** 具体内容，例如「「乐高」 · 100 分」。 */
export function approvalDetail(summary: ApprovalSummary): string {
  switch (summary.kind) {
    case 'redeem':
      return `「${summary.title}」 · ${summary.cost} 分`
    case 'add_wish':
      return `${summary.emoji}「${summary.title}」 · ${summary.cost} 分`
    case 'bonus': {
      const base = `+${summary.amount} 分`
      const why = summary.reason.trim()
      const basis = summary.basisTitle?.trim() ?? ''
      if (basis !== '') {
        return why === ''
          ? `${base} · 依据「${basis}」`
          : `${base} · ${why}（依据「${basis}」）`
      }
      return why === '' ? base : `${base} · ${why}`
    }
  }
}

/** 收件箱里的一行（`GET /approvals` 的 `items[]`）。 */
export interface ApprovalInboxItem {
  id: string
  /** 线格式动作名（`redeem` / `request_points_bonus` / `add_wish` …）。 */
  action: string
  /** `pending` / `approved` / `rejected` / `withdrawn` / `invalidated` / `expired`。 */
  status: string
  requesterUserId: string
  decidedByUserId: string | null
  executedRecordId: string | null
  /** 自动失效的原因（`WISH_DELETED` / `INSUFFICIENT_POINTS` …），否则 null。 */
  autoReason: string | null
  /** epoch 毫秒（与小程序其余模型的时间表示一致）。 */
  createdAt: number
  decidedAt: number | null
  /** `pending` 的 TTL 截止时刻（`02` §4.3 的 72h）。 */
  expiresAt: number
  /**
   * `null` = payload 读不懂（库里的坏数据）。**必须**显示成「内容无法识别」并
   * 禁用批准 —— 不是因为不能批，而是因为家长看不到自己在批什么。
   */
  summary: ApprovalSummary | null
}

export function isApprovalPending(item: ApprovalInboxItem): boolean {
  return item.status === 'pending'
}

/** 本地时间判断是否已过期（服务端会在下次读写时惰性落成 `expired`）。 */
export function isApprovalExpired(
  item: ApprovalInboxItem,
  now: number
): boolean {
  return isApprovalPending(item) && item.expiresAt <= now
}

/**
 * 能不能批。
 *
 * 三条都满足才行：`pending`、没过期、看得懂 payload。
 * **拒绝**不需要读 payload（家长可以不看内容就驳回），因此单独给
 * [canRejectApproval] —— 坏数据那一行仍然可以被拒，不会永久卡在列表里。
 */
export function canApproveApproval(
  item: ApprovalInboxItem,
  now: number
): boolean {
  return (
    isApprovalPending(item) && !isApprovalExpired(item, now) && item.summary !== null
  )
}

export function canRejectApproval(
  item: ApprovalInboxItem,
  now: number
): boolean {
  return isApprovalPending(item) && !isApprovalExpired(item, now)
}

/** 不能批的原因（可展示中文）；能批时为 null。 */
export function approvalBlockedReason(
  item: ApprovalInboxItem,
  now: number
): string | null {
  if (!isApprovalPending(item)) return '这条申请已经处理过了。'
  if (isApprovalExpired(item, now)) {
    return '已超过 72 小时有效期，请让孩子重新提交。'
  }
  if (item.summary === null) {
    return '内容无法识别（数据异常），不能批准；可以拒绝后让孩子重新提交。'
  }
  return null
}

/** 剩余有效期的**可读**提示；不适用（已处理 / 已过期）时为 null。 */
export function approvalRemainingText(
  item: ApprovalInboxItem,
  now: number
): string | null {
  if (!isApprovalPending(item) || isApprovalExpired(item, now)) return null
  const leftMinutes = Math.floor((item.expiresAt - now) / 60000)
  if (leftMinutes >= 60) return `还剩 ${Math.floor(leftMinutes / 60)} 小时`
  if (leftMinutes >= 1) return `还剩 ${leftMinutes} 分钟`
  return '不到 1 分钟'
}

/** 状态的可读名。未知状态**不猜** —— 直接把原值说出来。 */
export function approvalStatusLabel(item: ApprovalInboxItem): string {
  switch (item.status) {
    case 'pending':
      return '待处理'
    case 'approved':
      return '已通过'
    case 'rejected':
      return '已拒绝'
    case 'withdrawn':
      return '已撤回'
    case 'invalidated':
      return '已失效'
    case 'expired':
      return '已过期'
    default:
      return `状态未知（${item.status}）`
  }
}

/** `invalidated` 的具体原因 → 一句人话（其余状态返回空串）。 */
export function approvalAutoReasonLabel(item: ApprovalInboxItem): string {
  switch (item.autoReason) {
    case 'WISH_DELETED':
      return '心愿已经被删除了'
    case 'INSUFFICIENT_POINTS':
      return '积分不够了'
    case 'MEMBER_REMOVED':
      return '成员已经被移出家庭'
    case null:
      return ''
    default:
      return `已有前提发生变化（${item.autoReason}）`
  }
}

/** 一页收件箱 + 下一页游标。`nextCursor === null` ⇔ 没有更多。 */
export interface ApprovalsPage {
  items: ApprovalInboxItem[]
  hasMore: boolean
  nextCursor: string | null
}

/** 收件箱的状态筛选（默认只看待处理）。 */
export const approvalFilters = ['pending', 'approved', 'rejected', 'all'] as const
export type ApprovalFilter = typeof approvalFilters[number]

/** 筛选 chip 的文案。 */
export function approvalFilterLabel(filter: ApprovalFilter): string {
  switch (filter) {
    case 'pending':
      return '待处理'
    case 'approved':
      return '已通过'
    case 'rejected':
      return '已拒绝'
    case 'all':
      return '全部'
  }
}

/** 筛选值 → 请求参数（「全部」不带 `status`）。 */
export function approvalFilterQuery(filter: ApprovalFilter): string | undefined {
  return filter === 'all' ? undefined : filter
}

/**
 * 批准 / 拒绝前的确认文案。
 *
 * 放在模型层（纯函数）而不是页面里，是为了能被单测直接钉住 ——
 * 「批准后到底扣多少分 / 加多少分」这种句子写错，比按钮点不动更糟。
 */
export function approvalConfirmText(
  approve: boolean,
  item: ApprovalInboxItem
): string {
  if (!approve) return '拒绝后这次申请不会生效，积分与心愿都不会变化。'
  const summary = item.summary
  if (summary === null) {
    // 调用方已拦住，兜底也必须说实话。
    return '这条申请的内容无法识别，不能批准。'
  }
  switch (summary.kind) {
    case 'redeem':
      return `批准后会立即扣 ${summary.cost} 分，并把「${summary.title}」标记为已兑换。`
    case 'bonus':
      return `批准后会立即给孩子加 ${summary.amount} 分。`
    case 'add_wish':
      return `批准后「${summary.title}」（${summary.cost} 分）会加入心愿单。`
  }
}

/**
 * `10 月 21 日 14:05`（本地时区）。
 *
 * 服务端下发的是 UTC 毫秒，直接用 `getUTCHours` 或字符串切片会差 8 小时；
 * 这里交给 Date 做本地化，只在最外层拼文案。
 */
export function formatApprovalTime(time: number): string {
  const date = new Date(time)
  const hh = `${date.getHours()}`.padStart(2, '0')
  const mm = `${date.getMinutes()}`.padStart(2, '0')
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${hh}:${mm}`
}

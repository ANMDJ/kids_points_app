import {
  isApprovalStatusChangedPush,
  isApprovalSubmittedPush,
  type PushMessage
} from './push.port'

/**
 * 推送重试队列的**数据结构与去重键**（W6-B，2026-10-24）。
 *
 * ── 去重键为什么是这个形状 ──────────────────────────────────────────────────
 *   `approval.status_changed:<approvalId>:<recipientUserId>:<status>`
 *   `approval.submitted:<approvalId>:<recipientUserId>`
 *
 *   三个考虑：
 *   ① **收件人在键里**：`approval.submitted` 是一次提交 → 多位家长各一条；
 *      若键里没有收件人，第二位家长的消息会被唯一约束当成「重复」直接丢掉；
 *   ② **审批 id 在键里**：同一件事只提醒一次，重放 / 双击 / worker 重启都不会
 *      变成两条（`Idempotency-Key` 管的是业务写入，管不到通知；通知需要自己的键）；
 *   ③ **`status` 在键里**（只对 `status_changed`）：`approved` 与 `rejected`
 *      是两次不同的事实，不能互相去重。
 *
 *   ★ 反向约束同样重要：**不要把时间**放进键里。放进去就等于没有去重 ——
 *     每次重算 `occurredAt` 都会得到一条新行，唯一约束永远不生效。
 */

export const PUSH_RETRY_STATUSES = ['pending', 'sending', 'sent', 'dead', 'expired'] as const
export type PushRetryStatus = (typeof PUSH_RETRY_STATUSES)[number]

/** 认一个字符串是不是合法的队列状态（用例里代替 `as`，避免把错字测成绿）。 */
export function isPushRetryStatus(value: unknown): value is PushRetryStatus {
  return typeof value === 'string' && (PUSH_RETRY_STATUSES as readonly string[]).includes(value)
}

/**
 * 队列里的一行。
 *
 * ★ `message` 允许为 `null`：`payload` 是 JSON 列，读到的东西**必须**校验。
 *   宁可让 worker 把它标成 `dead`（`invalid_payload`），也不要把 `undefined`
 *   送进适配器 —— 那会变成一条「发送成功但没人收到」的假记录。
 */
export interface PushRetryRow {
  id: string
  event: string
  dedupeKey: string
  message: PushMessage | null
  recipientUserId: string
  childId: string
  status: PushRetryStatus
  attempts: number
  maxAttempts: number
  nextAttemptAt: Date
  expiresAt: Date
  claimedAt: Date | null
  lastError: string | null
  providerMessageId: string | null
  sentAt: Date | null
  createdAt: Date
}

/** 入队参数（由适配器算好，仓储只负责写）。 */
export interface EnqueuePushRetryInput {
  message: PushMessage
  dedupeKey: string
  /** 入队时刻（DB 的时间由调用方给，便于用例固定时钟）。 */
  now: Date
  /** 超过它仍未送达 ⇒ `expired`。 */
  expiresAt: Date
  maxAttempts: number
  /**
   * 为什么入队（`provider_error: …` / `no_device_token` / …）。
   *
   * ★ 入队时就写下来：一条停在 `pending` 的行如果只有「等重试」，运维看不出
   *   它是因为「没配网关」还是「网关 500」。这一列是**入队那一刻的诚实**。
   */
  lastError?: string
}

/** 入队结论：`duplicate` 是**正常**结果（同一件事被重试到了第二次），不是错误。 */
export type EnqueuePushRetryResult = 'queued' | 'duplicate'

export interface ClaimDuePushRetryInput {
  now: Date
  /** 一次最多领几条（防止一个批次的扫描把进程按死）。 */
  limit: number
  /** `sending` 超过这么久还没落终态 ⇒ 视为进程崩了，可被重新领取。 */
  claimTimeoutMs: number
}

export interface MarkPushRetryInput {
  id: string
  attempts: number
  nextAttemptAt: Date
  lastError: string
}

/**
 * 一次 tick 的结算（worker 的返回值）。
 *
 * ★ 为什么返回这些数字而不是 `void`：`npm run test:db` 与运维都需要能说清
 *   「这一轮到底发生了什么」。只写日志的话，断言只能去 grep 日志文本。
 */
export interface PushRetryTickResult {
  /** 因超过 TTL 被标为 `expired` 的条数。 */
  expired: number
  /** 本轮领到的条数。 */
  claimed: number
  /** 送达并标为 `sent`。 */
  sent: number
  /** 失败但仍会再试（`nextAttemptAt` 已顺延）。 */
  retried: number
  /** 用满尝试次数，标为 `dead`。 */
  dead: number
}

/** 全零的 tick 结果（空跑时返回它，避免 `undefined` 混进日志）。 */
export function emptyTickResult(): PushRetryTickResult {
  return { expired: 0, claimed: 0, sent: 0, retried: 0, dead: 0 }
}

/**
 * 从消息算出**唯一**的去重键。
 *
 * 未知消息类型 ⇒ 抛错（不返回 `null`）：调用点只有两处、都在本模块内，
 * 抛错是编译期之外的免费保险；返回 `null` 反而会让调用方「记一条没有键的记录」。
 */
export function buildPushRetryDedupeKey(message: PushMessage): string {
  if (isApprovalStatusChangedPush(message)) {
    return `${message.type}:${message.approvalId}:${message.recipientUserId}:${message.status}`
  }
  if (isApprovalSubmittedPush(message)) {
    return `${message.type}:${message.approvalId}:${message.recipientUserId}`
  }
  // 穷尽性检查：新增消息类型时 TS 会在这里报错，逼你写出去重规则。
  const exhaustive: never = message
  throw new Error(`未知的推送消息类型：${JSON.stringify(exhaustive)}`)
}

/**
 * 从 JSON 列的值**重建** `PushMessage`；不合法 ⇒ `null`。
 *
 * ── 为什么不用 `as PushMessage` 直接断言 ──────────────────────────────────
 *   `payload` 列可以被任何一次手工 SQL / 迁移脚本写坏。断言之后，坏数据会一路
 *   走到适配器：`isApprovalStatusChangedPush` 读 `message.type === undefined`
 *   为假，于是**当成另一种消息**发出去 —— 结果是「发送成功、内容全空」。
 *   在这里挡下来，它只会是一条 `dead` + `lastError = invalid_payload`。
 */
export function parsePushMessage(value: unknown): PushMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const isFilled = (field: string): boolean =>
    typeof raw[field] === 'string' && (raw[field] as string).trim() !== ''

  for (const field of ['approvalId', 'childId', 'recipientUserId', 'action', 'occurredAt']) {
    if (!isFilled(field)) return null
  }

  if (raw.type === 'approval.status_changed') {
    if (raw.status !== 'approved' && raw.status !== 'rejected') return null
    if (raw.decidedByUserId !== null && typeof raw.decidedByUserId !== 'string') return null
    return raw as unknown as PushMessage
  }

  if (raw.type === 'approval.submitted') {
    if (!isFilled('submittedByUserId')) return null
    return raw as unknown as PushMessage
  }

  return null
}

import type { PushFailureReason, PushResult } from './push.port'

/**
 * 推送失败重试的**判定规则**（W6-B，2026-10-24）—— 纯函数，不读 `process.env`、
 * 不碰数据库、不看时钟（`now` 一律由调用方传入）。
 *
 * ── 为什么把「要不要重试、隔多久、算不算用掉一次」抽成纯函数 ────────────────
 *   这三件事决定了「一条推送最终会发几次、多久后放弃」，而它们在真实环境里
 *   **必须靠等几十分钟才能观察到**。抽出来之后，指数退避、上限、结构性失败的
 *   不消耗次数，都能在毫秒级的用例里逐条证伪（`test/push-retry.test.ts` 组 A/B）。
 *
 * ── 两类失败，两种命运（这张表是本节最要紧的东西）───────────────────────────
 *   `provider_error`（**transient**，渠道故障）
 *     → 消耗一次 `attempts`，按指数退避重试；用完 `maxAttempts` ⇒ `dead`。
 *       网关 500 / 证书过期 / 超时都属于这一类：**它是会好的**，所以要给它
 *       一个有限的次数与越来越长的间隔，别把网关按死。
 *
 *   `no_device_token` / `provider_not_configured`（**structural**，结构缺失）
 *     → **不消耗** `attempts`，固定慢速重试，直到 `expiresAt` ⇒ `expired`。
 *       这两件事不是「渠道坏了」：前者是这个人还没登录设备（装好 App 就有了），
 *       后者是我们还没配网关（配好就有了）。若也按指数退避算 6 次，
 *       30 分钟就会把队列里的通知判死 —— 而「配上网关」往往要等到第二天。
 *       但也不能无限等：`expiresAt` 之后如实标 `expired`，不假装它还活着。
 *
 * ★ 反过来的错误更隐蔽：把所有失败都当成「永久失败」直接丢弃。
 *   那会得到一条 100% 绿的重试队列 —— 因为里面什么都没有。
 */

/** 渠道故障的最多尝试次数（含首次同步发送）。6 次 ⇒ 约 30 分钟内放弃。 */
export const PUSH_RETRY_MAX_ATTEMPTS = 6
/** 第一次重试的间隔（秒级即可：这类故障通常几秒内自愈）。 */
export const PUSH_RETRY_BASE_DELAY_MS = 30_000
/** 退避上限：再久也不超过 30 分钟（否则一条通知可能躺在队列里「等一个奇迹」）。 */
export const PUSH_RETRY_MAX_DELAY_MS = 30 * 60_000
/** 结构性失败的固定间隔：5 分钟一次，便宜、够快、不吵。 */
export const PUSH_RETRY_STRUCTURAL_DELAY_MS = 5 * 60_000
/** 默认 TTL：24 小时内还没送达 ⇒ `expired`。 */
export const PUSH_RETRY_DEFAULT_TTL_MS = 24 * 60 * 60_000
/**
 * 连续失败达到这个次数就打一条 **warn**（只在「刚好跨过」时打一次）。
 *
 * ★ 为什么是「连续」而不是「总数」：总数大只说明用得久；**连续**失败才说明
 *   渠道此刻是坏的。混在一起，告警会在正常运行一个月后开始天天响。
 */
export const PUSH_RETRY_CONSECUTIVE_FAILURE_ALARM = 3

/**
 * 失败分类。
 *
 * ★ 这个类型只有两个值，是刻意的：新增第三种（例如 `permanent`）之前先想清楚
 *   「谁应该看到它、看到了能做什么」。目前没有任何失败是「再试也没用且不需要人管」的。
 */
export type PushFailureClass = 'transient' | 'structural'

/** `provider_error` ⇒ transient；其余两种 ⇒ structural。 */
export function classifyPushFailure(reason: PushFailureReason): PushFailureClass {
  return reason === 'provider_error' ? 'transient' : 'structural'
}

/**
 * 第 `attempts` 次失败之后应该等多久（`attempts` 是**已经用掉**的次数，≥ 1）。
 *
 * 序列：30s → 1m → 2m → 4m → 8m → 16m（第 6 次即用满 `maxAttempts`，不再排期）。
 * 没有抖动（jitter）：本仓库的用例必须能逐字复现时间，而「同时重试」在这里
 * 不会形成尖峰 —— 领件由单个 worker 顺序处理，批次上限 `PUSH_RETRY_BATCH`。
 *
 * 非法输入（`0` / 负数 / `NaN`）一律按第 1 次处理：宁可早一点重试，
 * 也不要因为一个坏数字把 `nextAttemptAt` 算成 `Invalid Date`（那会**永不领取**）。
 */
export function backoffDelayMs(attempts: number): number {
  const safe = Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1
  const exponential = PUSH_RETRY_BASE_DELAY_MS * 2 ** (safe - 1)
  return Math.min(exponential, PUSH_RETRY_MAX_DELAY_MS)
}

/** 结构性失败的固定间隔（与 `attempts` 无关）。 */
export function structuralDelayMs(): number {
  return PUSH_RETRY_STRUCTURAL_DELAY_MS
}

/** `attempts` 是否已经用满（用满 ⇒ `dead`，不再排期）。 */
export function isRetryExhausted(attempts: number, maxAttempts: number): boolean {
  return attempts >= maxAttempts
}

/**
 * 把一次失败写成 `lastError`（一行，可直接贴进运维查询结果）。
 *
 * 形如 `provider_error: 网关 500` / `no_device_token`。
 * 不含消息正文 —— `lastError` 会进日志与工单，别把「谁申请了什么」抄进去。
 */
export function describePushFailure(result: Extract<PushResult, { delivered: false }>): string {
  const detail = typeof result.detail === 'string' && result.detail.trim() !== '' ? result.detail.trim() : ''
  return detail === '' ? result.reason : `${result.reason}: ${detail}`
}

/** 同一形状，但用于「适配器抛错」那条路径（没有 `PushResult` 可读）。 */
export function describePushThrow(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const trimmed = detail.trim() === '' ? '未知错误' : detail
  // 抛错一律按渠道故障处理：网络层直接 reject 是最常见的形态。
  return `provider_error: ${trimmed}`
}

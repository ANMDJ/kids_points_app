import {
  PUSH_RETRY_DEFAULT_TTL_MS,
  PUSH_RETRY_MAX_ATTEMPTS
} from './push-retry.policy'

/**
 * 推送重试 worker 的环境配置（W6-B，2026-10-24）—— **纯函数**，不读 `process.env`。
 *
 * 与 `push-webhook.config.ts` 同一手法，理由也一样：
 *   ① 校验规则要能**离线证伪**（`PUSH_RETRY_BATCH=abc` / `-5` / 巨大值）；
 *   ② 装配层只做「拿结论、选实现」，不做字符串解析。
 *
 * ── 非法值不抛错，夹到边界并**如实报告实际采用的值** ────────────────────────
 *   一个写错的 `PUSH_RETRY_INTERVAL_MS` 不该让服务起不来（推送重试是次要路径），
 *   但也不能静默按默认值跑 —— 启动日志会打出最终生效的数字（见 `NotificationsModule`）。
 *
 * ── 五个旋钮，各自防的事 ───────────────────────────────────────────────────
 *   `intervalMs`      扫得太快 ⇒ 空转占 CPU；太慢 ⇒ 重试窗口被错过。
 *   `batchSize`       一次领太多 ⇒ 网关抖动时会一次性打出去一大把。
 *   `ttlMs`           没有上限 ⇒ 「未送达」永远是中间态（谁也不敢删）。
 *   `claimTimeoutMs`  `sending` 的行必须有回收时间，否则进程崩溃后那些行**永不重试**。
 *   `maxAttempts`     渠道故障的容忍度（结构性失败不消耗次数，见 policy）。
 */

/**
 * 配置的注入令牌。刻意与「端口令牌」分开放在本文件：
 * 配置是**值**（不随环境变化而换实现），端口才需要 `useClass` 分叉。
 */
export const PUSH_RETRY_CONFIG = Symbol('PUSH_RETRY_CONFIG')

export const PUSH_RETRY_ENABLED_ENV = 'PUSH_RETRY_ENABLED'
export const PUSH_RETRY_INTERVAL_ENV = 'PUSH_RETRY_INTERVAL_MS'
export const PUSH_RETRY_BATCH_ENV = 'PUSH_RETRY_BATCH'
export const PUSH_RETRY_TTL_ENV = 'PUSH_RETRY_TTL_MS'
export const PUSH_RETRY_CLAIM_TIMEOUT_ENV = 'PUSH_RETRY_CLAIM_TIMEOUT_MS'
export const PUSH_RETRY_MAX_ATTEMPTS_ENV = 'PUSH_RETRY_MAX_ATTEMPTS'

export const DEFAULT_PUSH_RETRY_INTERVAL_MS = 15_000
export const MIN_PUSH_RETRY_INTERVAL_MS = 1_000
export const MAX_PUSH_RETRY_INTERVAL_MS = 300_000

export const DEFAULT_PUSH_RETRY_BATCH = 20
export const MIN_PUSH_RETRY_BATCH = 1
export const MAX_PUSH_RETRY_BATCH = 100

export const MIN_PUSH_RETRY_TTL_MS = 60_000
export const MAX_PUSH_RETRY_TTL_MS = 7 * 24 * 60 * 60_000

export const DEFAULT_PUSH_RETRY_CLAIM_TIMEOUT_MS = 60_000
export const MIN_PUSH_RETRY_CLAIM_TIMEOUT_MS = 10_000
export const MAX_PUSH_RETRY_CLAIM_TIMEOUT_MS = 10 * 60_000

export const MIN_PUSH_RETRY_ATTEMPTS = 1
export const MAX_PUSH_RETRY_ATTEMPTS = 20

export interface PushRetryConfig {
  /** `false` ⇒ worker 不启动（`main.ts` 读它）。默认 `true`。 */
  enabled: boolean
  intervalMs: number
  batchSize: number
  ttlMs: number
  claimTimeoutMs: number
  maxAttempts: number
}

export function readPushRetryConfig(env: NodeJS.ProcessEnv): PushRetryConfig {
  return {
    enabled: readEnabled(env[PUSH_RETRY_ENABLED_ENV]),
    intervalMs: readInt(env[PUSH_RETRY_INTERVAL_ENV], {
      fallback: DEFAULT_PUSH_RETRY_INTERVAL_MS,
      min: MIN_PUSH_RETRY_INTERVAL_MS,
      max: MAX_PUSH_RETRY_INTERVAL_MS
    }),
    batchSize: readInt(env[PUSH_RETRY_BATCH_ENV], {
      fallback: DEFAULT_PUSH_RETRY_BATCH,
      min: MIN_PUSH_RETRY_BATCH,
      max: MAX_PUSH_RETRY_BATCH
    }),
    ttlMs: readInt(env[PUSH_RETRY_TTL_ENV], {
      fallback: PUSH_RETRY_DEFAULT_TTL_MS,
      min: MIN_PUSH_RETRY_TTL_MS,
      max: MAX_PUSH_RETRY_TTL_MS
    }),
    claimTimeoutMs: readInt(env[PUSH_RETRY_CLAIM_TIMEOUT_ENV], {
      fallback: DEFAULT_PUSH_RETRY_CLAIM_TIMEOUT_MS,
      min: MIN_PUSH_RETRY_CLAIM_TIMEOUT_MS,
      max: MAX_PUSH_RETRY_CLAIM_TIMEOUT_MS
    }),
    maxAttempts: readInt(env[PUSH_RETRY_MAX_ATTEMPTS_ENV], {
      fallback: PUSH_RETRY_MAX_ATTEMPTS,
      min: MIN_PUSH_RETRY_ATTEMPTS,
      max: MAX_PUSH_RETRY_ATTEMPTS
    })
  }
}

/**
 * 关闭开关：只有明确写成 `0` / `false` / `off` / `no` 才关。
 *
 * ★ 方向刻意选成「不认识的值 ⇒ 保持开启」：这条 worker 是**兜底**，
 *   关掉它不会有任何可见报错（只是推送不再重试）。所以「拼错一个值就静默关闭」
 *   是不可接受的；反过来「拼错一个值仍然尝试重试」最多多几次无用的领件。
 */
function readEnabled(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return true
  const value = raw.trim().toLowerCase()
  return !['0', 'false', 'off', 'no', 'disabled'].includes(value)
}

/** 整数 + 夹取。空串 / 非数字 ⇒ 默认；小数 ⇒ 向下取整后再夹。 */
function readInt(
  raw: string | undefined,
  bounds: { fallback: number; min: number; max: number }
): number {
  if (typeof raw !== 'string' || raw.trim() === '') return bounds.fallback
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed)) return bounds.fallback
  const rounded = Math.floor(parsed)
  if (rounded < bounds.min) return bounds.min
  if (rounded > bounds.max) return bounds.max
  return rounded
}

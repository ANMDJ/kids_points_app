import { Injectable, NotImplementedException } from '@nestjs/common'

/**
 * `PushRetryJob` 的保留（retention）策略（W6-D，2026-10-24）。
 *
 * ── 它解决的那条「表会一直长」──────────────────────────────────────────────
 *   W6-C 之后**每条审批提醒**都会在队列里留一行；`sent` / `expired` / `dead`
 *   却永远不会被删除（W6-B 交接单 §5 第 4 条）。接生产前必须定归档策略，
 *   否则 `PushRetryJob` 会随审批量线性增长，`claimDue` 的子查询也会越来越慢。
 *
 * ── 只删终态，且三档保留期 ─────────────────────────────────────────────────
 *   `sent`     默认 7 天  —— 已经送达，留一周够排查「那天到底发了没」；
 *   `expired`  默认 7 天  —— 结构缺失（没配网关 / 没设备），同一批原因，留一周；
 *   `dead`     默认 30 天 —— **它是证据**：渠道反复失败通常要事后复盘，
 *                            删得太快就只剩一句「当时好像死过几条」。
 *
 *   `pending` / `sending` **永远不删**：前者还没送，后者可能正在送（删掉等于
 *   把一条即将发生的推送从队列里抹掉）。
 *
 * ── 时间字段为什么是 `updatedAt` 而不是 `sentAt` ────────────────────────────
 *   `sent` 有 `sentAt`，但 `expired` / `dead` 没有各自的「终结时刻」列。
 *   三条终态路径都只做一次 `updateMany`，Prisma 的 `updatedAt` 恰好就是那个
 *   时刻；统一用它，避免「两张表两个口径」。代价：人工改过一行的 `lastError`
 *   会把它的保留期从改动时刻重新算起 —— 对归档任务来说这是可接受的保守方向
 *   （晚删 > 误删）。
 *
 * ── 为什么删除要分批 ──────────────────────────────────────────────────────
 *   `DELETE ... WHERE updatedAt < ...` 一次删十万行会长时间持锁并撑大 WAL。
 *   每轮每个状态最多 `batchSize` 行、最多 `PUSH_RETRY_RETENTION_MAX_ROUNDS`
 *   轮；删不完的下一轮继续（不会漏，只是慢）。
 */
export const PUSH_RETRY_RETENTION_PORT = Symbol('PUSH_RETRY_RETENTION_PORT')
export const PUSH_RETRY_RETENTION_CONFIG = Symbol('PUSH_RETRY_RETENTION_CONFIG')

export const PUSH_RETRY_RETENTION_ENABLED_ENV = 'PUSH_RETRY_RETENTION_ENABLED'
export const PUSH_RETRY_RETENTION_INTERVAL_ENV = 'PUSH_RETRY_RETENTION_INTERVAL_MS'
export const PUSH_RETRY_RETENTION_SENT_ENV = 'PUSH_RETRY_RETENTION_SENT_MS'
export const PUSH_RETRY_RETENTION_EXPIRED_ENV = 'PUSH_RETRY_RETENTION_EXPIRED_MS'
export const PUSH_RETRY_RETENTION_DEAD_ENV = 'PUSH_RETRY_RETENTION_DEAD_MS'
export const PUSH_RETRY_RETENTION_BATCH_ENV = 'PUSH_RETRY_RETENTION_BATCH'

export const DEFAULT_PUSH_RETRY_RETENTION_INTERVAL_MS = 60 * 60_000
export const MIN_PUSH_RETRY_RETENTION_INTERVAL_MS = 60_000
export const MAX_PUSH_RETRY_RETENTION_INTERVAL_MS = 24 * 60 * 60_000

const DAY_MS = 24 * 60 * 60_000
export const DEFAULT_PUSH_RETRY_RETENTION_SENT_MS = 7 * DAY_MS
export const DEFAULT_PUSH_RETRY_RETENTION_EXPIRED_MS = 7 * DAY_MS
export const DEFAULT_PUSH_RETRY_RETENTION_DEAD_MS = 30 * DAY_MS
export const MIN_PUSH_RETRY_RETENTION_AGE_MS = 60_000
export const MAX_PUSH_RETRY_RETENTION_AGE_MS = 365 * DAY_MS

export const DEFAULT_PUSH_RETRY_RETENTION_BATCH = 500
export const MIN_PUSH_RETRY_RETENTION_BATCH = 1
export const MAX_PUSH_RETRY_RETENTION_BATCH = 5_000

/**
 * 一轮里每个状态最多删几批。
 *
 * 500 × 10 = 5000 行/状态/轮；一小时一轮足够追上正常审批量。**不**做成环境变量：
 * 它保护的是「别把一条 DELETE 变成锁表」，不是业务旋钮。
 */
export const PUSH_RETRY_RETENTION_MAX_ROUNDS = 10

/** 允许删除的三个终态。`pending` / `sending` 不在此列（见文件头）。 */
export const PUSH_RETRY_RETENTION_STATUSES = ['sent', 'expired', 'dead'] as const
export type PushRetryRetentionStatus = (typeof PUSH_RETRY_RETENTION_STATUSES)[number]

export interface PushRetryRetentionConfig {
  /** `false` ⇒ worker 不启动。默认 `true`。 */
  enabled: boolean
  intervalMs: number
  /** 已完成的行保留多久后删除。 */
  sentMs: number
  expiredMs: number
  deadMs: number
  /** 每批最多删多少行（也是「一批够不够、要不要再来一批」的判断依据）。 */
  batchSize: number
}

export interface PushRetryRetentionCutoffs {
  sentBefore: Date
  expiredBefore: Date
  deadBefore: Date
}

/** 端口输入：**一个**状态 + 一个「早于它」的截止时刻 + 批量上限。 */
export interface DeleteSettledPushRetryInput {
  status: PushRetryRetentionStatus
  before: Date
  limit: number
}

export interface PushRetryRetentionPort {
  /** 删除该状态下 `updatedAt < before` 的最多 `limit` 行；返回实际删除条数。 */
  deleteSettled(input: DeleteSettledPushRetryInput): Promise<number>
}

export interface PushRetryRetentionTickResult {
  sent: number
  expired: number
  dead: number
  total: number
}

export function emptyRetentionResult(): PushRetryRetentionTickResult {
  return { sent: 0, expired: 0, dead: 0, total: 0 }
}

/** 由「现在」与配置算出三条截止线 —— 纯函数，用例可逐字校验。 */
export function retentionCutoffs(
  now: Date,
  config: PushRetryRetentionConfig
): PushRetryRetentionCutoffs {
  return {
    sentBefore: new Date(now.getTime() - config.sentMs),
    expiredBefore: new Date(now.getTime() - config.expiredMs),
    deadBefore: new Date(now.getTime() - config.deadMs)
  }
}


/** 环境配置 —— 纯函数（与 `push-retry.config.ts` 同款：非法值夹取并如实生效）。 */
export function readPushRetryRetentionConfig(
  env: NodeJS.ProcessEnv
): PushRetryRetentionConfig {
  return {
    enabled: readEnabled(env[PUSH_RETRY_RETENTION_ENABLED_ENV]),
    intervalMs: readInt(env[PUSH_RETRY_RETENTION_INTERVAL_ENV], {
      fallback: DEFAULT_PUSH_RETRY_RETENTION_INTERVAL_MS,
      min: MIN_PUSH_RETRY_RETENTION_INTERVAL_MS,
      max: MAX_PUSH_RETRY_RETENTION_INTERVAL_MS
    }),
    sentMs: readInt(env[PUSH_RETRY_RETENTION_SENT_ENV], {
      fallback: DEFAULT_PUSH_RETRY_RETENTION_SENT_MS,
      min: MIN_PUSH_RETRY_RETENTION_AGE_MS,
      max: MAX_PUSH_RETRY_RETENTION_AGE_MS
    }),
    expiredMs: readInt(env[PUSH_RETRY_RETENTION_EXPIRED_ENV], {
      fallback: DEFAULT_PUSH_RETRY_RETENTION_EXPIRED_MS,
      min: MIN_PUSH_RETRY_RETENTION_AGE_MS,
      max: MAX_PUSH_RETRY_RETENTION_AGE_MS
    }),
    deadMs: readInt(env[PUSH_RETRY_RETENTION_DEAD_ENV], {
      fallback: DEFAULT_PUSH_RETRY_RETENTION_DEAD_MS,
      min: MIN_PUSH_RETRY_RETENTION_AGE_MS,
      max: MAX_PUSH_RETRY_RETENTION_AGE_MS
    }),
    batchSize: readInt(env[PUSH_RETRY_RETENTION_BATCH_ENV], {
      fallback: DEFAULT_PUSH_RETRY_RETENTION_BATCH,
      min: MIN_PUSH_RETRY_RETENTION_BATCH,
      max: MAX_PUSH_RETRY_RETENTION_BATCH
    })
  }
}

/** 一行日志（与 `describeReconcile` 同一手法：字段名英文、值可读）。 */
export function describeRetention(result: PushRetryRetentionTickResult): string {
  return `sent=${result.sent} expired=${result.expired} dead=${result.dead} total=${result.total}`
}

/** 关闭开关：只有明确写成 `0` / `false` / `off` / `no` 才关。 */
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
  const floored = Math.floor(parsed)
  return Math.min(Math.max(floored, bounds.min), bounds.max)
}

/** 无库装配：没有表可删 ⇒ 501（绝不在没有库时假装「清理完成」）。 */
@Injectable()
export class NotImplementedPushRetryRetention implements PushRetryRetentionPort {
  async deleteSettled(_input: DeleteSettledPushRetryInput): Promise<number> {
    throw new NotImplementedException({
      code: 'PUSH_RETRY_RETENTION_NOT_IMPLEMENTED',
      message: '推送队列保留清理需要数据库连接（DATABASE_URL 未设置）'
    })
  }
}

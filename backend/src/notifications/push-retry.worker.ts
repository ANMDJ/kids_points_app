import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'

import {
  PUSH_DELIVERY_PORT,
  PUSH_SEND_TIMEOUT_MS,
  type PushPort,
  type PushResult
} from './push.port'
import { PUSH_RETRY_CONFIG, type PushRetryConfig } from './push-retry.config'
import { PushRetryMetrics } from './push-retry.metrics'
import {
  backoffDelayMs,
  classifyPushFailure,
  describePushFailure,
  describePushThrow,
  isRetryExhausted,
  structuralDelayMs
} from './push-retry.policy'
import { PUSH_RETRY_REPOSITORY, type PushRetryPort } from './push-retry.repository'
import {
  emptyTickResult,
  type PushRetryRow,
  type PushRetryTickResult
} from './push-retry.types'

/** 过期结算写进 `lastError` 的固定文案（运维按它区分「渠道坏了」与「一直没送出去」）。 */
export const PUSH_RETRY_EXPIRED_MESSAGE = 'expired: 超过 TTL 仍未送达'
/** payload 不是合法 `PushMessage` 时的固定文案。 */
export const PUSH_RETRY_INVALID_PAYLOAD_MESSAGE = 'invalid_payload: 不是可发送的 PushMessage'

/** 单条结算的结论（与 `PushRetryTickResult` 的字段名一一对应，便于直接累加）。 */
type SettleOutcome = 'sent' | 'retried' | 'dead' | 'expired'

/**
 * 推送重试 worker（W6-B，2026-10-24）。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────────────
 *   每一轮：① 清扫过期 → ② 领一批该发的 → ③ 逐条发送并结算。
 *   没有魔法，全部落在那 6 行 `tick()` 里；复杂的是**结算规则**，已经抽到
 *   `push-retry.policy.ts` 并用例逐条证明（退避序列、结构性失败不消耗次数）。
 *
 * ── 为什么计时器**不**在构造函数里启动 ──────────────────────────────────────
 *   与 `ApprovalsExpiryService` 同一纪律：`npm test` 会实例化模块，若构造函数
 *   里 `setInterval`，测试进程会留下一个永不结束的计时器（Node 进程不退出 =
 *   看着像卡死）。所以只有 `main.ts` 调 `start()`，且 `unref()` 掉。
 *
 * ── 并发与崩溃 ────────────────────────────────────────────────────────────
 *   · 单进程重入保护：`running` 保证上一轮没跑完不会叠上下一轮；
 *   · 多进程安全：领取是 `FOR UPDATE SKIP LOCKED` 的单条 UPDATE（见仓储注释），
 *     两个 worker 不会领到同一行；
 *   · 进程在「领走之后、标记之前」崩溃 ⇒ 该行停在 `sending`，
 *     `claimTimeoutMs` 之后会被下一轮**重新领取**（不是永久卡住）。
 *     代价是极端情况下可能重复发送一次 —— 比「永远不发」好，也不撒谎。
 *
 * ── 它**不**做的事 ────────────────────────────────────────────────────────
 *   · 不生成消息：payload 原样送回端口（内容语义只有一处定义）；
 *   · 不改业务表：只写 `PushRetryJob`（`01` §4：通知在账本事务之外）；
 *   · 不做无限重试：结构性失败到 TTL、渠道故障到 `maxAttempts`。
 */
@Injectable()
export class PushRetryWorker implements OnApplicationShutdown {
  private readonly log = new Logger(PushRetryWorker.name)
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    @Inject(PUSH_RETRY_REPOSITORY) private readonly repository: PushRetryPort,
    @Inject(PUSH_DELIVERY_PORT) private readonly delivery: PushPort,
    @Inject(PUSH_RETRY_CONFIG) private readonly config: PushRetryConfig,
    private readonly metrics: PushRetryMetrics
  ) {}

  /** 启动周期扫描（幂等：重复调用不会多一个计时器）。 */
  start(): void {
    if (this.timer !== null) return
    if (!this.config.enabled) {
      this.log.warn('PUSH_RETRY_ENABLED=0 —— 推送重试 worker 不启动（失败推送会停在 pending）')
      return
    }
    this.timer = setInterval(() => {
      void this.safeTick()
    }, this.config.intervalMs)
    // 不拦着进程退出（`main.ts` 的 enableShutdownHooks 仍会正常关停）。
    this.timer.unref()
    this.log.log(
      `推送重试 worker 已启动（每 ${this.config.intervalMs}ms 一轮，批量 ${this.config.batchSize}，` +
        `TTL ${this.config.ttlMs}ms，渠道故障上限 ${this.config.maxAttempts} 次）`
    )
    // 启动即跑一轮：部署后积压的失败推送不必等第一个间隔。
    void this.safeTick()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
    this.log.log('推送重试 worker 已停止')
  }

  onApplicationShutdown(): void {
    this.stop()
  }

  /**
   * 一轮结算。`now` 可注入 —— 用例因此不必真的等 30 分钟才能看到第二次退避。
   *
   * ★ 它的异常**向上抛**：调用方（`safeTick` / 用例）需要知道这一轮失败了；
   *   `safeTick` 会把它变成一条 error 日志，而不是让计时器回调把异常甩到
   *   `unhandledRejection`。
   */
  async tick(now: Date = new Date()): Promise<PushRetryTickResult> {
    const result = emptyTickResult()

    const expiredCount = await this.repository.expireOverdue(now, PUSH_RETRY_EXPIRED_MESSAGE)
    result.expired += expiredCount
    if (expiredCount > 0) this.metrics.recordExpired(expiredCount)

    const rows = await this.repository.claimDue({
      now,
      limit: this.config.batchSize,
      claimTimeoutMs: this.config.claimTimeoutMs
    })
    result.claimed = rows.length
    this.metrics.recordClaimed(rows.length)

    for (const row of rows) {
      try {
        const outcome = await this.settle(row, now)
        result[outcome] += 1
      } catch (error) {
        // 结算失败（数据库抖动 / 行被并发改掉）：**不**动这一行。
        // 它停在 `sending`，`claimTimeoutMs` 之后会被重新领取 —— 这是自愈路径。
        const detail = error instanceof Error ? error.message : String(error)
        this.log.error(`推送重试结算失败（id=${row.id}，${row.dedupeKey}）：${detail}`)
      }
    }

    if (result.claimed > 0 || result.expired > 0) {
      this.log.log(`一轮结算：${describeTick(result)}｜${this.metrics.toLogLine()}`)
    }
    return result
  }

  /** 计时器回调：吞掉异常并保证不重入。 */
  private async safeTick(): Promise<void> {
    if (this.running) {
      this.log.debug('上一轮还没跑完，跳过本轮')
      return
    }
    this.running = true
    try {
      await this.tick(new Date())
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log.error(`推送重试扫描失败（下一轮继续）：${detail}`)
    } finally {
      this.running = false
    }
  }

  /** 单条结算：过期的先过期，其余发一次再决定下一步。 */
  private async settle(row: PushRetryRow, now: Date): Promise<SettleOutcome> {
    if (row.message === null) {
      await this.repository.markDead(row.id, PUSH_RETRY_INVALID_PAYLOAD_MESSAGE, now)
      this.metrics.recordDead(PUSH_RETRY_INVALID_PAYLOAD_MESSAGE, 'structural')
      return 'dead'
    }

    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.repository.markExpired(row.id, PUSH_RETRY_EXPIRED_MESSAGE, now)
      this.metrics.recordExpired(1)
      return 'expired'
    }

    let result: PushResult
    try {
      result = await withTimeout(this.delivery.send(row.message), PUSH_SEND_TIMEOUT_MS)
    } catch (error) {
      return this.settleFailure(row, now, describePushThrow(error), 'provider_error')
    }

    if (result.delivered) {
      await this.repository.markSent(row.id, result.providerMessageId ?? null, now)
      this.metrics.recordSent()
      return 'sent'
    }
    return this.settleFailure(row, now, describePushFailure(result), result.reason)
  }

  /**
   * 失败结算 —— 本文件里唯一需要「想清楚」的地方。
   *
   * 两条岔路（细节见 `push-retry.policy.ts` 文件头）：
   *   transient（`provider_error`）⇒ `attempts + 1`，按退避排下一次；用满 ⇒ `dead`；
   *   structural（没设备 / 没配网关）⇒ `attempts` **不变**，固定 5 分钟后再试；
   *   下一次已经越过 `expiresAt` ⇒ 直接 `expired`（别排一个永远到不了的期）。
   */
  private async settleFailure(
    row: PushRetryRow,
    now: Date,
    lastError: string,
    reason: Parameters<typeof classifyPushFailure>[0]
  ): Promise<SettleOutcome> {
    const failureClass = classifyPushFailure(reason)

    if (failureClass === 'transient') {
      const attempts = row.attempts + 1
      if (isRetryExhausted(attempts, row.maxAttempts)) {
        await this.repository.markDead(row.id, lastError, now)
        this.metrics.recordDead(lastError, failureClass)
        this.alarmIfNeeded()
        return 'dead'
      }
      await this.repository.markRetry({
        id: row.id,
        attempts,
        nextAttemptAt: new Date(now.getTime() + backoffDelayMs(attempts)),
        lastError
      })
      this.metrics.recordRetried(lastError, failureClass)
      this.alarmIfNeeded()
      return 'retried'
    }

    const nextAttemptAt = new Date(now.getTime() + structuralDelayMs())
    if (nextAttemptAt.getTime() >= row.expiresAt.getTime()) {
      await this.repository.markExpired(row.id, lastError, now)
      this.metrics.recordExpired(1)
      return 'expired'
    }
    await this.repository.markRetry({
      id: row.id,
      attempts: row.attempts,
      nextAttemptAt,
      lastError
    })
    this.metrics.recordRetried(lastError, failureClass)
    return 'retried'
  }

  private alarmIfNeeded(): void {
    if (!this.metrics.consumeAlarm()) return
    const snapshot = this.metrics.snapshot()
    this.log.warn(
      `推送渠道连续失败 ${snapshot.consecutiveFailures} 次（最近一次：${snapshot.lastError ?? '未知'}）` +
        ' —— 请检查网关凭据 / 网络；队列会在 TTL 内继续重试'
    )
  }
}

/** 一行摘要（日志与用例共用同一措辞，避免「日志里看不出这一轮做了什么」）。 */
export function describeTick(result: PushRetryTickResult): string {
  return (
    `claimed=${result.claimed} sent=${result.sent} retried=${result.retried} ` +
    `dead=${result.dead} expired=${result.expired}`
  )
}

/**
 * 给一次外部调用套上上限。
 *
 * ★ 与 `NotificationsService` 的兜底同一手法、同一个时长（`PUSH_SEND_TIMEOUT_MS`）：
 *   「失败」必须包含「太慢」，否则一个永不 resolve 的网关会把 worker 永久卡在
 *   同一行上（`running` 保护让后续每一轮都跳过 —— 队列看上去还在，其实死了）。
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`推送适配器 ${timeoutMs}ms 未返回`)), timeoutMs)
        timer.unref()
      })
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

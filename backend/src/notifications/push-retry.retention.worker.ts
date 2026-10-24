import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'

import {
  PUSH_RETRY_RETENTION_CONFIG,
  PUSH_RETRY_RETENTION_MAX_ROUNDS,
  PUSH_RETRY_RETENTION_PORT,
  PUSH_RETRY_RETENTION_STATUSES,
  describeRetention,
  emptyRetentionResult,
  retentionCutoffs,
  type PushRetryRetentionConfig,
  type PushRetryRetentionPort,
  type PushRetryRetentionStatus,
  type PushRetryRetentionTickResult
} from './push-retry.retention'

/**
 * 队列保留清理 worker（W6-D，2026-10-24）。
 *
 * ── 它删什么、不删什么 ────────────────────────────────────────────────────
 *   每轮对 `sent` / `expired` / `dead` 三个终态各删若干批（`updatedAt` 早于各自
 *   保留期）；`pending` / `sending` 一行都不动。所以本 worker 跑与不跑，
 *   **都不影响任何一条尚未送达的推送** —— 这是它可以默认开启的前提。
 *
 * ── 为什么「部分失败」不静默吞掉 ───────────────────────────────────────────
 *   三个状态是独立的删除；某个失败（例如锁超时）不该让另外两个白跑，所以
 *   逐个 try/catch 后继续；但**最后仍然抛错**，让 `safeTick`（和用例）看到
 *   「这一轮没删干净」，而不是打一行 warn 就当成功。
 *
 * ── 计时器纪律（与 `PushRetryWorker` / `NotificationsReconcileWorker` 相同）──
 *   构造函数里不启动；只有 `main.ts` 调 `start()`，`unref()` 掉。
 */
@Injectable()
export class PushRetryRetentionWorker implements OnApplicationShutdown {
  private readonly log = new Logger(PushRetryRetentionWorker.name)
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    @Inject(PUSH_RETRY_RETENTION_PORT) private readonly port: PushRetryRetentionPort,
    @Inject(PUSH_RETRY_RETENTION_CONFIG) private readonly config: PushRetryRetentionConfig
  ) {}

  start(): void {
    if (this.timer !== null) return
    if (!this.config.enabled) {
      this.log.warn('PUSH_RETRY_RETENTION_ENABLED=0 —— 推送队列保留清理不启动（表会一直长）')
      return
    }
    this.timer = setInterval(() => {
      void this.safeTick()
    }, this.config.intervalMs)
    this.timer.unref()
    this.log.log(
      `推送队列保留清理已启动（每 ${this.config.intervalMs}ms 一轮；` +
        `sent>${this.config.sentMs}ms / expired>${this.config.expiredMs}ms / ` +
        `dead>${this.config.deadMs}ms，每批 ${this.config.batchSize} 行）`
    )
    // 启动即清一轮：重启频繁时可把「积压了一整轮间隔」的删除量提前消化。
    void this.safeTick()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
    this.log.log('推送队列保留清理已停止')
  }

  onApplicationShutdown(): void {
    this.stop()
  }

  /**
   * 一轮清理。`now` 可注入 —— 用例固定时钟即可断言截止线，不必真的等到一周后。
   */
  async tick(now: Date = new Date()): Promise<PushRetryRetentionTickResult> {
    const cutoffs = retentionCutoffs(now, this.config)
    const result = emptyRetentionResult()
    const failures: string[] = []

    for (const status of PUSH_RETRY_RETENTION_STATUSES) {
      const before = cutoffFor(status, cutoffs)
      try {
        result[status] = await this.deleteStatus(status, before)
        result.total += result[status]
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        failures.push(`${status}: ${detail}`)
        this.log.error(`保留清理失败（status=${status}）：${detail}`)
      }
    }

    if (result.total > 0) {
      this.log.log(`推送队列保留清理完成：${describeRetention(result)}`)
    } else {
      this.log.debug(`推送队列保留清理：无需删除（${describeRetention(result)}）`)
    }

    if (failures.length > 0) {
      throw new Error(`推送队列保留清理部分失败：${failures.join('；')}`)
    }
    return result
  }

  /** 单个状态：删到「一批没满」或「批数用尽」为止。 */
  private async deleteStatus(
    status: PushRetryRetentionStatus,
    before: Date
  ): Promise<number> {
    let deleted = 0
    for (let round = 0; round < PUSH_RETRY_RETENTION_MAX_ROUNDS; round += 1) {
      const count = await this.port.deleteSettled({
        status,
        before,
        limit: this.config.batchSize
      })
      deleted += count
      if (count < this.config.batchSize) return deleted
      if (round === PUSH_RETRY_RETENTION_MAX_ROUNDS - 1) {
        this.log.debug(
          `status=${status} 已达到本轮 ${PUSH_RETRY_RETENTION_MAX_ROUNDS} 批上限，剩余留待下一轮`
        )
      }
    }
    return deleted
  }

  private async safeTick(): Promise<void> {
    if (this.running) {
      this.log.debug('上一轮保留清理还没跑完，跳过本轮')
      return
    }
    this.running = true
    try {
      await this.tick(new Date())
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log.error(`保留清理失败（下一轮继续）：${detail}`)
    } finally {
      this.running = false
    }
  }
}

/** 状态 → 截止时刻。写成函数而不是 `cutoffs[status]`，避免拼错键名时拿到 `undefined`。 */
function cutoffFor(
  status: PushRetryRetentionStatus,
  cutoffs: ReturnType<typeof retentionCutoffs>
): Date {
  switch (status) {
    case 'sent':
      return cutoffs.sentBefore
    case 'expired':
      return cutoffs.expiredBefore
    case 'dead':
      return cutoffs.deadBefore
  }
}

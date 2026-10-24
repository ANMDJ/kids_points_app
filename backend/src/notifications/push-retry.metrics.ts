import { Injectable } from '@nestjs/common'

import {
  PUSH_RETRY_CONSECUTIVE_FAILURE_ALARM,
  type PushFailureClass
} from './push-retry.policy'

/**
 * 推送重试的**进程内计数**（W6-B，2026-10-24）。
 *
 * ── 它回答什么问题 ────────────────────────────────────────────────────────
 *   「推送到底有没有在发」——这个问题在只有日志的世界里只能靠 grep。
 *   计数把它变成一行可读的数字（`toLogLine()`），每次有结算就写一条 info。
 *
 * ── 为什么是进程内，而不是一张统计表 ────────────────────────────────────────
 *   队列表本身已经给了**按事实**的答案（`status = 'dead'` 有多少条、
 *   `lastError` 是什么）。再建一张统计表，就得考虑「统计写失败怎么办」
 *   —— 那会把一个观测问题变成一个一致性问题。
 *   进程内计数的诚实边界写在这里：**它随重启归零，多实例各算各的**。
 *   需要跨实例口径时查表，不要查这里。
 *
 * ── 连续性，而不是总数 ────────────────────────────────────────────────────
 *   `consecutiveFailures` 在 `recordSent()` 时归零。告警看的是它 ——
 *   「连续 3 次失败」说明渠道此刻是坏的；「累计 300 次失败」只说明用得久。
 */
@Injectable()
export class PushRetryMetrics {
  private enqueued = 0
  private duplicates = 0
  private enqueueFailures = 0
  private expired = 0
  private claimed = 0
  private sent = 0
  private retried = 0
  private dead = 0
  private transientFailures = 0
  private structuralFailures = 0
  private consecutiveFailures = 0
  private alarmConsumed = false
  private lastError: string | null = null
  private lastOutcomeAt: Date | null = null

  /** 入队成功（新行）。`count` 允许批量写入一次记多条。 */
  recordEnqueued(count = 1): void {
    this.enqueued += count
  }

  /** 入队撞上唯一约束 —— 正常（同一件事重放），单独计数以免看起来像故障。 */
  recordDuplicate(count = 1): void {
    this.duplicates += count
  }

  /** 入队本身失败（无库 / 连接池耗尽）：推送会因此**失去重试机会**，必须可见。 */
  recordEnqueueFailure(): void {
    this.enqueueFailures += 1
  }

  recordClaimed(count: number): void {
    this.claimed += count
  }

  recordSent(): void {
    this.sent += 1
    this.consecutiveFailures = 0
    // 成功即恢复：下一次连续失败可以再告警一次（否则一次故障之后永不告警）。
    this.alarmConsumed = false
    this.lastOutcomeAt = new Date()
  }

  recordRetried(error: string, failureClass: PushFailureClass): void {
    this.retried += 1
    this.recordFailure(error, failureClass)
  }

  recordDead(error: string, failureClass: PushFailureClass): void {
    this.dead += 1
    this.recordFailure(error, failureClass)
  }

  recordExpired(count: number): void {
    this.expired += count
  }

  /**
   * 告警闸门：**跨过阈值后的第一次调用**返回 `true`，之后保持 `false`，直到
   * 一次成功（`recordSent()`）把它重新武装。
   *
   * 为什么不用 `===`：那条路径只在「每次失败都立刻调用一次」时成立；若两次
   * 失败之间没人调用（例如一轮里结算了三条），阈值会被**跨过去**而永远不响。
   * 用「≥ 阈值 + 已消费标记」则无论调用节奏如何都只响一次，且晚到的调用
   * 也能补上这次告警 —— 宁可晚一条，也不要漏。
   */
  consumeAlarm(): boolean {
    if (this.alarmConsumed) return false
    if (this.consecutiveFailures < PUSH_RETRY_CONSECUTIVE_FAILURE_ALARM) return false
    this.alarmConsumed = true
    return true
  }

  snapshot(): {
    enqueued: number
    duplicates: number
    enqueueFailures: number
    expired: number
    claimed: number
    sent: number
    retried: number
    dead: number
    transientFailures: number
    structuralFailures: number
    consecutiveFailures: number
    lastError: string | null
    lastOutcomeAt: string | null
  } {
    return {
      enqueued: this.enqueued,
      duplicates: this.duplicates,
      enqueueFailures: this.enqueueFailures,
      expired: this.expired,
      claimed: this.claimed,
      sent: this.sent,
      retried: this.retried,
      dead: this.dead,
      transientFailures: this.transientFailures,
      structuralFailures: this.structuralFailures,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastOutcomeAt: this.lastOutcomeAt?.toISOString() ?? null
    }
  }

  /** 一行日志（info）。字段名用英文，值里可以是中文 —— 方便 grep `push-retry`。 */
  toLogLine(): string {
    const s = this.snapshot()
    return (
      `push-retry enqueued=${s.enqueued} dup=${s.duplicates} enqueueFailed=${s.enqueueFailures} ` +
      `claimed=${s.claimed} sent=${s.sent} retried=${s.retried} dead=${s.dead} expired=${s.expired} ` +
      `transient=${s.transientFailures} structural=${s.structuralFailures} consecutive=${s.consecutiveFailures}`
    )
  }

  private recordFailure(error: string, failureClass: PushFailureClass): void {
    if (failureClass === 'transient') this.transientFailures += 1
    else this.structuralFailures += 1
    this.consecutiveFailures += 1
    this.lastError = error
    this.lastOutcomeAt = new Date()
  }
}

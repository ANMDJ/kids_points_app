import { Logger } from '@nestjs/common'

import type { PushRetryConfig } from './push-retry.config'
import { PushRetryMetrics } from './push-retry.metrics'
import type { PushRetryPort } from './push-retry.repository'
import { buildPushRetryDedupeKey } from './push-retry.types'
import { describePushFailure, describePushThrow } from './push-retry.policy'
import type { PushMessage, PushPort, PushResult } from './push.port'

/**
 * 给推送端口套上「失败即入队」的**装饰器**（W6-B，2026-10-24）。
 *
 * ── 为什么是装饰器，而不是改 `NotificationsService` ─────────────────────────
 *   ① `NotificationsService` 只该做一件事：**站内先写、再尽力推送**。让它同时
 *      操心「入队 / 去重 / TTL」，那条「通知永不抛错」的口径会立刻长出分支；
 *   ② 装饰器让「原始渠道」与「带重试的渠道」是**同一个接口的两个实例**
 *      （`PUSH_DELIVERY_PORT` vs `PUSH_PORT`）。worker 用前者（只发一次，失败由
 *      它自己结算），业务用后者（发一次 + 失败入队）——重复入队由唯一约束兜住，
 *      所以即使两者用错也不会变成两条；
 *   ③ 用例里 `new NotificationsService(fakePush, fakeRepo)` **一行都不用改**：
 *      「推送是否入队」是在端口那一层被测的，不是在 service 里。
 *
 * ── ★ 三条不可违背的约束 ─────────────────────────────────────────────────
 *   ① 入队失败**绝不**抛给调用方：否则一次数据库抖动会把已经提交的批准变成 500
 *      （`01` §4 的反面教材）。记 warn + 计数，然后原样返回适配器的结果；
 *   ② 适配器抛错时**先入队、再把原错误抛出去**：`NotificationsService` 依赖
 *      那个异常走它的 `provider_error` 兜底分支；吞掉它会让失败变成成功；
 *   ③ 返回值**原样透传**：`delivered: true` 就是 true，不因为「我们顺手记了一笔」
 *      而改变语义。
 *
 * ── 诚实边界 ──────────────────────────────────────────────────────────────
 *   这不是完整 outbox：请求路径**仍然先同步试一次**（1s 兜底）。真正的 outbox
 *   是把入队放进业务事务内、请求路径**完全不发**；那会改变通知与账本的相对位置，
 *   见 30 号交接单 §5。
 */
export class PushRetryAdapter implements PushPort {
  private readonly log = new Logger(PushRetryAdapter.name)

  constructor(
    private readonly inner: PushPort,
    private readonly repository: PushRetryPort,
    private readonly config: PushRetryConfig,
    private readonly metrics: PushRetryMetrics
  ) {}

  async send(message: PushMessage): Promise<PushResult> {
    let result: PushResult
    try {
      result = await this.inner.send(message)
    } catch (error) {
      // 见约束 ②：先入队（渠道故障 ⇒ transient），再把原错误原样抛出去。
      await this.enqueue(message, describePushThrow(error))
      throw error
    }

    if (!result.delivered) {
      // 三种未送达原因都会入队，但**命运不同**：`provider_error` 消耗尝试次数，
      // 另外两种不消耗（见 `push-retry.policy.ts`）。
      await this.enqueue(message, describePushFailure(result))
    }
    return result
  }

  /** 入队一次；任何异常都在这里被吃掉（约束 ①）。 */
  private async enqueue(message: PushMessage, lastError: string): Promise<void> {
    try {
      const now = new Date()
      const outcome = await this.repository.enqueue({
        message,
        dedupeKey: buildPushRetryDedupeKey(message),
        now,
        expiresAt: new Date(now.getTime() + this.config.ttlMs),
        maxAttempts: this.config.maxAttempts,
        lastError
      })
      if (outcome === 'queued') this.metrics.recordEnqueued()
      else this.metrics.recordDuplicate()
      this.log.debug(
        `推送未送达，已${outcome === 'queued' ? '入队' : '确认已在队列中'}（${lastError}）`
      )
    } catch (error) {
      this.metrics.recordEnqueueFailure()
      const detail = error instanceof Error ? error.message : String(error)
      this.log.warn(`推送重试入队失败（不影响业务，本条推送不会重试）：${detail}`)
    }
  }
}

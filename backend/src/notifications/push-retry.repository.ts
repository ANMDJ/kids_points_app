import { Injectable, NotImplementedException } from '@nestjs/common'

import type {
  ClaimDuePushRetryInput,
  EnqueuePushRetryInput,
  EnqueuePushRetryResult,
  MarkPushRetryInput,
  PushRetryRow
} from './push-retry.types'

/**
 * 推送重试队列的**持久化端口**（W6-B，2026-10-24）。
 *
 * ── 六个方法，各自只回答一件结构事实 ────────────────────────────────────────
 *   `enqueue`       往队列里放一条（重复 ⇒ `'duplicate'`，**不是**错误）
 *   `claimDue`      领一批「现在该发」的行，并原子地标成 `sending`
 *   `markSent`      送达
 *   `markRetry`     没送达、但还有下一次
 *   `markDead`      用满尝试次数，放弃
 *   `markExpired`   超过 TTL，放弃（与 `dead` 分开：原因不同）
 *   `expireOverdue` 清扫（每轮先跑，避免过期行被领走）
 *
 * ── 为什么 `claimDue` 必须**原子**（这是本端口唯一真正难的部分）────────────
 *   「先 SELECT 再 UPDATE」在两个进程之间会让同一条推送发两次 —— 而推送是
 *   **不可撤回的外部副作用**（用户手机上会响两次）。所以领取必须是单条
 *   `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING ...`：
 *     · `SKIP LOCKED` ⇒ 多实例部署时各领各的，不互相等；
 *     · `RETURNING`   ⇒ 「谁领到了」与「标记成 sending」是同一个原子事实。
 *   真实实现在 `push-retry.prisma.repository.ts`；本接口只承诺这个语义。
 *
 * ── 无库装配 ──────────────────────────────────────────────────────────────
 *   全部 501。`enqueue` 的 501 会被 `PushRetryAdapter` 吞掉并记 warn
 *   （推送失败绝不能反过来把审批请求打挂）；worker 在没有库时**根本不会启动**
 *   （`main.ts` 按 `hasDatabaseUrl()` 判断），所以其余方法不会被调用。
 */
export const PUSH_RETRY_REPOSITORY = Symbol('PUSH_RETRY_REPOSITORY')

export interface PushRetryPort {
  /** 写入一条待重试的推送；`dedupeKey` 已存在 ⇒ `'duplicate'`（幂等，不覆盖原行）。 */
  enqueue(input: EnqueuePushRetryInput): Promise<EnqueuePushRetryResult>

  /**
   * 领取最多 `limit` 条该发的行，并原子地标为 `sending`。
   *
   * 三条筛选口径：
   *   ① `pending` 且 `nextAttemptAt <= now`；
   *   ② `sending` 且 `claimedAt <= now - claimTimeoutMs`（进程崩了的回收）；
   *   ③ `expiresAt > now`（过期的由 `expireOverdue` 处理，不进发送路径）。
   */
  claimDue(input: ClaimDuePushRetryInput): Promise<PushRetryRow[]>

  markSent(id: string, providerMessageId: string | null, now: Date): Promise<void>

  markRetry(input: MarkPushRetryInput): Promise<void>

  markDead(id: string, lastError: string, now: Date): Promise<void>

  /** 条件更新：只有仍处于 `pending` / `sending` 才算过期；返回是否真的改到了行。 */
  markExpired(id: string, lastError: string, now: Date): Promise<boolean>

  /** 批量清扫；返回条数。 */
  expireOverdue(now: Date, lastError: string): Promise<number>
}

/** 无库装配：全部 501（不假装入队、不假装领取、不假装送达）。 */
@Injectable()
export class NotImplementedPushRetryRepository implements PushRetryPort {
  async enqueue(_input: EnqueuePushRetryInput): Promise<EnqueuePushRetryResult> {
    throw this.notImplemented('推送重试入队')
  }

  async claimDue(_input: ClaimDuePushRetryInput): Promise<PushRetryRow[]> {
    throw this.notImplemented('领取待重试推送')
  }

  async markSent(_id: string, _providerMessageId: string | null, _now: Date): Promise<void> {
    throw this.notImplemented('标记推送已送达')
  }

  async markRetry(_input: MarkPushRetryInput): Promise<void> {
    throw this.notImplemented('顺延重试')
  }

  async markDead(_id: string, _lastError: string, _now: Date): Promise<void> {
    throw this.notImplemented('标记推送放弃')
  }

  async markExpired(_id: string, _lastError: string, _now: Date): Promise<boolean> {
    throw this.notImplemented('标记推送过期')
  }

  async expireOverdue(_now: Date, _lastError: string): Promise<number> {
    throw this.notImplemented('清扫过期推送')
  }

  private notImplemented(action: string): NotImplementedException {
    return new NotImplementedException({
      code: 'NOT_IMPLEMENTED',
      message: `${action}需要数据库连接（DATABASE_URL 未设置）`
    })
  }
}

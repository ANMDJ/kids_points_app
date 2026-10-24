import { Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type { PushRetryPort } from './push-retry.repository'
import {
  isPushRetryStatus,
  parsePushMessage,
  type ClaimDuePushRetryInput,
  type EnqueuePushRetryInput,
  type EnqueuePushRetryResult,
  type MarkPushRetryInput,
  type PushRetryRow,
  type PushRetryStatus
} from './push-retry.types'

/**
 * 推送重试队列端口的 **Prisma 适配器**（W6-B，2026-10-24）。
 *
 * ── 本文件只有一处「难」的 SQL：领取（`claimDue`）───────────────────────────
 *   ```sql
 *   UPDATE "PushRetryJob" AS job
 *   SET status = 'sending', "claimedAt" = now
 *   WHERE job.id IN (
 *     SELECT id FROM "PushRetryJob"
 *     WHERE "expiresAt" > now
 *       AND ((status = 'pending' AND "nextAttemptAt" <= now)
 *         OR (status = 'sending' AND "claimedAt" <= staleBefore))
 *     ORDER BY "nextAttemptAt"
 *     LIMIT n
 *     FOR UPDATE SKIP LOCKED
 *   )
 *   RETURNING ...
 *   ```
 *   · `FOR UPDATE SKIP LOCKED` —— 多实例 / 多轮并发时**同一条只会被一个 worker 领到**
 *     （推送是不可撤回的外部副作用，重复发送等于让用户手机响两次）；
 *   · `LIMIT` 在子查询里 —— 锁的也是这 n 条，不会把整张表锁住；
 *   · **一条语句**完成「选 + 标记」—— 分成两条就会出现「A 选完、B 也选到、两人都发」；
 *   · 返回前在应用侧再按 `nextAttemptAt` 排一次：`RETURNING` 的行序在 Postgres 里
 *     **未定义**（实测按更新顺序），而 worker 是按数组顺序发送的。
 *
 * ── 其余五处都是条件 UPDATE / 幂等 INSERT ──────────────────────────────────
 *   · `enqueue` 靠 `dedupeKey` 唯一约束（`P2002`）回答 `'duplicate'`，不先查后写；
 *   · 三个 `mark*` 用 `updateMany`：**条件不满足就算 0 行**，不抛错
 *     （行可能已被另一实例改成终态，那是正常竞争，不是故障）；
 *   · 终态（`sent` / `dead` / `expired`）一律把 `claimedAt` 清空 ——
 *     它的语义是「正在发送中的那一次领取」，留下旧值会让排查时误判。
 */

/** `$queryRaw` 回来的行（列名与 `RETURNING` 一致；`status` 先按 `string` 读再校验）。 */
interface RawPushRetryRow {
  id: string
  event: string
  dedupeKey: string
  payload: unknown
  recipientUserId: string
  childId: string
  status: string
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

@Injectable()
export class PrismaPushRetryRepository implements PushRetryPort {
  private readonly log = new Logger(PrismaPushRetryRepository.name)

  constructor(private readonly prisma: PrismaService) {}

  async enqueue(input: EnqueuePushRetryInput): Promise<EnqueuePushRetryResult> {
    try {
      await this.prisma.pushRetryJob.create({
        data: {
          event: input.message.type,
          dedupeKey: input.dedupeKey,
          // 消息**原样**存进去：worker 送回去的必须与当初那条一字不差，
          // 否则重试就成了「重新生成一条内容可能已经变了的通知」。
          payload: input.message as unknown as Prisma.InputJsonValue,
          recipientUserId: input.message.recipientUserId,
          childId: input.message.childId,
          status: 'pending',
          attempts: 0,
          maxAttempts: input.maxAttempts,
          nextAttemptAt: input.now,
          expiresAt: input.expiresAt,
          lastError: input.lastError ?? null
        }
      })
      return 'queued'
    } catch (error) {
      // 唯一约束 = 同一件事再次入队（重放 / 并发 / worker 重启）。
      // ★ 这里**不刷新** `nextAttemptAt`：已有那一行带着它自己的退避进度，
      //   被「重新入队」重置只会让它永远停在第一次重试的间隔上。
      if (isUniqueViolation(error)) return 'duplicate'
      // 其它错误（连接池耗尽 / 表不存在）**必须**抛出去：`PushRetryAdapter`
      // 会记 warn + 计数，但不会让它打断业务请求。吞掉它才是真的丢消息。
      throw error
    }
  }

  async claimDue(input: ClaimDuePushRetryInput): Promise<PushRetryRow[]> {
    const now = input.now
    const staleBefore = new Date(now.getTime() - input.claimTimeoutMs)
    const limit = Math.max(1, Math.floor(input.limit))

    const rows = await this.prisma.$queryRaw<RawPushRetryRow[]>`
      UPDATE "PushRetryJob" AS job
      SET "status" = 'sending', "claimedAt" = ${now}, "updatedAt" = ${now}
      WHERE job."id" IN (
        SELECT "id" FROM "PushRetryJob"
        WHERE "expiresAt" > ${now}
          AND (
            ("status" = 'pending' AND "nextAttemptAt" <= ${now})
            OR ("status" = 'sending' AND "claimedAt" IS NOT NULL AND "claimedAt" <= ${staleBefore})
          )
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING job."id", job."event", job."dedupeKey", job."payload",
                job."recipientUserId", job."childId", job."status", job."attempts",
                job."maxAttempts", job."nextAttemptAt", job."expiresAt", job."claimedAt",
                job."lastError", job."providerMessageId", job."sentAt", job."createdAt"
    `

    // ★ `RETURNING` 的行序在 Postgres 里是**未定义**的（实测按更新/物理顺序返回，
    //   不是子查询里的 `ORDER BY`）。worker 按数组顺序发送，所以这里显式再排一次：
    //   否则「拖得最久的最先发」只在某些执行计划下成立，重启一次就换一个顺序。
    const ordered = [...rows].sort(
      (left, right) =>
        left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() ||
        left.createdAt.getTime() - right.createdAt.getTime()
    )
    return ordered.map((row) => this.toRow(row, now))
  }

  async markSent(id: string, providerMessageId: string | null, now: Date): Promise<void> {
    const result = await this.prisma.pushRetryJob.updateMany({
      where: { id },
      data: { status: 'sent', sentAt: now, claimedAt: null, providerMessageId, lastError: null }
    })
    this.logIfMissing(result.count, id, 'sent')
  }

  async markRetry(input: MarkPushRetryInput): Promise<void> {
    const result = await this.prisma.pushRetryJob.updateMany({
      where: { id: input.id },
      data: {
        status: 'pending',
        attempts: input.attempts,
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError,
        claimedAt: null
      }
    })
    this.logIfMissing(result.count, input.id, 'pending')
  }

  async markDead(id: string, lastError: string, _now: Date): Promise<void> {
    const result = await this.prisma.pushRetryJob.updateMany({
      where: { id },
      data: { status: 'dead', lastError, claimedAt: null }
    })
    this.logIfMissing(result.count, id, 'dead')
  }

  async markExpired(id: string, lastError: string, _now: Date): Promise<boolean> {
    const result = await this.prisma.pushRetryJob.updateMany({
      where: { id, status: { in: ['pending', 'sending'] } },
      data: { status: 'expired', lastError, claimedAt: null }
    })
    return result.count > 0
  }

  async expireOverdue(now: Date, lastError: string): Promise<number> {
    const result = await this.prisma.pushRetryJob.updateMany({
      where: { status: { in: ['pending', 'sending'] }, expiresAt: { lte: now } },
      data: { status: 'expired', lastError, claimedAt: null }
    })
    return result.count
  }

  /**
   * 原始行 → 领域行。
   *
   * `status` 用守卫（而不是 `as`）：DB 里出现第六个枚举值时，这里必须**响亮失败**
   * —— 静默断言会让 worker 把它当成「不认识的状态」既不领也不报。
   * `payload` 反之：坏 payload 只影响这一条，交给 worker 标 `dead`。
   */
  private toRow(row: RawPushRetryRow, now: Date): PushRetryRow {
    if (!isPushRetryStatus(row.status)) {
      throw new Error(`PushRetryJob.status 出现未知值：${row.status}（id=${row.id}）`)
    }
    if (row.expiresAt.getTime() <= now.getTime()) {
      // 领件 SQL 已排除过期行；走到这里说明时钟在两条语句之间跨过了 TTL —— 极少见，
      // 但把「已过期」当正常行送出去会让 `expired` 语义失真。
      // 这里不抛错：交给 worker 先 `markExpired` 结算。
      this.log.debug(`领到一条刚好过期的推送（id=${row.id}），交给 worker 结算`)
    }
    return {
      id: row.id,
      event: row.event,
      dedupeKey: row.dedupeKey,
      message: parsePushMessage(row.payload),
      recipientUserId: row.recipientUserId,
      childId: row.childId,
      status: row.status as PushRetryStatus,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      nextAttemptAt: row.nextAttemptAt,
      expiresAt: row.expiresAt,
      claimedAt: row.claimedAt,
      lastError: row.lastError,
      providerMessageId: row.providerMessageId,
      sentAt: row.sentAt,
      createdAt: row.createdAt
    }
  }

  /** `updateMany` 改到 0 行不是错误（另一实例已把它推成终态），但值得留一条 debug。 */
  private logIfMissing(count: number, id: string, status: PushRetryStatus): void {
    if (count === 0) {
      this.log.debug(`PushRetryJob ${id} 已不在可写状态，跳过标记 ${status}`)
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

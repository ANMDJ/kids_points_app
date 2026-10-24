import { Inject, Injectable, NotImplementedException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import type { ActionType } from '../contracts/permission-matrix'
import {
  approvalNotificationContent,
  approvalSubmittedContent,
  buildApprovalStatusChangedMessage,
  buildApprovalSubmittedMessage
} from './approval-notification.content'
import { PUSH_RETRY_CONFIG, type PushRetryConfig } from './push-retry.config'
import { PushRetryMetrics } from './push-retry.metrics'
import { buildPushRetryDedupeKey } from './push-retry.types'
import type { PushMessage } from './push.port'

/**
 * 审批通知的 **outbox**（W6-C，2026-10-24）。
 *
 * ── 它解决的那条缝隙 ──────────────────────────────────────────────────────
 *   W6-B 的顺序是「业务事务提交 → 同步试发一次 → 失败才入队」。如果进程在
 *   「提交」与「入队」之间崩掉，这条提醒**永久丢失**，`PushRetryJob` 里连一行
 *   都没有。现在改为：`Notification` 与 `PushRetryJob` 在**审批事务内**写入，
 *   请求路径**完全不发送**；worker 是唯一发送者。
 *
 * ── 为什么这不违反 `01` §4 ────────────────────────────────────────────────
 *   §4 禁止的是「**外部推送**放进账本事务」—— 推送服务不可靠，失败会回滚一笔
 *   已经成立的加分。本文件只写**同一个数据库里的两行**（`Notification` /
 *   `PushRetryJob`），不调用任何第三方。外部推送仍然在 worker 里、事务之外。
 *   本地库写不进去时，审批本身也写不进去 —— 这不是「推送失败回滚账本」，
 *   而是「同一个事务没有提交」。
 *
 * ── 收件人解析 ────────────────────────────────────────────────────────────
 *   `approval.submitted` 的收件人是这个孩子的 **active guardian**，并**排除提交人**
 *   （家长自己提交、需另一位确认时，不能只发给他自己）。解析与写入在同一个
 *   事务里完成：成员位在提交那一刻是什么样，通知就发给谁。
 *
 * ── 失败边界 ──────────────────────────────────────────────────────────────
 *   本端口的方法**允许抛错**：outbox 是业务事务的一部分，静默吞掉会让
 *   「审批已提交、提醒没有行」重新变成一条看不见的缝隙。外部推送的失败仍由
 *   `PushRetryWorker` 结算，永远不会回滚审批。
 */
export const NOTIFICATIONS_OUTBOX = Symbol('NOTIFICATIONS_OUTBOX')

/** 一次 outbox 写入的结论（便于用例与日志说清「写了几条、撞了几条重复」）。 */
export interface OutboxWriteResult {
  notifications: number
  jobs: number
  /** 去重键已存在、因此**没有**重复入队的条数。 */
  duplicates: number
}

/** 「审批结论变了」→ 申请人。 */
export interface ApprovalStatusChangedOutboxInput {
  approvalId: string
  childId: string
  /** 收件人：申请人（`ApprovalRequest.requesterUserId`）。 */
  recipientUserId: string
  action: ActionType
  status: 'approved' | 'rejected'
  decidedByUserId: string | null
}

/** 「有新申请待确认」→ 这个孩子的 active guardian（排除提交人）。 */
export interface ApprovalSubmittedOutboxInput {
  approvalId: string
  childId: string
  requesterUserId: string
  action: ActionType
}

/**
 * 审批事务内可用的 outbox 端口。
 *
 * ★ `tx` 是**审批事务的客户端**，不是 `PrismaService`：所有写入必须与审批行
 *   同生共死。传 `PrismaService` 会让 outbox 在事务外提交，缝隙原样回来。
 */
export interface NotificationsOutboxPort {
  enqueueApprovalStatusChanged(
    tx: Prisma.TransactionClient,
    input: ApprovalStatusChangedOutboxInput,
    now: Date
  ): Promise<OutboxWriteResult>

  enqueueApprovalSubmitted(
    tx: Prisma.TransactionClient,
    input: ApprovalSubmittedOutboxInput,
    now: Date
  ): Promise<OutboxWriteResult>
}

interface OutboxEntry {
  message: PushMessage
  notification: Prisma.NotificationCreateManyInput
}

/** 有库装配：真写 `Notification` + `PushRetryJob`（同一事务）。 */
@Injectable()
export class PrismaNotificationsOutbox implements NotificationsOutboxPort {
  constructor(
    @Inject(PUSH_RETRY_CONFIG) private readonly config: PushRetryConfig,
    private readonly metrics: PushRetryMetrics
  ) {}

  async enqueueApprovalStatusChanged(
    tx: Prisma.TransactionClient,
    input: ApprovalStatusChangedOutboxInput,
    now: Date
  ): Promise<OutboxWriteResult> {
    const occurredAt = now.toISOString()
    const message = buildApprovalStatusChangedMessage({ ...input, occurredAt })
    const content = approvalNotificationContent(message)
    return this.write(
      tx,
      [
        {
          message,
          notification: {
            childId: message.childId,
            recipientUserId: message.recipientUserId,
            ...content,
            payload: {
              approvalId: message.approvalId,
              status: message.status,
              action: message.action,
              decidedByUserId: message.decidedByUserId
            } as Prisma.InputJsonValue
          }
        }
      ],
      now
    )
  }

  async enqueueApprovalSubmitted(
    tx: Prisma.TransactionClient,
    input: ApprovalSubmittedOutboxInput,
    now: Date
  ): Promise<OutboxWriteResult> {
    const guardians = await tx.childMember.findMany({
      where: { childId: input.childId, role: 'guardian', status: 'active' },
      select: { userId: true }
    })

    // 去重 + 排除提交人 + 丢掉空 id（坏数据不该变成一条发给 `''` 的通知）。
    const recipients = Array.from(new Set(guardians.map((row) => row.userId))).filter(
      (userId) => userId.trim() !== '' && userId !== input.requesterUserId
    )
    if (recipients.length === 0) {
      return { notifications: 0, jobs: 0, duplicates: 0 }
    }

    const occurredAt = now.toISOString()
    const content = approvalSubmittedContent(input.action)
    const entries: OutboxEntry[] = recipients.map((recipientUserId) => {
      const message = buildApprovalSubmittedMessage({
        approvalId: input.approvalId,
        childId: input.childId,
        recipientUserId,
        action: input.action,
        submittedByUserId: input.requesterUserId,
        occurredAt
      })
      return {
        message,
        notification: {
          childId: message.childId,
          recipientUserId: message.recipientUserId,
          ...content,
          payload: {
            approvalId: message.approvalId,
            action: message.action,
            submittedByUserId: message.submittedByUserId
          } as Prisma.InputJsonValue
        }
      }
    })
    return this.write(tx, entries, now)
  }

  /**
   * 同一事务里的两次 `createMany`。
   *
   * ── 为什么先查一次已存在的键 ──────────────────────────────────────────────
   *   `createMany({ skipDuplicates: true })` 会静默跳过重复，但**不会告诉我们
   *   跳过了哪几条**；如果不先查，通知行会照写，而队列行没有 —— 站内多一条、
   *   推送没有，两边从此对不上。先查一遍把重复条目整个排除，至少让「同一审批
   *   被重放」不会多写一条站内通知。
   *
   * ★ 极小的竞态窗口仍在：查完到写入之间，另一个事务可能插入同一 `dedupeKey`。
   *   审批路径上这不会发生（`decide` 先锁行、`createPending` 每次是新 id），
   *   所以这里不引入 advisory lock；真出现时 `skipDuplicates` 保证队列不会重复，
   *   多出来的那条站内通知由后续对账发现（见 W6-C 交接单 §仍未落地）。
   */
  private async write(
    tx: Prisma.TransactionClient,
    entries: OutboxEntry[],
    now: Date
  ): Promise<OutboxWriteResult> {
    if (entries.length === 0) return { notifications: 0, jobs: 0, duplicates: 0 }

    try {
      const keys = entries.map((entry) => buildPushRetryDedupeKey(entry.message))
      const existing = await tx.pushRetryJob.findMany({
        where: { dedupeKey: { in: keys } },
        select: { dedupeKey: true }
      })
      const existingKeys = new Set(existing.map((row) => row.dedupeKey))
      const fresh = entries.filter(
        (entry) => !existingKeys.has(buildPushRetryDedupeKey(entry.message))
      )
      const duplicates = entries.length - fresh.length
      if (fresh.length === 0) {
        this.metrics.recordDuplicate(duplicates)
        return { notifications: 0, jobs: 0, duplicates }
      }

      await tx.notification.createMany({
        data: fresh.map((entry) => entry.notification)
      })
      const jobs = await tx.pushRetryJob.createMany({
        data: fresh.map((entry) => ({
          event: entry.message.type,
          dedupeKey: buildPushRetryDedupeKey(entry.message),
          payload: entry.message as unknown as Prisma.InputJsonValue,
          recipientUserId: entry.message.recipientUserId,
          childId: entry.message.childId,
          status: 'pending' as const,
          attempts: 0,
          maxAttempts: this.config.maxAttempts,
          nextAttemptAt: now,
          expiresAt: new Date(now.getTime() + this.config.ttlMs)
        })),
        // 竞态兜底：真撞上唯一约束时不让整个审批事务回滚。
        skipDuplicates: true
      })

      const skipped = fresh.length - jobs.count
      this.metrics.recordEnqueued(jobs.count)
      if (duplicates + skipped > 0) this.metrics.recordDuplicate(duplicates + skipped)
      return {
        notifications: fresh.length,
        jobs: jobs.count,
        duplicates: duplicates + skipped
      }
    } catch (error) {
      // outbox 写失败 ⇒ 审批事务整体回滚。这不是「推送失败回滚账本」：
      // 外部推送根本没在这里发生；失败的是与审批同一个本地库的写入。
      this.metrics.recordEnqueueFailure()
      throw error
    }
  }
}

/** 无库装配：outbox 没有任何地方可写，响亮失败（绝不静默丢通知）。 */
@Injectable()
export class NotImplementedNotificationsOutbox implements NotificationsOutboxPort {
  async enqueueApprovalStatusChanged(
    _tx: Prisma.TransactionClient,
    _input: ApprovalStatusChangedOutboxInput,
    _now: Date
  ): Promise<OutboxWriteResult> {
    throw this.notImplemented()
  }

  async enqueueApprovalSubmitted(
    _tx: Prisma.TransactionClient,
    _input: ApprovalSubmittedOutboxInput,
    _now: Date
  ): Promise<OutboxWriteResult> {
    throw this.notImplemented()
  }

  private notImplemented(): NotImplementedException {
    return new NotImplementedException({
      code: 'NOTIFICATIONS_OUTBOX_NOT_IMPLEMENTED',
      message:
        '当前装配没有数据库连接：审批通知的 outbox 无处落库，拒绝假装写入成功。' +
        '请配置 DATABASE_URL 后重试。'
    })
  }
}

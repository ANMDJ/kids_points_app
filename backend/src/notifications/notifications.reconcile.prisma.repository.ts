import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import {
  RECONCILED_NOTIFICATION_TYPES,
  type NotificationsReconcilePort,
  type NotificationsReconcileSnapshot
} from './notifications.reconcile'

/**
 * 对账端口的 **Prisma 适配器**（W6-D，2026-10-24）。
 *
 * ── 匹配键为什么是「收件人 + approvalId + 事件语义」──────────────────────────
 *   `Notification` 与 `PushRetryJob` 之间**没有外键**（W6-B 刻意如此：投递事实
 *   必须比业务行活得久）。能对上的唯一事实是 outbox 写两行时用的同一个
 *   `payload.approvalId` 与同一个收件人。事件语义要把两边对齐：
 *     `Notification.type`                    `PushRetryJob.event`
 *     `approval.submitted`             ⇔     `approval.submitted`
 *     `approval.approved` / `.rejected` ⇔    `approval.status_changed`
 *   且后者的 `payload.status` 必须与通知类型一致 —— 只比 approvalId 会把
 *   「批准通知」与「拒绝任务」错配成一对。
 *
 * ── 一条更隐蔽的错配：收件人对不上 ──────────────────────────────────────────
 *   同一 approvalId 可能同时有「发给家长的 submitted」与「发给申请人的
 *   status_changed」两组行。若省略收件人条件，任何一组都能替另一组作证，
 *   对账会恒为 0。所以两处 NOT EXISTS 都带 `recipientUserId`。
 *
 * ── 已知代价 ────────────────────────────────────────────────────────────────
 *   `payload` 是 JSON 列，两个查询都要解 JSON 且没有可用索引；当前数据量很小，
 *   默认 5 分钟一轮可以接受。数据量上来后应改为**在写入时冗余一列**
 *   `approvalId`（可索引），而不是给 `payload->>` 建表达式索引 ——
 *   后者同样会随 JSON 形状漂移。此事已写进 `32-w6d-handoff.md` §5。
 */
@Injectable()
export class PrismaNotificationsReconcile implements NotificationsReconcilePort {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(now: Date): Promise<NotificationsReconcileSnapshot> {
    const notificationsWithoutJob = await this.countNotificationsWithoutJob()
    const jobsWithoutNotification = await this.countJobsWithoutNotification()
    const duplicateNotifications = await this.countDuplicateNotifications()
    const statusCounts = await this.countJobsByStatus()
    const oldestPending = await this.prisma.pushRetryJob.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true }
    })

    return {
      notificationsWithoutJob,
      jobsWithoutNotification,
      duplicateNotifications,
      pending: statusCounts.pending,
      sending: statusCounts.sending,
      sent: statusCounts.sent,
      dead: statusCounts.dead,
      expired: statusCounts.expired,
      oldestPendingAgeMs:
        oldestPending === null
          ? null
          : Math.max(0, now.getTime() - oldestPending.createdAt.getTime()),
      checkedAt: now
    }
  }

  /** 有站内通知、没有对应任务。 */
  private async countNotificationsWithoutJob(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS "count"
      FROM "Notification" n
      WHERE n."type" IN (${Prisma.join(RECONCILED_NOTIFICATION_TYPES)})
        AND NOT EXISTS (
          SELECT 1
          FROM "PushRetryJob" j
          WHERE j."recipientUserId" = n."recipientUserId"
            AND j."payload"->>'approvalId' IS NOT NULL
            AND j."payload"->>'approvalId' = n."payload"->>'approvalId'
            AND j."event" = CASE n."type"
              WHEN 'approval.submitted' THEN 'approval.submitted'
              ELSE 'approval.status_changed'
            END
            AND (
              n."type" = 'approval.submitted'
              OR n."type" = 'approval.' || (j."payload"->>'status')
            )
        )
    `)
    return rows[0]?.count ?? 0
  }

  /** 有推送任务、没有对应站内通知。 */
  private async countJobsWithoutNotification(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      SELECT count(*)::int AS "count"
      FROM "PushRetryJob" j
      WHERE j."event" IN ('approval.submitted', 'approval.status_changed')
        AND NOT EXISTS (
          SELECT 1
          FROM "Notification" n
          WHERE n."recipientUserId" = j."recipientUserId"
            AND n."payload"->>'approvalId' IS NOT NULL
            AND n."payload"->>'approvalId' = j."payload"->>'approvalId'
            AND n."type" = CASE j."event"
              WHEN 'approval.submitted' THEN 'approval.submitted'
              ELSE 'approval.' || (j."payload"->>'status')
            END
        )
    `)
    return rows[0]?.count ?? 0
  }

  /**
   * 多出来的站内通知条数（每组 n 条计 n−1）。
   *
   * ★ 分组键必须与 W6-C 的去重键同构：收件人 + 类型 + approvalId。
   *   少了 `type`，`approved` 与 `rejected` 会被算成重复（它们本就该各有一条）；
   *   少了 `recipientUserId`，两位家长各收一条也会被算成重复。
   * ★ `approvalId` 为 NULL 的行会互相成组：那是**脏数据**（审批提醒必带
   *   approvalId），把它算成重复方向正确 —— 宁可多看一条告警。
   */
  private async countDuplicateNotifications(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ extra: number }>>(Prisma.sql`
      SELECT COALESCE(sum(g."cnt" - 1), 0)::int AS "extra"
      FROM (
        SELECT count(*) AS "cnt"
        FROM "Notification" n
        WHERE n."type" IN (${Prisma.join(RECONCILED_NOTIFICATION_TYPES)})
        GROUP BY n."recipientUserId", n."type", n."payload"->>'approvalId'
        HAVING count(*) > 1
      ) g
    `)
    return rows[0]?.extra ?? 0
  }

  /** 队列状态分布。
   *
   * ★ 不写死「五个状态各查一次」：`groupBy` 只回答存在的状态，其余补 0。
   *   若将来枚举新增状态，这里**不会**把它悄悄算进任何一个已有桶。
   */
  private async countJobsByStatus(): Promise<Record<'pending' | 'sending' | 'sent' | 'dead' | 'expired', number>> {
    const grouped = await this.prisma.pushRetryJob.groupBy({
      by: ['status'],
      _count: { _all: true }
    })
    const counts = { pending: 0, sending: 0, sent: 0, dead: 0, expired: 0 }
    for (const row of grouped) {
      counts[row.status] = row._count._all
    }
    return counts
  }
}

import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type { NotificationsPort } from './notifications.repository'
import type {
  AppendNotificationInput,
  ListNotificationsInput,
  MarkNotificationReadResult,
  NotificationPageRow,
  NotificationRow
} from './notifications.types'

/**
 * 站内通知端口的 **Prisma 适配器**（W5-L，2026-10-23）—— `NotificationsPort` 的真实现。
 *
 * ── 这一层只回答「怎么把行读 / 写出来」─────────────────────────────────────
 *   · 谁能读、能读谁：三道屏障 + controller（`view_notifications`）；
 *   · 收件人是谁：**会话 actor**（`recipientUserId` 由 service 传入）；
 *   · 文案是什么：`NotificationsService` 按 `action + status` 生成（渠道无关）。
 *
 * ── 三个口径，写下来免得后来者「优化」掉 ──────────────────────────────────
 *   ① **孩子已软删 ⇒ `null`**（不是空页）：与 `read.prisma.repository.ts` 一致。
 *      返回空页会把「这个孩子不在库里」显示成「你没有新消息」。
 *   ② **游标是 `(createdAt, id)` 双条件**：同一毫秒的两条通知在真库里确实可能
 *      同时存在（批量写入），只比时间会把剩余行全部漏掉。
 *   ③ **`unreadCount` 与列表同一次查询**：分开两次查会出现「列表已读、红点还在」
 *      或反过来的闪烁；同一个 `$transaction` 至少让它们来自同一个快照。
 *
 * ── 真库证据 ──────────────────────────────────────────────────────────────
 *   离线用例（`test/notifications-http.test.ts`）只能证明「把哪个键交给了端口」；
 *   「接了库真的读得对」由 `test-db/notifications-db.dbtest.ts` 证明（写入两条、
 *   翻页、标记已读、跨用户隔离）。
 */
@Injectable()
export class PrismaNotificationsRepository implements NotificationsPort {
  constructor(private readonly prisma: PrismaService) {}

  async listForRecipient(input: ListNotificationsInput): Promise<NotificationPageRow | null> {
    // 见文件头 ①：软删的孩子不能被当成「正常但没消息」.
    const child = await this.prisma.child.findFirst({
      where: { id: input.childId, status: 'active' },
      select: { id: true }
    })
    if (child === null) return null

    const where: Prisma.NotificationWhereInput = {
      childId: input.childId,
      recipientUserId: input.recipientUserId,
      // 见文件头 ②：键集翻页，排序是 (createdAt desc, id desc)。
      ...(input.before === undefined
        ? {}
        : {
            OR: [
              { createdAt: { lt: input.before.createdAt } },
              { createdAt: input.before.createdAt, id: { lt: input.before.id } }
            ]
          })
    }

    const [rows, unreadCount] = await this.prisma.$transaction([
      // 多取一条判定 `hasMore`：本页正好满 ≠ 还有下一页。
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          type: true,
          title: true,
          body: true,
          payload: true,
          readAt: true,
          createdAt: true
        }
      }),
      this.prisma.notification.count({
        where: {
          childId: input.childId,
          recipientUserId: input.recipientUserId,
          readAt: null
        }
      })
    ])

    const hasMore = rows.length > input.limit
    const page: NotificationRow[] = (hasMore ? rows.slice(0, input.limit) : rows).map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      payload: row.payload,
      readAt: row.readAt,
      createdAt: row.createdAt
    }))
    return { rows: page, hasMore, unreadCount }
  }

  async markRead(input: {
    childId: string
    recipientUserId: string
    notificationId: string
  }): Promise<MarkNotificationReadResult> {
    // 归属条件进 where：不是发给我的通知 = **不存在**（与 W3-B 同一条口径）。
    const existing = await this.prisma.notification.findFirst({
      where: {
        id: input.notificationId,
        childId: input.childId,
        recipientUserId: input.recipientUserId
      },
      select: { id: true, readAt: true }
    })
    if (existing === null) return { kind: 'not_found' }
    // 已读 ⇒ 幂等：回原来的 readAt，**不写第二次**（同 `POST /invites/:id/revoke`）。
    if (existing.readAt !== null) {
      return { kind: 'ok', id: existing.id, readAt: existing.readAt }
    }

    const readAt = new Date()
    // `readAt: null` 在 where 里：两个并发「标已读」只有一个真正写入；
    // 另一个 count=0，随后读回同一条结果 —— 与「重复调用」同一条路径。
    await this.prisma.notification.updateMany({
      where: {
        id: input.notificationId,
        childId: input.childId,
        recipientUserId: input.recipientUserId,
        readAt: null
      },
      data: { readAt }
    })

    const after = await this.prisma.notification.findFirst({
      where: {
        id: input.notificationId,
        childId: input.childId,
        recipientUserId: input.recipientUserId
      },
      select: { id: true, readAt: true }
    })
    // 并发删除 / 归属被改：形状坏了 ⇒ 500（数据问题不该被当成 404 或 200）。
    if (after === null || after.readAt === null) {
      throw new Error(
        `通知 ${input.notificationId} 在标记已读后读不回 readAt —— 数据形状异常（不是业务分支）。`
      )
    }
    return { kind: 'ok', id: after.id, readAt: after.readAt }
  }

  async append(input: AppendNotificationInput): Promise<void> {
    await this.prisma.notification.create({
      data: {
        childId: input.childId,
        recipientUserId: input.recipientUserId,
        type: input.type,
        title: input.title,
        body: input.body,
        // `undefined` 不落键（Prisma 写 null）；显式空对象仍要保留 —— 见契约注释。
        ...(input.payload === undefined
          ? {}
          : { payload: input.payload as Prisma.InputJsonValue })
      }
    })
  }
}

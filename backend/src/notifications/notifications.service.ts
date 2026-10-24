import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'

import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetPosition
} from '../common/keyset-cursor'
import {
  NOTIFICATIONS_REPOSITORY,
  type NotificationsPort
} from './notifications.repository'
import type {
  MarkNotificationReadResponse,
  NotificationDto,
  NotificationsListResponse
} from './notifications.types'

/**
 * 通知的**读接口**（W5-L 站内，2026-10-23；W6-C 收敛，2026-10-24）。
 *
 * ── 为什么现在只剩读 ──────────────────────────────────────────────────────
 *   W6-C 把「审批提醒」的写入搬进了审批事务（`NotificationsOutbox`），
 *   本 service **不再**写通知、也不再发送推送。这样：
 *     · 入队与审批同生共死，不会出现「审批提交了、提醒没入队」；
 *     · 请求路径不调用第三方，网关慢/挂都不会拖住 202 / 200；
 *     · `PushRetryWorker` 是**唯一**发送者，重试与告警只有一条路径。
 *
 * ── 读方法的诚实边界 ──────────────────────────────────────────────────────
 *   `null`（孩子不存在 / 已软删）⇒ 404，不返回空列表冒充「你没有通知」。
 *   无库装配 ⇒ 端口 501 直接上抛：读不到就说读不到，不假装读过。
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(NOTIFICATIONS_REPOSITORY) private readonly repository: NotificationsPort
  ) {}

  /**
   * `GET /notifications` —— 读「发给我的」一页（W5-L）。
   *
   * ── 收件人从哪里来 ──────────────────────────────────────────────────────
   *   `recipientUserId` 由 controller 从**会话**取出后传入，没有 query 入口。
   *   `childId` 同理（身份 Guard）。两者都不是客户端可选的过滤条件。
   *
   * ── `null` 与空页的区别 ────────────────────────────────────────────────
   *   端口回 `null` = 孩子不存在 / 已软删 ⇒ 404 `CHILD_NOT_FOUND`；
   *   空 `rows` = 真的没有通知 ⇒ 200 + `items: []`。
   *   把前者做成 200 空页，会让「数据被删了」伪装成「你没有新消息」。
   */
  async list(input: {
    childId: string
    recipientUserId: string
    limit: number
    cursor?: string
  }): Promise<NotificationsListResponse> {
    const before =
      input.cursor === undefined ? undefined : this.decodeCursor(input.cursor)

    const page = await this.repository.listForRecipient({
      childId: input.childId,
      recipientUserId: input.recipientUserId,
      limit: input.limit,
      ...(before === undefined ? {} : { before })
    })
    if (page === null) {
      throw new NotFoundException({
        code: 'CHILD_NOT_FOUND',
        message: '这个孩子不存在或已被移出，读不到通知。'
      })
    }

    // 游标指向**本页最后一行**（不是多取的那一行），两页之间不会重叠。
    const last = page.rows[page.rows.length - 1]
    const nextCursor =
      page.hasMore && last !== undefined
        ? encodeKeysetCursor({ createdAt: last.createdAt, id: last.id })
        : null

    return {
      items: page.rows.map(toNotificationDto),
      nextCursor,
      hasMore: page.hasMore,
      unreadCount: page.unreadCount
    }
  }

  /**
   * `PATCH /notifications/:id/read` —— 标记一条通知已读（W5-L）。
   *
   * ── 幂等，且**不重复写** ────────────────────────────────────────────────
   *   已读再点一次返回**原来的** `readAt`（不是新的时间戳）：否则「什么时候
   *   第一次看到」会被最后一次点击覆盖，红点逻辑也会跟着抖。
   *
   * ── 不属于我的通知 = 不存在 ────────────────────────────────────────────
   *   别人的 id 与不存在的 id 回同一个 404 `NOTIFICATION_NOT_FOUND`：
   *   区分两者等于给出「这个 id 存在」的探测口（与 W3-B 的审批同一条纪律）。
   */
  async markRead(input: {
    childId: string
    recipientUserId: string
    notificationId: string
  }): Promise<MarkNotificationReadResponse> {
    const result = await this.repository.markRead({
      childId: input.childId,
      recipientUserId: input.recipientUserId,
      notificationId: input.notificationId
    })
    if (result.kind === 'not_found') {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: '这条通知不存在，或者不是发给你的。'
      })
    }
    return { id: result.id, readAt: result.readAt.toISOString() }
  }

  /** 游标只在 service 里解析；格式错 = 400，绝不静默退回第一页。 */
  private decodeCursor(cursor: string): KeysetPosition {
    const position = decodeKeysetCursor(cursor)
    if (position === null) {
      throw new BadRequestException({
        code: 'INVALID_NOTIFICATION_CURSOR',
        message: 'cursor 不是本接口上一页返回的 nextCursor，请从第一页重新加载。'
      })
    }
    return position
  }
}

/** 行 → 线格式：`Date` 只在这一处翻成 ISO 串（与 `read.mapper.ts` 同一个口径）。 */
function toNotificationDto(row: {
  id: string
  type: string
  title: string
  body: string
  payload: unknown
  readAt: Date | null
  createdAt: Date
}): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: row.payload,
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  }
}

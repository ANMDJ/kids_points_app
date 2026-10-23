import {
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Query,
  Req,
  UseGuards
} from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { Actor, RequestWithActor } from '../permissions/actor'
import { ListNotificationsQueryDto } from './dto/list-notifications.query'
import { NotificationsService } from './notifications.service'
import type {
  MarkNotificationReadResponse,
  NotificationsListResponse
} from './notifications.types'

/** 默认页大小（DTO 只表达「没传」，默认值在 controller 落 —— 与 `/records` 同一手法）。 */
const DEFAULT_LIMIT = 20

/**
 * 站内通知中心（W5-L，2026-10-23）—— 两条路由，全部三道屏障。
 *
 *   GET   /notifications          `view_notifications`  guardian ALLOW / child ALLOW
 *   PATCH /notifications/:id/read `read_notifications`  guardian ALLOW / child ALLOW
 *
 * ── 收件人来自会话，**不是**请求参数 ────────────────────────────────────────
 *   两条路由都没有 `recipientUserId` / `userId` 入参：
 *   · 屏障二只回答「这个角色能不能用通知功能」，它**管不了**「这是不是你那一条」；
 *   · 一旦收件人可由客户端指定，孩子（或家长）改一个 id 就能读另一个人的通知 ——
 *     而矩阵会照常放行（`view_notifications` 两侧都是 ALLOW）。
 *   ⇒ 服务端从 `kpActor.userId` 取收件人，从 `kpChildId` 取孩子。
 *   与 `GET /approvals/mine`（按 `requesterUserId = 本人` 收口）同一条纪律。
 *
 * ── 为什么两个孩子都放行 ──────────────────────────────────────────────────
 *   通知里**不含**别人家的数据：写入时 `recipientUserId` 就是申请人本人，
 *   读取时又按同一个键收口。藏起来只会让「审批被拒了」永远没人知道 ——
 *   那恰恰是最需要被看见的一条消息。
 *
 * ── 为什么标记已读没有 body ─────────────────────────────────────────────────
 *   要改的只有一条通知的一个事实（读了），路径里已经有 id 与动作名；
 *   请求体只会引入「客户端传 readAt / 传别人的 id」两种歪路 —— 所以是
 *   `PATCH :id/read`，而不是 `PATCH { read: true }` 或 `POST .../read`。
 *   幂等语义在 service / 适配器：已读再调 = 200 + **原来的** `readAt`。
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
  @RequireAction('view_notifications')
  async list(
    @Query() query: ListNotificationsQueryDto,
    @Req() req: RequestWithActor
  ): Promise<NotificationsListResponse> {
    return await this.service.list({
      childId: this.childIdOf(req),
      recipientUserId: this.actorOf(req).userId,
      limit: query.limit ?? DEFAULT_LIMIT,
      // ★ 只透传「真的传了」的 cursor：显式 `undefined` 与缺失在 service 里同义，
      //   但保持这个写法，将来加参数时不会误把默认值当成用户输入。
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    })
  }

  @Patch(':id/read')
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
  @HttpCode(200)
  @RequireAction('read_notifications')
  async markRead(
    @Param('id') id: string,
    @Req() req: RequestWithActor
  ): Promise<MarkNotificationReadResponse> {
    return await this.service.markRead({
      childId: this.childIdOf(req),
      recipientUserId: this.actorOf(req).userId,
      notificationId: id
    })
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄（缺失 = 装配错误）。 */
  private actorOf(req: RequestWithActor): Actor {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error(
        'NotificationsController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）'
      )
    }
    return actor
  }

  /** `kpChildId` 由身份 Guard 写、屏障一验过。**绝不**从 query / body 取孩子 id。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'NotificationsController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards
} from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import {
  DEVICE_ID_HEADER,
  DeviceSessionGuard
} from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { Actor, RequestWithActor } from '../permissions/actor'
import { AcceptInviteDto } from './dto/accept-invite.dto'
import { CreateInviteDto } from './dto/create-invite.dto'
import { InvitesService } from './invites.service'
import type {
  InviteAcceptResponse,
  InviteCodeDto,
  InviteListResponse,
  InviteRevokeResponse
} from './invites.types'

/**
 * 邀请码（W5-G，2026-10-22）—— 四条路由，两种身份口径。
 *
 *   POST /invites               `invite_member`  guardian ALLOW / child DENY
 *   GET  /invites               `invite_member`  guardian ALLOW / child DENY
 *   POST /invites/:id/revoke    `invite_member`  guardian ALLOW / child DENY
 *   POST /invites/accept        ——（见下）被邀请人自己，天然不是这个孩子的成员
 *
 * ── 为什么「列出邀请码」也用 `invite_member`，而不是一个 `view_invites` ────
 *   列表回的是**码本身**，而码就是凭据：看得见 = 可以拿去加入。
 *   一个「只读」的查看权限在这里没有任何意义 —— 它不是数据，是钥匙。
 *   矩阵里没有 `view_invites`，也不该有。
 *
 * ── ★ `accept` 为什么只有身份屏障（这是本模块最需要解释的一处）──────────
 *   前三条路由的被授权人是**这个孩子的现有成员**，所以成员位（屏障一）与
 *   矩阵（屏障二）问得出问题。`accept` 的被授权人**按定义还不是**这个孩子的
 *   成员 —— 这正是它的用途。若也要求「先有成员位」，这条路由对真正的
 *   被邀请人永远 403，成为一条只对内部人可用的死路。
 *
 *   于是授权判据变成了「**持有家长签发的码**」：
 *     · 屏障一（成员资格）用**码本身**替代 —— 码由 guardian 生成、有次数上限、
 *       有有效期、可吊销，且占位是库层面原子的（02 §8）；
 *     · 屏障二（矩阵）没有可查的列：矩阵描述的是「成员对某孩子的操作」，
 *       而被邀请人此刻还不是成员，`resolveVerdict()` 对非成员无意义；
 *     · 身份屏障保留：`accept` **不能**匿名调用 —— 它要往 `ChildMember`
 *       与 `DeviceSession` 里写一个 `userId`，而「你是谁」必须来自服务端会话
 *       （不是请求体），否则任何人都能以任意 userId 加入。
 *
 *   ⚠️ 因此它的前提是：**调用方已经在某处有一个会话**（`x-kp-device-id` +
 *   `x-kp-child-id` 能查到会话行）。全新设备上「第一次加入」还需要登录链路
 *   （L2 / `code2session`，05 §6 的阻塞项），本轮**不假装已经有了**。
 *
 * ── 为什么四条路由都不加 `Idempotency-Key` ────────────────────────────────
 *   · `create`：每次调用都**应该**产生一个新码（不是重放同一个请求），
 *     加了幂等键反而会让「我刚才那个码呢」变成一个查不到的状态；
 *   · `revoke`：构造幂等 —— 已吊销再吊销回同一个 200，且不写第二条审计；
 *   · `accept`：次数上限本身就是并发判据（条件 UPDATE），重复提交会得到
 *     `ALREADY_MEMBER`（且**不消耗**名额）—— 这不是需要缓存掉的错误，
 *     而是正确答案。
 */
@Controller('invites')
export class InvitesController {
  constructor(private readonly service: InvitesService) {}

  @Post()
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
  @RequireAction('invite_member')
  async create(
    @Body() dto: CreateInviteDto,
    @Req() req: RequestWithActor
  ): Promise<InviteCodeDto> {
    return await this.service.createInvite(this.childIdOf(req), dto, this.actorOf(req))
  }

  @Get()
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
  @RequireAction('invite_member')
  async list(@Req() req: RequestWithActor): Promise<InviteListResponse> {
    return await this.service.listInvites(this.childIdOf(req))
  }

  @Post(':id/revoke')
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
  @HttpCode(200)
  @RequireAction('invite_member')
  async revoke(
    @Param('id') id: string,
    @Req() req: RequestWithActor
  ): Promise<InviteRevokeResponse> {
    return await this.service.revokeInvite(this.childIdOf(req), id, this.actorOf(req))
  }

  @Post('accept')
  @UseGuards(DeviceSessionGuard)
  @HttpCode(200)
  async accept(
    @Body() dto: AcceptInviteDto,
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<InviteAcceptResponse> {
    return await this.service.acceptInvite(dto, this.actorOf(req), this.deviceIdOf(deviceId))
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄（缺失 = 装配错误）。 */
  private actorOf(req: RequestWithActor): Actor {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error(
        'InvitesController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）'
      )
    }
    return actor
  }

  /** `kpChildId` 由身份 Guard 写、屏障一验过。**绝不**从请求体取孩子 id。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'InvitesController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }

  /** 加入要在这台设备上签发会话 —— 设备 id 只能来自请求头（身份 Guard 已要求存在）。 */
  private deviceIdOf(deviceId: string | undefined): string {
    if (typeof deviceId !== 'string' || deviceId.trim() === '') {
      throw new Error(
        `InvitesController 缺少 ${DEVICE_ID_HEADER}：` +
          '身份 Guard 理应已拦下（401）；这里是装配/顺序问题的响亮失败。'
      )
    }
    return deviceId
  }
}

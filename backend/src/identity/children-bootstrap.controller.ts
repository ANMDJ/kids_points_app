import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common'

import type { RequestWithActor } from '../permissions/actor'
import { AuthGuard } from './auth.guard'
import { BootstrapChildDto } from './dto/bootstrap-child.dto'
import { readDeviceId, requireIdentity } from './identity.controller'
import { IdentityService, type BootstrapChildView } from './identity.service'

/**
 * 新用户 bootstrap：`POST /children`（W9-A，2026-10-29 / `40` §7）。
 *
 * ── 为什么是**独立控制器**而不是塞进 `ChildrenController` ────────────────────
 *   现有的 `@Controller('child')`（单数）只有 `PATCH /child`（改昵称），它挂着
 *   `DeviceSessionGuard + MembershipGuard + PermissionsGuard + ConsentGuard`
 *   —— 这一条**一个都不能挂**（用户按定义还没有孩子：没有成员位、没有矩阵列、
 *   本路由本身就是建立同意的那一步）。把它们塞进同一个类，只能靠在方法上
 *   逐个"排除"，而那正是"某天有人给类加了个 Guard"就会炸的形状。
 *   ⇒ 路径也刻意不同（`/children` 复数 = 建/列，`/child` 单数 = 当前那个孩子），
 *     与仓库既有命名一致（`POST /invites` vs `/invite`）。
 *
 * ── 它是全仓库**第二条**没有三道屏障的路由 ──────────────────────────────────
 *   第一条是 `POST /invites/accept`（`02` §8）。例外必须**显式点名**，
 *   否则下一个人会以为"这里是不是漏挂了 Guard"。
 *
 * ── 为什么**不挂** `Idempotency-Key` ────────────────────────────────────────
 *   重复提交会命中 409 `CHILD_LIMIT_REACHED`（构造幂等）。加缓存反而会**掩盖**
 *   "我已经建过了"这个事实，把 409 变成 200（客户端会以为成功了第二次）。
 */
@Controller('children')
export class ChildrenBootstrapController {
  constructor(private readonly service: IdentityService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async create(
    @Body() dto: BootstrapChildDto,
    @Req() request: RequestWithActor
  ): Promise<BootstrapChildView> {
    return await this.service.bootstrapChild(
      requireIdentity(request),
      dto,
      readDeviceId(request),
      request.headers
    )
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards
} from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { IdempotencyService } from '../idempotency/idempotency.service'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { RequestWithActor } from '../permissions/actor'
import type { WishDto } from '../read/read.mapper'
import { CreateWishDto } from './dto/create-wish.dto'
import { WishesService, type WishOperator } from './wishes.service'

/**
 * 心愿写入口（W5-B，2026-10-20）。
 *
 * ── 只有两条路由，为什么 ──────────────────────────────────────────────────
 *   · `POST /wishes`：**新增**。矩阵 `add_wish` = 家长 ALLOW / 孩子 REQUIRE_APPROVAL。
 *     孩子调到这里会被 `PermissionsGuard` 拦成 `403 APPROVAL_REQUIRED`（不是 500，
 *     也不是静默成功）—— 客户端据此提示「需要家长确认」，**不会**出现「界面上加好了、
 *     其实没落库」的假成功。
 *   · `DELETE /wishes/:id`：**软删**（移到回收站，90 天可恢复 —— 与修 C9 同口径）。
 *     矩阵 `delete_wish` 对孩子 = DENY。
 *   · **兑换没有第三条路由**：兑换必须写流水 + 改余额 + 标记 `redeemed`，
 *     走 `POST /approvals`（action=`redeem`，家长可显式自批）。在这里再开一条
 *     「扣分入口」会让 I2（余额只能由账本推导）裂成两份实现。
 *
 * ── 三道屏障 + 幂等（与 `RulesController` 同一手法）────────────────────────
 *   `DeviceSessionGuard` → `MembershipGuard` → `PermissionsGuard`；
 *   两条写入口都支持 `Idempotency-Key`：双击「保存心愿」不会建出两个心愿，
 *   双击「删除」也不会写出两条审计。
 *
 * ── 状态码 ────────────────────────────────────────────────────────────────
 *   新增 201（返回与 `GET /home` 的 `wishes[]` 同构的行）；删除 200 `{ wishId }`（幂等）。
 */
@Controller('wishes')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class WishesController {
  constructor(
    private readonly service: WishesService,
    private readonly idempotency: IdempotencyService
  ) {}

  @Post()
  @HttpCode(201)
  @RequireAction('add_wish')
  async create(
    @Body() dto: CreateWishDto,
    @Req() req: RequestWithActor,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<WishDto> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)

    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'add_wish',
        requestHash: IdempotencyService.hashRequest('POST', '/wishes', dto)
      },
      async () => ({
        statusCode: 201,
        body: await this.service.createWish(childId, dto, actor)
      })
    )
    return result.body
  }

  @Delete(':id')
  @HttpCode(200)
  @RequireAction('delete_wish')
  async remove(
    @Param('id') id: string,
    @Req() req: RequestWithActor,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<{ wishId: string }> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)

    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'delete_wish',
        // DELETE 没有请求体：路径里已经包含唯一目标；重复删除由仓储幂等处理。
        requestHash: IdempotencyService.hashRequest('DELETE', `/wishes/${id}`, null)
      },
      async () => ({
        statusCode: 200,
        body: await this.service.deleteWish(childId, id, actor)
      })
    )
    return result.body
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄。 */
  private actorOf(req: RequestWithActor): WishOperator {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error('WishesController 缺少 DeviceSessionGuard：请求没有 actor')
    }
    if (actor.role === 'viewer') {
      // 矩阵对 viewer 一律 DENY；Guard 理应已拦下。这里再挡一次是防御纵深。
      throw new BadRequestException({
        code: 'WISH_ACTOR_ROLE_INVALID',
        message: 'viewer 不能写心愿。'
      })
    }
    return { userId: actor.userId, role: actor.role }
  }

  /**
   * `kpChildId` 由身份 Guard 写、屏障一验过。
   * ★ 绝不从请求体取孩子 id —— 那等于让客户端决定改谁家的心愿单。
   */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'WishesController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { Actor, RequestWithActor } from '../permissions/actor'
import { DeviceTokensService } from './device-tokens.service'
import type { DeviceTokenDto } from './device-tokens.types'
import { RegisterDeviceTokenDto, RevokeDeviceTokenDto } from './dto/register-device-token.dto'

/**
 * 设备推送 token（W6-A，2026-10-24）—— 两条路由，全部三道屏障。
 *
 *   POST /device-tokens          `manage_device_tokens`  登记（幂等：同 token 重复上报只刷新）
 *   POST /device-tokens/revoke   `manage_device_tokens`  注销（幂等：已注销仍 200）
 *
 * ── 为什么注销不是 `DELETE /device-tokens/:token` ───────────────────────────
 *   ① `token` 是可直接用来推送的凭据，放进 URL 会留在 access log / 代理日志里；
 *   ② `fetch` / `Taro.request` 对 DELETE 带 body 的支持并不一致（历史上被剥掉过）。
 *   所以两条都是 POST + body，`token` 只出现在请求体里。
 *
 * ── 为什么没有 `GET /device-tokens` ─────────────────────────────────────────
 *   列表里没有 `token`（不能回显），剩下的只有「我这台设备登记过」——
 *   而客户端本来就知道自己登记过。为避免多一个「看起来能调试、实际看不出所以然」
 *   的端点，本阶段不加；真需要排查时用 `test-db/device-tokens-db.dbtest.ts` 那套读法。
 *
 * ── 为什么不需要 `Idempotency-Key` ──────────────────────────────────────────
 *   两条路由都是**构造幂等**：重复登记 ⇒ 同一行、同一 `id`；重复注销 ⇒ 200 + 原
 *   `revokedAt`。缓存一个重放结果只会引入「缓存说成功、库里没有」的中间态。
 *
 * ── 为什么登记也回 200（不是 201）───────────────────────────────────────────
 *   `201 Created` 在「这个 token 早就登记过、这次只是刷新」时是假话。两种情况都是
 *   「登记完成」，200 + 行本身（`id` / `active` / `lastSeenAt`）比一个可能撒谎的
 *   状态码有用。本阶段**不下发** `created`：客户端不需要区分「新登记 / 只是刷新」，
 *   两者对它的下一步动作完全相同。
 */
@Controller('device-tokens')
export class DeviceTokensController {
  constructor(private readonly service: DeviceTokensService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
  @RequireAction('manage_device_tokens')
  async register(
    @Body() dto: RegisterDeviceTokenDto,
    @Req() req: RequestWithActor
  ): Promise<DeviceTokenDto> {
    return await this.service.register(dto, this.actorOf(req), this.childIdOf(req))
  }

  @Post('revoke')
  @HttpCode(200)
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
  @RequireAction('manage_device_tokens')
  async revoke(
    @Body() dto: RevokeDeviceTokenDto,
    @Req() req: RequestWithActor
  ): Promise<DeviceTokenDto> {
    return await this.service.revoke(dto, this.actorOf(req))
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄（缺失 = 装配错误）。 */
  private actorOf(req: RequestWithActor): Actor {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error(
        'DeviceTokensController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）'
      )
    }
    return actor
  }

  /** `kpChildId` 由身份 Guard 写、屏障一验过。**绝不**从请求体 / 路径取孩子 id。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'DeviceTokensController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

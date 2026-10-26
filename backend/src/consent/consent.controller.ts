import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards
} from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { RequestWithActor } from '../permissions/actor'
import type { ConsentOperator, ConsentState } from './consent.repository'
import { ConsentService, type ConsentPii } from './consent.service'
import { GrantConsentDto } from './dto/grant-consent.dto'
import { clientIpOf } from './hash-pii'

/**
 * 监护人同意（W7-A，2026-10-26）—— `GET /consent`、`POST /consent`、
 * `POST /consent/withdraw`。
 *
 * ── 路由为什么没有 childId ────────────────────────────────────────────────
 *   与 `PATCH /child` 同一原则：孩子身份**只**来自会话
 *   （`x-kp-device-id` + `x-kp-child-id` ⇒ `kpChildId`，且必须等于会话行上的 childId）。
 *   路径里带 id 会给客户端第二种「对谁」的写法 —— 两种来源不一致时，
 *   我们只能二选一地相信其中一个，那是不必要的歧义。
 *
 * ── 为什么这三个端点**不挂** `ConsentGuard` ─────────────────────────────────
 *   `view_consent` / `manage_consent` 在 `contracts/consent-policy.ts` 里是**豁免**动作：
 *   撤回后必须还能看状态、还能重新同意。若把同意闸门也挂在这里，
 *   用户会被锁死在「撤回了、也永远无法恢复」的状态里 —— 这既不合规，也无法解释。
 *
 * ── 三道屏障 ──────────────────────────────────────────────────────────────
 *   `view_consent` / `manage_consent` 均为 guardian ALLOW / child DENY / viewer DENY
 *   （viewer 在矩阵里没有列 ⇒ `resolveVerdict` 一律 DENY）。
 *   即：只有家长能给同意、能撤回、能看状态。孩子设备 403，且**不会**留下任何记录。
 *
 * ── 为什么 `POST /consent` 返回 200 而不是 201 ───────────────────────────────
 *   它不"创建一份新资源"给客户端用 id 访问，而是**记录一条事实**并回当前状态；
 *   重复调用回同一个结果（幂等）。201 会暗示"又建了一份"。
 */
@Controller('consent')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class ConsentController {
  constructor(private readonly service: ConsentService) {}

  @Get()
  @RequireAction('view_consent')
  async read(@Req() req: RequestWithActor): Promise<ConsentState> {
    return await this.service.read(this.childIdOf(req))
  }

  @Post()
  @HttpCode(200)
  @RequireAction('manage_consent')
  async grant(
    @Body() dto: GrantConsentDto,
    @Req() req: RequestWithActor
  ): Promise<ConsentState> {
    return await this.service.grant(
      this.childIdOf(req),
      dto,
      this.actorOf(req),
      this.piiOf(req)
    )
  }

  @Post('withdraw')
  @HttpCode(200)
  @RequireAction('manage_consent')
  async withdraw(@Req() req: RequestWithActor): Promise<ConsentState> {
    return await this.service.withdraw(this.childIdOf(req), this.actorOf(req), this.piiOf(req))
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄。 */
  private actorOf(req: RequestWithActor): ConsentOperator {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error('ConsentController 缺少 DeviceSessionGuard：请求没有 actor')
    }
    if (actor.role === 'viewer') {
      // 矩阵对 viewer 一律 DENY，Guard 理应已拦下；这里再挡一次是防御纵深。
      throw new BadRequestException({
        code: 'CONSENT_ACTOR_ROLE_INVALID',
        message: 'viewer 不能代表监护人作出或撤回同意。'
      })
    }
    return { userId: actor.userId, role: actor.role }
  }

  /** `kpChildId` 由身份 Guard 写、屏障一验过；绝不从请求体/路径取。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'ConsentController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }

  /** 留痕原料：原文只用于本次哈希（见 `hash-pii.ts`），不落库、不进日志。 */
  private piiOf(req: RequestWithActor): ConsentPii {
    const rawUserAgent = req.headers['user-agent']
    const userAgent = Array.isArray(rawUserAgent) ? rawUserAgent[0] : rawUserAgent
    return { ip: clientIpOf(req.headers), userAgent }
  }
}

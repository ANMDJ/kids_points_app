import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UseGuards
} from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { RequestWithActor } from '../permissions/actor'
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto'
import { SaveOnboardingProfileDto } from './dto/save-onboarding-profile.dto'
import type {
  CompleteOnboardingResult,
  OnboardingOperator,
  OnboardingState
} from './onboarding.repository'
import { OnboardingService, type OnboardingView } from './onboarding.service'

/**
 * 首启引导（W8-A，2026-10-27 / `docs/design/04` §2–§6）。
 *
 * ── 三条路由与四个步骤的对应 ────────────────────────────────────────────────
 *   `GET   /onboarding`          → 第①–⑤步：读状态 + **排好序**的模板卡片
 *   `PATCH /onboarding/profile`  → 第③④步：学段 / 关注点草稿（中途退出再进入）
 *   `POST  /onboarding/complete` → 第⑤–⑦步：采纳模板 + 设 PIN + 置 `onboardedAt`
 *
 * ── 为什么没有 `childId` 参数 ────────────────────────────────────────────────
 *   与 `PATCH /child` / `GET /consent` 同一原则：孩子身份**只**来自会话
 *   （`x-kp-device-id` + `x-kp-child-id` ⇒ `kpChildId`）。路径或请求体里再带一份
 *   就是第二种「对谁」的写法 —— 不一致时只能二选一相信，那是不必要的歧义。
 *
 * ── 第四道屏障（同意闸门）为什么**只拦写** ──────────────────────────────────
 *   `view_onboarding` 在 `contracts/consent-policy.ts` 里是**豁免**动作：
 *   引导第①步就是「监护人同意」，页面必须先能打开、能读到第①步的内容 ——
 *   若 `GET` 也被 `ConsentGuard` 拦，用户会看到一个 403 的空页面，
 *   而页面上唯一能解除它的按钮（同意）都渲染不出来。
 *   `apply_onboarding`（草稿 + 完成）则**必须**过闸门：第②步起就在采集昵称，
 *   `04` §5 要求同意**先于**采集 —— 未同意时 `POST /onboarding/complete`
 *   返回 403 `CONSENT_REQUIRED`，且**不会**建出任何规则（Guard 在 handler 之前）。
 *
 * ── 为什么 `POST /onboarding/complete` 返回 200 而不是 201 ───────────────────
 *   它不创建「一个可寻址的引导」，而是把一个已存在的孩子标记为完成并回结果；
 *   重复调用是 409 而不是「再建一个」。201 会暗示「又建了一份」。
 */
@Controller('onboarding')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}

  @Get()
  @RequireAction('view_onboarding')
  async read(@Req() req: RequestWithActor): Promise<OnboardingView> {
    return await this.service.read(this.childIdOf(req))
  }

  @Patch('profile')
  @HttpCode(200)
  @RequireAction('apply_onboarding')
  async saveProfile(
    @Body() dto: SaveOnboardingProfileDto,
    @Req() req: RequestWithActor
  ): Promise<OnboardingState> {
    return await this.service.saveProfile(this.childIdOf(req), dto, this.actorOf(req))
  }

  @Post('complete')
  @HttpCode(200)
  @RequireAction('apply_onboarding')
  async complete(
    @Body() dto: CompleteOnboardingDto,
    @Req() req: RequestWithActor
  ): Promise<CompleteOnboardingResult> {
    return await this.service.complete(this.childIdOf(req), dto, this.actorOf(req))
  }

  /** Guard 已保证 `kpActor` 存在；断言只为编译期收窄。 */
  private actorOf(req: RequestWithActor): OnboardingOperator {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error('OnboardingController 缺少 DeviceSessionGuard：请求没有 actor')
    }
    // viewer 在矩阵里没有列 ⇒ 一律 DENY；这里再挡一次是防御纵深。
    if (actor.role === 'viewer') {
      throw new BadRequestException({
        code: 'ONBOARDING_ACTOR_ROLE_INVALID',
        message: '只读分享成员不能填写或完成首次引导（引导会采集孩子的昵称与学段）。'
      })
    }
    return { userId: actor.userId, role: actor.role }
  }

  /** `kpChildId` 由身份 Guard 写、屏障一验过；绝不从请求体/路径取。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'OnboardingController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

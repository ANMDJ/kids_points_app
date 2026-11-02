import {
  Header,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req
} from '@nestjs/common'

import { Public } from '../identity/public.decorator'
import type { RequestWithActor } from '../permissions/actor'
import { CreateRegistrationInviteDto } from './dto/create-registration-invite.dto'
import { REGISTRATION_INVITE_PAGE_HTML } from './registration-invite-page'
import type { CreateRegistrationInviteView } from './registration-invite.types'
import { RegistrationInvitesService } from './registration-invites.service'

/**
 * 网站「邀请码获取」的三条路由（W12，2026-11-02 / `48` §2）。
 *
 *   `GET  /invite`                        页面本身（HTML，同源）
 *   `GET  /public/registration-invites/quota`   今日剩余额度（给页面展示）
 *   `POST /public/registration-invites`         发放一张码（201）
 *
 * ── 为什么页面也由后端发 ────────────────────────────────────────────────────
 *   见 `registration-invite-page.ts` 文件头：同源 ⇒ 不用放宽 CORS、
 *   不用给 Caddy 加规则、不用在 `nest-cli` 配 assets 拷贝。
 *
 * ── 为什么两条 API 都在 `public/` 下 ────────────────────────────────────────
 *   申请人**还没有账号**，这正是这个页面的用途。匿名不是疏忽，而是产品前提；
 *   把路径写成 `public/...` 让「它为什么不需要登录」在路由表上就看得见。
 *   授权由「手机号 + 邮箱 + 每日额度」共同承担（`48` §3）。
 *
 * ── 为什么 201 ──────────────────────────────────────────────────────────────
 *   这一次调用**真的创建了**一张码（与 `POST /invites` 同一口径）。
 *   额度用完是 429，不是 201 加一个 `code: null` —— 后者会让页面必须
 *   「先看有没有 code 才知道成没成功」。
 */
@Controller()
export class RegistrationInvitesController {
  constructor(private readonly service: RegistrationInvitesService) {}

  @Public()
  @Post('public/registration-invites')
  @HttpCode(201)
  async create(
    @Body() dto: CreateRegistrationInviteDto,
    @Req() request: RequestWithActor
  ): Promise<CreateRegistrationInviteView> {
    return await this.service.create(dto, { headers: request.headers })
  }

  @Public()
  @Get('public/registration-invites/quota')
  async quota(): Promise<{
    dailyLimit: number
    remainingToday: number
    resetsAt: string
    timeZone: string
  }> {
    return await this.service.readQuota()
  }

  /**
   * `GET /invite` —— 页面。
   *
   * ★ `Cache-Control: no-store`：额度与文案都会变，被 CDN/浏览器缓存住时
   *   用户会看到「今天还剩 50 个」而实际早已发完（与 API 响应同一条纪律）。
   */
  @Public()
  @Get('invite')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(): string {
    return REGISTRATION_INVITE_PAGE_HTML
  }
}

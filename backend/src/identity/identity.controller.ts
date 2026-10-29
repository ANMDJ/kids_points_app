import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common'

import { DEVICE_ID_HEADER } from '../device-session/device-session.guard'
import type { AuthenticatedIdentity, RequestWithActor } from '../permissions/actor'
import { AuthGuard } from './auth.guard'
import { ChildSessionDto } from './dto/child-session.dto'
import { LoginDto } from './dto/login.dto'
import {
  IdentityService,
  type ChildSessionView,
  type LoginView,
  type SessionView
} from './identity.service'
import { Public } from './public.decorator'

/**
 * 登录 / 登出 / 会话查询的 HTTP 入口（W9-A，2026-10-29 / `40` §8）。
 *
 * ── 四条路由（判别点只有两处：谁能匿名、谁回 204）────────────────────────────
 *   `POST   /auth/login`          **@Public()**：它**签发**凭据，不能要求凭据（§8.2）
 *   `POST   /auth/logout`         `AuthGuard`，204（没有响应体：撤销就是没有可说的）
 *   `GET    /auth/session`        `AuthGuard`，200 `{ user, expiresAt, children }`
 *   `POST   /auth/child-session`  `AuthGuard`，200 `{ childId, role, sessionExpiresAt }`
 *
 * ── 为什么 `@UseGuards(AuthGuard)` 与 `APP_GUARD` 同时存在（不是重复）───────────
 *   · `APP_GUARD`（`app.module.ts`）：保证**生产**里每条路由默认要身份 ——
 *     防的是"漏挂一个控制器"（那类错误没有任何测试会红，除非恰好为它写了用例）；
 *   · 控制器上的显式挂载：让读者在这一行就看见"这条要登录"，并且让
 *     **只导入本模块的用例**（`test/identity-http.test.ts`）也真的走同一个 Guard。
 *   `AuthGuard.canActivate()` 见到 `request.kpAuth` 已存在会立刻返回 ——
 *   所以两处同时生效**不会**多查一次库。
 *
 * ── `POST /auth/login` 为什么回 200 而不是 201 ──────────────────────────────
 *   201 会暗示"创建了一个资源"，而这里创建的是**会话**（`AuthSession` 行）——
 *   但它不是客户端寻址的资源（没有 Location 可给）。与 `POST /auth/parent-mode`
 *   同一口径：回 200。真正的"创建"语义（`POST /children` 建孩子）也不回 201，
 *   理由相同：客户端拿到的是"当前状态"（childId + 5 分钟窗口），不是新资源的地址。
 */
@Controller('auth')
export class IdentityController {
  constructor(private readonly service: IdentityService) {}

  /** `POST /auth/login` —— 全仓库**唯一**免认证的写路由（限流在 service 第一行）。 */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() request: RequestWithActor): Promise<LoginView> {
    return await this.service.login(dto, {
      deviceId: readDeviceId(request),
      headers: request.headers
    })
  }

  /** `POST /auth/logout` —— 撤销**这一条**会话（幂等；已撤销再撤一次也回 204）。 */
  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  async logout(@Req() request: RequestWithActor): Promise<void> {
    await this.service.logout(requireIdentity(request))
  }

  /** `GET /auth/session` —— 我是谁 + 我在哪些孩子上有成员位（客户端据此选 childId）。 */
  @Get('session')
  @UseGuards(AuthGuard)
  async session(@Req() request: RequestWithActor): Promise<SessionView> {
    return await this.service.readSession(requireIdentity(request))
  }

  /** `POST /auth/child-session` —— 在这台设备上补一行 `DeviceSession`（§8.4）。 */
  @Post('child-session')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async childSession(
    @Body() dto: ChildSessionDto,
    @Req() request: RequestWithActor
  ): Promise<ChildSessionView> {
    return await this.service.ensureChildSession(requireIdentity(request), dto, readDeviceId(request))
  }
}

/**
 * 取 `x-kp-device-id`（**设备标识**，不是凭据）。
 *
 * 重复头 / 数组 ⇒ `null`（不猜）：与 `device-session.guard.ts#singleHeader` 同一理由 ——
 * "两个值里挑一个"的下一步就是"挑错了也看不出来"。
 */
export function readDeviceId(request: RequestWithActor): string | null {
  const raw = request.headers[DEVICE_ID_HEADER]
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 取 `kpAuth`，缺失 ⇒ **401 `UNAUTHENTICATED`**。
 *
 * 什么时候会缺失：双读期（非生产且未关 `AUTH_DEVICE_ID_FALLBACK`）里，
 * 一个只带 `x-kp-device-id` 的老客户端打到了**需要登录**的路由。
 * ★ 不能默认成某个 userId（那是提权），也不能 500（那是把"你还没登录"说成"服务坏了"）。
 */
export function requireIdentity(request: RequestWithActor): AuthenticatedIdentity {
  const identity = request.kpAuth
  if (identity === undefined) {
    throw new UnauthorizedException({
      code: 'UNAUTHENTICATED',
      message: '这条接口需要登录凭据（Authorization: Bearer <token>）。请先登录。'
    })
  }
  return identity
}

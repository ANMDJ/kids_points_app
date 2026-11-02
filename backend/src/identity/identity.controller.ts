import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards
} from '@nestjs/common'

import { DEVICE_ID_HEADER } from '../device-session/device-session.guard'
import type { AuthenticatedIdentity, RequestWithActor } from '../permissions/actor'
import { AuthGuard } from './auth.guard'
import { ChildSessionDto } from './dto/child-session.dto'
import { LoginAccountDto } from './dto/login-account.dto'
import { LoginDto } from './dto/login.dto'
import { RegisterWithInviteDto } from './dto/register-with-invite.dto'
import { UpdateAccountDto } from './dto/update-account.dto'
import { VerifyDateCodeDto } from './dto/verify-date-code.dto'
import type { DateCodeVerdict } from './date-verification-code'
import {
  IdentityService,
  type AccountView,
  type ChildSessionView,
  type LoginView,
  type SessionView
} from './identity.service'
import { Public } from './public.decorator'

/**
 * 登录 / 登出 / 会话查询的 HTTP 入口（W9-A，2026-10-29 / `40` §8）。
 *
 * ── 九条路由（判别点只有两处：谁能匿名、谁回 204）────────────────────────────
 *   `POST   /auth/login`          **@Public()**：它**签发**凭据，不能要求凭据（§8.2）
 *   `POST   /auth/login-account`  **@Public()**：同上 —— 手机号/邮箱 + 密码那条（W9-D）
 *   `POST   /auth/register-invite` **@Public()**：同上 —— 邀请码注册（W11-A / `45`）
 *   `POST   /auth/date-code`      **@Public()**：固定规则验证码的**服务端校验**（W9-C）
 *                                 它不签发任何凭据、不读用户数据，只回 `{ valid }`
 *   `POST   /auth/logout`         `AuthGuard`，204（没有响应体：撤销就是没有可说的）
 *   `GET    /auth/session`        `AuthGuard`，200 `{ user, expiresAt, children }`
 *   `GET    /auth/account`        `AuthGuard`，200 `{ phone, email, hasPassword }`（W9-D）
 *   `POST   /auth/child-session`  `AuthGuard`，200 `{ childId, role, sessionExpiresAt }`
 *   `PUT    /auth/account`        `AuthGuard`，200 `{ phone, email, hasPassword }`（W9-D）
 *   ★ 三条匿名路由的判据是同一句话：**要么不返回凭据，要么它就是签发凭据的那一个**。
 *     多一条的前提只有这个，不是"客户端现在还没登录"（那条理由会让每一条新路由都想匿名）。
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

  /**
   * `POST /auth/date-code` —— 固定规则 6 位验证码（`MMDD` ＋ 两位 ISO 星期）的校验（W9-C）。
   *
   * ── 为什么它可以 `@Public()`（唯一判据：**不返回任何凭据**）──────────────────
   *   响应只有 `{ valid, serverDate, weekDay, dayOffset, acceptedUntil }`：没有 token、
   *   没有 userId、没有"已通过"的会话状态。拿它换不到任何东西 ⇒ 不需要先登录。
   *   反过来：**一旦有人往响应里加 token，它就必须改回 `AuthGuard`** —— 那等于用
   *   一个可推导的码签发凭据（见 `date-verification-code.ts` 文件头的诚实标注）。
   *
   * ── 为什么是 POST 而不是 GET ────────────────────────────────────────────────
   *   GET 会把 `code` 写进访问日志 / 浏览器历史 / 代理缓存。虽然这个码可推导，
   *   但"某人在某时刻试过哪个码"没有任何必要被留着；POST 还顺便让它与登录
   *   共用同一条限流口径（`LoginRateLimiter`，见 service）。
   */
  @Public()
  @Post('date-code')
  @HttpCode(200)
  async verifyDateCode(
    @Body() dto: VerifyDateCodeDto,
    @Req() request: RequestWithActor
  ): Promise<DateCodeVerdict> {
    return await this.service.verifyDateCode(dto, {
      deviceId: readDeviceId(request),
      headers: request.headers
    })
  }

  /**
   * `POST /auth/login-account` —— App 用手机号/邮箱 + 密码登录（W9-D，2026-10-30）。
   *
   * ── 它为什么可以 `@Public()`（判据要补一句限定）────────────────────────────
   *   `public.decorator.ts` 的原文判据是「响应里没有任何凭据」。这里显然不满足
   *   （它**就是**发 token 的那个）。但把它标成需要登录会构成自举死锁 ——
   *   和 `POST /auth/login` 完全一样。
   *   ⇒ 判据的完整形式是：**要么不返回凭据，要么它就是签发凭据的那一个**。
   *   全仓库满足后半句的只有两条（`/auth/login`、`/auth/login-account`），
   *   而且两者返回的是**同一种** `AuthSession` token。
   *
   * ── 与 `/auth/login` 的分工（写清，否则以后会有人想合并）────────────────────
   *   不合并：微信那条要一个外网 `code2session`（可能 5xx / 45011），
   *   密码这条纯本地校验。合并会让"微信挂了"和"密码错了"共用一个错误面，
   *   客户端就无法决定是"稍后重试"还是"检查密码"。
   */
  @Public()
  @Post('login-account')
  @HttpCode(200)
  async loginAccount(
    @Body() dto: LoginAccountDto,
    @Req() request: RequestWithActor
  ): Promise<LoginView> {
    return await this.service.loginWithAccount(dto, {
      deviceId: readDeviceId(request),
      headers: request.headers
    })
  }

  /**
   * `POST /auth/register-invite` —— **邀请码注册**（W11-A，2026-11-02 / `45` §3.1）。
   *
   * ── 为什么它可以 `@Public()`（与上面两条登录路由同一条判据）──────────────────
   *   它**签发**凭据，所以不能要求凭据。授权由**邀请码**承担：码是家长生成、
   *   有次数上限、有有效期、可吊销的凭据（`02` §8）。
   *
   * ★ 它不是「开放注册」：没有有效邀请码时，这条路由不会建出任何 `User`
   *   （见 `IdentityService.registerWithInvite`）。`42` §5.1 的拒绝理由仍然成立。
   */
  @Public()
  @Post('register-invite')
  @HttpCode(200)
  async registerWithInvite(
    @Body() dto: RegisterWithInviteDto,
    @Req() request: RequestWithActor
  ): Promise<LoginView> {
    return await this.service.registerWithInvite(dto, {
      deviceId: readDeviceId(request),
      headers: request.headers
    })
  }

  /**
   * `GET /auth/account` —— 读当前绑定情况（W9-D，2026-10-30）。
   *
   * 与下面那条 `PUT` 是**同一份** `AccountView`：客户端那一屏先读、再写、
   * 用写回来的形状覆盖读到的形状。两者形状必须逐字一致，否则保存成功那一刻
   * 界面会「少几个字段」。
   *
   * ★ 必须 `AuthGuard`：这是「我这个账号绑了什么」，匿名可读等于给了别人
   *   一个按手机号探测「这个号是不是注册过」的接口。
   */
  @Get('account')
  @UseGuards(AuthGuard)
  async readAccount(@Req() request: RequestWithActor): Promise<AccountView> {
    return await this.service.readAccount(requireIdentity(request))
  }

  /**
   * `PUT /auth/account` —— 绑定手机号/邮箱 + 设置/修改密码（W9-D，2026-10-30）。
   *
   * ★ **必须** `AuthGuard`：它写的是"以后能不能登录"。匿名可写 = 账号接管。
   *   合法调用者只有"已经通过微信登录的小程序用户"（见 service 注释）。
   *
   * 200 而不是 204：客户端要用返回的 `{ phone, email, hasPassword }` 立刻
   * 刷新那一屏（"已绑定 138****8000"），少一次 `GET /auth/session`。
   */
  @Put('account')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async updateAccount(
    @Body() dto: UpdateAccountDto,
    @Req() request: RequestWithActor
  ): Promise<AccountView> {
    return await this.service.updateAccount(requireIdentity(request), dto)
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

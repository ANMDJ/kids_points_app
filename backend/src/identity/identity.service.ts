import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException
} from '@nestjs/common'

import { PARENT_MODE_TTL_MS } from '../auth/parent-mode.policy'
import { consentTextVersion } from '../consent/consent.service'
import { clientIpOf, hashPii } from '../consent/hash-pii'
import type { AuthenticatedIdentity } from '../permissions/actor'
import { authSessionExpiresAt, hashToken, issueToken } from './auth-session.gate'
import { AUTH_SESSION_REPOSITORY, type AuthSessionPort } from './auth-session.repository'
import type { BootstrapChildDto } from './dto/bootstrap-child.dto'
import type { ChildSessionDto } from './dto/child-session.dto'
import type { LoginDto } from './dto/login.dto'
import { CHILD_SESSION_TTL_MS } from './identity.prisma.repository'
import {
  IDENTITY_REPOSITORY,
  type ChildMembershipRow,
  type IdentityPort
} from './identity.repository'
import { LoginRateLimiter } from './login-rate-limiter'
import {
  WECHAT_CODE2SESSION,
  type Code2SessionOutcome,
  type WechatCode2SessionPort
} from './wechat/wechat-code2session.port'

/** `GET /auth/session` 的响应（`40` §8.3）。 */
export interface SessionView {
  user: { id: string; displayName: string | null }
  /** 这条**认证会话**的绝对到期（UTC ISO）。 */
  expiresAt: string
  children: ChildMembershipRow[]
}

/** `POST /auth/login` 的响应（`40` §8.1）。 */
export interface LoginView {
  /** ★ 明文 token：**只在这里出现一次**（`40` §11.2）。 */
  token: string
  expiresAt: string
  user: { id: string; displayName: string | null }
  /**
   * 首屏提示用的"我猜你只有一个孩子"。
   * ★ `GET /auth/session` 才是**权威**来源（返回完整列表）；这里只少一次往返。
   */
  membership: { childId: string; role: string } | null
}

/** `POST /children` 的响应（`40` §8.1）。 */
export interface BootstrapChildView {
  childId: string
  role: 'guardian'
  parentModeUntil: string
  /** 引导期没有 PIN ⇒ 来源是 `bootstrap`（客户端据此不画"PIN 换的"）。 */
  modeSource: 'bootstrap'
}

/** `POST /auth/child-session` 的响应（`40` §8.1）。 */
export interface ChildSessionView {
  childId: string
  role: string
  sessionExpiresAt: string
}

const MEMBER_ROLES = ['guardian', 'child', 'viewer'] as const
type MemberRoleName = (typeof MEMBER_ROLES)[number]

function isMemberRole(value: string): value is MemberRoleName {
  return (MEMBER_ROLES as readonly string[]).includes(value)
}

/**
 * 登录链路的**业务层**（W9-A，2026-10-29 / `40` §6–§8）。
 *
 * ── 五条路由，五个职责（每条都有一个"容易做错的一处"）────────────────────────
 *   `POST /auth/login`         code → openId → **新签发** token（会话固定防护：§11.3）
 *   `POST /auth/logout`        撤销**这一条**（`tokenHash`），幂等，回 204
 *   `GET  /auth/session`       我是谁 + 我在哪些孩子上有成员位（客户端据此选 childId）
 *   `POST /children`           建占位档案 + 记同意（7 步同一事务，`40` §7.4）
 *   `POST /auth/child-session` 在这台设备上补一行 `DeviceSession`
 *
 * ── ★ 本层只做三件事（其余都在别处）────────────────────────────────────────
 *   ① 把微信的**五类结局**翻成 HTTP（映射在 `openIdOrThrow()`，逐条对应文档）；
 *   ② 显式同意的判定（`consent.accepted === true`，字面量）；
 *   ③ 把端口返回的 `Date` 转成 ISO 字符串（`Date` 不泄漏到 HTTP 层）。
 *   不做：token 判定（内核）、SQL（适配器）、角色权限（屏障二/三）。
 *
 * ── 绝不写进日志的四样东西（`40` §11.2）─────────────────────────────────────
 *   token 明文 / tokenHash / 微信 `code` / AppSecret。本文件的日志只写 errcode
 *   与不含凭据的一句话。
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name)

  constructor(
    @Inject(WECHAT_CODE2SESSION) private readonly wechat: WechatCode2SessionPort,
    @Inject(AUTH_SESSION_REPOSITORY) private readonly sessions: AuthSessionPort,
    @Inject(IDENTITY_REPOSITORY) private readonly identity: IdentityPort,
    private readonly limiter: LoginRateLimiter
  ) {}

  /**
   * `POST /auth/login`（**唯一**免认证的写路由）。
   *
   * ── 顺序不能换（第 3 条是安全条款）────────────────────────────────────────
   *   1. **限流**（在碰微信之前）：打不动外网，就不会把我们变成探测器/放大器；
   *   2. 微信 `code2session`（只取 openId，`session_key` 就地丢弃）；
   *   3. **新签发** token（`issueToken()`）—— 绝不接受"用旧 token 换新 token"，
   *      否则攻击者可以先把一个自己知道的 token 塞给受害者，等其登录后继续用（§11.3）；
   *   4. 落库（`User` upsert ＋ `AuthSession`，同一事务）。
   */
  async login(
    dto: LoginDto,
    context: { deviceId: string | null; headers: Record<string, string | string[] | undefined> }
  ): Promise<LoginView> {
    const limited = this.limiter.check(
      { ip: clientIpOf(context.headers), deviceId: context.deviceId },
      new Date()
    )
    if (limited !== null) {
      // 429 而不是 503：503 会被读成"服务挂了"（客户端退避 30s+），
      // 而 429 的语义正是"你太快了，等一下再来"（`40` §11.1）。
      throw new HttpException(
        {
          code: 'LOGIN_RATE_LIMITED',
          scope: limited.scope,
          retryAfterSeconds: limited.retryAfterSeconds,
          message:
            `登录尝试过于频繁（按 ${limited.scope === 'ip' ? 'IP' : '设备'} 限流）。` +
            `请等 ${limited.retryAfterSeconds} 秒再试；**不要**自动重试。`
        },
        HttpStatus.TOO_MANY_REQUESTS
      )
    }

    const outcome = await this.wechat.exchange(dto.code.trim())
    const openId = this.openIdOrThrow(outcome)

    const now = new Date()
    const token = issueToken()
    const expiresAt = authSessionExpiresAt(now)

    const user = await this.identity.loginWithOpenId({
      openId,
      tokenHash: hashToken(token),
      method: 'wechat_mp',
      deviceId: context.deviceId,
      expiresAt
    })

    const children = await this.identity.listChildren(user.userId)
    const first = children[0]

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.userId, displayName: user.displayName },
      membership:
        first === undefined
          ? null
          : { childId: first.childId, role: this.roleOrThrow(first.role) }
    }
  }

  /** `POST /auth/logout`：撤销**这一条**会话（幂等；已撤销再撤一次不报错）。 */
  async logout(identity: AuthenticatedIdentity): Promise<void> {
    await this.sessions.revoke(identity.tokenHash, new Date(), 'logout')
  }

  /** `GET /auth/session`：我是谁 + 我在哪些孩子上有成员位。 */
  async readSession(identity: AuthenticatedIdentity): Promise<SessionView> {
    const user = await this.identity.readUser(identity.userId)
    if (user === null) {
      // 有会话行却没有 active 用户：要么刚被停用，要么数据不一致。
      // ★ 回 403 而不是 401：401 会让客户端"重新登录"，而重登也发不出凭据
      //   （`loginWithOpenId` 对非 active 用户同样 403）。
      throw new ForbiddenException({
        code: 'USER_NOT_ACTIVE',
        message: '这个账号当前不可用。请联系家庭里其他监护人，或稍后再试。'
      })
    }

    const children = await this.identity.listChildren(user.userId)
    return {
      user: { id: user.userId, displayName: user.displayName },
      expiresAt: identity.expiresAt.toISOString(),
      children: children.map((child) => ({
        childId: child.childId,
        name: child.name,
        role: this.roleOrThrow(child.role)
      }))
    }
  }

  /**
   * `POST /children`（新用户 bootstrap，`40` §7）。
   *
   * ── 三道屏障为什么**不挂**（写清，否则下一个人会以为漏了）──────────────────
   *   · 成员资格：用户**按定义**还不是任何孩子的成员；
   *   · 权限矩阵：矩阵描述"成员对某孩子的操作"，没有孩子就没有列可查；
   *   · 同意闸门：本路由**就是**建立同意的那一步。
   *   全仓库**第二条**没有三道屏障的路由（第一条是 `POST /invites/accept`）。
   *
   * ── 请求体里一个儿童信息都没有（`40` §7.3）────────────────────────────────
   *   只收 `consent.accepted`；名字是服务端占位 `'宝贝'`（真名走 `PATCH /child`）。
   */
  async bootstrapChild(
    identity: AuthenticatedIdentity,
    dto: BootstrapChildDto,
    deviceId: string | null,
    headers: Record<string, string | string[] | undefined>
  ): Promise<BootstrapChildView> {
    if (dto.consent?.accepted !== true) {
      // ★ 只认**字面 true**：缺 / false / 字符串 "true" 一律 400。
      //   与 W7-D 的 `{confirmed:true}` 同一口径（"同意"不能是"没反对"）。
      throw new BadRequestException({
        code: 'CONSENT_NOT_ACCEPTED',
        message:
          '建立孩子的档案之前必须先同意监护人协议（请求体必须是 { consent: { accepted: true } }）。' +
          '本次没有创建任何数据。'
      })
    }

    if (deviceId === null || deviceId === '') {
      // DeviceSession 的行键需要它（它是**设备标识**，不是凭据）。
      throw new BadRequestException({
        code: 'DEVICE_ID_REQUIRED',
        message:
          '缺少 x-kp-device-id 请求头：建孩子要同时在这台设备上开一个 5 分钟家长窗口，' +
          '而会话的行键是 (deviceId, childId)。'
      })
    }

    const now = new Date()
    const result = await this.identity.bootstrapChild({
      userId: identity.userId,
      consentVersion: consentTextVersion(),
      ipHash: hashPii(clientIpOf(headers)),
      userAgentHash: hashPii(singleHeader(headers['user-agent'])),
      relation: dto.relation ?? 'other',
      parentModeUntil: new Date(now.getTime() + PARENT_MODE_TTL_MS),
      deviceId
    })

    return {
      childId: result.childId,
      role: result.role,
      parentModeUntil: result.parentModeUntil.toISOString(),
      modeSource: 'bootstrap'
    }
  }

  /**
   * `POST /auth/child-session`：已登录用户在这台设备上补一行 `DeviceSession`（`40` §8.4）。
   *
   * 三条前置（缺一条就是越权）：
   *   ① `x-kp-device-id` 存在；② 在该 childId 上有 `ChildMember(active)`（403 `NOT_A_MEMBER`）；
   *   ③ 该 `(deviceId, childId)` 行不属于别人（409 `DEVICE_SESSION_CONFLICT`）。
   *   ②③ 在适配器事务内读+写（否则中间被移除成员位就会写出一行越权会话）。
   */
  async ensureChildSession(
    identity: AuthenticatedIdentity,
    dto: ChildSessionDto,
    deviceId: string | null
  ): Promise<ChildSessionView> {
    if (deviceId === null || deviceId === '') {
      throw new BadRequestException({
        code: 'DEVICE_ID_REQUIRED',
        message: '缺少 x-kp-device-id 请求头：(deviceId, childId) 是会话的行键。'
      })
    }

    const childId = dto.childId.trim()
    const result = await this.identity.ensureChildSession({
      userId: identity.userId,
      childId,
      deviceId,
      sessionExpiresAt: new Date(Date.now() + CHILD_SESSION_TTL_MS)
    })

    return {
      childId,
      role: this.roleOrThrow(result.role),
      sessionExpiresAt: result.sessionExpiresAt.toISOString()
    }
  }

  /**
   * 微信五类结局 ⇒ HTTP（`40` §8.2 的映射表，逐条）。
   *
   * ★ `CREDENTIAL_INVALID` 是**最容易做错**的一行：那是我们自己的配置坏了
   *   （`40125` / `40013`），报成 401 会让用户/客服/开发一致地朝"用户登录失败"
   *   排查 —— 2026-10-29 真实发生过一次。故 500 + `logger.error`（会进告警）。
   */
  private openIdOrThrow(outcome: Code2SessionOutcome): string {
    switch (outcome.kind) {
      case 'OK':
        return outcome.openId
      case 'CODE_INVALID':
        throw new UnauthorizedException({
          code: 'WECHAT_CODE_INVALID',
          message:
            `微信登录码无效或已使用过（errcode=${outcome.errcode ?? 'n/a'}）。` +
            '请重新 wx.login() 拿到新 code 后再试**一次**。'
        })
      case 'RATE_LIMITED':
        throw new HttpException(
          {
            code: 'LOGIN_RATE_LIMITED',
            scope: 'wechat',
            retryAfterSeconds: 60,
            message: '微信侧限流（45011）。请退避一段时间，**不要**自动重试。'
          },
          HttpStatus.TOO_MANY_REQUESTS
        )
      case 'CREDENTIAL_INVALID':
        this.logger.error(
          `微信凭据无效（errcode=${outcome.errcode ?? 'n/a'}）：检查 WECHAT_MP_APPID / WECHAT_MP_SECRET` +
            '（AppSecret 泄露或过期需在公众平台重置）。★ 这是**服务端配置**问题，不是用户的问题。'
        )
        throw new InternalServerErrorException({
          code: 'WECHAT_CREDENTIAL_INVALID',
          message: '服务端的微信凭据配置有误，登录暂时不可用。已记录告警，请稍后再试。'
        })
      case 'NOT_CONFIGURED':
        throw new ServiceUnavailableException({
          code: 'WECHAT_NOT_CONFIGURED',
          missing: outcome.missing,
          message:
            `服务端还没有配置微信小程序凭据（缺 ${outcome.missing.join(' / ')}），登录暂不可用。`
        })
      case 'UNAVAILABLE':
        this.logger.warn(`微信 code2session 不可用：${outcome.detail}`)
        throw new BadGatewayException({
          code: 'WECHAT_UNAVAILABLE',
          message: '微信登录服务暂时不可用（网络或微信侧故障）。请稍后重试。'
        })
    }
  }

  /** 角色白名单：读到白名单外的值 ⇒ **500**（数据/实现问题，不是权限问题）。 */
  private roleOrThrow(raw: string): MemberRoleName {
    if (!isMemberRole(raw)) {
      this.logger.error(`成员位角色非法：${JSON.stringify(raw)}（白名单 ${MEMBER_ROLES.join(' / ')}）`)
      throw new InternalServerErrorException({
        code: 'MEMBER_ROLE_INVALID',
        message:
          '服务端的成员位角色不在白名单内，已拒绝本次请求。' +
          '★ 这不是"你没权限"：重新登录不会修好它 —— 请报给开发者。'
      })
    }
    return raw
  }
}

/** `user-agent` 这类头只取单值；重复头按"没有"处理（不拼接，避免歧义）。 */
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}


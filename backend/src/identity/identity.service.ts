import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
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
import { burnPasswordHashCost, hashPassword, verifyPassword } from '../common/password-hash'
import { consentTextVersion } from '../consent/consent.service'
import { clientIpOf, hashPii } from '../consent/hash-pii'
import {
  INVITE_CODE_LENGTH,
  INVITE_SESSION_TTL_MS,
  isWellFormedInviteCode,
  normalizeInviteCode
} from '../invites/invite-code'
import {
  REGISTRATION_INVITE_REPOSITORY,
  type RegistrationInvitePort
} from '../registration-invites/registration-invite.repository'
import type { AuthenticatedIdentity } from '../permissions/actor'
import {
  classifyIdentifier,
  identifierMessage,
  normalizeEmail,
  normalizePhone,
  passwordMessage,
  validatePasswordStrength
} from './account-identifier'
import { authSessionExpiresAt, hashToken, issueToken } from './auth-session.gate'
import { AUTH_SESSION_REPOSITORY, type AuthSessionPort } from './auth-session.repository'
import type { BootstrapChildDto } from './dto/bootstrap-child.dto'
import type { ChildSessionDto } from './dto/child-session.dto'
import type { LoginAccountDto } from './dto/login-account.dto'
import type { LoginDto } from './dto/login.dto'
import type { RegisterWithInviteDto } from './dto/register-with-invite.dto'
import type { UpdateAccountDto } from './dto/update-account.dto'
import type { VerifyDateCodeDto } from './dto/verify-date-code.dto'
import { verifyDateVerificationCode, type DateCodeVerdict } from './date-verification-code'
import { CHILD_SESSION_TTL_MS } from './identity.prisma.repository'
import {
  INVITE_REGISTRATION_REPOSITORY,
  type InviteRegistrationPort
} from './invite-registration.repository'
import {
  IDENTITY_REPOSITORY,
  type ChildMembershipRow,
  type IdentityPort
} from './identity.repository'
import {
  PUBLIC_REGISTRATION_REPOSITORY,
  type PublicRegistrationPort
} from './public-registration.repository'
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

/**
 * `PUT /auth/account` 的响应（W9-D，2026-10-30 / `42` §3.3）。
 *
 * ★ **没有** `passwordHash`、没有密码长度、没有任何"密码长什么样"的信息 ——
 *   只回答"设了没有"。客户端据此决定下次显示"设置密码"还是"修改密码"。
 */
export interface AccountView {
  phone: string | null
  email: string | null
  hasPassword: boolean
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
    @Inject(INVITE_REGISTRATION_REPOSITORY)
    private readonly registration: InviteRegistrationPort,
    @Inject(REGISTRATION_INVITE_REPOSITORY)
    private readonly registrationInvites: RegistrationInvitePort,
    @Inject(PUBLIC_REGISTRATION_REPOSITORY)
    private readonly publicRegistration: PublicRegistrationPort,
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
    this.enforceRateLimit(context)

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

  /**
   * `POST /auth/login-account` —— App 用**手机号/邮箱 + 密码**登录（W9-D，2026-10-30）。
   *
   * ── 它与 `POST /auth/login` 的关系（**不是**第二条身份体系）──────────────────
   *   两者签发的是**同一种** `AuthSession`，只是"验身方式"不同：
   *     微信：`code` → `openId` → 找到/建立 User；
   *     密码：`identifier` → 找到 User → 校验 `passwordHash`。
   *   落库之后 `method` 只是审计字段，守卫判定完全一致（`auth-session.gate.ts`）。
   *
   * ── 顺序（第 2 条与第 4 条是安全条款）──────────────────────────────────────
   *   1. **限流**：与 `/auth/login` 共用同一份额度（同 IP 20/分、同设备 10/分）。
   *      密码可以被猜，共用额度意味着"狂刷登录页"会同时限制住微信登录，
   *      这是刻意的 —— 两个端点打的是同一个东西（拿到凭据）。
   *   2. **先分类标识**：形状错 ⇒ 400，且**不消耗**一次 scrypt。
   *      反过来（先查库）会让畸形输入也走一遍索引查询。
   *   3. **统一 401**：账号不存在 / 从未设密码 / 密码错 ⇒ **同一个** 401
   *      `ACCOUNT_INVALID_CREDENTIALS`。前两种还会空跑一次 scrypt
   *      （`burnPasswordHashCost()`），否则"响应快 = 这个号没注册"就是一条
   *      手机号枚举接口。
   *   4. **新签发** token（`issueToken()`）：与微信登录同一条会话固定防护 ——
   *      绝不接受"用旧 token 换新 token"（`40` §11.3）。
   *   5. 落库：`identity.issueSession()` 在**同一事务**里再确认 `status='active'`
   *      （验密码到写会话之间隔了 ~50ms 的 scrypt，账号可能刚被停用）。
   *
   * ── 为什么**不**在这里建 User ─────────────────────────────────────────────────
   *   首版没有开放注册（`42` §5）：所有账号都由小程序（微信登录）创建，
   *   App 只是**另一种进入方式**。这条约束换来两件事：
   *     ① 不会出现"没有任何家庭的孤儿账号"；
   *     ② 忘记密码有兜底 —— 家长可以在小程序里（微信身份已证明）重设密码。
   *   若在这里"查不到就建一个"，手机号打错一个数字就会静默生成一个新账号，
   *   然后他进去发现"我的孩子不见了"（`42` §5.2）。
   */
  async loginWithAccount(
    dto: LoginAccountDto,
    context: { deviceId: string | null; headers: Record<string, string | string[] | undefined> }
  ): Promise<LoginView> {
    this.enforceRateLimit(context)

    const classified = classifyIdentifier(dto.identifier)
    if (classified.kind === 'invalid') {
      throw new BadRequestException({
        code: 'INVALID_IDENTIFIER',
        reason: classified.reason,
        message: identifierMessage(classified.reason)
      })
    }

    const { type, value } = classified.identifier
    const account = await this.identity.readAccountByIdentifier(type, value)
    if (account === null || account.passwordHash === null) {
      // ★ 这三行是**时序**，不是逻辑：不存在与「没设密码」都必须花掉与
      //   "密码错了"同等的 CPU，否则响应时间会变成一张注册状态表。
      await burnPasswordHashCost()
      this.accountInvalid()
    }

    if (!(await verifyPassword(dto.password, account.passwordHash))) {
      this.accountInvalid()
    }

    const now = new Date()
    const token = issueToken()
    const expiresAt = authSessionExpiresAt(now)

    const user = await this.identity.issueSession({
      userId: account.userId,
      tokenHash: hashToken(token),
      method: 'password',
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

  /**
   * `POST /auth/register-invite` —— **用邀请码注册**（W11-A，2026-11-02 / `45`）。
   *
   * ── 它把「开放注册」替换成了什么 ─────────────────────────────────────────────
   *   `42` §5.1 拒绝开放注册（打错一位手机号 ⇒ 孤儿账号 + 「我的孩子不见了」），
   *   `42` §9 第 1 条写明了补上它的**前置条件**：邀请码并入家庭。
   *   本方法就是那个前置条件：
   *     · 没有邀请码 ⇒ 400（形状不对）/ 409（不可用），**注册不成立**；
   *     · 有邀请码 ⇒ 建的是「加入这个家庭的新账号」，不是新家庭。
   *   所以它既不是开放注册，也不需要在 App 里「先随便建个号再加家庭」。
   *
   * ── W12（2026-11-02）：同一个端点还服务**网站发放的注册码** ─────────────────
   *   网站码不绑定家庭（`RegistrationInvite`），只授权「建一个账号」。
   *   走那条路时回包的 `membership` 是 **null**：新账号零个孩子，
   *   客户端走既有的「建立孩子档案」引导（`POST /children`）。
   *   两条路共用一个端点，是因为对用户而言输入完全相同（码 + 标识 + 密码），
   *   而「码从哪来」不该要求用户先选对入口。
   *
   * ── 顺序（第 2/3 条是安全条款）──────────────────────────────────────────────
   *   1. **限流**：与两个登录端点共用同一份额度（同 IP 20/分、同设备 10/分）。
   *      注册同样是「拿到凭据」，不共用额度就等于开了一个绕过限流的后门。
   *   2. **先验形状**（邀请码 / 标识 / 密码强度）再花 scrypt：
   *      畸形输入不该消耗一次 ~50ms 的哈希。
   *   3. **角色绝不来自请求体**：DTO 没有 `role`，全局管道对多余键 400；
   *      真正的角色由适配器从邀请码行读取。
   *   4. **新签发** token（`issueToken()`）：与两条登录路由同一条会话固定防护。
   *
   * ── 成功回包与 `POST /auth/login-account` **逐字段同构** ────────────────────
   *   客户端只需要一套解析器（`AuthLoginResult`）。家庭邀请码的 `membership`
   *   一定有值；网站注册码是 `null`（见上）。无论哪种，客户端都应走既有的
   *   `POST /auth/child-session` / 建孩子编排 —— 那条路已经处理了
   *   「换设备 / 换账号 / 零个孩子」。
   */
  async registerWithInvite(
    dto: RegisterWithInviteDto,
    context: { deviceId: string | null; headers: Record<string, string | string[] | undefined> }
  ): Promise<LoginView> {
    this.enforceRateLimit(context)

    // DeviceSession 的行键是 (deviceId, childId)。没有设备 id 就注册 ⇒ 发出去的
    // token 永远过不了业务守卫，用户会看到「登录成功」然后每个请求 401。
    if (context.deviceId === null || context.deviceId === '') {
      throw new BadRequestException({
        code: 'DEVICE_ID_REQUIRED',
        message:
          '缺少 x-kp-device-id 请求头：注册要同时在这台设备上开一个会话，' +
          '而会话的行键是 (deviceId, childId)。'
      })
    }

    // 用户会把码抄成 `abcd-efgh` / `ABCD EFGH` / 前后带空格 —— 归一化只有一份
    // （规范化和形状判定都在 `invite-code.ts`，与 `/invites/accept` 同一份）。
    const code = normalizeInviteCode(dto.inviteCode)
    if (!isWellFormedInviteCode(code)) {
      // 形状错是**输入**问题（400），不是「码不可用」（409）：
      // 说成后者会让人去找家长重发，而他其实只是抄漏了一位。
      throw new BadRequestException({
        code: 'INVITE_CODE_MALFORMED',
        message:
          `邀请码是 ${INVITE_CODE_LENGTH} 位字母数字（不含容易认错的 0/O/1/I/L）。` +
          '请检查是否抄漏或抄错了字符。'
      })
    }

    const classified = classifyIdentifier(dto.identifier)
    if (classified.kind === 'invalid') {
      throw new BadRequestException({
        code: 'INVALID_IDENTIFIER',
        reason: classified.reason,
        message: identifierMessage(classified.reason)
      })
    }
    const { type, value } = classified.identifier

    // ★ 密码强度**只在设置密码时**判定（与 `updateAccount` 同一口径）：
    //   规则也只有一份（`account-identifier.ts`）。
    const strength = validatePasswordStrength(dto.password, value)
    if (strength.kind === 'invalid') {
      throw new BadRequestException({
        code: 'WEAK_PASSWORD',
        reason: strength.reason,
        message: passwordMessage(strength.reason)
      })
    }
    const passwordHash = await hashPassword(dto.password)

    const now = new Date()
    const token = issueToken()
    const expiresAt = authSessionExpiresAt(now)
    const rawName = dto.displayName?.trim() ?? ''

    // ── 这张码是「网站发的」还是「家庭里发的」？────────────────────────────
    //   W12 起同一个端点服务两种凭据。先问**来源**（只读，不授权），
    //   两种码的形状相同（8 位、同一字母表），靠库里的表区分。
    //   ★ 这里只做路由：真正的「还能不能用」仍由各自的事务用一条 SQL 回答。
    const websiteInvite = await this.registrationInvites.findByCode(code)
    if (websiteInvite !== null) {
      // 网站码绑定「手机号 + 邮箱」，注册时填其中任意一个即可。
      // ★ 这里先比一次是为了给用户一句准确的话；占码 SQL 里还有同样的条件，
      //   两处不矛盾：SQL 是授权判据，这里是文案判据。
      if (websiteInvite.phone !== value && websiteInvite.email !== value) {
        throw new ConflictException({
          code: 'INVITE_CODE_UNAVAILABLE',
          message:
            '这张邀请码与这里填写的手机号/邮箱不一致（也可能已使用、过期或已吊销）。' +
            '请回到获取页面，用申请时的手机号或邮箱填写；或重新申请一张。'
        })
      }

      const registered = await this.publicRegistration.registerWithInvite({
        code,
        identifierType: type,
        identifierValue: value,
        passwordHash,
        displayName: rawName === '' ? null : rawName,
        deviceId: context.deviceId,
        tokenHash: hashToken(token),
        authExpiresAt: expiresAt
      })

      // ★ `membership: null` 是**事实**：网站码不加入任何家庭，这个账号此刻
      //   零个孩子。客户端（App 的 `AccountGate` / 小程序的登录闸门）本来就会
      //   在 `children: []` 时走「建立孩子档案」引导 —— 不需要新状态。
      return {
        token,
        expiresAt: expiresAt.toISOString(),
        user: { id: registered.userId, displayName: registered.displayName },
        membership: null
      }
    }

    const registered = await this.registration.registerWithInvite({
      code,
      identifierType: type,
      identifierValue: value,
      passwordHash,
      // 空字符串 ⇒ null：`User.displayName` 可空，不要落一个空串（界面上会画成空白）。
      displayName: rawName === '' ? null : rawName,
      deviceId: context.deviceId,
      tokenHash: hashToken(token),
      authExpiresAt: expiresAt,
      // 与 `POST /invites/accept` 同一条 TTL（`INVITE_SESSION_TTL_MS` 的注释里
      // 写清了它与 02 §7「5 分钟家长模式」的偏差，改的时候两处必须一起改）。
      deviceSessionExpiresAt: new Date(now.getTime() + INVITE_SESSION_TTL_MS)
    })

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: registered.userId, displayName: registered.displayName },
      membership: { childId: registered.childId, role: registered.role }
    }
  }

  /**
   * 三个「拿到凭据」的端点共用的**限流闸门**。
   *
   * ── 为什么抽成一个方法（而不是每个端点抄一遍）────────────────────────────────
   *   `LoginRateLimiter` 的 key 是**来源**（IP / deviceId），不是端点。三处若各抄
   *   一份，某天有人只调了其中一个的额度，就会出现「登录限流 20 次、注册限流
   *   不限」—— 那等于用注册绕过登录限流。
   *
   * 429 而不是 503：503 会被读成「服务挂了」（客户端退避 30s+），而 429 的语义
   * 正是「你太快了，等一下再来」（`40` §11.1）。
   */
  private enforceRateLimit(context: {
    deviceId: string | null
    headers: Record<string, string | string[] | undefined>
  }): void {
    const limited = this.limiter.check(
      { ip: clientIpOf(context.headers), deviceId: context.deviceId },
      new Date()
    )
    if (limited === null) return

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

  /**
   * 账号登录失败的**唯一出口**（401）。
   *
   * ★ 不区分「没有这个账号」「从未设过密码」「密码不对」：分开说等于把
   *   `/auth/login-account` 变成"这个手机号/邮箱注册过吗"的查询接口。
   *   手机号号段有限、邮箱可批量猜 —— 那是一条真实可用的枚举路径（`42` §5.3）。
   *
   * 返回 `never` 是**刻意的**：调用方写 `this.accountInvalid()` 之后，
   * TS 会立刻收窄上面那些 `null` 判断 —— 于是不存在"忘了 return"的分支。
   */
  private accountInvalid(): never {
    throw new UnauthorizedException({
      code: 'ACCOUNT_INVALID_CREDENTIALS',
      message:
        '手机号/邮箱或密码不正确。' +
        '如果还没设置过密码，请在小程序「我的 → App 登录账号」绑定手机号/邮箱并设置密码；' +
        '忘记密码也可以在那里重设（不需要短信验证码）。'
    })
  }

  /**
   * `POST /auth/date-code` —— 固定规则验证码（`MMDD` ＋ 两位 ISO 星期）的服务端校验（W9-C）。
   *
   * ── 为什么校验必须在服务端（这是本端点的**全部**价值）──────────────────────
   *   码本身由「日期 + 星期」推导而来，客户端当然也能算 —— 但**由客户端自己判**就等于
   *   没有校验：孩子把手机系统时间往前拨一天，界面就会放行。放在这里 ⇒ 判定用的是
   *   **服务器时钟**，规则也只有一份实现（`date-verification-code.ts`）。
   *
   * ── 限流：与登录**共用**同一份额度（刻意的）───────────────────────────────
   *   `LoginRateLimiter` 的 key 是"来源"（IP / deviceId），不是"端点" ——
   *   于是同一来源的匿名尝试共享 20/分（IP）与 10/分（设备）的总额。
   *   代价：有人狂刷本端点会让同一来源的登录也多等一会儿（最多 1 分钟）；
   *   收益：不引入第二个限流器，也不会出现"两个端点各有一份额度 ⇒ 总额放大 2 倍"。
   *
   * ── 码不对为什么回 200 而不是 401 ────────────────────────────────────────────
   *   它是**校验结果**，不是认证失败：回 401 会让客户端误以为"要重新登录"，
   *   而调用它的界面（家长门 / 登录页第二步）此刻可能根本没有会话可登录。
   *   于是 `{ valid: false }` ＋ 200 是唯一不会把人送到错误分支的形状。
   */
  async verifyDateCode(
    dto: VerifyDateCodeDto,
    context: { deviceId: string | null; headers: Record<string, string | string[] | undefined> }
  ): Promise<DateCodeVerdict> {
    const now = new Date()
    const limited = this.limiter.check(
      { ip: clientIpOf(context.headers), deviceId: context.deviceId },
      now
    )
    if (limited !== null) {
      throw new HttpException(
        {
          code: 'DATE_CODE_RATE_LIMITED',
          scope: limited.scope,
          retryAfterSeconds: limited.retryAfterSeconds,
          message:
            `验证码尝试过于频繁（按 ${limited.scope === 'ip' ? 'IP' : '设备'} 限流）。` +
            `请等 ${limited.retryAfterSeconds} 秒再试；**不要**自动重试。`
        },
        HttpStatus.TOO_MANY_REQUESTS
      )
    }

    // ★ 不把输入值写进日志：它可推导，但"用户输入了什么"不该出现在服务端日志里。
    return verifyDateVerificationCode(dto.code, now)
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
   * `PUT /auth/account` —— 绑定手机号/邮箱、设置或修改密码（W9-D，2026-10-30）。
   *
   * ── 为什么它必须 `AuthGuard`（而不是 `@Public()`）───────────────────────────
   *   它**写入**的是"以后能不能登录"。匿名可写等于任何人都能给别人的账号
   *   绑一个自己的手机号 —— 那是账号接管，不是"注册"。
   *   唯一合法的调用者：**已经**通过微信登录的小程序用户（他的身份由
   *   `Authorization` 里的 `AuthSession` 背书，而不是由手机号背书）。
   *
   * ── 两条判定（写在最前面，因为它们决定后面算不算）──────────────────────────
   *   ① 三个字段全空 ⇒ 400 `ACCOUNT_NOTHING_TO_UPDATE`（不是静默 200：
   *      静默成功会让客户端以为"保存好了"，而什么都没变）；
   *   ② 账号非 active ⇒ 403（不是 401：401 会让他去"重新登录"，
   *      而他本来就有有效凭据，问题是账号被停用）。
   *
   * ── 改密码的两道门 ─────────────────────────────────────────────────────────
   *   · **已设过密码** ⇒ 必须带 `currentPassword` 且正确。否则"拿到解锁手机的人"
   *     可以直接改密码，把真正的家长锁在外面；
   *   · 改成功后**撤销其它所有会话**（保留当前这条）—— 见
   *     `AuthSessionPort.revokeOthers` 的注释：不这么做，泄露的旧 token
   *     还能用满 7 天，"我改过密码了"就只是一句心理安慰。
   *
   * ── 唯一冲突 ⇒ 409，不在这里判 ───────────────────────────────────────────────
   *   "这个手机号已被别人绑定"由适配器的唯一索引兜住（`P2002` ⇒ 409
   *   `IDENTIFIER_TAKEN`）。不先查再写：两个请求同时绑同一个号时，
   *   "先查后写"会双双通过检查。
   */
  /**
   * `GET /auth/account` —— 我绑的是哪个手机号 / 邮箱，设过密码没有（W9-D，2026-10-30）。
   *
   * ── 为什么必须有一条**读**路由 ──────────────────────────────────────────────
   *   `PUT` 的回包已经回答了这三个字段，但那只在「刚保存完」时成立。用户下次
   *   打开「App 登录账号」那一屏时，界面必须先知道两件事，否则只能猜：
   *     · **现在绑的是哪个号** —— 不读就只能画一个空白输入框，而用户会把它
   *       读成「我根本没绑过」，于是又绑一次（换号 ⇒ 上一台设备上的 App 登录
   *       再也进不来）。
   *     · **设过密码没有** —— 决定那个框写「设置密码」还是「修改密码」，
   *       也决定要不要「当前密码」（后端在已有密码时**强制**要求它）。
   *       猜错的代价是一次必然 400 的往返，以及一句用户看不懂的错误。
   *
   * ── 为什么和 `PUT` 共用同一份 `AccountView` ─────────────────────────────────
   *   两条路由的响应若字段不同，客户端就要维护两套解析器；而「读到的形状」与
   *   「写回来的形状」不一致时，界面会在保存成功的那一瞬间闪一下（字段突然少了）。
   *
   * ── 泄漏面 ──────────────────────────────────────────────────────────────────
   *   `AuthGuard` 背书的就是调用者本人，返回的也只是他自己那一行：
   *   不返回 `passwordHash`，连密码长度都不给。那条 `status !== 'active'` 的检查
   *   与 `updateAccount` 同一口径 —— 已停用的账号不该在这一屏看到「一切正常」。
   */
  async readAccount(identity: AuthenticatedIdentity): Promise<AccountView> {
    const current = await this.identity.readAccount(identity.userId)
    if (current === null || current.status !== 'active') {
      throw new ForbiddenException({
        code: 'USER_NOT_ACTIVE',
        message: '这个账号当前不可用（已停用或已注销）。'
      })
    }
    return {
      phone: current.phone,
      email: current.email,
      hasPassword: current.passwordHash !== null
    }
  }

  async updateAccount(
    identity: AuthenticatedIdentity,
    dto: UpdateAccountDto
  ): Promise<AccountView> {
    if (dto.phone === undefined && dto.email === undefined && dto.password === undefined) {
      throw new BadRequestException({
        code: 'ACCOUNT_NOTHING_TO_UPDATE',
        message: '这次请求没有要改的内容：手机号、邮箱、密码至少要填一个。'
      })
    }

    const current = await this.identity.readAccount(identity.userId)
    if (current === null || current.status !== 'active') {
      throw new ForbiddenException({
        code: 'USER_NOT_ACTIVE',
        message: '这个账号当前不可用（已停用或已注销），没有修改任何内容。'
      })
    }

    let phone: string | undefined
    if (dto.phone !== undefined) {
      const normalized = normalizePhone(dto.phone)
      if (normalized.kind === 'invalid') {
        throw new BadRequestException({
          code: 'INVALID_PHONE',
          reason: normalized.reason,
          message: identifierMessage(normalized.reason)
        })
      }
      phone = normalized.identifier.value
    }

    let email: string | undefined
    if (dto.email !== undefined) {
      const normalized = normalizeEmail(dto.email)
      if (normalized.kind === 'invalid') {
        throw new BadRequestException({
          code: 'INVALID_EMAIL',
          reason: normalized.reason,
          message: identifierMessage(normalized.reason)
        })
      }
      email = normalized.identifier.value
    }

    // 密码强度里的"不能与标识相同"：**本次要改的值**优先于库里现有的值 ——
    // 用户在同一个请求里既换手机号又设密码时，他脑子里想的是新的那个号。
    const identifierForPassword = phone ?? email ?? current.phone ?? current.email ?? undefined

    let passwordHash: string | undefined
    if (dto.password !== undefined) {
      if (current.passwordHash !== null) {
        if (dto.currentPassword === undefined || dto.currentPassword === '') {
          throw new BadRequestException({
            code: 'CURRENT_PASSWORD_REQUIRED',
            message: '修改密码前请先填写当前密码（防止别人拿到你的手机就直接改密码）。'
          })
        }
        if (!(await verifyPassword(dto.currentPassword, current.passwordHash))) {
          // 403 而不是 401：调用者是**已认证**的，错的是他给的旧密码。
          // 401 会触发客户端"清 token 去登录页"，而他并不需要重新登录。
          throw new ForbiddenException({
            code: 'CURRENT_PASSWORD_INVALID',
            message: '当前密码不正确，密码没有修改。'
          })
        }
      }

      const strength = validatePasswordStrength(dto.password, identifierForPassword)
      if (strength.kind === 'invalid') {
        throw new BadRequestException({
          code: 'WEAK_PASSWORD',
          reason: strength.reason,
          message: passwordMessage(strength.reason)
        })
      }
      passwordHash = await hashPassword(dto.password)
    }

    const updated = await this.identity.writeAccount({
      userId: identity.userId,
      ...(phone === undefined ? {} : { phone }),
      ...(email === undefined ? {} : { email }),
      ...(passwordHash === undefined
        ? {}
        : { passwordHash, passwordSetAt: new Date() })
    })

    if (passwordHash !== undefined) {
      const revoked = await this.sessions.revokeOthers(
        identity.userId,
        identity.tokenHash,
        new Date(),
        'password_changed'
      )
      this.logger.log(
        `修改密码后撤销了 ${revoked} 条其它会话（userId=${identity.userId}；当前这条保留）`
      )
    }

    return updated
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


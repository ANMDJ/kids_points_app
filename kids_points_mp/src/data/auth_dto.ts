import { AUTH_FALLBACK_MESSAGES, AuthApiException } from './auth_api_errors'
import type { MemberRole } from './types'

/**
 * 登录链路的**线格式**（W9-A / `40` §8.1）。
 *
 * 五条路由的回包，逐字段对着 `backend/src/identity/identity.service.ts` 的
 * `SessionView` / `LoginView` / `BootstrapChildView` / `ChildSessionView` 抄。
 *
 * ── 三条贯穿全文件的解析纪律（与 `read_dto.ts` 同源）────────────────────────
 *   ① **不猜默认值**。`children` 缺失是 `malformed`，不是"没有孩子"——
 *      后者会让用户看到"建第一个孩子"的引导，而他其实有 3 个。
 *      同理 `expiresAt` 不认识就是不认识，不许当成"永不过期"。
 *   ② **枚举必须过白名单**。`role` 只认 `guardian|child|viewer`；
 *      后端多给一个值，客户端不许 `as MemberRole` 硬塞（那会让权限判断静默错）。
 *   ③ **时间统一成 epoch 毫秒的绝对时刻**（`readDate` 同口径）。
 *      存绝对时刻、界面现算剩余，是本仓库的既有纪律（`02` §7 的倒计时教训）：
 *      存"还剩 7 天"的东西会在切后台 / 改系统时间后说谎。
 */

/** 会话里的用户信息（`user` 块，两条路由同构）。 */
export interface AuthUser {
  readonly id: string
  readonly displayName: string | null
}

/** `GET /auth/session` 的 `children[]` 一项：成员位，不是"当前角色"。 */
export interface ChildMembership {
  readonly childId: string
  readonly name: string
  readonly role: MemberRole
}

const MEMBER_ROLES: readonly MemberRole[] = ['guardian', 'child', 'viewer']

export class AuthUserDto {
  private constructor() {}

  static fromJson(raw: unknown, path = 'user'): AuthUser {
    const json = requireObject(raw, path)
    return {
      id: requireString(json, 'id', `${path}.id`),
      displayName: requireOptionalString(json, 'displayName', `${path}.displayName`)
    }
  }
}

export class ChildMembershipDto {
  private constructor() {}

  static fromJson(raw: unknown, path: string): ChildMembership {
    const json = requireObject(raw, path)
    return {
      childId: requireString(json, 'childId', `${path}.childId`),
      name: requireString(json, 'name', `${path}.name`),
      role: requireEnum(MEMBER_ROLES, json, 'role', `${path}.role`)
    }
  }
}

/** `GET /auth/session` 的回包。 */
export class SessionDto {
  readonly user: AuthUser
  /** 认证会话的绝对到期（epoch ms）。7 天绝对到期，不因使用而延长。 */
  readonly expiresAt: number
  readonly children: readonly ChildMembership[]

  private constructor(input: {
    user: AuthUser
    expiresAt: number
    children: readonly ChildMembership[]
  }) {
    this.user = input.user
    this.expiresAt = input.expiresAt
    this.children = input.children
  }

  static fromJson(raw: unknown): SessionDto {
    const json = requireObject(raw, '$')
    const user = AuthUserDto.fromJson(json.user, 'user')
    const expiresAt = requireDate(json, 'expiresAt', 'expiresAt')
    const rawChildren = requireList(json, 'children', 'children')
    const children = rawChildren.map((item, index) =>
      ChildMembershipDto.fromJson(item, `children[${index}]`)
    )
    assertUniqueChildIds(children)
    return new SessionDto({ user, expiresAt, children })
  }

  /** 0 个 ⇒ `POST /children`；1 个 ⇒ 直接进；N 个 ⇒ 选择器（首版限 1）。 */
  get childCount(): number {
    return this.children.length
  }
}

/**
 * `POST /auth/login` 的回包。
 *
 * ★ `token` **只在这里出现一次**（`40` §11.2）：本对象不许被 JSON.stringify 进
 *   日志 / 埋点 / 异常 detail。`toDebugString()` 是唯一"安全打印"的入口。
 *
 * ★ `membership` 只是"少一次往返"的提示，**权威来源是 `GET /auth/session`**
 *   （`40` §8.3）。客户端不得凭它决定"能不能用某个 childId"。
 */
export class LoginResultDto {
  readonly token: string
  readonly expiresAt: number
  readonly user: AuthUser
  readonly membership: { readonly childId: string; readonly role: MemberRole } | null

  private constructor(input: {
    token: string
    expiresAt: number
    user: AuthUser
    membership: { childId: string; role: MemberRole } | null
  }) {
    this.token = input.token
    this.expiresAt = input.expiresAt
    this.user = input.user
    this.membership = input.membership
  }

  static fromJson(raw: unknown): LoginResultDto {
    const json = requireObject(raw, '$')
    const token = requireString(json, 'token', 'token').trim()
    if (token === '') {
      throw AuthApiException.malformed('token', '期望非空字符串，实际空串')
    }
    if (/\s/.test(token)) {
      // 空白会让 `Authorization: Bearer <token>` 在中间层被截断。
      throw AuthApiException.malformed('token', 'token 里不能有空白字符')
    }
    const expiresAt = requireDate(json, 'expiresAt', 'expiresAt')
    const user = AuthUserDto.fromJson(json.user, 'user')

    const rawMembership = json.membership
    let membership: LoginResultDto['membership'] = null
    if (rawMembership !== undefined && rawMembership !== null) {
      const membershipJson = requireObject(rawMembership, 'membership')
      membership = {
        childId: requireString(membershipJson, 'childId', 'membership.childId'),
        role: requireEnum(MEMBER_ROLES, membershipJson, 'role', 'membership.role')
      }
    }

    return new LoginResultDto({ token, expiresAt, user, membership })
  }

  /** 日志安全版：**没有** token（`40` §11.2 第一条）。 */
  toDebugString(): string {
    return `LoginResult(user=${this.user.id}, membership=${
      this.membership === null ? 'null' : this.membership.childId
    }, expiresAt=${new Date(this.expiresAt).toISOString()})`
  }
}

/**
 * `POST /children` 的回包。
 *
 * `modeSource` 只可能是 `bootstrap`：引导期**根本没有 PIN**，
 * 这 5 分钟不是"输 PIN 换来的"。若后端给了别的值，说明契约变了 ——
 * 客户端宁可 malformed，也不要画一个"PIN 已被绕过"的假象。
 */
export class BootstrapChildResultDto {
  readonly childId: string
  readonly role: 'guardian'
  readonly parentModeUntil: number
  readonly modeSource: 'bootstrap'

  private constructor(input: { childId: string; parentModeUntil: number }) {
    this.childId = input.childId
    this.role = 'guardian'
    this.parentModeUntil = input.parentModeUntil
    this.modeSource = 'bootstrap'
  }

  static fromJson(raw: unknown): BootstrapChildResultDto {
    const json = requireObject(raw, '$')
    const childId = requireString(json, 'childId', 'childId')
    const parentModeUntil = requireDate(json, 'parentModeUntil', 'parentModeUntil')
    const role = requireString(json, 'role', 'role')
    if (role !== 'guardian') {
      throw AuthApiException.malformed(
        'role',
        `建孩子的回包角色必须是 guardian，实际 ${role}`
      )
    }
    const modeSource = requireString(json, 'modeSource', 'modeSource')
    if (modeSource !== 'bootstrap') {
      throw AuthApiException.malformed(
        'modeSource',
        `引导期来源必须是 bootstrap，实际 ${modeSource}（PIN 窗口不该出现在这里）`
      )
    }
    return new BootstrapChildResultDto({ childId, parentModeUntil })
  }
}

/** `POST /auth/child-session` 的回包。 */
export class ChildSessionResultDto {
  readonly childId: string
  readonly role: MemberRole
  /** 这条**设备会话**的绝对到期（epoch ms）—— 与 `AuthSession.expiresAt` 是两件事。 */
  readonly sessionExpiresAt: number

  private constructor(input: {
    childId: string
    role: MemberRole
    sessionExpiresAt: number
  }) {
    this.childId = input.childId
    this.role = input.role
    this.sessionExpiresAt = input.sessionExpiresAt
  }

  static fromJson(raw: unknown, expectedChildId?: string): ChildSessionResultDto {
    const json = requireObject(raw, '$')
    const childId = requireString(json, 'childId', 'childId')
    if (expectedChildId !== undefined && childId !== expectedChildId) {
      // 回声不一致 = 这台设备的会话被开在了**另一个孩子**上。
      // 静默采用会让后续所有请求打到错误的孩子（那是最难查的一类越权）。
      throw AuthApiException.malformed(
        'childId',
        `回包 childId=${childId} 与请求 ${expectedChildId} 不一致`
      )
    }
    return new ChildSessionResultDto({
      childId,
      role: requireEnum(MEMBER_ROLES, json, 'role', 'role'),
      sessionExpiresAt: requireDate(json, 'sessionExpiresAt', 'sessionExpiresAt')
    })
  }
}

/**
 * `children[]` 里 **childId 必须互不相同**。
 *
 * 重复 = 后端把同一条成员位算了两遍。客户端若静默去重，"我有几个孩子"就会
 * 与界面上的数量不一致；若不去重，选择器里会出现两个一模一样的条目。
 * 报错是唯一不会撒谎的处理。
 */
function assertUniqueChildIds(children: readonly ChildMembership[]): void {
  const seen = new Set<string>()
  children.forEach((child, index) => {
    if (seen.has(child.childId)) {
      throw AuthApiException.malformed(
        `children[${index}].childId`,
        `childId 重复：${child.childId}`
      )
    }
    seen.add(child.childId)
  })
}

// ─────────────────────────────────────────────────────── 本地严格读取器
//
// 为什么不复用 `read_dto.ts` 的 `readString` 等：那些读器抛的是
// `ReadApiException`。登录链路的调用方（`auth_session.ts`）必须只面对
// **一种**异常类型，否则"这 401 要不要静默重登"就要判两个 instanceof。

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw AuthApiException.malformed(path, `期望对象，实际 ${typeName(value)}`)
}

function requireString(
  json: Record<string, unknown>,
  key: string,
  path: string
): string {
  const value = json[key]
  if (typeof value === 'string' && value !== '') return value
  throw AuthApiException.malformed(path, `期望非空字符串，实际 ${typeName(value)}`)
}

function requireOptionalString(
  json: Record<string, unknown>,
  key: string,
  path: string
): string | null {
  const value = json[key]
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  throw AuthApiException.malformed(path, `期望字符串或 null，实际 ${typeName(value)}`)
}

function requireList(
  json: Record<string, unknown>,
  key: string,
  path: string
): unknown[] {
  const value = json[key]
  if (Array.isArray(value)) return value
  throw AuthApiException.malformed(path, `期望数组，实际 ${typeName(value)}`)
}

function requireEnum<T extends string>(
  values: readonly T[],
  json: Record<string, unknown>,
  key: string,
  path: string
): T {
  const raw = json[key]
  if (typeof raw === 'string' && (values as readonly string[]).indexOf(raw) >= 0) {
    return raw as T
  }
  throw AuthApiException.malformed(
    path,
    `期望 ${values.join(' | ')} 之一，实际 ${typeName(raw)}`
  )
}

/**
 * ISO-8601 → epoch ms。
 *
 * `Date.parse('')` / `Date.parse('abc')` 都是 `NaN`，但 `Date.parse('2026-13-45')`
 * 在部分引擎里会**回绕**成别的日期。故额外要求字符串里带 `T`（ISO 的日期时间
 * 分隔符），把"日期串"与"日期时间串"区分开 —— 后端发的都是
 * `new Date().toISOString()`，一定带 `T`。
 */
function requireDate(
  json: Record<string, unknown>,
  key: string,
  path: string
): number {
  const raw = requireString(json, key, path)
  const parsed = Date.parse(raw)
  if (raw.indexOf('T') < 0 || !Number.isFinite(parsed)) {
    throw AuthApiException.malformed(path, `不是 ISO-8601 时间：${raw}`)
  }
  return parsed
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 业务码 → 中文兜底文案（服务端没给 `message` 时用）。 */
/** `PUT /auth/account` 的回包（W9-D，2026-10-30 / `42` §3.2）。 */
export interface AccountSnapshot {
  readonly phone: string | null
  readonly email: string | null
  readonly hasPassword: boolean
}

/**
 * 绑定结果解析。
 *
 * ★ **没有**密码长度 / 哈希 —— 服务端只回答"设了没有"，
 *   客户端也就只该知道这一个比特（`42` §3.2）。
 *
 * ★ 自相矛盾的一条：三个字段全空 ⇒ `malformed`。那种状态下这个账号
 *   根本登不进 App，说"保存成功"会让用户在白屏上反复试密码。
 *   （只设密码不绑标识是允许的：`hasPassword=true` ⇒ 通过检查。）
 */
export class AccountDto {
  private constructor() {}

  /**
   * `PUT /auth/account` 的回包（**严格**）。
   *
   * 三字段全空 ⇒ `malformed`：一次"保存成功"之后账号必然至少有一个登录标识，
   * 全空说明回包坏了，此时说"保存成功"会让用户在白屏上反复试密码。
   */
  static fromJson(raw: unknown, path = 'account'): AccountSnapshot {
    return AccountDto.parse(raw, path, false)
  }

  /**
   * `GET /auth/account` 的回包（**宽松**）。
   *
   * ★ 与 `fromJson` 的唯一差别：三字段全空在这里是**合法**的。
   *   它表示"这个账号还没有 App 登录账号" —— 这正是那一屏要告诉用户的结论，
   *   也是「绑定」这个动作存在的前提。若沿用严格解析，**每个新用户一打开
   *   那一屏就会看到"服务器返回的数据不符合约定"**，然后永远绑不上。
   *
   * ★ 两个入口共用一份 `parse`，形状判定只有一处 —— 否则 `GET` 与 `PUT`
   *   的字段规则一旦漂移，保存后界面就会闪一下（字段突然少了）。
   */
  static fromReadJson(raw: unknown, path = 'account'): AccountSnapshot {
    return AccountDto.parse(raw, path, true)
  }

  private static parse(
    raw: unknown,
    path: string,
    allowUnbound: boolean
  ): AccountSnapshot {
    const json = requireObject(raw, path)
    const hasPassword = json.hasPassword
    if (typeof hasPassword !== 'boolean') {
      throw AuthApiException.malformed(
        `${path}.hasPassword`,
        `期望布尔值，实际 ${typeName(hasPassword)}`
      )
    }
    const snapshot: AccountSnapshot = {
      phone: requireOptionalString(json, 'phone', `${path}.phone`),
      email: requireOptionalString(json, 'email', `${path}.email`),
      hasPassword
    }
    if (
      !allowUnbound &&
      snapshot.phone === null &&
      snapshot.email === null &&
      !snapshot.hasPassword
    ) {
      throw AuthApiException.malformed(
        path,
        'phone / email / hasPassword 全空：这个账号无法用于登录'
      )
    }
    return snapshot
  }
}

export function authMessageForCode(code: string | null, fallback: string): string {
  if (code === null) return fallback
  return AUTH_FALLBACK_MESSAGES[code] ?? fallback
}


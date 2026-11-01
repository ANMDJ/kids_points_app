import { AUTH_FALLBACK_MESSAGES, AuthApiException } from './auth_api_errors'
import {
  AccountDto,
  AccountSnapshot,
  BootstrapChildResultDto,
  ChildSessionResultDto,
  LoginResultDto,
  SessionDto
} from './auth_dto'
import { kDeviceIdHeader, type ReadEnvironment } from './read_api'
import { readCompiledEnvironment } from './compiled_env'
import { WriteApiException } from './write_api_errors'
import { TaroWriteTransport, type WriteMethod, type WriteTransport } from './write_api'

/**
 * 登录五条路由的 HTTP 客户端（W9-A / `40` §8）。
 *
 *   `POST /auth/login`          `{ code }`            → `LoginResultDto`（**唯一**发 token 的响应）
 *   `POST /auth/logout`         204 无体              → void
 *   `GET  /auth/session`                             → `SessionDto`
 *   `POST /children`            `{ consent:{accepted:true}, relation? }` → `BootstrapChildResultDto`
 *   `POST /auth/child-session`  `{ childId }`        → `ChildSessionResultDto`
 *
 * ── 为什么**不能**用 `ReadApiConfig` ────────────────────────────────────────
 *   它的 `isConfigured` 要求 **deviceId + childId** 三项齐全。登录发生在
 *   "还不知道 childId"的时刻（`GET /auth/session` 返回之前），
 *   拿它做前置判定会把登录链路本身锁死：配置"不齐"⇒ 不发请求 ⇒ 永远登不上。
 *   故本文件只要求 `baseUrl`，deviceId 走**参数**（来自 `resolveDeviceId()`）。
 *
 * ── 会话固定（`40` §11.3 / `02` §11）────────────────────────────────────────
 *   `login()` 的签名里**没有** token 参数，[send] 也只认显式传入的 token。
 *   ⇒ "拿旧 token 换新 token"这条攻击在**结构上**不可能发生，
 *     不依赖任何一句"我们记得别传"的注释。
 */

/** 监护关系（`POST /children` 可选字段，`RelationKind` 的四值）。 */
export type BootstrapRelation = 'father' | 'mother' | 'grandparent' | 'other'

/**
 * 登录链路的连接配置：**只有 baseUrl**。
 *
 * 与 `ReadApiConfig` 的差异是刻意的（见文件头）。`TARO_APP_KP_API_BASE_URL`
 * 缺失 ⇒ [isConfigured] 为 false ⇒ 整个登录链路**静默不工作**，
 * 应用继续用本地预览数据（`40` §10.1 规矩三：登录链路不得让没配后端的
 * 开发者看到登录页）。
 */
export class AuthApiConfig {
  constructor(readonly baseUrl: string) {}

  static fromEnvironment(
    env: ReadEnvironment = defaultEnvironment()
  ): AuthApiConfig {
    return new AuthApiConfig(env.TARO_APP_KP_API_BASE_URL ?? '')
  }

  get isConfigured(): boolean {
    return this.validationError === null
  }

  get validationError(): string | null {
    const base = this.baseUrl.trim()
    if (base === '') {
      return (
        '未配置 TARO_APP_KP_API_BASE_URL：登录链路不工作，现在显示的是本地预览数据。\n' +
        '接后端请在 kids_points_mp/.env.local 填 TARO_APP_KP_API_BASE_URL=http://127.0.0.1:3000。'
      )
    }
    if (!/^https?:\/\/[^/\s]+/i.test(base)) {
      return `TARO_APP_KP_API_BASE_URL 不是合法的 http(s) 地址：${base}。`
    }
    return null
  }

  uri(path: string): string {
    const base = this.baseUrl.trim().replace(/\/+$/, '')
    const suffix = path.startsWith('/') ? path : `/${path}`
    return `${base}${suffix}`
  }
}

/** 一次请求的**身份**参数：两者都可缺（login 没有 token，logout 不需要 deviceId）。 */
export interface AuthRequestIdentity {
  /** Bearer token；**只有**显式给才会发 Authorization 头。 */
  token?: string | null
  /** 设备标识（不是凭据）；空串/缺省 ⇒ 不发这个头。 */
  deviceId?: string | null
}

/** `AuthSessionMachine` 依赖的能力（测试注入假实现，不必起 HTTP 服务）。 */
export interface AuthApi {
  /** 微信一次性 code → 新签发的会话。★ 不接收 token（会话固定）。 */
  login(input: { code: string; deviceId?: string | null }): Promise<LoginResultDto>
  fetchSession(token: string): Promise<SessionDto>
  logout(token: string): Promise<void>
  bootstrapChild(
    token: string,
    input: { deviceId: string; relation?: BootstrapRelation }
  ): Promise<BootstrapChildResultDto>
  ensureChildSession(
    token: string,
    input: { childId: string; deviceId: string }
  ): Promise<ChildSessionResultDto>
  close(): void
}

/** 基于 `Taro.request`（复用写层 transport）的实现。 */
/**
 * 「绑定 App 登录账号」的能力（W9-D，2026-10-30）。
 *
 * ── 为什么单独一个接口，而不是塞进 `AuthApi` ────────────────────────────────
 *   `AuthApi` 是 `AuthSessionMachine` 的依赖（登录 / 会话 / 建孩子 / 选孩子）。
 *   把 `updateAccount` 加进去，那个编排层的**每一个测试替身**都被迫实现一个
 *   它永远用不到的方法 —— 替身越胖，用例就越容易只测"能编译"。
 *   这里只有一个方法，且只被「绑定 App 账号」那一屏依赖。
 *
 * ── 它必须带 token ─────────────────────────────────────────────────────────
 *   它写的是"以后能不能登录"。匿名可写 = 任何人能给别人的账号绑自己的手机号
 *   （后端 `PUT /auth/account` 挂着 `AuthGuard`，见 `42` §3.2）。
 */
export interface AccountBinder {
  /**
   * `GET /auth/account` —— 我现在绑的是哪个号、设过密码没有（W9-D）。
   *
   * ★ 为什么需要它：那一屏要先回答「你有没有 App 登录账号」。
   *   不读就只能画一个空白表单 —— 用户会读成「我根本没绑过」然后又绑一次
   *   （换号 ⇒ 上一台手机的 App 登录再也进不来），而且不知道密码框该写
   *   「设置密码」还是「修改密码」（后者必须带当前密码，猜错就是一次必然 400）。
   */
  fetchAccount(token: string): Promise<AccountSnapshot>
  updateAccount(
    token: string,
    input: {
      phone?: string
      email?: string
      password?: string
      currentPassword?: string
    }
  ): Promise<AccountSnapshot>
}

export class AuthApiClient implements AuthApi, AccountBinder {
  private readonly config: AuthApiConfig
  private readonly transport: WriteTransport
  private readonly timeoutMs: number

  constructor(input: {
    config: AuthApiConfig
    transport?: WriteTransport
    timeoutMs?: number
  }) {
    this.config = input.config
    this.transport = input.transport ?? new TaroWriteTransport()
    // 登录要等微信 code2session（一次外网往返），比普通写请求慢；
    // 但仍要有上界 —— 没有上界的等待在小程序里就是"一直转圈"。
    this.timeoutMs = input.timeoutMs ?? 15000
  }

  async login(input: {
    code: string
    deviceId?: string | null
  }): Promise<LoginResultDto> {
    const code = typeof input.code === 'string' ? input.code.trim() : ''
    if (code === '') {
      // ★ 本地就拒：空 code 打到后端必然 `40029`→401，白花一次外网往返。
      throw new Error('微信登录码不能为空（wx.login 失败时不要调用 login）。')
    }
    const decoded = await this.send('POST', '/auth/login', { code }, {
      deviceId: input.deviceId ?? null
    })
    return LoginResultDto.fromJson(decoded)
  }

  async fetchSession(token: string): Promise<SessionDto> {
    const decoded = await this.send('GET', '/auth/session', null, {
      token: requireToken(token)
    })
    return SessionDto.fromJson(decoded)
  }

  /**
   * 撤销**这一条**会话。
   *
   * ★ 401 不抛：后端 `logout` 是幂等的（已撤销再撤一次也回 204），而
   *   "token 已经失效"与"撤销成功"对用户是同一件事。抛出去只会让登出按钮
   *   在 token 过期时显示"登出失败"，然后用户永远退不出去。
   */
  async logout(token: string): Promise<void> {
    const trimmed = requireToken(token)
    try {
      await this.send('POST', '/auth/logout', null, { token: trimmed }, true)
    } catch (error) {
      const auth = AuthApiException.of(error)
      if (auth !== null && auth.statusCode === 401) return
      throw error
    }
  }

  /**
   * `PUT /auth/account` —— 绑定手机号/邮箱、设置或修改密码（W9-D）。
   *
   * ── 这就是「App 能用手机号登录」的**唯一入口** ──────────────────────────────
   *   App 首版**不开放注册**（`42` §5.1）：所有账号都由小程序创建，
   *   App 只是另一种进入方式。所以这一屏不是"可选设置"，而是 App 能不能用
   *   的前提 —— 文案里要写清楚（「App 登录账号」而不是「安全设置」）。
   *
   * ── 为什么必须带 token，且**不带** deviceId 之外的任何东西 ─────────────────
   *   身份由 `Authorization` 背书；手机号在**这里**只是"要绑上去的值"，
   *   不是"我是谁"的证明。把手机号当身份凭据正是 `42` §5.3 要拦的那类混淆。
   *
   * ── `currentPassword` 的服务端规则（客户端不重复判断"要不要"）────────────
   *   已设过密码再改 ⇒ 必填；从未设过 ⇒ 可不填。客户端只知道"要不要显示
   *   输入框"这件事需要一次 `hasPassword`，而那一屏会在保存后拿到
   *   `AccountSnapshot.hasPassword` 才决定下次显示什么。
   */
  /**
   * `GET /auth/account` —— 读当前绑定（W9-D）。
   *
   * ── 用 `fromReadJson`（宽松）而不是 `fromJson`（严格）──────────────────────
   *   全新账号的答案是「三字段全空」，那是**合法结论**（还没有 App 登录账号），
   *   不是畸形回包。用严格解析的话，每个新用户一打开那一屏都会看到
   *   "服务器返回的数据不符合约定"，然后永远绑不上。
   */
  async fetchAccount(token: string): Promise<AccountSnapshot> {
    const decoded = await this.send('GET', '/auth/account', null, {
      token: requireToken(token)
    })
    return AccountDto.fromReadJson(decoded)
  }

  async updateAccount(
    token: string,
    input: {
      phone?: string
      email?: string
      password?: string
      currentPassword?: string
    }
  ): Promise<AccountSnapshot> {
    const trimmedToken = requireToken(token)
    const body: Record<string, unknown> = {}
    if (input.phone !== undefined) body.phone = input.phone
    if (input.email !== undefined) body.email = input.email
    if (input.password !== undefined) body.password = input.password
    if (input.currentPassword !== undefined) {
      body.currentPassword = input.currentPassword
    }
    if (Object.keys(body).length === 0) {
      // 与后端 `ACCOUNT_NOTHING_TO_UPDATE` 同一条判定，但**不发请求**：
      // 一次必然 400 的往返只会让用户看到"保存失败"。
      throw new Error('手机号、邮箱、密码至少要填一个。')
    }

    const decoded = await this.send('PUT', '/auth/account', body, {
      token: trimmedToken
    })
    return AccountDto.fromJson(decoded)
  }

  async bootstrapChild(
    token: string,
    input: { deviceId: string; relation?: BootstrapRelation }
  ): Promise<BootstrapChildResultDto> {
    const deviceId = requireDeviceId(input.deviceId)
    // ★ 只发 `consent.accepted: true` + 可选 relation：请求体里**一个儿童
    //   个人信息都没有**（`40` §7.3，同意必须先于采集）。名字走下一步
    //   `PATCH /child`，不在这一条请求里。
    const body: Record<string, unknown> = { consent: { accepted: true } }
    if (input.relation !== undefined) body.relation = input.relation
    const decoded = await this.send('POST', '/children', body, {
      token: requireToken(token),
      deviceId
    })
    return BootstrapChildResultDto.fromJson(decoded)
  }

  async ensureChildSession(
    token: string,
    input: { childId: string; deviceId: string }
  ): Promise<ChildSessionResultDto> {
    const childId = typeof input.childId === 'string' ? input.childId.trim() : ''
    if (childId === '') throw new Error('childId 不能为空。')
    const deviceId = requireDeviceId(input.deviceId)
    const decoded = await this.send(
      'POST',
      '/auth/child-session',
      { childId },
      { token: requireToken(token), deviceId }
    )
    return ChildSessionResultDto.fromJson(decoded, childId)
  }

  close(): void {
    this.transport.close?.()
  }

  /**
   * 唯一的出口。三件事只在这里做一次：拼头、超时、`!2xx` → 异常。
   *
   * ★ Authorization 只来自 `identity.token`（显式传入）。本方法**绝不**去读
   *   全局 token 持有者 —— 那样 `login()` 就可能带上一个旧 token，
   *   会话固定的防线就消失了。
   */
  private async send(
    method: WriteMethod,
    path: string,
    body: Record<string, unknown> | null,
    identity: AuthRequestIdentity,
    expectNoBody = false
  ): Promise<unknown> {
    const configError = this.config.validationError
    if (configError !== null) {
      throw new AuthApiException('badRequest', configError, {
        code: 'CLIENT_NOT_CONFIGURED'
      })
    }

    const headers: Record<string, string> = { Accept: 'application/json' }
    const token = identity.token ?? ''
    if (token !== '') headers['Authorization'] = `Bearer ${token}`
    const deviceId = (identity.deviceId ?? '').trim()
    if (deviceId !== '') headers[kDeviceIdHeader] = deviceId
    // GET / 无体的 POST 绝不声明 Content-Type：严格后端会拒"空 JSON 体"。
    if (body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
    }

    let response: { statusCode: number; body: unknown }
    try {
      response = await withTimeout(
        this.transport.send(
          this.config.uri(path),
          headers,
          body,
          this.timeoutMs,
          method
        ),
        this.timeoutMs
      )
    } catch (error) {
      if (error instanceof AuthApiException) throw error
      // 传输层抛的是 `WriteApiException`（network/timeout）——换成本层的类型，
      // 让调用方只面对一种异常。
      const write = error instanceof WriteApiException ? error : null
      if (write !== null) {
        throw new AuthApiException(write.kind, write.userMessage, {
          statusCode: write.statusCode,
          code: write.code,
          detail: write.detail
        })
      }
      throw AuthApiException.of(error) ?? this.networkError(error)
    }

    const decoded = decodeBody(response.body)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw this.fromHttp(response.statusCode, decoded)
    }
    if (expectNoBody) return null
    if (decoded === null) {
      throw AuthApiException.malformed(
        '$',
        `HTTP ${response.statusCode} 但响应体为空`
      )
    }
    return decoded
  }

  private networkError(error: unknown): AuthApiException {
    return new AuthApiException('network', '连不上服务器，登录没有完成。请检查网络后重试。', {
      code: 'NETWORK_ERROR',
      detail: error instanceof Error ? error.message : String(error)
    })
  }

  /**
   * `!2xx` → 异常。
   *
   * 只做三件 `WriteApiException.fromHttp()` 不认识的事：
   *   ① **保留业务码**（`TOKEN_EXPIRED` / `TOKEN_INVALID` / `UNAUTHENTICATED`
   *      是登录链路唯一的决策依据，不能被压成一句"401 设备身份无效"）；
   *   ② **429** 带上 `retryAfterSeconds`（用户需要知道是"等 30 秒"而不是"重试"）；
   *   ③ 服务端 `message` 优先 —— 它比本地兜底更具体（比如"还剩 4 次机会"）。
   */
  private fromHttp(statusCode: number, body: unknown): AuthApiException {
    const map =
      body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : null
    const rawCode = map?.code
    const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : null
    const rawMessage = map?.message ?? map?.error
    const serverMessage =
      typeof rawMessage === 'string' && rawMessage.trim() !== '' ? rawMessage : null

    const kind =
      statusCode === 400
        ? 'badRequest'
        : statusCode === 401
          ? 'unauthenticated'
          : statusCode === 403
            ? 'forbidden'
            : statusCode === 404
              ? 'notFound'
              : statusCode === 409
                ? 'conflict'
                : statusCode === 429
                  ? 'conflict'
                  : statusCode === 503
                    ? 'unavailable'
                    : statusCode >= 500
                      ? 'server'
                      : 'badRequest'

    const fallback =
      code !== null
        ? (AUTH_FALLBACK_MESSAGES[code] ?? '登录请求失败，请稍后重试。')
        : `登录请求失败（HTTP ${statusCode}），请稍后重试。`

    const retryAfterSeconds =
      statusCode === 429 ? readRetryAfterSeconds(map?.retryAfterSeconds) : null

    return new AuthApiException(kind, serverMessage ?? fallback, {
      statusCode,
      code,
      detail: serverMessage,
      retryAfterSeconds
    })
  }
}

/** 只接受**正整数秒**；缺失/负数/非数字一律 0（"现在可以重试"）。 */
function readRetryAfterSeconds(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  return Math.max(0, Math.floor(raw))
}

/**
 * token 是**编程前提**，不是用户输入。
 *
 * 空串说明调用方状态错了（例如没登录就去 `fetchSession`）。
 * 这里抛 `Error` 而不是 `AuthApiException`：后者会被登录编排当成"服务端拒绝了
 * 这个 token"，从而清掉一个其实存在的 token。
 */
function requireToken(raw: string): string {
  const token = typeof raw === 'string' ? raw.trim() : ''
  if (token === '') {
    throw new Error('缺少 token：调用方必须先登录（或从 storage 恢复）。')
  }
  return token
}

/** 建孩子 / 选孩子都需要设备标识（它是 `DeviceSession` 的行键，不是凭据）。 */
function requireDeviceId(raw: string): string {
  const deviceId = typeof raw === 'string' ? raw.trim() : ''
  if (deviceId === '') {
    throw new Error('缺少 deviceId：请先用 resolveDeviceId() 取到设备标识。')
  }
  return deviceId
}

/**
 * 配置齐全时才构造客户端；否则返回 null。
 *
 * ★ 与 `createReadApiFromEnvironment` 的差别：只看 `baseUrl`（见文件头），
 *   所以"没有 deviceId / childId"也能登录 —— 否则新用户永远进不来。
 */
export function createAuthApiFromEnvironment(
  env: ReadEnvironment = defaultEnvironment()
): AuthApi | null {
  const config = AuthApiConfig.fromEnvironment(env)
  return config.isConfigured ? new AuthApiClient({ config }) : null
}

/**
 * 只构造「绑定 App 账号」需要的那一个能力。
 *
 * ★ 为什么不复用 [createAuthApiFromEnvironment]：它的返回类型是 `AuthApi`，
 *   上面没有 `fetchAccount` / `updateAccount`（那两个属于 `AccountBinder`）。
 *   硬转一次类型能编过，但那等于用断言绕开类型系统 —— 以后真把
 *   `updateAccount` 挪走，编译不会红，面板会在运行期炸。
 */
export function createAccountBinderFromEnvironment(
  env: ReadEnvironment = defaultEnvironment()
): AccountBinder | null {
  const config = AuthApiConfig.fromEnvironment(env)
  return config.isConfigured ? new AuthApiClient({ config }) : null
}

function defaultEnvironment(): ReadEnvironment {
  // ★ 必须走 [readCompiledEnvironment]：Taro 的 DefinePlugin 只替换
  //   `process.env.TARO_APP_X` 这种**整段字面量**，而小程序里整体的
  //   `process.env` 只是 webpack 的空 polyfill ⇒ 直接读它会永远拿到 undefined。
  return readCompiledEnvironment()
}

/** 超时是**客户端**的承诺：Taro.request 的 timeout 在部分平台不生效。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const seconds = Math.max(1, Math.round(timeoutMs / 1000))
      reject(
        new AuthApiException(
          'timeout',
          `登录请求超时（${seconds} 秒）。可能是网络问题，也可能是服务端在等微信。请重试。`,
          { code: 'TIMEOUT' }
        )
      )
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** 文本 / 已解析对象都接受；空体或坏 JSON 交给 DTO 报 `malformed`。 */
function decodeBody(body: unknown): unknown {
  if (typeof body !== 'string') return body
  const text = body.trim()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}


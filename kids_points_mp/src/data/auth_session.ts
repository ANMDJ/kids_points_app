import { login as taroLogin } from '@tarojs/taro'

import {
  AuthApi,
  AuthApiConfig,
  createAuthApiFromEnvironment,
  type BootstrapRelation
} from './auth_api'
import { AuthApiException } from './auth_api_errors'
import type { ChildMembership, SessionDto } from './auth_dto'
import { AuthTokenHolder, sharedAuthTokens } from './auth_token_holder'
import { KeyValueStorage, TaroKeyValueStorage } from './client_storage'
import { resolveDeviceId } from './device_identity'
import { ReadApiException } from './read_api_errors'
import { WriteApiException } from './write_api_errors'

/**
 * 小程序登录链路的**编排层**（W9-A / `40` §10.1）。
 *
 * ```
 * wx.login() → code → POST /auth/login → token
 *   → storage('kp_token') + 内存持有者
 *   → GET /auth/session ⇒ children
 *       · 0 个 → POST /children（勾选同意）
 *       · 1 个 → POST /auth/child-session → 之后所有请求带 Authorization + x-kp-child-id
 *       · N 个 → 选择器（首版限 1，见 `40` §14 Q3，走不到这里）
 * ```
 *
 * ── 三条客户端纪律（`40` §10.1，每一条都对应下面一个方法）──────────────────
 *   ① **静默重登只重试一次**：[retryOnce] 里没有循环，重登后仍 401 ⇒ 交还
 *      `login_required`。不做这个限制就是无限循环（登录本身也可能 401）。
 *   ② **`TOKEN_EXPIRED` 与 `TOKEN_INVALID` 分开处理**：前者重登一次，
 *      后者直接清 token 去登录页（见 `auth_api_errors.ts#shouldRelogin`）。
 *   ③ **预览模式不变**：没配 `TARO_APP_KP_API_BASE_URL` 时整条链路**不发一个
 *      请求**、不清任何东西（`kind:'preview'`），开发者继续看本地预览数据。
 *      登录链路绝不能把"没配后端"变成"登录页"。
 *
 * ── 本层**不做**的三件事 ────────────────────────────────────────────────────
 *   · 不碰 UI（不 `Taro.navigateTo`、不弹 toast）：返回**判别联合**，页面自己决定；
 *   · 不写 store：`AppStore` 拿到 `ready` 之后再决定载入什么；
 *   · 不判断权限：`role` 是设备会话给的事实，"能不能点这个按钮"仍由权限矩阵那套
 *     既有逻辑 + 服务端 403 决定。
 *
 * ── 为什么状态不放在这里 ────────────────────────────────────────────────────
 *   本类只保证"这一次调用看到了什么"。最后一个结果落在 `AppStore`（单一真源），
 *   否则页面与编排层会各持一份 session，谁新谁旧说不清。
 */

/** 认证 token 的 storage 键（与 `kp_device_id` 同一命名前缀）。 */
export const kTokenStorageKey = 'kp_token'

/**
 * 为什么必须重新登录。
 *
 * 页面据此说不同的话 —— 把它们压成一个 `false` 就会变成"登录过期了"
 * （对 `no_token` 是错的：他从来没登录过）。
 */
export type AuthLoginReason =
  | 'no_token' // 从没登录过 / 刚登出
  | 'token_rejected' // 服务端拒绝了这个 token（INVALID / EXPIRED / UNAUTHENTICATED）
  | 'relogin_failed' // 静默重登试过**一次**，仍然不行
  | 'login_failed' // 这次 `wx.login` → `/auth/login` 本身失败（限流 / code 失效 / 微信不可用）
  | 'account_inactive' // 403 `USER_NOT_ACTIVE`：账号被停用，重登也没用

/**
 * 一次 `restore()` / `login()` / `bootstrapChild()` 的结局。
 *
 * 六个分支各有对应的界面动作，调用方必须 `switch` 完（TS 的穷尽性检查会帮忙）：
 *   `preview`               → 继续用本地预览数据（**不是错误**）
 *   `needs_login`           → 登录页（`reason` 决定文案）
 *   `needs_bootstrap`       → 同意勾选 + "建立档案"（`POST /children`）
 *   `needs_child_selection` → 选择器（首版限 1 个孩子，正常走不到）
 *   `ready`                 → 进主页；之后所有请求带 token + childId
 *   `unreachable`           → 网络/服务端问题，**不要**清 token、**不要**跳登录页
 */
export type AuthRestoreResult =
  | { kind: 'preview'; message: string }
  | { kind: 'needs_login'; reason: AuthLoginReason; message: string }
  | { kind: 'needs_bootstrap'; token: string; session: SessionDto }
  | {
      kind: 'needs_child_selection'
      token: string
      children: readonly ChildMembership[]
      message: string
    }
  | {
      kind: 'ready'
      token: string
      session: SessionDto
      membership: ChildMembership
      /** 这条**设备会话**的绝对到期（epoch ms）。 */
      sessionExpiresAt: number
    }
  | { kind: 'unreachable'; message: string; error: AuthApiException }

/** token 的持久化位置（`kp_token`）。 */
export interface AuthTokenStore {
  read(): string | null
  write(token: string): void
  clear(): void
}

/**
 * 基于微信 storage 的实现。
 *
 * ★ 读的时候**校验形状**：旧版本/手工改过的 storage 里可能躺着
 *   `'undefined'`、带空格的值。这类值发出去只会得到 401，却会让界面
 *   先显示"已登录"再闪回登录页 —— 直接当成"没有 token"更诚实（并顺手清掉）。
 */
export class StorageAuthTokenStore implements AuthTokenStore {
  private readonly storage: KeyValueStorage

  constructor(storage: KeyValueStorage = new TaroKeyValueStorage()) {
    this.storage = storage
  }

  read(): string | null {
    const raw = this.storage.read(kTokenStorageKey)
    if (raw === null) return null
    const token = raw.trim()
    if (token === '' || /\s/.test(token)) {
      this.clear()
      return null
    }
    return token
  }

  write(token: string): void {
    const trimmed = token.trim()
    if (trimmed === '') throw new Error('token 不能为空：没有凭据时请 clear()。')
    this.storage.write(kTokenStorageKey, trimmed)
  }

  clear(): void {
    this.storage.remove(kTokenStorageKey)
  }
}

/** 用例专用：断言"到底写了什么 / 清了几次"。 */
export class MemoryAuthTokenStore implements AuthTokenStore {
  private token: string | null = null
  /** 写入次数（用来钉住"登录只写一次"）。 */
  writes = 0
  clears = 0

  constructor(seed: string | null = null) {
    this.token = seed
  }

  read(): string | null {
    return this.token
  }

  write(token: string): void {
    this.token = token
    this.writes += 1
  }

  clear(): void {
    this.token = null
    this.clears += 1
  }
}

/** `wx.login` 的端口：测试注入固定 code，运行时走 `Taro.login()`。 */
export interface WechatLoginPort {
  getCode(): Promise<string>
}

/**
 * `Taro.login()` 的实现。
 *
 * ★ 失败时**抛错**而不是重试：`errMsg` 里的失败（如 `login:fail 系统错误`）
 *   重试一次也一样，而"静默重试"会让用户以为按钮没反应。
 * ★ `code` 5 分钟有效且**只能用一次**，所以这里绝不缓存。
 */
export class TaroWechatLoginPort implements WechatLoginPort {
  async getCode(): Promise<string> {
    const result = await taroLogin()
    const code = typeof result?.code === 'string' ? result.code.trim() : ''
    if (code === '') {
      throw new Error('wx.login 没有返回 code（微信登录不可用）。')
    }
    return code
  }
}


/**
 * [AuthSessionMachine.retryOnce] 的结局。
 *
 * `login_required` 与"抛错"是两件事：前者是**正常的**会话生命周期终点
 * （到期 / 被撤销），页面要跳登录页；后者是网络坏了 / 服务端 500，
 * 页面应显示"重试"而不是"请重新登录"。
 */
export type AuthRetryResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'login_required'; reason: AuthLoginReason; message: string }

/**
 * 登录编排器。
 *
 * 一次 `restore()` 就是一次**冷启动**：读 token → 问服务端"我是谁" →
 * 按孩子数量分流 → 在这台设备上开一条 `DeviceSession`。
 *
 * 它**没有** `subscribe()`：状态只有 `AppStore` 一份（见文件头）。
 */
export class AuthSessionMachine {
  private readonly api: AuthApi | null
  private readonly config: AuthApiConfig
  private readonly tokens: AuthTokenStore
  private readonly loginPort: WechatLoginPort
  private readonly holder: AuthTokenHolder
  private readonly storage: KeyValueStorage
  private readonly env: Record<string, string | undefined>
  private readonly generate: (() => string) | undefined
  /** deviceId 解析一次就记住：它必须**稳定**，每次调用都重新生成等于换了台设备。 */
  private deviceIdMemo: string | null = null

  constructor(input: {
    config: AuthApiConfig
    api?: AuthApi | null
    tokens?: AuthTokenStore
    loginPort?: WechatLoginPort
    /** 运行期凭据持有者（默认全局单例，`read_api` 等四个客户端读的是同一个）。 */
    holder?: AuthTokenHolder
    /** deviceId 的 storage（默认走微信 storage）。 */
    storage?: KeyValueStorage
    /** 编译期覆盖（默认 `process.env`）。用例用它注入，**不碰** `process.env`。 */
    env?: Record<string, string | undefined>
    /** 生成随机 deviceId 的随机源（用例要确定性）。 */
    generate?: () => string
  }) {
    this.config = input.config
    // `api` 传 `undefined` ⇒ 按配置自己造；显式传 `null` ⇒ 真的是"没接后端"。
    this.api =
      input.api === undefined
        ? createAuthApiFromEnvironment(input.env ?? defaultEnvironment())
        : input.api
    this.tokens = input.tokens ?? new StorageAuthTokenStore(input.storage)
    this.loginPort = input.loginPort ?? new TaroWechatLoginPort()
    this.holder = input.holder ?? sharedAuthTokens
    this.storage = input.storage ?? new TaroKeyValueStorage()
    this.env = input.env ?? defaultEnvironment()
    this.generate = input.generate
  }

  /**
   * 登录链路是否接上了后端。
   *
   * `false` ⇒ 一切方法都走 `preview`：不发请求、不读不写 token
   * （`40` §10.1 规矩三）。这条判断在每个公开方法的**第一行**，
   * 因为"漏掉一个"就会让没配后端的开发者看到登录页。
   */
  get isConfigured(): boolean {
    return this.api !== null && this.config.isConfigured
  }

  /** 当前 token（内存持有者）；没有就是 null。UI 只用它判断"要不要显示退出按钮"。 */
  currentToken(): string | null {
    return this.holder.current()
  }

  /**
   * 这台设备的 deviceId（`kp_device_id` / 编译期覆盖 / 首次生成的一起算）。
   *
   * ★ 与「请求头里的 deviceId」必须**是同一个**：`AppStore` 拿到 `ready` 后
   *   把它装进 `sharedDeviceContext`；若这里换一个值，服务端会认为
   *   "开会话的设备和发请求的设备不是一台"（`DEVICE_SESSION_CONFLICT`）。
   *   所以它复用同一个 memo（`requireDeviceId()`），不做第二次解析。
   */
  currentDeviceId(): string {
    return this.requireDeviceId()
  }

  /**
   * 冷启动 / 回到前台时调用。
   *
   * ★ 网络失败**不清 token**：把"信号差"当成"掉登录"会让用户在电梯里被登出，
   *   回到有网的地方还得重新走一遍微信授权。
   */
  async restore(): Promise<AuthRestoreResult> {
    const preview = this.previewResult()
    if (preview !== null) return preview

    const token = this.tokens.read()
    if (token === null) {
      this.holder.clear()
      return needsLogin('no_token', '还没有登录过：请先点「微信一键登录」。')
    }
    // 从 storage 恢复的 token 必须进持有者，否则后续业务请求仍不带 Authorization。
    this.holder.set(token)

    let session: SessionDto
    try {
      session = await this.requireApi().fetchSession(token)
    } catch (error) {
      return this.failureResult(error)
    }
    return await this.enterFromSession(token, session)
  }

  /**
   * `wx.login()` → `POST /auth/login` → 存 token → `restore()`。
   *
   * ★ 登录成功**必须**新签发 token（`40` §11.3 会话固定）：
   *   `AuthApi.login()` 的签名里没有 token 参数，这条防线是结构性的。
   */
  async login(): Promise<AuthRestoreResult> {
    const preview = this.previewResult()
    if (preview !== null) return preview

    let code: string
    try {
      code = await this.loginPort.getCode()
    } catch (error) {
      return {
        kind: 'needs_login',
        reason: 'login_failed',
        message:
          error instanceof Error
            ? `微信登录没有完成：${error.message}`
            : '微信登录没有完成，请重试。'
      }
    }

    try {
      const deviceId = this.requireDeviceId()
      const result = await this.requireApi().login({ code, deviceId })
      this.tokens.write(result.token)
      this.holder.set(result.token)
    } catch (error) {
      const failure = toAuthFailure(error)
      if (failure === null) throw error
      // ★ 这里**不清 token**：登录失败（限流 / code 失效 / 微信不可用）说明不了
      //   旧 token 已经失效。清了会把"一次失败的重登"变成"彻底掉登录"。
      // ★ 停用单独成一档：它是终态，登录页据此禁用按钮（再点也不会成功），
      //   而不是把用户留在一个"再试一次"的死循环里。
      return {
        kind: 'needs_login',
        reason: failure.code === 'USER_NOT_ACTIVE' ? 'account_inactive' : 'login_failed',
        message: failure.userMessage
      }
    }
    return await this.restore()
  }

  /**
   * `POST /children`：新用户建第一个孩子（同意**先行**，`40` §7.3）。
   *
   * ★ `accepted !== true` 在**本地**就拒：这条请求体里唯一的内容就是同意，
   *   没同意时它没有意义（后端也会 400 `CONSENT_NOT_ACCEPTED`）。
   * ★ 成功后仍走 `restore()`：`GET /auth/session` 是 session 的唯一权威来源
   *   （`40` §8.3），多一次往返换来的是"只有一个真相"。
   */
  async bootstrapChild(input: {
    accepted: boolean
    relation?: BootstrapRelation
  }): Promise<AuthRestoreResult> {
    if (input.accepted !== true) {
      throw new Error(
        '必须先勾选并同意监护人协议（consent.accepted 字面 true）才能建立档案。本次没有发请求。'
      )
    }
    const preview = this.previewResult()
    if (preview !== null) return preview

    const token = this.requireToken()
    try {
      await this.requireApi().bootstrapChild(token, {
        deviceId: this.requireDeviceId(),
        relation: input.relation
      })
    } catch (error) {
      return this.failureResult(error)
    }
    return await this.restore()
  }

  /**
   * 选一个孩子（`POST /auth/child-session`）。
   *
   * 只在"有多个孩子"时用得上，也是将来做"切换孩子"的入口。
   * 权限由服务端判定（非成员 ⇒ 403 `NOT_A_MEMBER`），客户端不预判。
   */
  async selectChild(childId: string): Promise<AuthRestoreResult> {
    const preview = this.previewResult()
    if (preview !== null) return preview

    const id = typeof childId === 'string' ? childId.trim() : ''
    if (id === '') throw new Error('childId 不能为空。')

    const token = this.requireToken()
    let session: SessionDto
    try {
      session = await this.requireApi().fetchSession(token)
    } catch (error) {
      return this.failureResult(error)
    }
    const membership = session.children.filter((child) => child.childId === id)[0]
    if (membership === undefined) {
      // 能列出孩子、却选不到这个孩子 ⇒ 本地状态与服务端不一致。
      // 不静默建会话（那可能给一个已被移除的成员位开会话），交给服务端 403。
      return {
        kind: 'unreachable',
        message: '这个账号在这台设备上找不到该孩子的成员位，请刷新后重试。',
        error: new AuthApiException('forbidden', '该孩子不在当前账号的成员位里。', {
          statusCode: 403,
          code: 'NOT_A_MEMBER'
        })
      }
    }
    return await this.enterChild(token, membership, session)
  }


  /**
   * 登出。
   *
   * ★ **本地先清**：网络失败也必须能退出（否则在没网的地方永远退不出去）。
   *   代价是服务端那条会话要等 7 天绝对到期自然失效 —— 返回值如实告诉调用方
   *   `revoked: false`，而不是假装已撤销。
   */
  async logout(): Promise<{ revoked: boolean }> {
    const token = this.tokens.read()
    this.clearToken()
    if (token === null || this.api === null) return { revoked: true }
    try {
      await this.api.logout(token)
      return { revoked: true }
    } catch (error) {
      return { revoked: false }
    }
  }

  /**
   * 一条业务请求的"过期就静默重登一次"包装（`40` §10.1 规矩一）。
   *
   * 只有 `TOKEN_EXPIRED` 会触发重登；`TOKEN_INVALID` / 403 / 网络错误**原样抛**
   * 给调用方（它们不是重登能解决的）。重登后再 401 ⇒ 返回 `login_required`，
   * 由页面跳登录页 —— **不会**再试第三次（代码里没有循环）。
   */
  async retryOnce<T>(
    operation: (token: string) => Promise<T>
  ): Promise<AuthRetryResult<T>> {
    const token = this.tokens.read()
    if (token === null) {
      return {
        kind: 'login_required',
        reason: 'no_token',
        message: '还没有登录：请先点「微信一键登录」。'
      }
    }

    try {
      return { kind: 'ok', value: await operation(token) }
    } catch (error) {
      const failure = toAuthFailure(error)
      if (failure === null || !failure.shouldRelogin) throw error
    }

    // 走到这里 ⇒ 上一次失败是 `TOKEN_EXPIRED`。只重登**一次**。
    const relogged = await this.login()
    if (relogged.kind !== 'ready') {
      return {
        kind: 'login_required',
        reason: 'relogin_failed',
        message: messageOf(relogged)
      }
    }

    try {
      return { kind: 'ok', value: await operation(relogged.token) }
    } catch (error) {
      const failure = toAuthFailure(error)
      if (failure !== null && failure.shouldClearToken) this.clearToken()
      return {
        kind: 'login_required',
        reason: 'relogin_failed',
        message:
          failure !== null ? failure.userMessage : '重新登录后仍然失败，请稍后再试。'
      }
    }
  }

  // ──────────────────────────────────────────────────────────── 内部步骤

  /** 预览模式（没配后端）⇒ 返回 preview；否则 null（继续往下走）。 */
  private previewResult(): AuthRestoreResult | null {
    if (this.isConfigured) return null
    return {
      kind: 'preview',
      message:
        this.config.validationError ??
        '没有可用的登录后端：现在显示的是本地预览数据，登录链路没有生效。'
    }
  }

  /**
   * `GET /auth/session` 之后的分流（`40` §10.1 那张图的右半边）。
   *
   * 注意 `> 1` 分支不是"不可能发生"：首版虽然限 1 个孩子（§14 Q3），
   * 但数据模型允许多个，客户端必须**能表达**，否则将来会以"选第一个"的
   * 形式静默选中错误的孩子。
   */
  private async enterFromSession(
    token: string,
    session: SessionDto
  ): Promise<AuthRestoreResult> {
    if (session.childCount === 0) {
      return { kind: 'needs_bootstrap', token, session }
    }
    if (session.childCount > 1) {
      return {
        kind: 'needs_child_selection',
        token,
        children: session.children,
        message: `这个账号有 ${session.childCount} 个孩子：请选择这台设备要用哪一个。`
      }
    }
    return await this.enterChild(token, session.children[0], session)
  }

  /** 在这台设备上开一条 `DeviceSession`，然后交出 `ready`。 */
  private async enterChild(
    token: string,
    membership: ChildMembership,
    session: SessionDto
  ): Promise<AuthRestoreResult> {
    try {
      const result = await this.requireApi().ensureChildSession(token, {
        childId: membership.childId,
        deviceId: this.requireDeviceId()
      })
      return {
        kind: 'ready',
        token,
        session,
        // 角色取**服务端这次**给的值：它是 `DeviceSession.activeRole`（这台设备
        // 现在是什么角色），成员位上的 role 只是"这个人在这个家里是什么角色"。
        membership: { childId: result.childId, name: membership.name, role: result.role },
        sessionExpiresAt: result.sessionExpiresAt
      }
    } catch (error) {
      return this.failureResult(error)
    }
  }

  /**
   * 任何一次调用失败 → 判别联合里对应的那一支。
   *
   * 三条分流（顺序即优先级）：
   *   ① 403 `USER_NOT_ACTIVE` ⇒ 账号被停用（重登无用，**不清** token）；
   *   ② 401（INVALID / EXPIRED / UNAUTHENTICATED）⇒ 清 token 去登录页；
   *   ③ 其它（网络 / 超时 / 5xx / 403 NOT_A_MEMBER / malformed）⇒ `unreachable`，
   *      **保 token**，页面显示"重试"。
   */
  private failureResult(error: unknown): AuthRestoreResult {
    const failure = toAuthFailure(error)
    if (failure === null) throw error

    if (failure.code === 'USER_NOT_ACTIVE') {
      return {
        kind: 'needs_login',
        reason: 'account_inactive',
        message: failure.userMessage
      }
    }
    if (failure.shouldClearToken) {
      this.clearToken()
      return {
        kind: 'needs_login',
        reason: 'token_rejected',
        message: failure.userMessage
      }
    }
    return { kind: 'unreachable', message: failure.userMessage, error: failure }
  }

  private requireApi(): AuthApi {
    if (this.api === null) {
      throw new Error('登录链路没有接后端（isConfigured=false）：不该走到这里。')
    }
    return this.api
  }

  private requireToken(): string {
    const token = this.tokens.read()
    if (token === null) {
      throw new Error('缺少 token：调用方必须先登录（restore() 或 login()）。')
    }
    return token
  }

  /** deviceId 解析一次即缓存：它必须稳定，重新生成等于换了台设备。 */
  private requireDeviceId(): string {
    if (this.deviceIdMemo !== null) return this.deviceIdMemo
    const resolved = resolveDeviceId({
      env: this.env,
      storage: this.storage,
      generate: this.generate
    })
    this.deviceIdMemo = resolved.deviceId
    return resolved.deviceId
  }

  private clearToken(): void {
    this.tokens.clear()
    this.holder.clear()
  }
}


/** 一条 `needs_login` 结果（三种来源共用，避免各写一遍）。 */
function needsLogin(reason: AuthLoginReason, message: string): AuthRestoreResult {
  return { kind: 'needs_login', reason, message }
}

/** 把任意一支结果翻成**一句可展示的话**（`retryOnce` 用它填 `message`）。 */
export function messageOf(result: AuthRestoreResult): string {
  switch (result.kind) {
    case 'preview':
    case 'needs_login':
    case 'needs_child_selection':
    case 'unreachable':
      return result.message
    case 'needs_bootstrap':
      return '这个账号还没有孩子的档案：请先勾选同意并建立档案。'
    case 'ready':
      return '登录已完成。'
  }
}

/**
 * 任意异常 → `AuthApiException`；**不是**登录侧异常就返回 null。
 *
 * 为什么返回 null 而不是"包一层"：DTO 的 `AuthApiException` 与传输层的
 * `WriteApiException` 都在 `auth_api.ts` 里换过一次类型；走到这里还不是
 * `AuthApiException` 的，只可能是**编程错误**（比如 `requireToken` 抛的空 token）。
 * 把它当成"网络失败"会让真正的 bug 永远只显示一句"请重试"。
 */
function toAuthFailure(error: unknown): AuthApiException | null {
  if (error instanceof AuthApiException) return error
  if (error instanceof WriteApiException) {
    return new AuthApiException(error.kind, error.userMessage, {
      statusCode: error.statusCode,
      code: error.code,
      detail: error.detail
    })
  }
  // ★ 只读端点走的是 `ReadApiException`：业务请求到期时抛的是它，不是上面两种。
  //   不收编这一支，`retryOnce` 看到的就是"认不出的错误"⇒ 原样抛回 store ⇒
  //   首页挂着一条「设备身份无效（401）」的错误条，静默重登**永远不会发生**。
  //   只认 401：403（非成员）/ 5xx / 网络都不是"该重登"的信号。
  if (error instanceof ReadApiException && error.statusCode === 401) {
    return new AuthApiException('unauthenticated', error.userMessage, {
      statusCode: error.statusCode,
      code: error.code,
      detail: error.detail
    })
  }
  return null
}

function defaultEnvironment(): Record<string, string | undefined> {
  if (typeof process !== 'undefined' && process.env) {
    return process.env as Record<string, string | undefined>
  }
  return {}
}

/**
 * 按编译期环境变量装配一个编排器。
 *
 * ★ `env` 是**参数**（不是直接读 `process.env`）：用例可以给出"只有
 *   baseUrl"的假环境，从而在不碰真进程环境的前提下测出"预览模式"与
 *   "已配置"两条路径（`auth-boot-config.test.ts` 对后端用的是同一手法）。
 */
export function createAuthSessionMachine(
  input: {
    env?: Record<string, string | undefined>
    storage?: KeyValueStorage
    loginPort?: WechatLoginPort
    api?: AuthApi | null
    tokens?: AuthTokenStore
    holder?: AuthTokenHolder
    generate?: () => string
  } = {}
): AuthSessionMachine {
  const env = input.env ?? defaultEnvironment()
  return new AuthSessionMachine({
    config: AuthApiConfig.fromEnvironment(env),
    env,
    api: input.api,
    tokens: input.tokens,
    loginPort: input.loginPort,
    holder: input.holder,
    storage: input.storage,
    generate: input.generate
  })
}


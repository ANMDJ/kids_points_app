import { WriteApiException, type WriteFailureKind } from './write_api_errors'

/**
 * 登录链路的**失败分类**（W9-A / `40` §9.3、§10.1）。
 *
 * ── 为什么不直接用 `WriteApiException` ──────────────────────────────────────
 *   401 在登录链路上有**三种**含义，客户端要做的三件事完全不同：
 *     · `TOKEN_EXPIRED`     —— 静默重登**一次**，然后重放原请求；
 *     · `TOKEN_INVALID`     —— 清 token，**不**重登（重登也还是被撤销）；
 *     · `UNAUTHENTICATED`   —— 我们压根没带凭据（本地状态错），清 token 去登录页。
 *   `WriteApiException.fromHttp()` 只知道"401"，会把三者压成同一句
 *   "设备身份无效" —— 那正是本轮要拆掉的东西。
 *
 * ── 继承 `WriteApiException` 而不是 `Error` ─────────────────────────────────
 *   `ParentPinLockException` 已是同一手法：既有的 `instanceof WriteApiException`
 *   分支（store 里有一处按 `kind` 分流）都能接住它，只有真正关心"是哪种 401"
 *   的地方才需要再判一次类型。kind 仍用写层的枚举：`unauthenticated` 就够。
 */
export class AuthApiException extends WriteApiException {
  /** `429 LOGIN_RATE_LIMITED` 的等待秒数；其它情况 null。 */
  readonly retryAfterSeconds: number | null

  constructor(
    kind: WriteFailureKind,
    userMessage: string,
    options: {
      statusCode?: number | null
      code?: string | null
      detail?: string | null
      retryAfterSeconds?: number | null
    } = {}
  ) {
    super(kind, userMessage, options)
    this.name = 'AuthApiException'
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }

  /** 200 但形状不对（DTO 解析失败）。 */
  static override malformed(path: string, detail?: string): AuthApiException {
    return new AuthApiException(
      'malformed',
      `服务器返回的登录结果不符合约定（字段 \`${path}\`）。请确认客户端与服务端版本一致。`,
      { code: 'MALFORMED_RESPONSE', detail: detail ?? null }
    )
  }

  /** 判定用：任何异常 → 是不是"登录这一侧的"异常。 */
  static of(error: unknown): AuthApiException | null {
    return error instanceof AuthApiException ? error : null
  }

  /**
   * 要不要**静默重登一次**。
   *
   * ★ 只有 `TOKEN_EXPIRED`。`TOKEN_INVALID` 重登只会换来同一句话
   *   （会话被撤销/伪造），而"重登"本身是用户能看见的动作。
   */
  get shouldRelogin(): boolean {
    return this.statusCode === 401 && this.code === 'TOKEN_EXPIRED'
  }

  /**
   * 要不要**清掉本地 token**。
   *
   * 三种 401 + 一种 400（`malformed` 解析出的凭据无法解析 ⇒ 后端 `TOKEN_INVALID`）
   * 都意味着"这条 token 再也不可能成功"。清掉之后重登才有意义。
   * ★ 网络/超时/5xx **不**清：把"信号差"当成"掉登录"是这类产品最常见的伤害。
   */
  get shouldClearToken(): boolean {
    if (this.statusCode === 401) return true
    return this.code === 'TOKEN_INVALID' || this.code === 'UNAUTHENTICATED'
  }

  /** 这条失败是不是"需要用户重新登录"（而非"稍后重试"）。 */
  get requiresLogin(): boolean {
    return this.shouldClearToken
  }
}

/**
 * `AUTH_*` / `LOGIN_*` / `WECHAT_*` 业务码的兜底文案（服务端没给 `message` 时用）。
 *
 * 服务端几乎总会给 `message`（`identity.service.ts` 每条都写了），
 * 这里存在的意义是：**反代/网关**回 502/503 时通常没有我们的业务码，
 * 而客户端不能因此显示一句"未知错误"。
 */
export const AUTH_FALLBACK_MESSAGES: Record<string, string> = {
  LOGIN_RATE_LIMITED: '登录尝试太频繁，请稍后再试（这不是密码错误）。',
  WECHAT_CODE_INVALID: '微信登录码已失效，请重新点击登录（code 只能用一次，5 分钟内有效）。',
  WECHAT_NOT_CONFIGURED:
    '服务端还没有配置微信小程序凭据（WECHAT_MP_APPID / WECHAT_MP_SECRET），现在无法登录。',
  WECHAT_UNAVAILABLE: '暂时连不上微信服务器，请稍后重试。',
  WECHAT_CREDENTIAL_INVALID:
    '服务端的微信 AppSecret 无效（微信拒绝了 code2session）。请联系管理员核对凭据。',
  USER_NOT_ACTIVE: '这个账号已被停用，无法登录。',
  CONSENT_NOT_ACCEPTED: '必须先勾选并同意监护人协议，才会创建孩子的档案。',
  DEVICE_ID_REQUIRED: '这次请求缺少设备标识（x-kp-device-id），请重启小程序后再试。',
  NOT_A_MEMBER: '这个账号在这个孩子上没有成员位（可能已被移除）。',
  DEVICE_SESSION_CONFLICT: '这台设备已经绑定到另一个孩子上，请用原来的账号继续。',
  TOKEN_INVALID: '登录凭据无效或已被撤销，请重新登录。',
  TOKEN_EXPIRED: '登录已过期（认证会话有效期 7 天，不因使用而延长），请重新登录。',
  UNAUTHENTICATED: '这个请求没有携带登录凭据，请先登录。'
}

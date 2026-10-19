/**
 * 只读 API 的**失败分类** —— 页面据此决定「能重试 / 该改配置 / 别重试」。
 *
 * 与 Flutter `lib/data/read_api_errors.dart` 一一对应，也与后端契约一致
 * （`backend/src/read/read.controller.ts`）：401 没身份、403 非成员、
 * 404 孩子不存在或已删、400 形状不对、501 没接数据库、503 身份校验未就绪、
 * 5xx 其它服务端问题。客户端的职责是**如实显示**，不是把 501 说成「暂无记录」。
 */
export type ReadFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'childNotFound'
  | 'badRequest'
  | 'notImplemented'
  | 'unavailable'
  | 'server'
  | 'network'
  | 'timeout'
  | 'malformed'

export interface ReadApiExceptionOptions {
  statusCode?: number | null
  code?: string | null
  detail?: string | null
}

/**
 * 只读 API 的统一异常。**永远带得上**一个可展示的中文说明，
 * 页面不需要（也不允许）自己按状态码另编一套文案。
 */
export class ReadApiException extends Error {
  readonly kind: ReadFailureKind
  readonly userMessage: string
  readonly statusCode: number | null
  readonly code: string | null
  readonly detail: string | null

  constructor(
    kind: ReadFailureKind,
    userMessage: string,
    options: ReadApiExceptionOptions = {}
  ) {
    super(userMessage)
    this.name = 'ReadApiException'
    this.kind = kind
    this.userMessage = userMessage
    this.statusCode = options.statusCode ?? null
    this.code = options.code ?? null
    this.detail = options.detail ?? null
  }

  /** 200 但形状不对：由 DTO / 映射层抛出，`path` 指出哪个字段坏了。 */
  static malformed(path: string, detail?: string): ReadApiException {
    return new ReadApiException(
      'malformed',
      `服务器返回的数据不符合约定（字段 \`${path}\`）。请确认客户端与服务端版本一致。`,
      { code: 'MALFORMED_RESPONSE', detail: detail ?? null }
    )
  }

  static network(error: unknown): ReadApiException {
    return new ReadApiException(
      'network',
      '连不上服务器。请检查网络，或确认 TARO_APP_KP_API_BASE_URL 指向正在运行的后端。',
      { code: 'NETWORK_ERROR', detail: errorText(error) }
    )
  }

  static timeout(timeoutMs: number): ReadApiException {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    return new ReadApiException(
      'timeout',
      `请求超时（${seconds} 秒）。请稍后重试。`,
      { code: 'TIMEOUT' }
    )
  }

  /**
   * 把 `!2xx` 的响应翻译成异常。错误体尽量解析，
   * 但**绝不**因解析失败而丢状态码。
   */
  static fromHttp(input: {
    statusCode: number
    body: unknown
  }): ReadApiException {
    const statusCode = input.statusCode
    let code: string | null = null
    let detail: string | null = null

    if (typeof input.body === 'object' && input.body !== null) {
      const body = input.body as Record<string, unknown>
      if (typeof body.code === 'string' && body.code !== '') {
        code = body.code
      }
      const rawMessage = body.message ?? body.error
      if (typeof rawMessage === 'string') {
        detail = rawMessage
      } else if (Array.isArray(rawMessage)) {
        detail = rawMessage
          .filter((item): item is string => typeof item === 'string')
          .join('；')
      }
    }

    const base = { statusCode, code, detail }

    if (statusCode === 401) {
      return new ReadApiException(
        'unauthenticated',
        '设备身份无效或会话不存在（401）。请重新配对设备后再试。',
        base
      )
    }
    if (statusCode === 403) {
      return new ReadApiException(
        'forbidden',
        '当前账号没有查看这个孩子数据的权限（403）。',
        base
      )
    }
    if (statusCode === 404) {
      return new ReadApiException(
        'childNotFound',
        '孩子档案不存在或已被删除（404）。',
        base
      )
    }
    if (statusCode === 400) {
      return new ReadApiException(
        'badRequest',
        '请求参数不被服务端接受（400）。',
        base
      )
    }
    if (statusCode === 501) {
      return new ReadApiException(
        'notImplemented',
        '服务端还没有接数据库，只读查询暂不可用（501）。这不是「没有记录」。',
        base
      )
    }
    if (statusCode === 503) {
      return new ReadApiException(
        'unavailable',
        '服务端身份校验未就绪（503）。请稍后重试。',
        base
      )
    }
    return new ReadApiException(
      statusCode >= 500 ? 'server' : 'badRequest',
      `服务端返回 HTTP ${statusCode}。请稍后重试。`,
      base
    )
  }

  /** 一次性重试**可能**有用：网络、超时、5xx（含 501 配好库之后）。 */
  get isRetryable(): boolean {
    return (
      this.kind === 'network' ||
      this.kind === 'timeout' ||
      this.kind === 'server' ||
      this.kind === 'unavailable' ||
      this.kind === 'notImplemented'
    )
  }

  toString(): string {
    const status = this.statusCode === null ? '' : ` http=${this.statusCode}`
    const serverCode = this.code === null ? '' : ` code=${this.code}`
    const extra = this.detail === null ? '' : ` detail=${this.detail}`
    return `ReadApiException(${this.kind}${status}${serverCode}): ${this.userMessage}${extra}`
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const errMsg = (error as Record<string, unknown>).errMsg
    if (typeof errMsg === 'string') return errMsg
  }
  return String(error)
}

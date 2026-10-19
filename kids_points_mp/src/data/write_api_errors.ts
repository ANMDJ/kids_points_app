/**
 * 写端点（W4-E：打卡 / 撤销）的**失败分类**。
 *
 * 与只读错误分开，是因为同一个 HTTP 状态码在两边语义不同：
 * 404 在写里常见的是 `HABIT_NOT_FOUND` / `RECORD_NOT_FOUND`；
 * 409 在只读里不会出现，在写里却是主要业务拒绝（每日上限 / 积分不足 / 重复撤销）。
 */
export type WriteFailureKind =
  | 'unauthenticated'
  | 'forbidden'
  | 'notFound'
  | 'badRequest'
  | 'conflict'
  | 'unavailable'
  | 'server'
  | 'network'
  | 'timeout'
  | 'malformed'

export interface WriteApiExceptionOptions {
  statusCode?: number | null
  code?: string | null
  detail?: string | null
}

/** 写端点的统一异常：永远带一个可直接展示的中文说明。 */
export class WriteApiException extends Error {
  readonly kind: WriteFailureKind
  readonly userMessage: string
  readonly statusCode: number | null
  readonly code: string | null
  readonly detail: string | null

  constructor(
    kind: WriteFailureKind,
    userMessage: string,
    options: WriteApiExceptionOptions = {}
  ) {
    super(userMessage)
    this.name = 'WriteApiException'
    this.kind = kind
    this.userMessage = userMessage
    this.statusCode = options.statusCode ?? null
    this.code = options.code ?? null
    this.detail = options.detail ?? null
  }

  static malformed(path: string, detail?: string): WriteApiException {
    return new WriteApiException(
      'malformed',
      `服务器返回的写入结果不符合约定（字段 \`${path}\`）。请确认客户端与服务端版本一致。`,
      { code: 'MALFORMED_RESPONSE', detail: detail ?? null }
    )
  }

  static network(error: unknown): WriteApiException {
    return new WriteApiException(
      'network',
      '连不上服务器，这次操作没有保存。请检查网络后重试。',
      { code: 'NETWORK_ERROR', detail: errorText(error) }
    )
  }

  static timeout(timeoutMs: number): WriteApiException {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000))
    return new WriteApiException(
      'timeout',
      `请求超时（${seconds} 秒），这次操作可能未保存。请刷新确认后再试。`,
      { code: 'TIMEOUT' }
    )
  }

  /**
   * 业务码优先于状态码：`HABIT_DAILY_LIMIT_REACHED` 比「HTTP 409」对用户有用。
   * 解析失败时**绝不丢状态码**（诊断需要它）。
   */
  static fromHttp(input: {
    statusCode: number
    body: unknown
  }): WriteApiException {
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
      return new WriteApiException(
        'unauthenticated',
        '设备身份无效或会话不存在（401），这次操作没有保存。请重新配对设备后再试。',
        base
      )
    }
    if (statusCode === 403) {
      return new WriteApiException(
        'forbidden',
        '当前账号没有执行这个操作的权限（403），这次操作没有保存。',
        base
      )
    }
    if (statusCode === 404) {
      if (code === 'HABIT_NOT_FOUND') {
        return new WriteApiException(
          'notFound',
          '这个习惯不存在或已被删除，无法打卡。',
          base
        )
      }
      if (code === 'RECORD_NOT_FOUND') {
        return new WriteApiException(
          'notFound',
          '这条打卡记录不存在或已被删除，无法撤销。',
          base
        )
      }
      return new WriteApiException(
        'notFound',
        '要操作的数据不存在或已被删除（404），这次操作没有保存。',
        base
      )
    }
    if (statusCode === 400) {
      return new WriteApiException(
        'badRequest',
        '请求参数不被服务端接受（400），这次操作没有保存。',
        base
      )
    }
    if (statusCode === 409) {
      if (code === 'HABIT_DAILY_LIMIT_REACHED') {
        return new WriteApiException(
          'conflict',
          '这个习惯今天的次数已经用完啦，明天继续加油～',
          base
        )
      }
      if (code === 'INSUFFICIENT_POINTS') {
        return new WriteApiException(
          'conflict',
          '积分不足，无法撤销这笔打卡（撤销不能把余额扣成负数）。',
          base
        )
      }
      if (code === 'ALREADY_REVERSED') {
        return new WriteApiException(
          'conflict',
          '这笔打卡已经撤销过了，不需要重复撤销。',
          base
        )
      }
      if (code === 'NOT_A_HABIT_CHECK_IN' || code === 'CANNOT_REVERSE_REVERSAL') {
        return new WriteApiException(
          'conflict',
          '这笔记录不是可撤销的打卡记录。',
          base
        )
      }
      if (code === 'HABIT_POINTS_INVALID') {
        return new WriteApiException(
          'conflict',
          '这个习惯的分值配置不正确，暂时不能打卡。',
          base
        )
      }
      return new WriteApiException(
        'conflict',
        '当前状态不允许这个操作（409），这次操作没有保存。',
        base
      )
    }
    if (statusCode === 503) {
      return new WriteApiException(
        'unavailable',
        '服务端身份校验未就绪（503），这次操作没有保存。请稍后重试。',
        base
      )
    }
    return new WriteApiException(
      statusCode >= 500 ? 'server' : 'badRequest',
      `服务端返回 HTTP ${statusCode}，这次操作没有保存。请稍后重试。`,
      base
    )
  }

  /** 重试可能有用：网络、超时、5xx。409 是明确拒绝，原样重试只会再被拒一次。 */
  get isRetryable(): boolean {
    return (
      this.kind === 'network' ||
      this.kind === 'timeout' ||
      this.kind === 'server' ||
      this.kind === 'unavailable'
    )
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

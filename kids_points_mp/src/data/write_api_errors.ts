/**
 * 写端点（W4-E：打卡 / 撤销，W5-A：规则新增 / 编辑 / 删除 / 加入习惯）的**失败分类**。
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
      if (code === 'APPROVAL_REQUIRED') {
        // 孩子在 `REQUIRE_APPROVAL` 下直接写心愿 / 规则时被拦 —— 这不是故障，
        // 而是约定：同一次操作必须走审批流。文案要给出**下一步**，但**不能**
        // 说“已提交”（403 时并没有生成审批单），否则家长会去审批页找不到任何东西。
        return new WriteApiException(
          'forbidden',
          '这个操作需要家长确认，这次没有保存。请让家长直接操作（或由家长在「审批」里处理后再试）。',
          base
        )
      }
      if (code === 'CANNOT_MODIFY_SELF') {
        // W5-H：成员写入口**都不能**作用于自己。降级自己会把自己锁在门外
        // （没有家长能再改回来）；移出自己则等于「退出家庭」——
        // 后端刻意不支持，靠家庭码重新加入才是正路。
        return new WriteApiException(
          'forbidden',
          '不能修改自己的家庭成员身份，这次操作没有保存。请让另一位家长来处理。',
          base
        )
      }
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
      if (code === 'RULE_NOT_FOUND') {
        return new WriteApiException(
          'notFound',
          '这条规则不存在或已被删除，请刷新后重试。',
          base
        )
      }
      if (code === 'WISH_NOT_FOUND') {
        return new WriteApiException(
          'notFound',
          '这个心愿不存在或已被删除（可能已在别的设备上删掉了）。',
          base
        )
      }
      if (code === 'APPROVAL_NOT_FOUND') {
        return new WriteApiException(
          'notFound',
          '这条审批请求不存在或已被删除，可能已在别的设备上处理过了。',
          base
        )
      }
      if (code === 'MEMBER_NOT_FOUND') {
        // W5-H：不存在与「属于别的孩子」共用这一个 code —— 后端刻意不区分，
        // 客户端也没必要替它猜。
        return new WriteApiException(
          'notFound',
          '这个成员不存在，或已被移出家庭，请刷新成员列表。',
          base
        )
      }
      if (code === 'INVITE_NOT_FOUND') {
        // W5-I：同样不区分「不存在」与「属于别的孩子」—— 后者会泄露别家 id。
        return new WriteApiException(
          'notFound',
          '这个邀请码不存在或已被删除，请刷新邀请码列表。',
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
      // ── 孩子档案（W5-E）：昵称的两条校验失败 ──────────────────────────────
      // 「参数不被接受」对改昵称毫无帮助；用户需要知道的是**改哪里**。
      if (code === 'CHILD_NAME_EMPTY') {
        return new WriteApiException(
          'badRequest',
          '昵称不能为空，这次没有保存。',
          base
        )
      }
      if (code === 'CHILD_NAME_TOO_LONG') {
        return new WriteApiException(
          'badRequest',
          '昵称最多 16 个字符（表情按 1 个算），这次没有保存。',
          base
        )
      }
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
          '积分不足：这次操作会把余额扣成负数，没有保存。',
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
      if (code === 'RULE_VERSION_CONFLICT') {
        return new WriteApiException(
          'conflict',
          '这条规则刚被其他人改动过，请刷新后再改（不会覆盖别人的修改）。',
          base
        )
      }
      if (code === 'RULE_IS_PENALTY') {
        return new WriteApiException(
          'conflict',
          '这是扣分规则，不能加入今天的习惯。',
          base
        )
      }
      if (code === 'HABIT_ALREADY_EXISTS') {
        return new WriteApiException(
          'conflict',
          '这个习惯已经在今天的习惯里了。',
          base
        )
      }
      if (code === 'WISH_ALREADY_REDEEMED') {
        return new WriteApiException(
          'conflict',
          '这个心愿已经兑换过了，再申请一次会重复扣分，所以没有提交。',
          base
        )
      }
      // ── 审批收件箱（W5-D）的三个业务拒绝 ────────────────────────────────
      // 都要说清「列表已经变了，刷新一下」，否则家长会盯着一条已失效的申请反复点。
      if (code === 'ALREADY_DECIDED') {
        return new WriteApiException(
          'conflict',
          '这条申请已经被处理过了（可能是在另一台设备上）。刷新一下就能看到最新状态。',
          base
        )
      }
      if (code === 'APPROVAL_EXPIRED') {
        return new WriteApiException(
          'conflict',
          '这条申请已超过 72 小时有效期，现在不能再批 / 拒，请让孩子重新提交。',
          base
        )
      }
      if (code === 'APPROVAL_INVALIDATED') {
        return new WriteApiException(
          'conflict',
          '这条申请的前提已经变了（心愿被删或积分不够），不能批准；刷新后可选择拒绝。',
          base
        )
      }
      // ── 家庭成员（W5-H）的两个业务拒绝 ──────────────────────────────────
      // 都是「这次改动会把家庭改坏」，必须说清为什么，不能当成网络故障重试。
      if (code === 'LAST_GUARDIAN_PROTECTED') {
        return new WriteApiException(
          'conflict',
          '家庭里至少要有一位家长：这次改动会让家长变成 0 位，所以没有保存。请先把另一位成员设为家长。',
          base
        )
      }
      if (code === 'MEMBER_NOT_ACTIVE') {
        return new WriteApiException(
          'conflict',
          '这个成员已经被移出家庭了，请刷新成员列表。',
          base
        )
      }
      // ── 邀请码（W5-I）：服务端连续撞码后放弃 ────────────────────────────
      // 不是用户的错，也不该说成「网络问题」：重试一次通常就好了。
      if (code === 'INVITE_CODE_GENERATION_FAILED') {
        return new WriteApiException(
          'conflict',
          '服务端连续生成的邀请码都撞上了已有码，这次没有生成。请再试一次。',
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

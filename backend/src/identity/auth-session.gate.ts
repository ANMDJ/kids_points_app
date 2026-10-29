import { createHash, randomBytes } from 'node:crypto'

/**
 * 认证会话 · **判定内核**（W9-A，2026-10-29 / `docs/design/40-login-and-session-design.md` §4、§5.3）
 *
 * 回答一句话：**这个 Bearer token 现在代表谁？**
 *
 *     Authorization 头  →  readBearerToken()  →  resolveAuthSession(行, 哈希, now)
 *                                                  →  ALLOW（userId）| DENY（TOKEN_INVALID / TOKEN_EXPIRED）
 *
 * ── 与 `session.gate.ts` 的分工（两张表、两个问题、两个内核）──────────────────
 *   · 本文件：**"你是谁"**（`AuthSession`，跨设备跨孩子）；
 *   · `session.gate.ts`：**"你在这台设备的这个孩子上是什么角色"**（`DeviceSession`，含 5 分钟家长模式窗口）。
 *   合并它们会让 `expiresAt` 一列承载两个语义 —— 那正是 W8-C 付过的代价（`40` §1.3）。
 *
 * ── 为什么**不是** JWT（四条都在 `40` §4.4，这里只留最要命的一条）────────────
 *   JWT 的 `exp` 边界写成 `>` 还是 `>=`、`NaN` 比较恒为 false —— 这类错**没人替你查**。
 *   不透明 token "什么都不声称"：形状在库里、到期在库里、撤销在库里。
 *   ⇒ 本文件的判定全部以**行**为准，不解析任何自证结构。
 *
 * ── ★ 形状与判定是两件事（与 `session.gate.ts` / D3b 同一条纪律）──────────────
 *   · 查不到 / 已撤销 / 已到期  → **判定**（401，见 `AuthDenial`）；
 *   · 行里的 `method` 不在白名单、`expiresAt` 解析不出、拿到的行不是这个 token 的
 *     → **形状错**（`AuthSessionShapeError`，守卫翻 **500**）。
 *   混起来的后果很具体：库里存了一个非法 `method` 会表现为"你的登录失效了"，
 *   用户被引导去重新登录，而病在数据。
 *
 * ── 纯函数 / 一个例外（写清）────────────────────────────────────────────────
 *   `resolveAuthSession()` / `readBearerToken()` / `isWellFormedToken()` / `hashToken()`
 *   都是纯的（可离线穷举，见 `test/auth-session-gate.test.ts`）。
 *   `issueToken()` 是**唯一**有随机性的函数 —— 它只产出明文，不判定任何事。
 */

/** 认证会话有效期：**7 天绝对**（`40` §4.3 / §14 Q2）。 */
export const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** token 前缀 —— 让它在日志 / 密钥扫描里一眼可识别（同 `ghp_` / `sk-` 的用意）。 */
export const TOKEN_PREFIX = 'kps_'

/** 随机字节数：32 字节 = 256 bit（不可穷举 ⇒ 配快哈希，`40` §4.2）。 */
export const TOKEN_BYTES = 32

/** base64url(32 字节) 恒为 43 个字符（无填充）。写成常量是为了让形状校验不必猜。 */
const TOKEN_BODY_LENGTH = 43

/**
 * 认证方式白名单。白名单外的值 ⇒ **500**（形状问题），不是 401、更不是默默当成
 * `wechat_mp` —— 见文件头「形状与判定是两件事」。
 *
 * `dev_seed` 只由 `seed:demo` 写入，且**仅非生产**可用（`40` §12.1 M3）。
 */
export const AUTH_METHODS = ['wechat_mp', 'dev_seed'] as const
export type AuthMethod = (typeof AUTH_METHODS)[number]


/**
 * 签发一条新凭据的**明文**（唯一有随机性的函数）。
 *
 * ★ 调用方必须做到两件事：① 立刻 `hashToken()` 落库；② 明文只出现在登录响应里，
 *   不写日志、不进审计快照、不回显到任何后续接口（`40` §11.2）。
 */
export function issueToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`
}

/**
 * `sha256(token)` 的十六进制（64 字符）—— **库里唯一存的东西**。
 *
 * ── 为什么是 sha256 而不是 scrypt（与 PIN 相反，理由必须记住）────────────────
 *   PIN 是 4–6 位数字（13–20 bit，可离线穷举）⇒ 必须慢哈希 + 计数 + 锁定；
 *   token 是 256 bit 随机数（不可穷举）⇒ 快哈希足够，慢哈希只会让**每个请求**
 *   多 30ms CPU。即「按熵选算法」（`40` §4.2）。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 形状校验：`kps_` + 43 个 base64url 字符。**不做任何判定**（那是 `resolveAuthSession`）。 */
export function isWellFormedToken(token: string): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) return false
  const body = token.slice(TOKEN_PREFIX.length)
  if (body.length !== TOKEN_BODY_LENGTH) return false
  return /^[A-Za-z0-9_-]+$/.test(body)
}

export type BearerReadResult =
  | { kind: 'MISSING' }
  | { kind: 'MALFORMED'; reason: string }
  | { kind: 'OK'; token: string }

/**
 * 读 `Authorization` 头。
 *
 * ── 四条 fail-closed ─────────────────────────────────────────────────────────
 *   ① 头缺失 ⇒ `MISSING`（**不是**"匿名放行"；调用方决定是 401 还是双读期旧路径）；
 *   ② 方案不是 `Bearer`（大小写不敏感，RFC 6750 要求）⇒ `MALFORMED`；
 *   ③ 重复头（数组）⇒ `MALFORMED` —— 拼接 / 取首值都会让"同时出示两个凭据"产生歧义，
 *      而歧义的下一步通常是"随便挑一个"（与 `device-session.guard.ts#singleHeader` 同一条理由）；
 *   ④ token 形状不对 ⇒ `MALFORMED`（**不**去查库：形状错的凭据不配消耗一次查询，
 *      也就不会把"扫描器乱发的一串字符"变成数据库负载）。
 */
export function readBearerToken(headerValue: string | string[] | undefined): BearerReadResult {
  if (headerValue === undefined) return { kind: 'MISSING' }
  if (Array.isArray(headerValue)) {
    return { kind: 'MALFORMED', reason: '重复的 Authorization 头（两个凭据并存 ⇒ 无法判定哪个有效）' }
  }
  const raw = headerValue.trim()
  if (raw === '') return { kind: 'MISSING' }

  const match = /^Bearer[ \t]+(\S+)$/i.exec(raw)
  if (match === null) {
    return { kind: 'MALFORMED', reason: 'Authorization 头必须是 `Bearer <token>`（不带其它方案）' }
  }
  const token = match[1]!
  if (!isWellFormedToken(token)) {
    return { kind: 'MALFORMED', reason: `token 形状不合法（应为 ${TOKEN_PREFIX}<43 位 base64url>）` }
  }
  return { kind: 'OK', token }
}


/**
 * 端口返回的**原始**行 —— 字段故意宽松（来自数据库，未经验证）。
 * 与 `SessionLookupRow` 同一条纪律：不许直接当类型用。
 */
export interface AuthSessionRow {
  id: string
  userId: string
  /** `sha256(token)` 十六进制；调用方已用它查到了这一行，这里再比一次（见 `TOKEN_HASH_MISMATCH`）。 */
  tokenHash: string
  /** 原始字符串（`wechat_mp` | `dev_seed`）—— 白名单校验在 `resolveAuthSession()`。 */
  method: string
  deviceId: string | null
  issuedAt: Date | string
  lastSeenAt: Date | string
  expiresAt: Date | string
  revokedAt: Date | string | null
}

/** 会话行**形状**问题的专用错误（**不是**权限判定）—— 守卫把它翻成 500。 */
export class AuthSessionShapeError extends Error {
  constructor(
    readonly code: 'INVALID_AUTH_METHOD' | 'INVALID_AUTH_EXPIRY' | 'TOKEN_HASH_MISMATCH',
    message: string
  ) {
    super(message)
    this.name = 'AuthSessionShapeError'
  }
}

/**
 * 两种 401 **必须分开**（`40` §9.3）：
 *   · `TOKEN_EXPIRED` —— 可以**静默重登一次**修好；
 *   · `TOKEN_INVALID` —— 重登也修不好（凭据本身不认识），必须清 token 进登录页。
 * 合成一个码的后果：家长每次换手机都看到登录页，而重登也修不好。
 *
 * ★ 「已撤销」归 `TOKEN_INVALID`：`POST /auth/logout` 之后客户端本来就应该清 token；
 *   若归 `TOKEN_EXPIRED`，客户端会静默重登 —— 那等于把"我要求退出"变成"再给我一张新凭据"。
 */
export type AuthDenial = 'TOKEN_INVALID' | 'TOKEN_EXPIRED'

export type AuthVerdict = { kind: 'ALLOW'; row: AuthSessionRow } | { kind: 'DENY'; code: AuthDenial }

/** 解析成毫秒时间戳；解析不出 ⇒ 形状错误（`NaN > n` 恒为 false，静默的失败最难查）。 */
function toEpoch(value: Date | string, field: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(ms)) {
    throw new AuthSessionShapeError(
      'INVALID_AUTH_EXPIRY',
      `AuthSession.${field} 无法解析：${JSON.stringify(value)}（到期判定依赖它，` +
        '解析不出时**绝不能**当成"没过期"继续 —— 那会让 7 天 TTL 静默失效）。'
    )
  }
  return ms
}

function isKnownAuthMethod(value: string): value is AuthMethod {
  return (AUTH_METHODS as readonly string[]).includes(value)
}

/**
 * 认证判定（纯函数，可穷举）。
 *
 * 顺序**不能换**：
 *   ① 行不存在 ⇒ `TOKEN_INVALID`（认都不认识，谈不上过期）；
 *   ② 行的 `tokenHash` 与本次出示的不一致 ⇒ **500** —— 查都按它查，对不上只可能是
 *      适配器的 `where` 写歪了（例如按 userId 查、或把参数写死）。这条与
 *      `session.gate.ts#SESSION_CHILD_MISMATCH` 同一族：**给适配器留的守卫**；
 *   ③ `method` 白名单 + 时间形状校验 ⇒ 坏数据在**判定阶段**就响亮（500）；
 *   ④ `revokedAt` 非空 ⇒ `TOKEN_INVALID`（退出登录 / 撤销）；
 *   ⑤ `now >= expiresAt` ⇒ `TOKEN_EXPIRED`（**`===` 算过期**，与 `session.gate.ts` 同一口径）；
 *   ⑥ 其余 ⇒ ALLOW。
 *
 * ★ 边界口径只在这里定死一处：`expiresAt === now` 即过期。两处（本文件与
 *   `isSessionActive`）若一个写 `>` 一个写 `>=`，"刚好第 7 天"就变成随机行为。
 */
export function resolveAuthSession(
  row: AuthSessionRow | null,
  presentedTokenHash: string,
  now: Date
): AuthVerdict {
  if (row === null) return { kind: 'DENY', code: 'TOKEN_INVALID' }

  if (row.tokenHash !== presentedTokenHash) {
    throw new AuthSessionShapeError(
      'TOKEN_HASH_MISMATCH',
      `会话返回的 tokenHash 与本次出示的不一致（id=${row.id} userId=${row.userId}）：` +
        '查询键就是 tokenHash，对不上意味着适配器**没有按 tokenHash 查**（写死 / 按 userId 查）。' +
        '★ 绝不能放行 —— 那等于"任意一个有效 token 都能换到别人的身份"。'
    )
  }

  if (!isKnownAuthMethod(row.method)) {
    throw new AuthSessionShapeError(
      'INVALID_AUTH_METHOD',
      `会话上的 method 非法：${JSON.stringify(row.method)}` +
        `（白名单只有 ${AUTH_METHODS.join(' / ')}）。id=${row.id} userId=${row.userId}` +
        ' —— 这是**数据/实现**的问题，不是权限问题，故 500 而不是 401。'
    )
  }

  const expiresAtMs = toEpoch(row.expiresAt, 'expiresAt')
  // 其余三列只做形状校验：坏时间戳不该等到"将来有人拿它算天数"时才炸。
  toEpoch(row.issuedAt, 'issuedAt')
  toEpoch(row.lastSeenAt, 'lastSeenAt')
  if (row.revokedAt !== null) toEpoch(row.revokedAt, 'revokedAt')

  if (row.revokedAt !== null) return { kind: 'DENY', code: 'TOKEN_INVALID' }
  if (now.getTime() >= expiresAtMs) return { kind: 'DENY', code: 'TOKEN_EXPIRED' }

  return { kind: 'ALLOW', row }
}

/** 签发时刻对应的绝对到期（**不滑动**，见 `AUTH_SESSION_TTL_MS` 的注释）。 */
export function authSessionExpiresAt(now: Date): Date {
  return new Date(now.getTime() + AUTH_SESSION_TTL_MS)
}

/**
 * App 账号标识的规范化与校验（W9-D，2026-10-30 / `42-account-login-design.md` §2）。
 *
 * 一句话：**「用户输入的字符串」与「库里那一列」必须是同一个值**。
 *
 * ── 为什么规范化必须只有一处 ─────────────────────────────────────────────────
 *   手机号能被写成 `138 0013 8000` / `138-0013-8000` / `+8613800138000`；
 *   邮箱能被写成 `Dad@Example.COM`。若「绑定时」与「登录时」各自 trim 一下，
 *   `User.phone` 的唯一约束就形同虚设 —— 同一个人能绑出三行账号，
 *   然后「我明明绑过」变成三次客服工单。
 *   ⇒ 写入与查询**都**走本文件的 `normalizeX()`；库里只存规范化后的值。
 *
 * ── 为什么手机号不做「国际号码」支持 ─────────────────────────────────────────
 *   首版产品面向中国大陆家庭（`date-verification-code.ts` 的时区判据同样是
 *   `Asia/Shanghai`）。`libphonenumber` 是一整个依赖 + 它的口径变化会影响登录，
 *   而「+86 以外」今天没有任何用户。故只接受 `1[3-9]\d{9}`，其余一律形状错。
 *   ★ 这是**已知边界**，不是遗漏：将来要国际化，改这里一处即可（其余层只认
 *     `{ type, value }`）。
 *
 * ── 为什么分类只看有没有 `@` ────────────────────────────────────────────────
 *   手机号里不可能出现 `@`，邮箱里必然有它。用「有没有 @」比「先试手机号正则、
 *   失败再试邮箱」更少歧义：后者会让一个畸形输入得到「手机号错」的文案，
 *   而用户明明填的是邮箱。
 */

export type IdentifierType = 'phone' | 'email'

/** 规范化后的标识 —— **落库与查询都用它**，不再保留用户原始输入。 */
export interface NormalizedIdentifier {
  type: IdentifierType
  value: string
}

/** 形状错的原因。**每一支都要能对用户说一句不同的话**（否则不如不分类）。 */
export type IdentifierFailure = 'EMPTY' | 'TOO_LONG' | 'PHONE_FORMAT' | 'EMAIL_FORMAT'

export type IdentifierResult =
  | { kind: 'ok'; identifier: NormalizedIdentifier }
  | { kind: 'invalid'; reason: IdentifierFailure }

/** 邮箱总长上限（RFC 5321 的 path 上限是 256，含尖括号；254 是实际可用值）。 */
export const EMAIL_MAX_LENGTH = 254
/** 邮箱本地部分上限（RFC 5321 §4.5.3.1.1）。 */
export const EMAIL_LOCAL_MAX_LENGTH = 64

/**
 * 分类 + 规范化。**这是登录与绑定两条路共用的唯一入口。**
 *
 * 顺序：先 trim → 空 ⇒ `EMPTY` → 含 `@` ⇒ 邮箱 → 否则手机号。
 * ★ 不猜：`12345` 既不是合法手机号也不是邮箱 ⇒ `PHONE_FORMAT`（因为不含 @，
 *   用户显然想填手机号）。
 */
export function classifyIdentifier(raw: string): IdentifierResult {
  const trimmed = raw.trim()
  if (trimmed === '') return { kind: 'invalid', reason: 'EMPTY' }
  if (trimmed.includes('@')) return normalizeEmail(trimmed)
  return normalizePhone(trimmed)
}

/**
 * 手机号规范化：去分隔符 → 剥国家码 → 必须是 11 位 `1[3-9]\d{9}`。
 *
 * ★ 剥离 `86` 只在**长度为 13** 时尝试：否则 `13800138000` 这种正常号码
 *   会被误剥成 `0013800138000`，报一个完全莫名其妙的格式错。
 */
export function normalizePhone(raw: string): IdentifierResult {
  const compact = raw.trim().replace(/[\s\-()]/g, '')
  if (compact === '') return { kind: 'invalid', reason: 'EMPTY' }

  let digits = compact
  if (digits.startsWith('+86')) {
    digits = digits.slice(3)
  } else if (digits.length === 13 && digits.startsWith('86')) {
    // 无 `+` 的 13 位写法（`8613800138000`），与 `+86` 同一语义。
    digits = digits.slice(2)
  }
  // ★ 其它国家码**明确**拒绝，而不是让它落进「太长 / 格式错」：
  //   `+1 415 555 0100` 长度是 12 位，若按 TOO_LONG 报「号码太长」，
  //   用户会以为自己少删了空格。这里直接说「不是中国大陆手机号」。
  if (digits.startsWith('+')) return { kind: 'invalid', reason: 'PHONE_FORMAT' }
  if (digits.length > 11) return { kind: 'invalid', reason: 'TOO_LONG' }
  if (!/^1[3-9]\d{9}$/.test(digits)) return { kind: 'invalid', reason: 'PHONE_FORMAT' }

  return { kind: 'ok', identifier: { type: 'phone', value: digits } }
}

/**
 * 邮箱规范化：trim + **全小写** + 基本结构校验。
 *
 * ── 为什么统一小写 ─────────────────────────────────────────────────────────
 *   绝大多数邮件服务商把本地部分当作大小写不敏感（技术上 SMTP 允许敏感，
 *   但现实里没人依赖它）；不统一就会「Dad@x.com 登录不了，因为我绑的是 dad@x.com」。
 *
 * ── 为什么不做 Gmail 的 `a.b@gmail.com` / `a+b@gmail.com` 归一 ────────────────
 *   那是 **provider 特定**行为：对 `a.b@公司域名` 做 dot-stripping 会把
 *   两个人的邮箱合成一个账号 —— 一条真实可用的账号接管路径。宁可让 Gmail 用户
 *   看到「该邮箱已被使用」，也不能猜。
 *
 * 这里**不**校验 MX、不发验证邮件：密码方案下「能不能收到信」不参与判定，
 * 邮箱只是一个唯一标识（与手机号同地位）。这一点在文档 §5 明确记为取舍。
 */
export function normalizeEmail(raw: string): IdentifierResult {
  const lower = raw.trim().toLowerCase()
  if (lower === '') return { kind: 'invalid', reason: 'EMPTY' }
  if (lower.length > EMAIL_MAX_LENGTH) return { kind: 'invalid', reason: 'TOO_LONG' }

  const at = lower.indexOf('@')
  if (at <= 0 || at !== lower.lastIndexOf('@')) {
    return { kind: 'invalid', reason: 'EMAIL_FORMAT' }
  }
  const local = lower.slice(0, at)
  const domain = lower.slice(at + 1)
  if (local.length > EMAIL_LOCAL_MAX_LENGTH) return { kind: 'invalid', reason: 'TOO_LONG' }
  if (domain === '' || !domain.includes('.')) {
    return { kind: 'invalid', reason: 'EMAIL_FORMAT' }
  }
  // 宽松但封闭：不允许空白、不允许连续点、不允许首尾点。
  if (/\s/.test(lower) || lower.includes('..')) {
    return { kind: 'invalid', reason: 'EMAIL_FORMAT' }
  }
  if (local.startsWith('.') || local.endsWith('.')) {
    return { kind: 'invalid', reason: 'EMAIL_FORMAT' }
  }
  if (domain.startsWith('.') || domain.endsWith('.') || domain.startsWith('-')) {
    return { kind: 'invalid', reason: 'EMAIL_FORMAT' }
  }

  return { kind: 'ok', identifier: { type: 'email', value: lower } }
}

/** 密码强度不合格的原因（每一支对应一句不同的话，见 `42` §2.3）。 */
export type PasswordFailure =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'ALL_SAME'
  | 'ALL_DIGITS'
  | 'COMMON'
  | 'SAME_AS_IDENTIFIER'

export type PasswordResult = { kind: 'ok' } | { kind: 'invalid'; reason: PasswordFailure }

/** 密码长度边界（码点数）—— 与 `password-hash.ts` 的常量同一口径。 */
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 64

/**
 * 常见弱口令（**小写比较**）。刻意只有十几条：
 *   这是一张"明显不该过"的清单，不是 rockyou。真正的防线是限流 + 慢哈希；
 *   把清单做大的收益很低（用户会换成 `Password123`），代价是每次维护都要解释。
 */
const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'password1',
  'passw0rd',
  'qwertyui',
  'qwerty123',
  'abc12345',
  'iloveyou',
  'admin123',
  '1qaz2wsx',
  'zxcvbnm1',
  'woaini1314'
])

/**
 * 密码强度判定（**服务端唯一一份**；客户端那份只为即时提示，不参与判定）。
 *
 * ── 为什么规则这么"松"（不强制大小写 + 符号）────────────────────────────────
 *   用户是家长（含祖辈）。强制复杂度最常见的结局是把密码写成 `Abc12345!`
 *   并贴在冰箱上 —— 可用性换来的"强度"是负的。
 *   这里只拦**明显不可接受**的五类：太短 / 太长 / 单一字符 / 纯数字 / 常见弱口令，
 *   外加一条最容易踩的：**密码与自己的手机号/邮箱相同**。
 *
 * ── 为什么"太长"也要拦（64）─────────────────────────────────────────────────
 *   scrypt 的输入会整体进内存；无上限等于给攻击者一个"用 1MB 密码打满 CPU"的入口。
 *   而 64 个字符对任何真实用户都足够。
 *
 * `identifierValue` 传规范化后的手机号或邮箱；邮箱还会比较**本地部分**
 * （`dad@x.com` ⇒ 也拦 `dad`，因为那是用户最容易想到的"密码"）。
 */
export function validatePasswordStrength(
  password: string,
  identifierValue?: string
): PasswordResult {
  const length = [...password].length
  if (length < PASSWORD_MIN) return { kind: 'invalid', reason: 'TOO_SHORT' }
  if (length > PASSWORD_MAX) return { kind: 'invalid', reason: 'TOO_LONG' }

  // ★ `SAME_AS_IDENTIFIER` **排在** `ALL_DIGITS` 之前：手机号当密码时，
  //   「不能和自己的手机号一样」比「不能纯数字」具体得多 —— 后者会让用户
  //   改成 `13800138001`（仍然是自己的号段），而前者直接指出真正的问题。
  if (identifierValue !== undefined && identifierValue !== '') {
    const lower = password.toLowerCase()
    const target = identifierValue.toLowerCase()
    if (lower === target) return { kind: 'invalid', reason: 'SAME_AS_IDENTIFIER' }
    const at = target.indexOf('@')
    if (at > 0 && lower === target.slice(0, at)) {
      return { kind: 'invalid', reason: 'SAME_AS_IDENTIFIER' }
    }
  }

  if (/^(.)\1+$/u.test(password)) return { kind: 'invalid', reason: 'ALL_SAME' }
  if (/^\d+$/.test(password)) return { kind: 'invalid', reason: 'ALL_DIGITS' }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { kind: 'invalid', reason: 'COMMON' }
  }

  return { kind: 'ok' }
}

/**
 * 形状错的用户文案（**服务端唯一一份**）。
 *
 * ── 为什么文案要和 code 一起放在纯函数层 ─────────────────────────────────────
 *   同一条规则在三个地方要用：登录、绑定手机号、绑定邮箱。若各写一遍，
 *   「登录时提示要填 11 位，绑定页却只说格式错」就是必然结果。
 *   放这里 ⇒ 改一句话只改一处，且单测能直接断言文案（不必起 HTTP）。
 *
 * ★ 文案里**不带**用户输入的原文：那句话会被原样回显到界面上，
 *   而输入可能被粘贴进日志 / 分享截图。
 */
export function identifierMessage(reason: IdentifierFailure): string {
  switch (reason) {
    case 'EMPTY':
      return '请填写手机号或邮箱。'
    case 'TOO_LONG':
      return '手机号或邮箱过长，请检查是否粘贴了多余内容。'
    case 'PHONE_FORMAT':
      return '手机号格式不对：请填 11 位中国大陆手机号（例如 13800138000）。'
    case 'EMAIL_FORMAT':
      return '邮箱格式不对：请检查 @ 前后是否有遗漏。'
  }
}

/**
 * 密码强度不足的用户文案。每一支都必须能指出**下一步怎么改**，
 * 否则用户只会反复提交同一个密码。
 */
export function passwordMessage(reason: PasswordFailure): string {
  switch (reason) {
    case 'TOO_SHORT':
      return `密码至少 ${PASSWORD_MIN} 位。`
    case 'TOO_LONG':
      return `密码最多 ${PASSWORD_MAX} 位（太长的密码只是给自己添麻烦）。`
    case 'ALL_SAME':
      return '密码不能是同一个字符重复。'
    case 'ALL_DIGITS':
      return '密码不能全是数字，请至少带一个字母。'
    case 'COMMON':
      return '这个密码太常见了，很容易被猜到，请换一个。'
    case 'SAME_AS_IDENTIFIER':
      return '密码不能和你的手机号或邮箱一样。'
  }
}

/**
 * 密码强度的**客户端镜像**（小程序侧，2026-11-03）。
 *
 * ── 为什么小程序也要有一份 ──────────────────────────────────────────────────
 *   2026-11-03 用户用网站邀请码在 App 注册，服务端回 `400 WEAK_PASSWORD`，
 *   而界面只说「HTTP 400」——他知道密码有问题，却不知道**要求是什么**。
 *   App 当天补了本地镜像（`lib/data/password_rules.dart`）；小程序当时没跟上，
 *   于是同一个弱密码在小程序仍要撞一次 400 才看得到原因（`43` §0
 *   「注册一致（小程序）」）。
 *
 * ── 与服务端的关系（**仍然只有服务端说了算**）────────────────────────────────
 *   真相之源：`backend/src/identity/account-identifier.ts#validatePasswordStrength`
 *   （阈值 8/64、六条拒绝口径、弱口令表）。本文件是逐条镜像。
 *
 *   ★ 三道同源闸门（改一边忘了另一边会红）：
 *     ① `tools/password-rules-check.mjs` —— 逐字比对 **Backend ↔ 小程序 ↔ App**
 *        的六句文案 / 两个边界 / 弱口令表（`npm run password:check`）；
 *     ② App 侧 `test/password_rules_test.dart` 读后端 TS 钉住同一批常量；
 *     ③ 真正不一致时**以服务端 `message` 为准**（`request.ts` 的写层已经把
 *        服务端原文透传到界面，本地这层只是「少一次必然失败的往返」）。
 *
 * ── 为什么文案里不带用户输入 ────────────────────────────────────────────────
 *   提示可能被截图、也可能进日志；服务端 `passwordMessage()` 的纪律同样如此。
 */

/** 与后端 `PASSWORD_MIN` / `PASSWORD_MAX` 逐字一致。 */
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 64

/** 注册 / 设密页**常驻**的要求文案（不是 placeholder —— 输入到一半就消失）。 */
export const PASSWORD_REQUIREMENT_HINT =
  `密码 ${PASSWORD_MIN}–${PASSWORD_MAX} 位，至少含一个字母；不能是纯数字、` +
  '同一字符重复、常见弱密码，也不能和手机号/邮箱相同。'

/** 不合格的原因（与后端 `PasswordFailure` 同名同序）。 */
export type PasswordFailure =
  | 'too_short'
  | 'too_long'
  | 'all_same'
  | 'all_digits'
  | 'common'
  | 'same_as_identifier'

/**
 * 常见弱口令（**小写比较**）。与后端 `COMMON_PASSWORDS` 同一张表。
 *
 * 刻意只有十几条：这是一张「明显不该过」的清单，不是 rockyou。
 * 真正的防线是限流 + 慢哈希。
 */
export const COMMON_PASSWORDS: readonly string[] = [
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
]

/** 把用户输入整理成「库里会存的那个值」，只用于密码比较。 */
function identifierForComparison(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return null
  if (trimmed.includes('@')) return trimmed.toLowerCase()

  let compact = trimmed.replace(/[\s\-()]/g, '')
  if (compact.startsWith('+86')) {
    compact = compact.slice(3)
  } else if (compact.length === 13 && compact.startsWith('86')) {
    compact = compact.slice(2)
  }
  return compact.toLowerCase()
}

/**
 * 密码强度判定（客户端镜像）。
 *
 * `identifier` 是用户填的手机号或邮箱**原文**（不必先规范化）。
 * 传 `null` / 省略 ⇒ 跳过 `same_as_identifier` 这一条
 * （例如改密时界面只拿到「当前密码」）。
 *
 * 判定顺序与后端**逐条相同**（顺序影响用户看到哪句话）：
 *   长度 → 与标识相同 → 单一字符 → 纯数字 → 常见弱口令。
 */
export function checkPasswordStrength(
  password: string,
  identifier?: string | null
): PasswordFailure | null {
  // ★ 用码点数而不是 `.length`：`😀😀😀😀` 在 JS 里 length=8，
  //   但服务端按 Unicode 码点算 4 位 ⇒ 两边会对同一个密码给出不同结论。
  const length = [...password].length
  if (length < PASSWORD_MIN) return 'too_short'
  if (length > PASSWORD_MAX) return 'too_long'

  const lower = password.toLowerCase()
  const target = identifierForComparison(identifier)
  if (target !== null && target !== '') {
    if (lower === target) return 'same_as_identifier'
    const at = target.indexOf('@')
    if (at > 0 && lower === target.slice(0, at)) return 'same_as_identifier'
  }

  // 反向引用：`aaaaaaaa` 命中，`aabbbbbb` 不命中（与后端同一写法）。
  // ★ 用 `[\s\S]` 而不是 `.`：目标 ES 版本没有 `dotAll`，而 `.` 不匹配换行 ——
  //   一串换行会在本地放行、到服务端被判"同一字符重复"。
  if (/^([\s\S])\1+$/u.test(password)) return 'all_same'
  if (/^\d+$/u.test(password)) return 'all_digits'
  if (COMMON_PASSWORDS.includes(lower)) return 'common'

  return null
}

/** 与服务端 `passwordMessage()` **逐字一致**的文案。 */
export function passwordFailureMessage(reason: PasswordFailure): string {
  switch (reason) {
    case 'too_short':
      return `密码至少 ${PASSWORD_MIN} 位。`
    case 'too_long':
      return `密码最多 ${PASSWORD_MAX} 位（太长的密码只是给自己添麻烦）。`
    case 'all_same':
      return '密码不能是同一个字符重复。'
    case 'all_digits':
      return '密码不能全是数字，请至少带一个字母。'
    case 'common':
      return '这个密码太常见了，很容易被猜到，请换一个。'
    case 'same_as_identifier':
      return '密码不能和你的手机号或邮箱一样。'
  }
}

/** 一步到位：`null` = 通过，否则是**给用户看的那句话**。 */
export function passwordProblem(
  password: string,
  identifier?: string | null
): string | null {
  const failure = checkPasswordStrength(password, identifier)
  return failure === null ? null : passwordFailureMessage(failure)
}

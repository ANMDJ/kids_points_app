import {
  PASSWORD_MAX as ACCOUNT_PASSWORD_MAX,
  PASSWORD_MIN as ACCOUNT_PASSWORD_MIN,
  passwordProblem
} from '../utils/password_rules'
import type { AccountSnapshot } from './auth_dto'

/**
 * 「App 登录账号」那一屏的**本地预检**与展示文案（W9-D，2026-10-30）。
 *
 * ── 客户端校验的边界（重要，别在这里加规则）──────────────────────────────────
 *   服务端的 `account-identifier.ts` 是**唯一判据**。这里只做两件事：
 *     ① 拦下"一定会 400 且本地就能说清楚"的输入（空、长度、手机号明显不像），
 *        省掉一次往返和一个更容易看错的错误框；
 *     ② 把**已经拿到的**服务端事实（手机号/邮箱）变成人话（掩码 + 能否登录）。
 *
 *   ★ 2026-11-03 起，密码强度**不再只是长度**：`checkAccountPassword()` 转调
 *     `utils/password_rules.ts`（服务端规则的镜像）。起因与 App 完全一样 ——
 *     用户看到 `400 WEAK_PASSWORD` 却不知道要求是什么，只能反复试。
 *     镜像的代价被三道同源闸门兜住：`tools/password-rules-check.mjs`
 *     逐字比对后端 / 小程序 / App 三份文案与阈值；真正不一致时以服务端
 *     `message` 为准（它每一条都写了"下一步怎么改"）。
 *
 * ── 提交的是**用户原文**，不是这里处理过的值 ────────────────────────────────
 *   `normalizePhonePreview` 只用于判断"像不像个手机号"；请求体里发的始终是
 *   输入框里的原文（`138 0013 8000` 就发这个）。规范化只允许有一处（服务端），
 *   客户端再归一一次就是两份真相：两边规则哪天不一致，绑上去的号就登不进来。
 */

/**
 * 密码长度边界**从 `utils/password_rules.ts` 再导出**（不在这里另写一份）。
 *
 * ★ 以前这里写着 `= 8` / `= 64` 两个字面量 —— 那正是"两处真相"的形状：
 *   服务端把 `PASSWORD_MAX` 从 64 改成 72 时，没人会想到还有一份在小程序里。
 */
export { ACCOUNT_PASSWORD_MAX, ACCOUNT_PASSWORD_MIN }

/**
 * 判断用的手机号（去掉空格 / 短横 / 括号 / 前置 `+86`）。
 *
 * ★ 仅供 [checkAccountPhone] 使用，**不要**拿去提交。
 */
export function normalizePhonePreview(raw: string): string {
  const compact = raw.trim().replace(/[\s\-()]/g, '')
  if (compact.startsWith('+86')) return compact.slice(3)
  if (compact.length === 13 && compact.startsWith('86')) return compact.slice(2)
  return compact
}

/** 手机号输入预检：`null` = 看起来没问题。 */
export function checkAccountPhone(raw: string): string | null {
  const digits = normalizePhonePreview(raw)
  if (digits === '') return '请填写手机号。'
  if (digits.length > 11) return '手机号过长，请检查是否粘贴了多余内容。'
  if (!/^1[3-9]\d{9}$/.test(digits)) {
    return '手机号格式不对：请填 11 位中国大陆手机号（例如 13800138000）。'
  }
  return null
}

/** 邮箱输入预检：`null` = 看起来没问题。只查最基本的结构，细节交给服务端。 */
export function checkAccountEmail(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return '请填写邮箱。'
  if (trimmed.length > 254) return '邮箱过长，请检查是否粘贴了多余内容。'
  const at = trimmed.indexOf('@')
  if (at <= 0 || at === trimmed.length - 1) {
    return '邮箱格式不对：请检查 @ 前后是否有遗漏。'
  }
  if (trimmed.slice(at + 1).indexOf('.') <= 0) {
    return '邮箱格式不对：@ 后面的域名不完整。'
  }
  return null
}

/**
 * 新密码预检：**完整镜像服务端规则**（`utils/password_rules.ts`）。
 *
 * ── 为什么不再只查长度 ──────────────────────────────────────────────────────
 *   只查长度时，`12345678` 在本地是绿的、服务端回 `400 WEAK_PASSWORD`，
 *   用户看到的是"保存失败"而不是"密码不能全是数字"（2026-11-03 App 的现场）。
 *
 * `identifier` 传用户这次要绑的手机号/邮箱原文（有就传）—— 它让
 * `same_as_identifier` 这一条也能本地判出来；不传就跳过那一条，
 * 由服务端对着库里的值回答。
 *
 * ★ 服务端仍然是唯一裁定者：这里只是"少一次必然失败的往返"。
 */
export function checkAccountPassword(
  raw: string,
  identifier?: string | null
): string | null {
  return passwordProblem(raw, identifier)
}

/** `13800138000` ⇒ `138****8000`（列表/状态行显示用）。 */
export function maskPhone(phone: string): string {
  return phone.length === 11
    ? `${phone.slice(0, 3)}****${phone.slice(7)}`
    : phone
}

/** `dad@example.com` ⇒ `d***@example.com`。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return email
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

/**
 * 当前绑定的标识（掩码后）。
 *
 * 两个都绑了就都列出来 —— 用户可能只记得其中一个，而两个都能登录。
 * 一个都没有 ⇒ `null`（那一屏据此显示"还没有 App 登录账号"）。
 */
export function accountIdentifierLabel(snapshot: AccountSnapshot): string | null {
  const parts: string[] = []
  if (snapshot.phone !== null) parts.push(maskPhone(snapshot.phone))
  if (snapshot.email !== null) parts.push(maskEmail(snapshot.email))
  return parts.length === 0 ? null : parts.join(' ／ ')
}

/**
 * 现在这台账号**能不能**用 App 登录。
 *
 * ★ 不是"绑了号就够了"：没有密码时 `POST /auth/login-account` 一律 401
 *   （与"账号不存在"逐字同形）。这一屏如果只检查手机号，用户会绑完号就
 *   以为能登，然后在 App 上试密码试到怀疑人生。
 */
export function accountLoginReady(snapshot: AccountSnapshot): boolean {
  return (snapshot.phone !== null || snapshot.email !== null) && snapshot.hasPassword
}

/** 状态行的一句话结论（「还差什么」比「已保存」有用得多）。 */
export function accountStatusText(snapshot: AccountSnapshot): string {
  const label = accountIdentifierLabel(snapshot)
  if (label === null) {
    return '还没有 App 登录账号。绑定手机号或邮箱并设置密码后，就可以在 App 里登录了。'
  }
  if (!snapshot.hasPassword) {
    return `已绑定 ${label}，但还没有设置密码 —— 现在还不能在 App 里登录。`
  }
  return `已绑定 ${label}，可以在 App 里用手机号或邮箱 + 密码登录。`
}

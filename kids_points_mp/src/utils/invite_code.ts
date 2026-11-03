/**
 * 邀请码的**形状**（长度 / 字符表 / 规范化）—— 纯函数层（P0-3，2026-11-03）。
 *
 * ── 为什么小程序也要有一份 ──────────────────────────────────────────────────
 *   `POST /invites/accept` 对形状错误回 400 `INVITE_CODE_MALFORMED`。
 *   用户少抄一位时就先等一次往返、再被拒，是可避免的等待；而客户端抄错
 *   一个字符就会变成「本地放行、服务端 400」。
 *
 *   ★ 三份镜像：`backend/src/invites/invite-code.ts`（唯一判据）、
 *     `lib/models/invite.dart`（App）、本文件（小程序）。
 *     它们由 `tools/invite-code-check.mjs` **逐字比对** —— 改一份忘另一份会红。
 */

/** 码长（不含展示用的连字符）。 */
export const INVITE_CODE_LENGTH = 8

/** 31 个易辨认字符：去掉 `0 O 1 I L`。 */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * 规范化用户输入（与后端 `normalizeInviteCode()` 同一条规则）：
 * 去空白与连字符、转大写。
 *
 * **不做** `O→0` / `l→1` 这类猜测：字母表里本来就没有它们，
 * 猜错了只会把「输错了」变成「码无效但看起来对」。
 */
export function normalizeInviteCodeInput(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

/**
 * 形状是否合法（应先 `normalizeInviteCodeInput`）。
 *
 * `false` ⇒ 界面就能说「还差几位 / 有非法字符」，不发一次必然 400 的请求。
 * ★ 「码能不能用」（过期 / 用完 / 吊销 / 已是成员）**不在这里**判断：
 *   那是服务端的事实，客户端猜错会让家长白白再发一张。
 */
export function isWellFormedInviteCode(code: string): boolean {
  if (code.length !== INVITE_CODE_LENGTH) return false
  for (const char of code) {
    if (!INVITE_CODE_ALPHABET.includes(char)) return false
  }
  return true
}

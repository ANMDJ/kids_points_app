import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `POST /auth/register-invite` 的请求体（W11-A，2026-11-02 / `45` §3.1）。
 *
 * ── 为什么必须有 `inviteCode`（而不是「开放注册」）────────────────────────────
 *   `42` §5.1 拒绝开放注册的理由是：手机号打错一位 ⇒ 静默生成新账号 ⇒
 *   用户进去发现「我的孩子不见了」。邀请码把注册变成**加入一个已存在的家庭**，
 *   打错号码最坏只是「多了一个加入同一家庭的账号」，而不是孤儿数据。
 *   它同时是这条路由唯一的授权凭据 —— 没有码，就没有注册。
 *
 * ── 为什么**没有** `role` 字段 ───────────────────────────────────────────────
 *   角色只能来自邀请码（谁生成的码、码上写什么角色）。请求体若能指定角色，
 *   「child 码 + role=guardian」就是一条现成的提权路径。
 *   全局管道是 `whitelist + forbidNonWhitelisted`（`app.setup.ts`）⇒
 *   多传一个 `role` 会直接 **400**，不会被静默忽略。
 *
 * ── 长度上限的依据（与登录 DTO 同一口径）────────────────────────────────────
 *   · `inviteCode` 32：展示形是 `ABCD-EFGH`（9 字符），留出空格/连字符的余量；
 *     真正的形状判定只有一处（`invite-code.ts#isWellFormedInviteCode`），
 *     这里只拦「一整段粘贴」。
 *   · `identifier` 254：RFC 5321 的邮箱总长上限，手机号远小于它。
 *   · `password` 64：scrypt 的输入整体进内存，不设上限等于给攻击者一个
 *     「用 1MB 密码打满 CPU」的入口（与 `account-identifier.ts#PASSWORD_MAX` 一致）。
 *   · `displayName` 40：只用于「家长」这一屏的称呼，不参与任何判定。
 *
 * ★ 这里**不**校验密码强度：规则只有一份（`validatePasswordStrength()`），
 *   放在 service；DTO 只负责「是不是字符串、多长」。
 */
export class RegisterWithInviteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  inviteCode!: string

  @IsString()
  @MinLength(1)
  @MaxLength(254)
  identifier!: string

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  password!: string

  @IsOptional()
  @IsString()
  @MaxLength(40)
  displayName?: string
}

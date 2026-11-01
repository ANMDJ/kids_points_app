import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `PUT /auth/account` 的请求体（W9-D，2026-10-30 / `42` §3.3）。
 *
 * 一个端点同时承担「绑定手机号/邮箱」与「设置/修改密码」，因为它们在**同一次
 * 交互**里发生（小程序「我的 → 绑定 App 账号」一屏填完），而拆成三个端点会让
 * 客户端必须自己保证"先设密码再绑号"的顺序 —— 顺序错了就会留下一个
 * 「能登录但没有标识」的账号。
 *
 * ── 三个字段都可选，但**不能全空** ──────────────────────────────────────────
 *   `{}` 是无效请求（service 回 400 `ACCOUNT_NOTHING_TO_UPDATE`）。
 *   `undefined` = 不变；字符串 = 设置为新值。★ 首版**不支持解绑**
 *   （传 `null` 不在 DTO 的封闭集合里 ⇒ 400），因为解绑的唯一合理场景是
 *   "换号"，而它需要先证明新号属于你 —— 那是 OTP 通道的活，不在本轮。
 *
 * ── `currentPassword` 何时必填 ─────────────────────────────────────────────
 *   **已设过密码**再改密码 ⇒ 必填且必须正确（防止拿到手机的人直接改密码）。
 *   **从未设过密码** ⇒ 可不填（此时身份由 `Authorization` 里的微信会话背书）。
 *   这条判定在 service（它要读库才知道"有没有设过"），不在 DTO。
 *
 * ── 为什么 `phone` / `email` 分开而不是一个 `identifier` ────────────────────
 *   与登录相反：绑定时"手机号和邮箱**可以都绑**"是合法且推荐的
 *   （换手机号后还能用邮箱登录）。一个字段表达不了"两个都要"。
 */
export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  phone?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  email?: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  password?: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  currentPassword?: string
}

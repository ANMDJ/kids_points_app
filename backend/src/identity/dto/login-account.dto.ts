import { IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `POST /auth/login-account` 的请求体（W9-D，2026-10-30 / `42` §3.2）。
 *
 * ── 为什么字段叫 `identifier` 而不是 `phone` / `email` 两个可选字段 ────────────
 *   两个可选字段会制造三种非法组合（都填 / 都不填 / 填了但形状错），
 *   而它们的**语义完全相同**：一个唯一标识 + 一个密码。
 *   一个字段 ⇒ 分类交给服务端唯一一处（`classifyIdentifier()`，看有没有 `@`），
 *   客户端不需要先判断"用户输的是手机还是邮箱"，界面也只有一个输入框。
 *
 * ── 上限 254 的依据 ─────────────────────────────────────────────────────────
 *   254 是邮箱的总长上限（RFC 5321），手机号远小于它。更长的输入只可能是
 *   payload 攻击或误粘贴 —— 由 DTO 拦在最外层，不让它进 scrypt。
 *
 * ── 密码为什么上限 64 ──────────────────────────────────────────────────────
 *   scrypt 的输入整体进内存；不设上限等于给攻击者一个"用 1MB 密码打满 CPU"
 *   的入口。与 `account-identifier.ts#PASSWORD_MAX` **同一口径**。
 *
 * ★ 这里**不**校验"密码够不够强"：登录不评判密码质量（历史密码可能不满足
 *   今天的规则），强度判定只在**设置**密码时生效。
 */
export class LoginAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  identifier!: string

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  password!: string
}

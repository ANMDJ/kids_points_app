import { IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `POST /auth/parent-pin/reset` 的请求体（P1-7，2026-11-04）。
 *
 * ── 为什么是「账号密码 ＋ 新 PIN」两个字段 ────────────────────────────────────
 *   `43` §4 P1-7 的验收判据是「走**监护人身份再验证**后重置，并写审计」。
 *   本仓库里最强的"再验证"凭据就是 `User.passwordHash`（登录用的那一份）：
 *   它与 PIN 哈希前缀不同、不可互换（`common/password-hash.ts` 文件头），
 *   所以拿着 PIN 的哈希 **不能**当密码用。
 *
 *   `pin` 是**新的**那把钥匙 —— 重置不能只把 PIN 清空：
 *   清空之后设备处于"没有钥匙"的状态，而 W14 的孩子模式到期后
 *   PIN 是唯一出口（`51` §2），清空等于把设备换成另一种锁死。
 *
 * ── 为什么 `password` 不写 `@MinLength(8)` ────────────────────────────────────
 *   密码强度是**注册 / 改密**时的规则（服务端 `WEAK_PASSWORD`）。
 *   这里只回答"这对不对"，长度不对的输入应该在**校验**里失败
 *   （`CURRENT_PASSWORD_INVALID`），而不是回 400 让攻击者知道
 *   "这个账号的密码一定 ≥ 8 位"或"你输的太短"。上限 64 是防超长 scrypt 拖 CPU。
 */
export class ResetParentPinDto {
  @IsString()
  @MaxLength(64)
  password!: string

  @IsString()
  @MinLength(1)
  @MaxLength(32)
  pin!: string
}

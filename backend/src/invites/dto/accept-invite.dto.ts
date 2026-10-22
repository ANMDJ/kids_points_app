import { IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `POST /invites/accept` 的请求体（W5-G，2026-10-22）。
 *
 * ── 为什么只收一个 `code`，且长度上限是 32 ──────────────────────────────────
 *   加入需要的信息全部来自**凭据本身**（码 → 孩子 + 角色）：客户端传
 *   `childId` 就是在声明「我要进哪个孩子」，那等于让邀请码变成一个可有可无的
 *   装饰品（`forbidNonWhitelisted` 会直接 400）。
 *
 *   `MaxLength(32)` 只是防超长 payload 的**粗上限**：真实码是 8 位，
 *   但用户可能贴成 `ABCD-EFGH`、带前后空格、或者被输入法塞了全角字符 ——
 *   去空格 / 去连字符 / 转大写由 `normalizeInviteCode()` 做（一份实现），
 *   真正的合法性判定是 `isWellFormedInviteCode()`（服务层，按 31 字符表）。
 */
export class AcceptInviteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string
}

import { IsString, MaxLength, ValidateIf } from 'class-validator'

/**
 * `POST /auth/parent-pin` 的请求体（W8-C，2026-10-27 / `02` §7）。
 *
 * ── 两个字段：新 PIN + （改的时候）旧 PIN ────────────────────────────────────
 *   `pin`       要写入的新 PIN（4–6 位数字，格式由 service 判，理由同
 *               `EnterParentModeDto`）。
 *   `currentPin` **只有已存在 PIN 时才需要**（首次设置不需要）。
 *
 * ── 为什么要旧 PIN 才能改 ──────────────────────────────────────────────────
 *   家长模式只有 5 分钟：家长把手机递给孩子之前若忘了退出，孩子手里仍有
 *   「家长模式」的窗口。若改 PIN 不需要旧 PIN，那个窗口就足以**永久**改掉钥匙，
 *   把真正的家长锁在家长模式之外（而且孩子下次可以自己进）。
 *   代价是"忘了自己 PIN 的家长改不了"（`02` §7 没有定义找回通道）——
 *   这是**已知限制**，写在 `auth.service.ts` 的 `setParentPin` 注释里，
 *   不假装它不存在。另一位家长用自己的 PIN 仍可正常使用家长模式。
 *
 * ── 为什么 `currentPin` 用 `@ValidateIf` 而不是 `@IsOptional` ─────────────────
 *   `@IsOptional` 会**放过 `null`**（class-validator 把 null 视为"未提供"），
 *   于是 `{"currentPin": null}` 与"省略"走到同一条分支 —— 而它们不是一回事：
 *   前者是客户端把"没填"序列化成了 null。用 `ValidateIf(v !== undefined)`
 *   让 `null` 撞上 `@IsString()` 报 400（与 `complete-onboarding.dto.ts` 同一手法）。
 */
export class SetParentPinDto {
  @IsString()
  @MaxLength(32)
  pin!: string

  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @MaxLength(32)
  currentPin?: string
}

import { IsString, MaxLength } from 'class-validator'

/**
 * `DELETE /auth/kid-mode` 的请求体（W14，2026-11-03）。
 *
 * ── 为什么收回要 PIN，而且 PIN 在请求体里 ────────────────────────────────────
 *   「收回孩子模式」是**提权**（child ⇒ guardian 的可行状态）。没有 PIN，
 *   「给孩子用 20 分钟」就是个装饰按钮：孩子自己点一下就回家长模式，
 *   还能顺手批掉自己的心愿。
 *
 * ── 为什么不用 `@Matches(PIN_PATTERN)` ──────────────────────────────────────
 *   与 `EnterParentModeDto` 完全同一条口径：格式错（3 位 / 混字母）是手滑，
 *   **不计入**失败次数，必须走到 service 由 `isPinFormatValid()` 给出
 *   `PARENT_PIN_FORMAT_INVALID`。管道层只留 `@MaxLength` 防滥用。
 */
export class ExitKidModeDto {
  @IsString()
  @MaxLength(32)
  pin!: string
}

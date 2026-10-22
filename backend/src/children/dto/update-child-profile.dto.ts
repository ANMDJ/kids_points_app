import { IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `PATCH /child` 的请求体（W5-E，2026-10-21）。
 *
 * ── 为什么只有一个字段 ──────────────────────────────────────────────────────
 *   本轮「我的」页只开放**昵称**。头像 / 生日 / 孩子 ID 都不在这里：
 *   前两者没有产品口径，后者是**主键**（改它等于换一个孩子）。
 *   集合封闭（`forbidNonWhitelisted`）保证传 `childId` / `points` 一律 400 ——
 *   与 `POST /point-rules` 拒绝 `direction` 同口径：客户端不许指定「改谁」。
 *
 * ── 为什么 DTO 上限是 32 而不是 16 ─────────────────────────────────────────
 *   `MaxLength` 数的是 **UTF-16 code unit**，而双端输入框的「16 个字」数的是
 *   用户看到的字符（emoji 算 1 个）。一个 emoji 占 2 个 code unit，若 DTO 直接
 *   卡 16，16 个 emoji 的昵称会被拦在管道层，客户端无法解释。故这里只做
 *   **粗上限**（防超长 payload），真正的 16 字符判定在 `ChildrenService` 里按
 *   码点（`Array.from(name).length`）做 —— 单一业务判据，单一错误码。
 */
export class UpdateChildProfileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  name!: string
}

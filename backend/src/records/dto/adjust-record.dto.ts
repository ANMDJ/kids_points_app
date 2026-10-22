import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, NotEquals } from 'class-validator'

/**
 * `POST /records/adjust` 的请求体 —— 「记一笔」（家长手动加 / 扣分，W5-B）。
 *
 * ★ 形状 = 集合封闭（全局 `ValidationPipe` 的 `whitelist + forbidNonWhitelisted`）：
 *   多传 `childId` / `source` / `operatorRole` / `balanceAfter` 一律 400。
 *   - `childId` 来自会话（`x-kp-child-id` 经身份 Guard 校验），**绝不**读请求体
 *     —— 否则等于让客户端决定「给谁加分」；
 *   - `source` 由会话角色派生（孩子 ⇒ `child_self`，家长 ⇒ `guardian`）；
 *   - `balanceAfter` 由账本内核按**锁内余额**算，客户端说了不算（B6：账本必须平）。
 *
 * `points` 是**带符号**的（负 = 扣分），与 `RecordDto.points` 同构 ——
 * 客户端 `addQuickNote(delta)` 的 `delta` 原样发出，不需要再取反。
 *
 * 上限 999 与两端 `PointsStepper(max: 999)` 同口径：超出这个量级的"手动调整"
 * 更可能是误触/脚本，而不是家长真想一次给 5000 分。
 */
export class AdjustRecordDto {
  /** 事由（流水标题）。落库的是**完整**标题，不在这里截断（修 B8）。 */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  // 纯空白也拒：`'   '` 过得了 MinLength，却会让内核报 MISSING_TITLE_SNAPSHOT（500）。
  // 输入错误应当在 400 就被拦住，而不是让服务端 500。
  @Matches(/\S/, { message: 'title 不能只有空白字符' })
  title!: string

  /** 带符号分值：`-999..-1` 为扣分，`1..999` 为加分；0 没有语义（流水无法解释）。 */
  @IsInt()
  @Min(-999)
  @Max(999)
  @NotEquals(0)
  points!: number

  /** 附注（可选，最多 200 字）；落进 `PointRecord.note`。 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string
}

import {
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals
} from 'class-validator'

/**
 * `POST /point-rules` 的请求体（W5-A，2026-10-19）。
 *
 * ★ 形状 = 集合封闭（全局 ValidationPipe 的 `whitelist + forbidNonWhitelisted`）：
 *   多传 `childId` / `direction` / `currentVersion` 一律 400。
 *   - `childId` 来自会话（`x-kp-child-id` 经身份 Guard 校验），**绝不**读请求体；
 *   - `direction` 由 `points` 的符号派生（负 = penalty），客户端不能单独指定，
 *     否则会出现 `points: 3, direction: penalty` 这种自相矛盾的行；
 *   - `currentVersion` 由服务端维护（新建恒为 1），客户端说了不算。
 *
 * `points` 是**带符号**的客户端契约（与 `RuleDto.points` 同构）：
 *   库内仍按 schema 存正数 + `direction`（03 A1），转换只发生在
 *   `RulesService` / `read.mapper` 各一处。
 */
export class CreateRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string

  /** 可为空串 —— 服务端会落成「家长约定」（与双端本地实现同口径）。 */
  @IsString()
  @MaxLength(200)
  condition!: string

  /** 1–5 次/天（PRD 硬性业务规则；与双端 `isDailyLimitValid()` 同口径）。 */
  @IsInt()
  @Min(1)
  @Max(5)
  dailyLimit!: number

  /**
   * 带符号分值：`-10..-1` 为扣分，`1..10` 为奖励。
   * 0 被拒：`+0` / `-0` 都不是一条讲得通的约定（也无法决定 direction）。
   */
  @IsInt()
  @Min(-10)
  @Max(10)
  @NotEquals(0)
  points!: number

  /** 图标**名字**（跨端白名单的成员；这里只挡形状，白名单由双端各自校验）。 */
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9]{0,63}$/, {
    message: 'icon 必须是字母开头的图标名字（1–64 字符）'
  })
  icon!: string

  /** `#rrggbb` —— 与 `Habit/PointRule.color` 的存储格式一致。 */
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'color 必须是 #rrggbb 形式的十六进制颜色'
  })
  color!: string
}

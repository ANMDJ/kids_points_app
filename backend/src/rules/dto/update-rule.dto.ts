import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals
} from 'class-validator'

/**
 * `PATCH /point-rules/:id` 的请求体（W5-A，2026-10-19）。
 *
 * ── 为什么是**整份替换**而不是部分字段 ─────────────────────────────────────
 *   规则版本是**全量快照**（`PointRuleVersion` 存 title/condition/dailyLimit/
 *   points/direction 五个字段，没有\"继承上一版\"的语义）。允许只传一个字段，
 *   服务端就必须先读旧值再拼快照 —— 那会在并发下写出\"一半旧一半新\"的版本。
 *   双端表单本来就每次都提交完整五元组，整份替换更简单也更诚实。
 *
 * ── `expectedVersion` 不是冗余字段 ────────────────────────────────────────
 *   它是**乐观锁**：家长 A 在页面上看到第 3 版，提交时若服务端已经是第 4 版，
 *   必须 409 `RULE_VERSION_CONFLICT`，而不是把 A 的修改盖在 B 的修改上。
 *   版本号同时是 `PointRuleVersion` 的主键的一半（`@@unique([ruleId, version])`），
 *   服务端只用 `expectedVersion + 1` 生成下一版 —— 绝不由客户端指定新版本号。
 *
 * `icon` / `color` 不在可编辑字段里：与双端 `updateRule()` 同口径
 * （D9：图标只在新建时选择；颜色随图标一起确定）。
 */
export class UpdateRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string

  @IsString()
  @MaxLength(200)
  condition!: string

  @IsInt()
  @Min(1)
  @Max(5)
  dailyLimit!: number

  @IsInt()
  @Min(-10)
  @Max(10)
  @NotEquals(0)
  points!: number

  /** 客户端看到的**当前版本号**；与实际不一致 ⇒ 409（不覆盖别人的修改）。 */
  @IsInt()
  @Min(1)
  expectedVersion!: number
}

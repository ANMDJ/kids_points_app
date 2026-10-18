import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

import { ALL_ACTIONS, type ActionType } from '../../contracts/permission-matrix'

/**
 * 建审批请求的请求体（`POST /approvals`，`02` §4.3 / §4.5）。
 *
 * 这里**只描述形状**，不描述「谁可以批准」—— 那是 `approval-policy.ts` 的事，
 * 而且**必须只有那一处**（`02` §4.5「唯一实现点」）。
 */
export class CreateApprovalRequestDto {
  /** 必须是 25 个已登记动作之一；未知动作在**入口**就被拒（fail-closed，与矩阵同源）。 */
  @IsIn(ALL_ACTIONS)
  action!: ActionType

  /** 目标对象 id（心愿 / 习惯 …）；长度上限对齐 cuid 尺度。 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetId?: string

  /**
   * 「申请时勾选自动审批」（`02` §4.5 形态②）。
   *
   * ★ 刻意**不加** `@IsBoolean()`：唯一判定点是 `approval-policy.ts`，而 §4.5
   *   硬约束 3 规定「缺席 / `false` / **非布尔** → 一律 `pending`」。
   *   若在此加 `@IsBoolean()`，客户端传 `"true"` 会变成 **400**，
   *   与「非布尔 = 未勾选 = pending」**直接冲突**（同一份输入两种口径）。
   *   把「什么算显式勾选」收敛到一处（严格 `=== true`，见 `decideRequestOutcome`），
   *   比在两层各写半条规则更安全。
   *
   * 形状封闭仍由 `ValidationPipe({ whitelist, forbidNonWhitelisted })` 保证：
   * 未知键（如 `foo`）→ 400（同 D3b 的多余键拒绝口径）。
   */
  @IsOptional()
  autoApprove?: unknown

  /**
   * `request_points_bonus` 的申请金额（Q15：单笔 ≤ 50）。
   *
   * ★ 形状校验只拦「明显不是金额」；**业务校验仍在端口**（`snapshotBonusPayload`）——
   *   例如 `ruleId` / `habitId` 与金额是否自洽、引用是否属于这个孩子。
   *   两层都写一遍才会漂移；这里只做 DTO 该做的形状封闭。
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  amount?: number

  /** 加分事由（可空；端口会快照进 `payload`，并作为流水标题的优先来源）。 */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string

  /** 加分所依据的规则（可选）。批准时会复查它是否仍为 `active` → 否则 `RULE_DELETED`。 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  ruleId?: string

  /** 加分所依据的习惯（可选）。批准时会复查它是否仍为 `active` → 否则 `HABIT_GONE`。 */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  habitId?: string

  /** `add_wish` 的心愿标题（孩子提申请时由孩子填写）。 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string

  /** `add_wish` 的兑换成本；批准时才真正落成 `Wish`。 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000)
  cost?: number

  /** `add_wish` 的表情（缺省 `🎁`）。 */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  emoji?: string
}

import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'

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
}

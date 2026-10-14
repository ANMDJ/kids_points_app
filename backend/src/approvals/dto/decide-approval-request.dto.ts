import { IsIn } from 'class-validator'

/** 终态里可由「人」指定的两个（`02` §4.1）：`withdrawn` / `invalidated` / `expired` 不由本端点产生。 */
export const DECIDABLE_OUTCOMES = ['approved', 'rejected'] as const

export type DecidableOutcome = (typeof DECIDABLE_OUTCOMES)[number]

/**
 * 批准 / 拒绝端点（`POST /approvals/:id/decide`，`02` §4.4 / §4.5）。
 *
 * `withdrawn`（申请人撤回）与 `invalidated`（前提消失，系统判定）**不在**这里 ——
 * 它们分别是另一个端点与系统行为；混进来会让「审批」变成万能状态写入口。
 */
export class DecideApprovalRequestDto {
  @IsIn(DECIDABLE_OUTCOMES)
  decision!: DecidableOutcome
}

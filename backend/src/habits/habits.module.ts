import { Module } from '@nestjs/common'

/**
 * 习惯（docs/design/03 A2 / A3 / E17）
 *
 * 结构字段：`dailyLimit: Int`（**不是**自由文本）—— 修 A2。
 * 派生字段（**不落库**）：`limitText` / `doneText` / `checked` —— 修 A3 / E17：
 *   limitText = dailyLimit === 1 ? '每天 1 次' : `每天最多 ${dailyLimit} 次`
 *   doneText  = `今日已完成 ${checkedCountToday} 次`
 *   `checked` 由「今日记录数 ≥ dailyLimit」计算，而不是一个可被任意赋值的布尔。
 *   03 E17：它们一旦被外部写入就**必然**与真实状态脱节（seed 里手写的
 *   '今日已完成 1 次' 与实际的 0 次就是这么脱节的）。
 *
 * `addHabitFromRule` 必须**拒绝** `direction=penalty` 的规则 —— 修 A1
 * （原实现用 `Math.abs()` 把负分抹平成加分，扣分约定变成加分）。
 *
 * ⚠ W0 状态：**签名占位**。验收用例见 02 §9.16 / §9.17 与 04 §4.5。
 */
@Module({})
export class HabitsModule {}

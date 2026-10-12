import { Module } from '@nestjs/common'

/**
 * 规则 + 规则版本化（docs/design/02 §5.3–§5.6 / 03 C10 / E15）
 *
 * `update_rule` 事务（**原子**，02 §5.3）：
 *   1. 读 currentVersion = v
 *   2. 写 PointRuleVersion { version: v+1, ...新值 }
 *   3. 更新 PointRule（含 currentVersion = v+1）
 *   4. 写 AuditLog { action:'point_rule.update', before:{...v}, after:{...v+1} }
 *   ↑ 四步同一 $transaction
 *
 * `PointRuleVersion` **只增不删**（写入频率极低：只在改规则时写一条，非每次打卡）。
 * 规则主体可软删（`status=deleted`），但版本永不删 ——
 * 否则历史记录的 (ruleId, ruleVersion) 指向空，「这分按什么规则给的」永远无法回答（02 §5.6）。
 *
 * 改规则对「今天已打卡」的语义（02 §5.5，**这是验收标准，不是可选项**）：
 *   历史不可回溯、未来从新规；今日已用额度**按新规重算**；已得的分不补差、不追扣。
 *   必须向家长明确提示「今天不能再打卡了」，否则必然产生投诉。
 *
 * 结构字段（03 E15）：`condition` / `dailyLimit` 是结构字段；
 * `detail` 降级为**派生展示串**，不落库 —— 不再靠 `split(' · ')` 反解析。
 *
 * ⚠ W0 状态：**签名占位**。验收用例见 02 §9.11（I1 逐字段 diff 为空）+ 02 §5.5。
 */
@Module({})
export class RulesModule {}

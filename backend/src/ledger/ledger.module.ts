import { Module } from '@nestjs/common'

/**
 * ★ 账本内核（docs/design/01 §4 / 02 §5 / §5.7）
 *
 * 不可违反的规则：
 * 1. `PointRecord` **只增不改不删**。撤销写**冲正**记录（`reversesRecordId`）—— 修 B7。
 * 2. `balanceAfter` 在同事务内计算并落库 —— 修 B6（原实现扣分静默截断 → 账本不平）。
 * 3. `titleSnapshot` 完整不截断（截断只发生在渲染层）—— 修 B8。
 * 4. `operatorUserId` / `operatorRole` 记录**真实**操作人 —— 修 A4（原硬编码「家长记录」）。
 * 5. 快照若与 `PointRuleVersion` 不一致，**以版本行为准**（版本是真相之源，快照只是缓存）。
 *
 * 事务边界（01 §4）—— 必须同一 $transaction：
 *   写 PointRecord(含 balanceAfter) + 更新 Child.pointsBalance
 *   + 写 PointRuleVersion(若涉及规则) + 写 AuditLog(before/after)
 *   + 更新 ApprovalRequest.status/executedRecordId(若由审批触发)
 * 必须**排除**在事务外：
 *   推送通知、埋点统计、报表生成、缓存失效。
 *   理由：推送服务不可靠 —— 放进事务会让一次模板消息失败**回滚一笔已经成立的加分**，
 *   孩子明明完成了、账却没了。验收：02 §9.23。
 *
 * ⚠ W0 状态：**签名占位**。验收用例见 02 §9.11–§9.14（I1–I6 不变量）。
 */
@Module({})
export class LedgerModule {}

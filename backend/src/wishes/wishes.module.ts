import { Module } from '@nestjs/common'

/**
 * 心愿（docs/design/03 B8 / C9 / E16）
 *
 * `coverStyle` 是**稳定枚举**（A|B|C|D）—— 修 E16：
 *   原实现 `backgroundIndex = wishes.length % 4` 由**插入时的列表长度**决定，
 *   删除中间某个心愿后，后续新增会与既有心愿撞色或跳变。
 *   若将来要「由 id 稳定派生」，也必须保证**不随列表增删变化**。
 *
 * 兑换成本必须**快照进审批 payload 的 `costSnapshot`**（02 §4.3）：
 *   否则家长同意时心愿价格已被改过，扣分金额与孩子申请时看到的不一致 —— 又一次账对不上。
 *
 * 软删除（C9）：`status=deleted` + `deletedAt`，回收站保留 90 天；
 * **流水永不删除** —— 回收站只作用于「配置」，永不作用于「账本」（02 §5.6）。
 *
 * ⚠ W0 状态：**签名占位**。验收用例见 04 §4.4（采纳后改模板不影响已采纳规则）。
 */
@Module({})
export class WishesModule {}

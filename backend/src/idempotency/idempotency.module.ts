import { Module } from '@nestjs/common'

/**
 * 幂等（docs/design/02 §4.4）
 *
 * 问题：网络重试 / 双击「同意」/ 前端重复提交，都会导致**重复扣分**。
 *
 * 设计：客户端生成幂等键（UUID），服务端在**同一事务**内：
 *   1. 尝试插入 `IdempotencyRecord`（`@@unique([childId, key])` 兜底）
 *   2. 唯一冲突 → 返回首次的 `responseStatus` / `responseBody`（而不是再执行一次）
 *   3. 同一键但 `requestHash` 不同 → 视为冲突，**不得静默复用**首次结果
 *
 * ★ 唯一约束必须在**数据库层**，不能只靠应用层「先查有没有」——
 *   并发下应用层检查必然漏（与 02 §8 邀请码是同一类错误）。
 *
 * `PointRecord.idempotencyKey` 同样有唯一约束，构成第二道兜底。
 *
 * ⚠ W0 状态：**签名占位**。验收用例见 02 §9.10（双击同意 → 第二次 409，账本只扣一次）。
 */
@Module({})
export class IdempotencyModule {}

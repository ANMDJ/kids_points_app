import { Module } from '@nestjs/common'

/**
 * 屏障一 · 成员资格门（docs/design/02 §3）
 *
 * 回答「这个人跟这个孩子有没有关系」：
 *   ChildMember(childId, userId).status === 'active' ？
 *   ✗ → 403 MEMBER_NOT_FOUND / MEMBER_REMOVED
 *
 * 为什么必须独立成第一道：权限矩阵是「角色 × 动作」，前提是**先有角色**。
 * 若把资格判定混进矩阵，非成员会被当成「未知角色」，判定语义就模糊了。
 *
 * ⚠ W0 状态：**签名占位**。实现随 W2 落地，验收用例见 02 §9.21（非成员 → 403）。
 */
@Module({})
export class MembershipModule {}

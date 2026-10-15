import { Module } from '@nestjs/common'

import { MembershipGuard } from './membership.guard'
import {
  MEMBERSHIP_REPOSITORY,
  NotImplementedMembershipRepository
} from './membership.repository'

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
 * ✅ **已接线（2026-10-15，W1-B）**：`MembershipGuard` ＋ 端口 `MembershipPort`
 *   ＋ 纯内核 `resolveMembership()`；挂载点是**控制器级**
 *   `@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)` ——
 *   数组顺序即语义（身份 → 资格 → 矩阵），理由见 guard 文件头「顺序」。
 *   用例：`test/membership-gate.test.ts`（纯内核）＋ `test/membership-http.test.ts`（真 HTTP）。
 *
 * ⚠ **仍未落地（不粉饰）**：真 Prisma 查询。端口默认实现是**显式 501**
 *   （`MEMBERSHIP_QUERY_NOT_IMPLEMENTED`）—— 即默认装配下，屏障一对**每个**请求
 *   返回 501（fail-closed：比"拦不住"强，但确实**还没读过库**）。
 *   真适配器 ＋ 真库验证属 W2（与 `ApprovalsPort` 的 Prisma 实现同一批）。
 */
@Module({
  providers: [
    MembershipGuard,
    // ★ 默认实现 = 一律 501（见 membership.repository.ts 的说明）。
    //   W2 落 Prisma 实现时**只换这一行**，守卫 / 端口 / 用例都不动。
    { provide: MEMBERSHIP_REPOSITORY, useClass: NotImplementedMembershipRepository }
  ],
  // 导出：让需要屏障一的模块（当前是 ApprovalsModule）在自己的控制器上挂载它。
  // ★ 与 PermissionsGuard 一样**不**改成全局 `APP_GUARD`：全局注册会先于身份解析执行，
  //   拿到空的 kpActor / kpChildId（理由与屏障二完全相同）。
  //
  // ★ **端口令牌也必须导出**（实测踩到）：`@UseGuards(某个类)` 时，Nest 在**宿主模块**
  //   （声明那个 controller 的模块）的上下文里实例化守卫并解析它的构造依赖 ——
  //   只导出 `MembershipGuard` 而把 `MEMBERSHIP_REPOSITORY` 留在本模块内部，
  //   ApprovalsModule / 测试探针模块会直接报
  //     `Nest can't resolve dependencies of the MembershipGuard (?) … Symbol(MEMBERSHIP_REPOSITORY)`
  //   （导入本模块**不等于**能看到它未导出的 provider）。
  //   导出后，替身/默认实现都能被上层模块正常注入与替换。
  exports: [MembershipGuard, MEMBERSHIP_REPOSITORY]
})
export class MembershipModule {}

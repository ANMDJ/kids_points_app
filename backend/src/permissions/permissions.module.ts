import { Module } from '@nestjs/common'

import { PermissionsGuard } from './permissions.guard'

/**
 * 屏障二 + 屏障三 + action-dispatcher（docs/design/02 §2 / §3 / §6）
 *
 * ├ 屏障二：消费 `src/contracts/permission-matrix.ts` 的矩阵（**唯一事实源**）。
 * │   ALLOW → 放行；REQUIRE_APPROVAL → 202 + 建 ApprovalRequest；DENY → 403。
 * │   ✅ **已落地（2026-10-14，W1-A）**：`PermissionsGuard` + `@RequireAction(...)` ——
 * │   矩阵**第一次被 HTTP 路径消费**（此前 `resolveVerdict` 只在单测里被调用）。
 * │   四处 fail-closed 见 guard 文件头；实测见 `test/permissions-guard.test.ts`。
 * │   ★ 注册方式是**控制器级**，不是 `APP_GUARD`：Nest 的 Guard 顺序是
 * │     「全局 → 控制器 → 方法」，全局注册会让屏障二**先于**身份解析执行（拿到空 actor）。
 * │     详见 guard 类注释「顺序」。
 * ├ 屏障三：成员级收紧。最终判定 = min(矩阵判定, 成员级限制)，
 * │   严苛度 DENY > REQUIRE_APPROVAL > ALLOW。**只能更严，永不放宽**。
 * │   ⚠ **尚未接线**：`member-restrictions.ts` 的 `validateRestrictions()` 目前只保证
 * │     「形状合法」，`stricter()` 还没有被任何请求路径调用（留给 W1-B）。
 * └ dispatcher 归一化（02 §6）：孩子调用 adjust_points 时不直接 403 ——
 *     delta > 0 归一化为 request_points_bonus 走审批；delta <= 0 → CHILD_CANNOT_DEDUCT。
 *     归一化放在这里而非矩阵，因为「按参数符号分流」是业务逻辑，
 *     塞进矩阵会让矩阵变形为代码（02 §6）。
 *
 * ⚠ 关键约束：本模块与 backend_agent 必须消费**同一张**矩阵。
 *   Agent 侧读由 `npm run contracts:emit` 生成的 contracts/permission-matrix.json。
 *   两条入口各自维护一份 = 必然漂移 = Agent 成为提权通道。
 *
 * ⚠ 仍未落地（都不粉饰）：① **屏障一**（成员资格门 `MembershipModule`）；
 *   ② 屏障三（上面已标）；③ **actor 仍来自临时头**（`x-kp-role`）——
 *   屏障二本身是真的，但它保护的"角色"尚未由服务端确立（W1-C 的 DeviceSession）。
 */
@Module({
  providers: [PermissionsGuard],
  // 导出：让需要屏障二的模块（当前是 ApprovalsModule）在自己的控制器上挂载它。
  // 将来端点变多时**也不改**成全局注册 —— 理由见文件头「注册方式」。
  exports: [PermissionsGuard]
})
export class PermissionsModule {}

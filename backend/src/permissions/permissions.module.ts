import { Module } from '@nestjs/common'

/**
 * 屏障二 + 屏障三 + action-dispatcher（docs/design/02 §2 / §3 / §6）
 *
 * ├ 屏障二：消费 `src/contracts/permission-matrix.ts` 的矩阵（**唯一事实源**）。
 * │   ALLOW → 放行；REQUIRE_APPROVAL → 202 + 建 ApprovalRequest；DENY → 403。
 * ├ 屏障三：成员级收紧。最终判定 = min(矩阵判定, 成员级限制)，
 * │   严苛度 DENY > REQUIRE_APPROVAL > ALLOW。**只能更严，永不放宽**。
 * └ dispatcher 归一化（02 §6）：孩子调用 adjust_points 时不直接 403 ——
 *     delta > 0 归一化为 request_points_bonus 走审批；delta <= 0 → CHILD_CANNOT_DEDUCT。
 *     归一化放在这里而非矩阵，因为「按参数符号分流」是业务逻辑，
 *     塞进矩阵会让矩阵变形为代码（02 §6）。
 *
 * ⚠ 关键约束：本模块与 backend_agent 必须消费**同一张**矩阵。
 *   Agent 侧读由 `npm run contracts:emit` 生成的 contracts/permission-matrix.json。
 *   两条入口各自维护一份 = 必然漂移 = Agent 成为提权通道。
 *
 * ⚠ W0 状态：**签名占位**。验收用例见 02 §9.2 / §9.5 / §9.15 / §9.22。
 */
@Module({})
export class PermissionsModule {}

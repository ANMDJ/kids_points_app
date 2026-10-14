import { SetMetadata } from '@nestjs/common'

import type { ActionType } from '../contracts/permission-matrix'

/** 元数据键。用常量而不是字面量 —— 两处各写错一个字符串，编译器不会互相报错。 */
export const REQUIRED_ACTION_KEY = 'kp:required-action'

/**
 * 声明端点对应的**矩阵动作**（屏障二的输入）。
 *
 *     @Post(':id/decide')
 *     @RequireAction('review_approvals')
 *
 * ── 两个刻意的设计 ──────────────────────────────────────────────────────
 * ① **参数类型是 `ActionType`，不是 `string`**：动作名写错时是**编译错误**，
 *    而不是运行时落到「未知动作」。矩阵对未知动作确实 fail-closed 返回 `DENY`，
 *    但那会让写错的端点表现为 `403` —— 看起来像权限问题，排查方向全错。
 *    能在编译期拦住的，就不要留到运行时。
 *
 * ② **漏标 = 拒绝**（不是放行）：`PermissionsGuard` 找不到本元数据时抛
 *    `403 NO_ACTION_DECLARED`。没有动作声明，Guard 无从判断该拦还是该放 ——
 *    「不知道」必须落在**拒绝**一侧（本仓库头号教训：默认放行就是提权，
 *    见 README「一条不会失败的测试器等于没有测试器」）。
 *
 * 与 `02` §2 的关系：本装饰器**不携带**判定，只携带"这是哪个动作"。
 * 判定永远只有一处 —— `PERMISSION_MATRIX`。若在这里塞白名单，
 * 就等于给矩阵开第二个事实源。
 */
export function RequireAction(action: ActionType): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRED_ACTION_KEY, action)
}

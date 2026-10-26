import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { isConsentGatedAction } from '../contracts/consent-policy'
import type { ActionType } from '../contracts/permission-matrix'
import type { RequestWithActor } from '../permissions/actor'
import { REQUIRED_ACTION_KEY } from '../permissions/require-action.decorator'
import { CONSENT_REPOSITORY, type ConsentPort } from './consent.repository'

/**
 * 屏障四 · **同意闸门**（W7-A，2026-10-26）——
 * 「撤回同意后全链路写入停止」的唯一执行点（PRD FR-12 / `04` §5）。
 *
 *     请求 → [身份] → [成员资格] → [矩阵+收紧] → **[本 Guard：这个孩子现在有有效同意吗]** → 业务层
 *
 * ── 为什么必须是 Guard，而不是在各 service 里各写一次 ────────────────────────
 *   「撤回后停止写入」的覆盖面是**全部写端点**（24 个动作，见
 *   `contracts/consent-policy.ts`）。在 service 里各写一次，就等于有 24 个
 *   可能忘记更新的地方；而漏掉的那一个**看起来完全正常**（HTTP 200，
 *   数据写入成功）—— 这正是本仓库反复强调的"不会失败的失败"。
 *   放在 Guard + 一份穷举清单，新增端点若忘了分类会被 `consent-policy.test.ts` 点名。
 *
 * ── 顺序：**必须排在 PermissionsGuard 之后** ────────────────────────────────
 *   ① 权限拒绝比同意状态更根本（先回答「你准不准做」，再回答「现在能不能做」）；
 *   ② 本 Guard 需要 `@RequireAction` 元数据，且**只在放行到业务层之前**才有意义；
 *   ③ 顺序反了不会静默失效，但会让「孩子越权调家长动作」白查一次库 ——
 *      不致命，仍然按正确的顺序挂：`…, PermissionsGuard, ConsentGuard`。
 *
 * ── 三处 fail-closed ───────────────────────────────────────────────────────
 *   ① **漏标 `@RequireAction` ⇒ 抛错（500）**：与控制器的装配约定不符
 *      （PermissionsGuard 已先一步 403 了，能走到这里说明装配被改坏）；
 *   ② **`kpChildId` / `kpActor` 缺失 ⇒ 抛错（500）**：那是身份层没跑。
 *      绝不默认「没有孩子 ⇒ 跳过检查」；
 *   ③ **`status` 既不是 `granted` 也不是 `withdrawn` / `none` ⇒ 拒绝**（见下）。
 *
 * ── 关于 `none`（从未同意）也拦 —— 这是**故意的**，且要知道它的上线代价 ──────
 *   `none` 不读作「老用户，免检」，也不读作「等于同意」。它读作
 *   **「没有任何同意证据」**，而「没有证据」与「证据说可以」不是同一件事。
 *   代价是真实的：存量家庭在升级后**第一次写操作会被 403 `CONSENT_REQUIRED`**，
 *   直到家长在同意页勾选一次。这是必须付的代价 ——
 *   自动补一条"同意"记录等于伪造合规事实（比 403 糟得多）。
 *   客户端的处理方式固定：收到 `details.status = 'none'` ⇒ 首次同意引导页；
 *   `'withdrawn'` ⇒ 重新同意页（文案不同，见 `04` §5）。
 *
 * ── 无库装配时为什么不放行 ─────────────────────────────────────────────────
 *   `NotImplementedConsentRepository` 会抛 **501**，本 Guard **原样传播**。
 *   绝不在 catch 里 `return true` —— 「查不到」永远不等于「没有限制」。
 */
@Injectable()
export class ConsentGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CONSENT_REPOSITORY) private readonly repository: ConsentPort
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<ActionType | undefined>(REQUIRED_ACTION_KEY, [
      context.getHandler(),
      context.getClass()
    ])

    // ① 装配错误：本 Guard 只应出现在已声明动作的端点之后
    if (action === undefined) {
      throw new Error(
        'ConsentGuard 执行时找不到 @RequireAction 元数据：它必须排在 PermissionsGuard 之后、' +
          '且只能挂在声明了动作的端点上。'
      )
    }

    // 读路径 / 行使权利 / 恢复同意 —— 不查库、直接放行（清单见 consent-policy.ts）
    if (!isConsentGatedAction(action)) return true

    const req = context.switchToHttp().getRequest<RequestWithActor>()

    // ② 身份层未就绪 ⇒ 响亮失败（绝不当作"没有孩子 ⇒ 免检"）
    if (req.kpActor === undefined) {
      throw new Error(
        `ConsentGuard 执行时 req.kpActor 为空（动作 ${action}）：身份 Guard 未运行或顺序颠倒。`
      )
    }
    const childId = req.kpChildId
    if (childId === undefined) {
      throw new Error(
        `ConsentGuard 执行时 req.kpChildId 为空（动作 ${action}）：` +
          '孩子上下文没解析，无法判断该问谁的同意 —— 拒绝放行。'
      )
    }

    const state = await this.repository.readState(childId)

    // ③ 只有明确的 granted 才放行
    if (state.status !== 'granted') {
      throw new ForbiddenException({
        code: 'CONSENT_REQUIRED',
        message:
          state.status === 'withdrawn'
            ? '监护人已撤回同意，写入已停止（读取与导出不受影响）。重新同意后才能继续。'
            : '这个档案还没有监护人同意记录，写入已被暂停。请监护人先完成同意。',
        details: {
          // 客户端据此区分两个文案：首次同意 / 重新同意
          status: state.status,
          consentVersion: state.consentVersion,
          withdrawnAt: state.withdrawnAt,
          action
        }
      })
    }

    return true
  }
}

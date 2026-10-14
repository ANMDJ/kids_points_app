import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { resolveVerdict, type ActionType } from '../contracts/permission-matrix'
import type { RequestWithActor } from './actor'
import { REQUIRED_ACTION_KEY } from './require-action.decorator'

/**
 * 屏障二 · 权限矩阵的**唯一消费点**（`02` §3）。
 *
 *     请求 → [身份 Guard 填 actor] → [本 Guard 查矩阵] → 业务层
 *
 * ── 它存在的意义 ────────────────────────────────────────────────────────
 *   `PERMISSION_MATRIX` 此前**没有任何调用者**（`resolveVerdict` 只在单测里被调）。
 *   一个没人消费的权限表＝事实上的注释：它不会阻止任何事。
 *   本 Guard 把它接上线上路径，且**只查表、不藏名单** ——
 *   这里出现任何 `role === 'guardian'` 都会立刻让矩阵变成第二事实源。
 *
 * ── 四处 fail-closed（每一处都对应一种"看起来在做安全"的失败）────────────
 *   ① **漏标 `@RequireAction` ⇒ 403**，不是放行 —— 「不知道该怎么判」必须落在拒绝一侧；
 *   ② **`kpActor` 缺失 ⇒ 抛错（500）**，不是默认角色 —— 默认 `guardian` 是提权，
 *      默认 `child` 是另一种撒谎（见 temporary-role.guard.ts）；这通常意味着
 *      **Guard 顺序颠倒**（见下方"顺序"）；
 *   ③ **`viewer` / 未知动作 ⇒ `DENY`** —— 由 `resolveVerdict()` 保证（D6 裁定）；
 *   ④ **`REQUIRE_APPROVAL` 默认也是拒绝（403 `APPROVAL_REQUIRED`）** —— 见下方说明。
 *
 * ── 为什么 `REQUIRE_APPROVAL` 不直接放行（④ 的展开）──────────────────────
 *   设计上它是「应当转为审批请求」（`02` §3：202 + 建 `ApprovalRequest`）。
 *   但**本 Guard 放行、业务层忘了建审批**的后果是「静默直接执行」——
 *   即：一个需要家长点头的动作，悄悄生效了。这是最难发现的一类失败
 *   （HTTP 200，一切都"成功"）。所以这里**不放行**，而是明确回
 *   `403 APPROVAL_REQUIRED`。将来第一个真正会建审批的端点（如孩子 `add_wish`）
 *   落地时，必须**显式**引入一个 opt-in 声明（例如 `@HandledByApprovalFlow()`）
 *   并在用例里证明"确实建了审批"，而**不是**把这里改成放行。
 *
 * ── 顺序（③ 的根因，实测过的坑）─────────────────────────────────────────
 *   Nest 的 Guard 执行顺序是 **全局 → 控制器 → 方法**。因此本 Guard **不能**用
 *   `APP_GUARD` 全局注册：那样它会**先于**控制器级挂载的身份 Guard 执行，
 *   `kpActor` 必然还是空的（② 会立刻抛错）。
 *   正确写法是同一层级内按数组顺序：
 *
 *       @UseGuards(TemporaryRoleHeaderGuard, PermissionsGuard)   // 身份在前，判定在后
 *
 *   `permissions-guard.test.ts` 里有一条用例覆盖"身份未就绪即响亮失败"，
 *   免得将来有人把它改成全局注册后**静默**退化成 500 噪音。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  // 显式 `@Inject`：与 `ApprovalsService` 同一口径 —— 不依赖 `emitDecoratorMetadata`
  // （tsx / esbuild 不产出它，靠它注入会在换加载器时静默失败）。
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.getAllAndOverride<ActionType | undefined>(REQUIRED_ACTION_KEY, [
      context.getHandler(),
      context.getClass()
    ])

    // ① 漏标 ⇒ 拒绝
    if (action === undefined) {
      throw new ForbiddenException({
        code: 'NO_ACTION_DECLARED',
        message:
          '端点没有声明 @RequireAction(...)：屏障二无从判定该动作，按拒绝处理（fail-closed）。' +
          '「不知道」永远不能落在放行一侧。'
      })
    }

    const req = context.switchToHttp().getRequest<RequestWithActor>()

    // ② 身份未就绪 ⇒ 响亮失败（绝不落到默认角色）
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error(
        `PermissionsGuard 执行时 req.kpActor 为空（动作 ${action}）：身份 Guard 未运行或顺序颠倒。` +
          '正确写法：@UseGuards(<身份 Guard>, PermissionsGuard) —— 顺序不能反，' +
          '也绝不能因此退化成"默认角色"。'
      )
    }

    // ③ 屏障二：查矩阵（viewer / 未知动作在 resolveVerdict 内已 DENY）
    const verdict = resolveVerdict(action, actor.role)

    // ④ 需要审批却无人处理 ⇒ 拒绝（不是放行 —— 见类注释 ④）
    if (verdict === 'REQUIRE_APPROVAL') {
      throw new ForbiddenException({
        code: 'APPROVAL_REQUIRED',
        message:
          `动作 ${action} 对角色 ${actor.role} 需要审批（矩阵 REQUIRE_APPROVAL），` +
          '但该端点未声明它会把请求转成审批 —— 直接放行等于「需要点头的事悄悄生效」，故拒绝。'
      })
    }

    // ⑤ 矩阵拒绝 ⇒ 403
    if (verdict === 'DENY') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: `动作 ${action} 对角色 ${actor.role} 不被允许（矩阵 ${action}.${actor.role} = DENY）。`
      })
    }

    // 落到这里只可能是 ALLOW。把判定结果留在请求上，供业务层读取（见 actor.ts 的说明）。
    req.kpVerdict = verdict
    return true
  }
}

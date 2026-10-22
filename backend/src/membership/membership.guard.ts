import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  type CanActivate,
  type ExecutionContext
} from '@nestjs/common'

import type { RequestWithActor } from '../permissions/actor'
import {
  MemberRowShapeError,
  clampRoleToMembership,
  resolveMembership,
  toMembership,
  type Membership
} from './membership.gate'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from './membership.repository'

/**
 * 屏障一 · 成员资格门的**唯一消费点**（`02` §3）。
 *
 *     请求 → [身份 Guard 填 actor] → **[屏障一：本 Guard]** → [屏障二/三：PermissionsGuard] → 业务层
 *
 * ── 它存在的意义 ────────────────────────────────────────────────────────
 *   `MembershipModule` 此前是**空壳**（W0 的签名占位，全仓零调用者）：
 *   "这个人跟这个孩子有没有关系"从来没被问过。于是**任何**带着合法角色头的请求
 *   都能对**任何** childId 走权限矩阵 —— 矩阵判的是"角色能不能做这件事"，
 *   它**无权回答**"这个角色跟这个孩子有没有关系"（那是两件事，见 gate 文件头）。
 *
 * ── 三处 fail-closed（每一处都对应一种"看起来在做安全"的失败）──────────────
 *   ① **`kpActor` 缺失 ⇒ 抛错（500）** —— 身份 Guard 未运行/顺序颠倒。绝不默认角色
 *      （默认 `guardian` 是提权）。同一口径见 `permissions.guard.ts` ②。
 *   ② **`kpChildId` 缺失 ⇒ 抛错（500）** —— 身份 Guard 没给出"对哪个孩子"。
 *      ★ 绝不能退化成"那就跳过成员检查"：那会让整道屏障变成可选。
 *      正常情况下这条**永远不该发生**（临时身份 Guard 强制要求该头，见其文件头），
 *      所以它出现即**装配漏了**，必须响亮。
 *   ③ **`MEMBER_NOT_FOUND` / `MEMBER_REMOVED` ⇒ 403** —— 由纯内核 `resolveMembership()`
 *      给出（`null` 与任何非 `active` 状态都在拒绝一侧）。
 *
 * ── 顺序（不能与 02 §3 反着来）─────────────────────────────────────────
 *   屏障一必须先于屏障二：矩阵要按**角色**查表，而"角色"在这条链上的合法性
 *   来自成员位（`ChildMember.role`）；先查矩阵再查资格，非成员就会先收到
 *   "角色不被允许"这种**含义错误**的 403。
 *   Nest 的 Guard 顺序：全局 → 控制器 → **同一层级按数组顺序**，故控制器上写
 *   `@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)`。
 *
 * ⚠️ 诚实标注（与"已完成"分开记）：本 Guard **接线是真的、判定是真的、403 是真的**，
 *   且（W2-D，2026-10-16）**查询也已经是真的** —— `MembershipModule.register()` 在有库时
 *   绑定 `PrismaMembershipRepository`（真查 `ChildMember`），无库时仍是显式 501
 *   （fail-closed）。⇒ "这个人跟这个孩子有没有关系"在**两个世界里都问得出口**，
 *   且两个世界的答案都不会是"跳过检查"。
 */
@Injectable()
export class MembershipGuard implements CanActivate {
  // 显式 `@Inject`：与 `ApprovalsService` / `PermissionsGuard` 同一口径 ——
  // 不依赖 `emitDecoratorMetadata`，令牌改名时编译期就能发现。
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly port: MembershipPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithActor>()

    // ① 身份未就绪 ⇒ 响亮失败
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error(
        'MembershipGuard 执行时 req.kpActor 为空：身份 Guard 未运行或顺序颠倒。' +
          '正确写法：@UseGuards(<身份 Guard>, MembershipGuard, PermissionsGuard)。'
      )
    }

    // ② 孩子上下文缺失 ⇒ 响亮失败（不是"跳过成员检查"）
    const childId = req.kpChildId
    if (childId === undefined) {
      throw new Error(
        'MembershipGuard 执行时 req.kpChildId 为空：身份 Guard 没有提供"对哪个孩子"，' +
          '屏障一无从判定资格。★ 绝不允许因此跳过检查 —— 那会把整道屏障变成可选。'
      )
    }

    // ③ 资格判定（纯内核）：查不到 ⇒ MEMBER_NOT_FOUND，非 active ⇒ MEMBER_REMOVED
    const row = await this.port.findMembership(childId, actor.userId)
    const verdict = resolveMembership(row)
    if (verdict.kind === 'DENY') {
      throw new ForbiddenException({
        code: verdict.code,
        message:
          verdict.code === 'MEMBER_NOT_FOUND'
            ? `用户 ${actor.userId} 不是孩子 ${childId} 的成员（无成员位）—— 屏障一（02 §3 / §9.21）。`
            : `用户 ${actor.userId} 与孩子 ${childId} 的成员位已失效（status ≠ active）—— 屏障一（02 §3 / §9.21）。`
      })
    }

    // ④ 形状把关：不合格 ⇒ 500（数据/实现的问题，**不是**权限问题 —— 见 gate 文件头）
    let membership: Membership
    try {
      membership = toMembership(verdict.row)
      req.kpMember = membership
    } catch (err) {
      if (err instanceof MemberRowShapeError) {
        throw new InternalServerErrorException({ code: err.code, message: err.message })
      }
      throw err
    }

    // ⑤ 角色收口（W5-H）：矩阵查表用的角色 = min(会话角色, 成员位角色)。
    //   降级会同时收回会话（同一事务），这里再收一次 —— 使"被降级的人仍是家长"
    //   不可能由**漏掉某条写路径**造成。理由见 `clampRoleToMembership()` 的注释。
    const effectiveRole = clampRoleToMembership(actor.role, membership.role)
    if (effectiveRole !== actor.role) {
      req.kpActor = { ...actor, role: effectiveRole }
    }

    return true
  }
}

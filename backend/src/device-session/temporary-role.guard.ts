import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext
} from '@nestjs/common'

import type { Role } from '../contracts/permission-matrix'
import type { Actor, RequestWithActor } from '../permissions/actor'

/**
 * ⚠️ **临时**角色来源（W1 之前）—— 后续由 `DeviceSession.activeRole` 取代（`02` §7）。
 *
 * ── 为什么它不是「可选的偷懒」──────────────────────────────────────────────
 *   HTTP 路径必须知道「**谁**在请求」，否则 `canReview()` / `canSelfApprove()` 无从判定。
 *   而 W1（身份与权限）尚未落地：没有登录、没有 `DeviceSession`、没有 PIN 校验。
 *   本 Guard 让审批路径**今天就可用、可测**，同时把风险关进三条闸门：
 *     ① **必须显式带** `x-kp-role` 与 `x-kp-user-id`：缺任一个 → **401**。
 *        绝不默认成 `guardian`（默认放行是提权，默认 `child` 是另一种撒谎）；
 *     ② 角色取值**白名单** `guardian / child / viewer`，其余 → 401；
 *     ③ `NODE_ENV === 'production'` → **503**：这条口径**禁止**上生产 ——
 *        免得「先这样跑起来」的临时物被忘在这里，变成客户端可自选角色的后门。
 *
 *   W1 到位后：本文件**删除**，改用 DeviceSession 解析出来的 actor；
 *   届时 `approvals-http.test.ts` 里「生产环境 503」那条用例会随之改写成「无会话 → 401」。
 */
export const ROLE_HEADER = 'x-kp-role'
export const USER_ID_HEADER = 'x-kp-user-id'

/**
 * ⚠️ 类型已迁出（W1-A，2026-10-14）：`Actor` / `RequestWithActor` 现在定义在
 *    `src/permissions/actor.ts` —— 它们不是「临时头」的私有物，屏障一／屏障二
 *    与各 service 都要用；留在本文件里会让 W1 删除临时 Guard 时连带牵动整个审批模块
 *    （类型搬家与行为变更混进同一个 diff）。本文件自此只负责**一件事**：
 *    「在没有真实身份之前，临时怎么造出一个 actor」。
 */

const KNOWN_ROLES: readonly (Role | 'viewer')[] = ['guardian', 'child', 'viewer']

function isKnownRole(value: string): value is Role | 'viewer' {
  return (KNOWN_ROLES as readonly string[]).includes(value)
}

/**
 * 取单值头。**重复头（数组）一律视为未提供** —— 拼接 / 取首值都会让
 * 「客户端说自己是 guardian、同时又说自己是 child」这类输入产生歧义，
 * 而歧义的下一步通常是「随便挑一个」，即不可预测的权限。
 */
function singleHeader(req: RequestWithActor, name: string): string | undefined {
  const raw = req.headers[name]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

@Injectable()
export class TemporaryRoleHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException({
        code: 'IDENTITY_NOT_IMPLEMENTED',
        message:
          '身份与权限（W1）尚未落地：临时角色头在生产环境被禁用（见 temporary-role.guard.ts）。'
      })
    }

    const req = context.switchToHttp().getRequest<RequestWithActor>()
    const role = singleHeader(req, ROLE_HEADER)
    const userId = singleHeader(req, USER_ID_HEADER)
    if (role === undefined || userId === undefined || !isKnownRole(role)) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message:
          `缺少或非法的身份头：${USER_ID_HEADER} / ${ROLE_HEADER}（W1 之前为临时口径，取值仅限 guardian / child / viewer）。`
      })
    }

    // 显式标注：这里产出的正是三道屏障共同消费的 `Actor`（定义已迁至 permissions/actor.ts）。
    // 将来身份来源换成 `DeviceSession` 时，这个注解会让类型不匹配在**编译期**暴露。
    const actor: Actor = { userId, role }
    req.kpActor = actor
    return true
  }
}

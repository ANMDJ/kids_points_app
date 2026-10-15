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
 *     ① **必须显式带** `x-kp-role`、`x-kp-user-id`、`x-kp-child-id`：缺任一个 → **401**。
 *        绝不默认成 `guardian`（默认放行是提权，默认 `child` 是另一种撒谎）；
 *        `x-kp-child-id` 同理**不许默认**到"随便哪个孩子"（W1-B 起必需 —— 屏障一要知道
 *        资格是对**哪个孩子**判的；见 CHILD_ID_HEADER 的说明）；
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
 * ★ W1-B（2026-10-15）新增：**孩子上下文**的临时替身。
 *
 * 为什么必须现在就有：屏障一（成员资格门）问的是
 * `ChildMember(childId, userId).status === 'active'` —— 没有 childId，这道门**问不出问题**。
 * 而 childId 在最终设计里**来自会话**（`DeviceSession(deviceId, childId, …)`，`02` §7），
 * 不是请求体：让客户端在 body 里自报 childId 才能省掉这个头，但那会让"对哪个孩子"
 * 变成可被伪造的输入（屏障一随即退化成"你是不是**某个**孩子的成员"）。
 * 故这里加一个与 `x-kp-role` / `x-kp-user-id` **同源的临时头**，
 * W1-C 的 `DeviceSession` 到位后**三个头一起删**。
 *
 * 缺失时由本 Guard 统一判 **401**（"身份不完整"），而不是留给下游去"跳过检查"——
 * 后者等于把屏障一变成可选（见 MembershipGuard 的 ②）。
 */
export const CHILD_ID_HEADER = 'x-kp-child-id'

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
    // ★ W1-B：孩子上下文也在这里要求 —— 「谁」与「对哪个孩子」共同构成"身份完整"。
    const childId = singleHeader(req, CHILD_ID_HEADER)
    if (
      role === undefined ||
      userId === undefined ||
      childId === undefined ||
      !isKnownRole(role)
    ) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message:
          `缺少或非法的身份头：${USER_ID_HEADER} / ${ROLE_HEADER} / ${CHILD_ID_HEADER}` +
          '（W1 之前为临时口径，角色取值仅限 guardian / child / viewer）。' +
          '★ 三个头**都**必需：少了孩子上下文，屏障一（成员资格门）无从判定 —— ' +
          '这里判 401 而不是让下游"跳过检查"，是因为跳过等于把屏障一变成可选。'
      })
    }

    // 显式标注：这里产出的正是三道屏障共同消费的 `Actor`（定义已迁至 permissions/actor.ts）。
    // 将来身份来源换成 `DeviceSession` 时，这个注解会让类型不匹配在**编译期**暴露。
    const actor: Actor = { userId, role }
    req.kpActor = actor
    // 孩子上下文单独放：它不是 `Actor` 的一部分（`Actor` = 谁 + 角色），
    // 而是**这次请求作用在哪个孩子身上**（屏障一的输入）。
    req.kpChildId = childId
    return true
  }
}

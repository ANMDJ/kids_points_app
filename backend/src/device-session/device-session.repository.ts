import { Injectable, NotImplementedException } from '@nestjs/common'

import type { SessionLookupRow } from './session.gate'

/**
 * 设备会话查询的**持久化端口**（端口 / 适配器里的「端口」，`02` §7）。
 *
 * ── 为什么单独一层（而不是让守卫直接 `new PrismaService()`）────────────────
 *   ① 身份判定的内核（`session.gate.ts`）是**纯函数**，它的输入必须能被替身喂进来 ——
 *      否则"过期 ⇒ 回落 child"「客户端自报角色无效」这些用例就得先有真库、真数据，
 *      CI 立刻变得不可移植；
 *   ② 端口的默认实现是**显式 501**（见文件末尾）：W2 之前它**不许**假装读得到会话。
 *      于是"会话查询未落地"是一个**可执行断言**，而不是注释里的一句话
 *      （与 `MEMBERSHIP_REPOSITORY` 完全同口径）。
 *
 * ⚠️ 目前的真实状态：**没有任何实现**（默认实现只会抛 501）。
 *    真 Prisma 适配器属 W2（与 `ApprovalsPort` / `MembershipPort` 的实现同一批，见 `05` §2）。
 */

/** Nest 注入令牌（用 unique symbol 避免字符串撞名）。 */
export const DEVICE_SESSION_REPOSITORY = Symbol('DEVICE_SESSION_REPOSITORY')

export interface DeviceSessionPort {
  /**
   * 查 `(deviceId, childId)` 的会话行。
   *
   * ★ 查不到就返回 `null`，**不抛异常** —— 「没有会话」是**正常分支**，
   *   它对应 401 `SESSION_NOT_FOUND`（由身份守卫决定），而不是"底层出错了"（那才是异常）。
   *
   * ★ `childId` 是**查询键的一部分**，不是过滤器：`DeviceSession` 的唯一约束就是
   *   `@@unique([deviceId, childId])`（一台设备可以对着多个孩子各有一份会话）。
   *   适配器若忽略它（只按 deviceId 查），内核的 `SESSION_CHILD_MISMATCH` 会当场变红 ——
   *   这条守卫是有意留给实现的。
   */
  findSession(deviceId: string, childId: string): Promise<SessionLookupRow | null>
}

/**
 * 默认实现：**一律 501**。
 *
 * ── 为什么默认不是"直接读 Prisma"（与 W1-B 的取舍同理由）──────────────────
 *   ① **会让无库环境在启动阶段就崩**：`DeviceSessionModule` 一旦注入 `PrismaService`，
 *      则任何装配了审批模块的测试（含无 `.env` 的 CI）都会在 `PrismaService` 的构造函数里
 *      因缺 `DATABASE_URL` 而抛错（那里是**刻意**失败的，见其文件头）；
 *   ② 与 `NotImplementedApprovalsRepository` / `NotImplementedMembershipRepository`
 *      同一口径：未落地的路径**必须响亮**。
 *
 * ⚠️ 代价同样写清楚（不粉饰）：**默认装配下，身份层对每个请求返回 501**
 *    （fail-closed —— 比"拦不住"强，但它也**还没有真的查过库**，甚至还没有真正的登录）。
 */
@Injectable()
export class NotImplementedDeviceSessionRepository implements DeviceSessionPort {
  private fail(deviceId: string, childId: string): never {
    throw new NotImplementedException({
      code: 'SESSION_LOOKUP_NOT_IMPLEMENTED',
      message:
        `设备会话查询尚未落地：findSession(${deviceId}, ${childId}) 没有实现。` +
        '身份判定**已接线**（TTL 回落 child、角色白名单、childId 同源校验都有用例），' +
        '但"这台设备现在是谁"目前读不到 —— 所以这里**拒绝**而不是放行：' +
        '放行等于把身份层整个跳过（fail-closed）。'
    })
  }

  findSession(deviceId: string, childId: string): Promise<SessionLookupRow | null> {
    return Promise.resolve(this.fail(deviceId, childId))
  }
}

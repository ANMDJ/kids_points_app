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
 * ✅ **真实现已落地（W2-D，2026-10-16）**：同目录 `device-session.prisma.repository.ts`
 *    （`PrismaDeviceSessionRepository`），由 `DeviceSessionModule.register()` 在**有库**时绑定。
 * ⚠️ 本文件末尾那个 501 实现**仍然有用**：无 `DATABASE_URL` 的装配（CI / `npm test`）走它 ⇒
 *    "身份层还没查过库"在那种世界里依然是一个**可执行断言**，而不是注释里的一句话。
 *    `ApprovalsPort` 的真实现仍未落地（见 `05` §2）。
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
 * **无库装配**时的实现：**一律 501**。
 *
 * ── 为什么它现在还在（W2-D 之后，写清楚免得被当成"忘了删"）────────────────────
 *   ① **有库时不再走它**：`DeviceSessionModule.register()` 在 `hasDatabaseUrl()` 为真时绑
 *      `PrismaDeviceSessionRepository`（见 `device-session.prisma.repository.ts`）；
 *   ② **无库时必须走它**：`PrismaService` 的构造函数在缺 `DATABASE_URL` 时**刻意**抛错，
 *      所以无库装配**不能**硬导 `PrismaModule`（否则任何离线用例在装配阶段就崩）。
 *      而"没有实现"这件事在无库世界里必须**响亮** —— 501 是一条可执行断言，
 *      静默 no-op 会让"身份层没落地"变成看不见的状态（B6 同族的病）；
 *   ③ 与 `NotImplementedApprovalsRepository` / `NotImplementedMembershipRepository`
 *      同一口径：未落地的路径**必须响亮**。
 *
 * ⚠️ 代价同样写清楚（不粉饰）：**无库装配下，身份层对每个请求返回 501**
 *    （fail-closed —— 比"拦不住"强；但也别把这条当成"身份层已完成"）。
 */
@Injectable()
export class NotImplementedDeviceSessionRepository implements DeviceSessionPort {
  private fail(deviceId: string, childId: string): never {
    throw new NotImplementedException({
      code: 'SESSION_LOOKUP_NOT_IMPLEMENTED',
      message:
        `当前进程没有 DATABASE_URL（无库装配）⇒ 设备会话查询不可用：findSession(${deviceId}, ${childId}) 没有实现。` +
        '身份判定**已接线**（TTL 回落 child、角色白名单、childId 同源校验都有用例）；' +
        '有库装配走的是 PrismaDeviceSessionRepository（真查 DeviceSession）；' +
        '这里**拒绝**而不是放行：放行等于把身份层整个跳过（fail-closed）。'
    })
  }

  findSession(deviceId: string, childId: string): Promise<SessionLookupRow | null> {
    return Promise.resolve(this.fail(deviceId, childId))
  }
}

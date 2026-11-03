import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'
import type { DeviceSessionPort } from './device-session.repository'
import type { SessionLookupRow } from './session.gate'

/**
 * 设备会话端口的 **Prisma 适配器**（W2-D，2026-10-16）—— `DeviceSessionPort` 的真实现。
 *
 * ── 它与内核的分工（一句话）───────────────────────────────────────────────
 *   内核（`session.gate.ts`）回答"**这台设备现在是谁**"（纯函数、可离线穷举）；
 *   本文件回答"**怎么把那一行读出来**"：用哪个键查、读哪几列。
 *   判定一律留在内核 —— 这里**再判一次**是禁止的（两套判定迟早漂移，与账本适配器同一条纪律）。
 *
 * ── ★ 本文件的全部要点就是**查询键**（W1-C 埋在这里的那条守卫）────────────────
 *   唯一约束是 `@@unique([deviceId, childId])`（一台设备可以对着多个孩子各有一份会话）
 *   ⇒ 这里必须用**复合唯一键** `deviceId_childId` 查：
 *
 *     ✅ findUnique({ where: { deviceId_childId: { deviceId, childId } } })
 *     ❌ findFirst({ where: { deviceId } })   ← 编译得过，但 childId 退化成了"过滤器"
 *
 *   为什么第二种最危险：它**看起来**在读同一个东西，但 `(device, childA)` 的会话会被
 *   `(device, childB)` 的请求命中 ⇒ 内核的 `SESSION_CHILD_MISMATCH` 当场变红（那是它存在的理由）；
 *   而若有人"顺手"把那条校验放宽，客户端选的 childId 就变成可以乱填的东西 ——
 *   「在哪个孩子的档案上」这一半身份又回到客户端手里。
 *   用复合键查，这种错**在类型层面**就不可能（`@@unique` 变了 ⇒ 编译期就报）。用例两处都钉：
 *     · 离线 `test/device-session-wiring.test.ts` —— 替身 Prisma 收下的 `where` 必须是复合键；
 *     · 真库 `test-db/identity-db.dbtest.ts` —— 同一 deviceId 在**另一个孩子**上必须是 `null`。
 *
 * ── 三处"不判"（都是刻意的）────────────────────────────────────────────────
 *   ① **不**在 SQL 里加 `expiresAt > now()`：TTL 到期是**降级**（guardian ⇒ child，`02` §9.19），
 *      不是"查不到"。一旦在查询里筛掉过期行，"过期 ⇒ 回落 child"这条已定口径就永远
 *      不会发生（全会变成 401 `SESSION_NOT_FOUND`）—— 把一条语义实现成了另一种行为；
 *   ② **不**筛 `activeRole`：库里存了枚举外的角色时，内核给 **500**（数据/实现问题）；
 *      这里筛掉它只会让它变成一次"查不到会话"的 401（数据病伪装成权限病，D3b 同族的病）；
 *   ③ **不**把"查不到"抛成异常：`null` 是**正常分支**（守卫翻成 401），
 *      抛 404 会把"这台设备没登录"变成一次服务端故障。
 *
 * ── ✅ 接线状态（W2-D）────────────────────────────────────────────────────
 *   `DeviceSessionModule` 已改成**动态模块**：`register()` 按 `hasDatabaseUrl()`
 *   （`prisma/database-enabled.ts`，判据只有一处）分叉 —— 有库 ⇒ 本文件；无库 ⇒ 显式 501。
 *   于是"身份层已接线、却**从没真的查过库**"这件事结束了。
 *   两端各有一半证据（缺一不可）：离线用例管"装配**声明**了什么"，真库用例管"**接了库真的通**"。
 *
 *   ⚠️ 仍未落地（与上面严格分开记）：**会话刷新**（`02` §7「每次 guardian 操作刷新 TTL」）
 *      与 **PIN 切换**（§9.18）仍无端点 ⇒ `expiresAt` / `pinHash` 现在只有读的一方，
 *      **没有人写**它们；`x-kp-device-id` 也仍然可被伪造（生产 503 保留，见 guard ④）。
 */
@Injectable()
export class PrismaDeviceSessionRepository implements DeviceSessionPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查 `(deviceId, childId)` 的会话行；查不到 ⇒ `null`。
   *
   * `select` 只取 `SessionLookupRow` 的那六列（**恰好**是内核要用的；W14 起
   * 第六列是 `kidModeUntil` —— 少读它 ⇒ 孩子模式静默失效）：
   * 少读一列 ⇒ 形状校验在运行时缺字段；多读几列 ⇒ 把 `id` / `issuedAt` 这类内部字段
   * 顺手带进请求上下文（actor 的来源必须窄，宁可多写一行 select）。
   */
  async findSession(deviceId: string, childId: string): Promise<SessionLookupRow | null> {
    // ★ 复合唯一键：两个参数都是**查询键**（见文件头）。
    //   `expiresAt` 原样返回："过期 ⇒ 回落 child"由内核的 `effectiveRole()` 判，不在这里筛。
    return this.prisma.deviceSession.findUnique({
      where: { deviceId_childId: { deviceId, childId } },
      select: {
        deviceId: true,
        childId: true,
        userId: true,
        activeRole: true,
        expiresAt: true,
        // W14（2026-11-03）：孩子模式的降级判定要用它。少读这一列 ⇒ 内核把
        // `undefined` 当成"没开孩子模式"⇒ 孩子直接拿到家长权限（静默提权）。
        kidModeUntil: true
      }
    })
  }
}

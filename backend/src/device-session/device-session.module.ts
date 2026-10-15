import { Module } from '@nestjs/common'

import { DeviceSessionGuard } from './device-session.guard'
import {
  DEVICE_SESSION_REPOSITORY,
  NotImplementedDeviceSessionRepository
} from './device-session.repository'

/**
 * 设备会话 / 角色模式切换（docs/design/02 §7）
 *
 * ★ 核心原则：**客户端不可信**。
 *   `activeRole` 由服务端 `DeviceSession` 持有，而非小程序 storage ——
 *   否则改一下小程序 storage 即可把自己提权成家长。
 *   服务端持有，才能让「家长模式」成为**真实的权限提升**，而不是一个 UI 开关。
 *
 * | 规则      | 说明
 * | 默认角色  | `child`（最小权限默认）—— 手机在孩子手里时不能是家长模式
 * | 切 guardian | 需输入 PIN（scrypt 哈希，落在 ChildMember.pinHash）
 * | TTL       | 5 分钟无操作回落 child；每次 guardian 操作刷新
 * | PIN 错误  | 5 次锁定 15 分钟（防暴力）
 * | 审计      | 每次切换写 AuditLog（含 deviceId）
 *
 * ── 状态（W1-C，2026-10-15）────────────────────────────────────────────
 *   ✅ **已落地**：`DeviceSessionGuard`（身份解析）＋ `session.gate.ts`（判定内核，纯函数）
 *      —— 「我是谁 / 我是什么角色」**由服务端会话行给出**，
 *      客户端只被允许回答「我是哪台设备、在哪个孩子的档案上」。
 *      由此 `temporary-role.guard.ts`（客户端自报角色）**已删除**。
 *   ✅ **TTL 口径**：`guardian` 会话过期 ⇒ **回落 `child`**（§9.19；降级而非 401），
 *      边界（`expiresAt === now` 即过期）在 `session.gate.ts` 一处定死并有用例。
 *   ⛔ **仍未落地**（与本模块"已完成"严格分开记）：
 *      · **查询实现**：`DEVICE_SESSION_REPOSITORY` 的默认实现是**显式 501** ⇒
 *        默认装配下每个请求 fail-closed（比"拦不住"强，但它**确实还没真的查过库**）；
 *        真 Prisma 适配器属 W2（与另两个端口同一批）。
 *      · **切 guardian / PIN 校验 / 锁 15 分钟 / 审计**：没有端点，`pinHash` /
 *        `pinLockedUntil` 目前**无人使用**（§9.18 的验收用例尚无对应路径）。
 *      · **会话刷新**：§7 的「每次 guardian 操作刷新 TTL」要写库 ⇒ 属 W2。
 *      · **凭据认证**：`x-kp-device-id` 仍可被伪造 ⇒ 生产 503（见 guard 的 ④）。
 *
 * ★ `exports` 里**必须**带上 `DEVICE_SESSION_REPOSITORY`：宿主模块
 *   （`ApprovalsModule`）会实例化 `DeviceSessionGuard`，而它的依赖要由**宿主模块**的
 *   注入器解析 —— 只导出 Guard 不导出令牌，会在启动时报
 *   `Nest can't resolve dependencies of the DeviceSessionGuard (?)`。
 *   （W1-B 在 `MembershipModule` 上实测过同一个坑，这里照抄结论。）
 */
@Module({
  providers: [
    DeviceSessionGuard,
    // ★ 默认实现 = 一律 501（见 device-session.repository.ts 的说明）。
    //   W2 落 Prisma 实现时**只换这一行**，guard / controller / 用例都不动。
    { provide: DEVICE_SESSION_REPOSITORY, useClass: NotImplementedDeviceSessionRepository }
  ],
  exports: [DeviceSessionGuard, DEVICE_SESSION_REPOSITORY]
})
export class DeviceSessionModule {}


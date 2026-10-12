import { Module } from '@nestjs/common'

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
 * ⚠ W0 状态：**签名占位**。验收用例见 02 §9.18 / §9.19。
 */
@Module({})
export class DeviceSessionModule {}

import { DynamicModule, Module } from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { ConsentModule } from '../consent/consent.module'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { DeviceTokensController } from './device-tokens.controller'
import { DeviceTokensModule, type DeviceTokensAssemblyOptions } from './device-tokens.module'

/**
 * 设备推送 token 的**路由装配**（W6-A，2026-10-24）。
 *
 * ── 为什么要单独一层 ──────────────────────────────────────────────────────
 *   `DeviceTokensModule`（核心）会被 `NotificationsModule` 导入多次，因此不能带
 *   controller；controller 需要四道屏障（身份 / 成员位 / 矩阵 / 同意），而那些守卫只在
 *   **声明 controller 的模块**的注入器里实例化。所以这一层只做一件事：
 *   把「核 + 四道屏障 + 两条路由」装在一起。
 *
 * ── 谁能调 ────────────────────────────────────────────────────────────────
 *   `manage_device_tokens`：guardian / child **都 ALLOW**（孩子的设备也要能收到推送）；
 *   仍然要过屏障一 —— 已被移出的成员不该再往这个家里登记设备。
 *
 * ── 无库时 ────────────────────────────────────────────────────────────────
 *   守卫链先跑，端口回 501（`DEVICE_TOKENS_PERSISTENCE_NOT_IMPLEMENTED`）。
 *   注意：无库时 `hasDatabase` 必须**向下传给三个依赖模块**，否则它们会各自按环境
 *   推断出另一个答案 —— 同一张图里只能有一个「在哪个世界」。
 */
@Module({})
export class DeviceTokensHttpModule {
  static register(options: DeviceTokensAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: DeviceTokensHttpModule,
      imports: [
        DeviceTokensModule.register({ hasDatabase }),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule,
        // ★ W7-A：同意闸门（登记推送 token = 采集设备信息，属写动作）。
        ConsentModule.register({ hasDatabase })
      ],
      controllers: [DeviceTokensController],
      // 控制器上的 Guard 在本模块注入器里实例化 —— 依赖由上面三个模块 exports 提供。
      providers: [
        DeviceSessionGuard,
        // ★ W7-A：同意闸门（依赖 CONSENT_REPOSITORY 由 ConsentModule.exports 提供）。
        ConsentGuard
      ]
    }
  }
}

import { DynamicModule, Module } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { ConsentController } from './consent.controller'
import { ConsentModule, type ConsentAssemblyOptions } from './consent.module'
import { ConsentService } from './consent.service'

/**
 * 同意的 **HTTP 入口**（W7-A，2026-10-26）——
 * `GET /consent` / `POST /consent` / `POST /consent/withdraw`。
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────────────────
 *   见 `consent.module.ts` 文件头：controller 必须**只声明一次**。
 *   本模块被 `app.module.ts` 导入一次；核心模块被各写模块重复导入。
 *
 * ── 三个 Guard 的实例化位置 ─────────────────────────────────────────────────
 *   `DeviceSessionGuard` 在本模块 `providers` 里显式声明（它依赖
 *   `DEVICE_SESSION_REPOSITORY`，由 `DeviceSessionModule.exports` 提供）；
 *   `MembershipGuard` / `PermissionsGuard` 由各自模块 exports 提供。
 *   `ConsentGuard` **刻意不挂**在本控制器上（见 `consent.controller.ts` 的说明）。
 *
 * ── 无库时 ─────────────────────────────────────────────────────────────────
 *   控制器照常装配，但 `GET /consent` 与两个写端点都会 **501**
 *   （`NotImplementedConsentRepository`）—— 不返回 `status: 'none'` 冒充"没有同意"。
 */
@Module({})
export class ConsentHttpModule {
  static register(options: ConsentAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: ConsentHttpModule,
      imports: [
        ConsentModule.register({ hasDatabase }),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule
      ],
      controllers: [ConsentController],
      providers: [ConsentService, DeviceSessionGuard]
    }
  }
}

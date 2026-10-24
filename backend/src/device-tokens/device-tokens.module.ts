import { DynamicModule, Module, type Type } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { PrismaDeviceTokensRepository } from './device-tokens.prisma.repository'
import {
  DEVICE_TOKENS_REPOSITORY,
  NotImplementedDeviceTokensRepository,
  type DeviceTokensPort
} from './device-tokens.repository'
import { DeviceTokensService } from './device-tokens.service'

/**
 * 设备推送 token 的**核心模块**（W6-A，2026-10-24）—— 只有端口与服务，**没有 controller**。
 *
 * ── 为什么把 controller 拆到 `DeviceTokensHttpModule` ───────────────────────
 *   本模块有两个消费者：HTTP 路由（家长 / 孩子上报 token）与
 *   **推送适配器**（`WebhookPushAdapter` 需要 `listActiveForUser`）。
 *   后者在 `NotificationsModule` 里被实例化，而 `NotificationsModule` 今天已经被
 *   `AppModule` 与 `ApprovalsModule` **各导入一次**。若 controller 也就挂在这里，
 *   同一条路由会被注册多次（Nest 不报错，最后一个生效）—— 一个「看起来有两条路由、
 *   其实谁生效取决于装配顺序」的坑。**没有 controller 的模块可以被安全地导入多次。**
 *
 * ── 世界钉死 ──────────────────────────────────────────────────────────────
 *   有库 ⇒ `PrismaDeviceTokensRepository`；无库 ⇒ 四个方法全 501
 *   （不返回空列表冒充「这个人没有设备」，也不假装登记成功）。
 */
export function resolveDeviceTokensRepositoryClass(
  hasDatabase: boolean
): Type<DeviceTokensPort> {
  return hasDatabase ? PrismaDeviceTokensRepository : NotImplementedDeviceTokensRepository
}

export interface DeviceTokensAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class DeviceTokensModule {
  static register(options: DeviceTokensAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: DeviceTokensModule,
      // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
      imports: hasDatabase ? [PrismaModule] : [],
      providers: [
        DeviceTokensService,
        {
          provide: DEVICE_TOKENS_REPOSITORY,
          useClass: resolveDeviceTokensRepositoryClass(hasDatabase)
        }
      ],
      // 适配器注入的是**端口令牌**，不是服务 —— 推送不需要「谁能做」的业务判断。
      exports: [DeviceTokensService, DEVICE_TOKENS_REPOSITORY]
    }
  }
}

import { DynamicModule, Module, type Type } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { NoopPushAdapter } from './noop-push.adapter'
import { NotificationsController } from './notifications.controller'
import { PrismaNotificationsRepository } from './notifications.prisma.repository'
import {
  NOTIFICATIONS_REPOSITORY,
  NotImplementedNotificationsRepository,
  type NotificationsPort
} from './notifications.repository'
import { NotificationsService } from './notifications.service'
import { PUSH_PORT } from './push.port'

/**
 * 通知（站内 + 推送）—— docs/design/01 §4 / 03 L3
 *
 * ── 两条通道，两种诚实 ────────────────────────────────────────────────────
 *   · **站内**（W5-L，2026-10-23）：`GET /notifications` / `PATCH /notifications/:id/read`。
 *     有库 ⇒ 真读 `Notification` 表；无库 ⇒ 501（不返回空列表冒充「你没有通知」）。
 *   · **推送**（W5-K）：`PUSH_PORT` + `NoopPushAdapter`，渠道未接时如实返回
 *     `provider_not_configured`，**不假装送达**。
 *
 * ── ★ 本模块的唯一不可妥协点 ──────────────────────────────────────────────
 *   通知发送必须在账本事务**之外**。若把通知放进事务，一次推送失败会回滚一笔
 *   已经成立的加分 —— 孩子明明完成了、账却没了（`01` §4 / 02 §9.23）。
 *   反过来，通知失败只意味着「晚一点知道」。
 *
 * ── 世界钉死（与 `MembersModule` 同一手法）───────────────────────────────
 *   有库 ⇒ `PrismaNotificationsRepository`；无库 ⇒ `NotImplemented` 三方法全 501。
 *   `hasDatabase` 由宿主（`app.module.ts` 或 `ApprovalsModule`）**传入**，本模块不
 *   自行推断两遍 —— 同一张图里只能有一个「在哪个世界」的答案。
 *
 * ⚠ 不要在 controller 里直接注入 `PUSH_PORT` / `NOTIFICATIONS_REPOSITORY` ——
 *   业务只能经 `NotificationsService`，否则「失败不外抛 / 超时兜底」会被绕过。
 */
export function resolveNotificationsRepositoryClass(
  hasDatabase: boolean
): Type<NotificationsPort> {
  return hasDatabase ? PrismaNotificationsRepository : NotImplementedNotificationsRepository
}

export interface NotificationsAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class NotificationsModule {
  static register(options: NotificationsAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: NotificationsModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule
      ],
      controllers: [NotificationsController],
      providers: [
        NotificationsService,
        // 控制器上的 Guard 在本模块注入器里实例化 —— 依赖由上面三个模块 exports 提供。
        DeviceSessionGuard,
        { provide: NOTIFICATIONS_REPOSITORY, useClass: resolveNotificationsRepositoryClass(hasDatabase) },
        // ★ 唯一换绑点：接第三方时把 useClass 换成真实 adapter（或改 register(options) 按环境选）。
        //   它**不依赖库**，所以无论有没有库都绑同一个 no-op。
        { provide: PUSH_PORT, useClass: NoopPushAdapter }
      ],
      exports: [NotificationsService, PUSH_PORT]
    }
  }
}



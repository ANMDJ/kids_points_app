import { DynamicModule, Logger, Module, type Type } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { DeviceTokensModule } from '../device-tokens/device-tokens.module'
import {
  DEVICE_TOKENS_REPOSITORY,
  type DeviceTokensPort
} from '../device-tokens/device-tokens.repository'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { NotificationsController } from './notifications.controller'
import { PrismaNotificationsRepository } from './notifications.prisma.repository'
import {
  NOTIFICATIONS_REPOSITORY,
  NotImplementedNotificationsRepository,
  type NotificationsPort
} from './notifications.repository'
import { NotificationsService } from './notifications.service'
import { PUSH_PORT } from './push.port'
import { readWebhookPushConfig, type WebhookPushConfigResult } from './push-webhook.config'
import { createPushAdapter } from './webhook-push.adapter'

/**
 * 通知（站内 + 推送）—— docs/design/01 §4 / 03 L3
 *
 * ── 两条通道，两种诚实 ────────────────────────────────────────────────────
 *   · **站内**（W5-L，2026-10-23）：`GET /notifications` / `PATCH /notifications/:id/read`。
 *     有库 ⇒ 真读 `Notification` 表；无库 ⇒ 501（不返回空列表冒充「你没有通知」）。
 *   · **推送**（W5-K → W6-A，2026-10-24）：`PUSH_PORT`。配置了 `PUSH_WEBHOOK_URL`
 *     ⇒ `WebhookPushAdapter`（读 `DeviceToken` 表、POST 到网关）；
 *     否则 ⇒ `NoopPushAdapter`，如实返回 `provider_not_configured`，**不假装送达**。
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
  /**
   * 推送网关配置。省略 ⇒ 读 `process.env`（生产）；**用例必须显式钉死**，
   * 否则某台开发机上恰好导出了 `PUSH_WEBHOOK_URL` 就会改变断言的结论。
   * 传 `{ kind: 'disabled', reason: 'not_configured' }` 即强制 no-op。
   */
  pushWebhook?: WebhookPushConfigResult
}

@Module({})
export class NotificationsModule {
  static register(options: NotificationsAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    const pushWebhook = options.pushWebhook ?? readWebhookPushConfig(process.env)
    logPushSelection(hasDatabase, pushWebhook)
    return {
      module: NotificationsModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule,
        // ★ W6-A：推送适配器要读设备 token；核心模块无 controller，可被安全多次导入。
        DeviceTokensModule.register({ hasDatabase })
      ],
      controllers: [NotificationsController],
      providers: [
        NotificationsService,
        // 控制器上的 Guard 在本模块注入器里实例化 —— 依赖由上面三个模块 exports 提供。
        DeviceSessionGuard,
        { provide: NOTIFICATIONS_REPOSITORY, useClass: resolveNotificationsRepositoryClass(hasDatabase) },
        // ★ 唯一换绑点（W6-A）：`createPushAdapter` 是三种配置结论的唯一分叉，
        //   生产与用例共用同一函数 —— 测试里另写一份 if/else 就会测到不存在的代码。
        {
          provide: PUSH_PORT,
          useFactory: (tokens: DeviceTokensPort) => createPushAdapter(pushWebhook, tokens),
          inject: [DEVICE_TOKENS_REPOSITORY]
        }
      ],
      exports: [NotificationsService, PUSH_PORT]
    }
  }
}

/**
 * 把「这次推送用的是哪种实现、为什么」写进启动日志。
 *
 * ★ `invalid` 必须用 **error**：它是「配了但配错」，落回 no-op 后表现出来的却是
 *   `provider_not_configured`。若只在装配处 warn 一句，线上排查会绕很大一圈。
 */
function logPushSelection(hasDatabase: boolean, result: WebhookPushConfigResult): void {
  if (result.kind === 'invalid') {
    Logger.error(`推送网关配置无效，已回落到 no-op：${result.reason}`, 'NotificationsModule')
    return
  }
  if (result.kind === 'disabled') {
    Logger.debug('未配置 PUSH_WEBHOOK_URL —— 推送使用 no-op（provider_not_configured）', 'NotificationsModule')
    return
  }
  if (!hasDatabase) {
    // 配置有效但没有库 ⇒ 每次推送都会在读 token 那一步返回 provider_error。
    // 这不是「静默降级」：结果如实报告，但启动时就该让人看见。
    Logger.warn(
      '已配置推送网关，但没有数据库连接 —— 设备 token 读不到，推送必然返回 provider_error',
      'NotificationsModule'
    )
    return
  }
  Logger.log(`推送走 webhook 网关（超时 ${result.config.timeoutMs}ms）`, 'NotificationsModule')
}




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
import { PUSH_DELIVERY_PORT, PUSH_PORT, type PushPort } from './push.port'
import { PushRetryAdapter } from './push-retry.adapter'
import { PUSH_RETRY_CONFIG, readPushRetryConfig, type PushRetryConfig } from './push-retry.config'
import { PushRetryMetrics } from './push-retry.metrics'
import { PrismaPushRetryRepository } from './push-retry.prisma.repository'
import {
  PUSH_RETRY_REPOSITORY,
  NotImplementedPushRetryRepository,
  type PushRetryPort
} from './push-retry.repository'
import { PushRetryWorker } from './push-retry.worker'
import { readWebhookPushConfig, type WebhookPushConfigResult } from './push-webhook.config'
import { createPushAdapter } from './webhook-push.adapter'

/**
 * 通知（站内 + 推送）—— docs/design/01 §4 / 03 L3
 *
 * ── 两条通道，两种诚实 ────────────────────────────────────────────────────
 *   · **站内**（W5-L，2026-10-23）：`GET /notifications` / `PATCH /notifications/:id/read`。
 *     有库 ⇒ 真读 `Notification` 表；无库 ⇒ 501（不返回空列表冒充「你没有通知」）。
 *   · **推送**（W5-K → W6-A → W6-B，2026-10-24）：`PUSH_PORT`。配置了 `PUSH_WEBHOOK_URL`
 *     ⇒ `WebhookPushAdapter`（读 `DeviceToken` 表、POST 到网关）；
 *     否则 ⇒ `NoopPushAdapter`，如实返回 `provider_not_configured`，**不假装送达**。
 *   · **重试**（W6-B）：`PUSH_PORT` = 原始适配器（`PUSH_DELIVERY_PORT`）+ `PushRetryAdapter`
 *     （失败即写 `PushRetryJob`）；`PushRetryWorker` 由 `main.ts` 启动，按退避重发，
 *     超过 TTL 标 `expired`、渠道故障用满次数标 `dead`。**无库 ⇒ 不套装饰器、不启动**。
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

/**
 * 重试队列端口的实现选择 —— 与上面那个函数**同一手法**：
 * 有库 ⇒ 真 `PushRetryJob` 读写；无库 ⇒ 全 501（`enqueue` 的 501 会被
 * `PushRetryAdapter` 吞掉并记 warn，业务请求不受影响）。
 */
export function resolvePushRetryRepositoryClass(hasDatabase: boolean): Type<PushRetryPort> {
  return hasDatabase ? PrismaPushRetryRepository : NotImplementedPushRetryRepository
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
  /**
   * 推送重试配置（W6-B）。省略 ⇒ 读 `process.env`（生产）；
   * 用例必须显式传入，否则本机恰好导出了 `PUSH_RETRY_BATCH=500` 就会改变结论。
   */
  pushRetry?: PushRetryConfig
}

@Module({})
export class NotificationsModule {
  static register(options: NotificationsAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    const pushWebhook = options.pushWebhook ?? readWebhookPushConfig(process.env)
    const pushRetry = options.pushRetry ?? readPushRetryConfig(process.env)
    logPushSelection(hasDatabase, pushWebhook)
    logPushRetrySelection(hasDatabase, pushRetry)
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
        // ★ W6-B：重试队列的持久化端口（无库 ⇒ 501，`enqueue` 的 501 被适配器吞掉）。
        {
          provide: PUSH_RETRY_REPOSITORY,
          useClass: resolvePushRetryRepositoryClass(hasDatabase)
        },
        // ★ W6-B：配置是**值**，不是实现 —— `main.ts` 与 worker 读同一份。
        { provide: PUSH_RETRY_CONFIG, useValue: pushRetry },
        // ★ W6-B：进程内计数（随重启归零；跨实例口径请查 `PushRetryJob` 表）。
        PushRetryMetrics,
        // ★ 唯一换绑点（W6-A）：`createPushAdapter` 是三种配置结论的唯一分叉，
        //   生产与用例共用同一函数 —— 测试里另写一份 if/else 就会测到不存在的代码。
        // ★ W6-B：这是**原始**适配器（只发一次），worker 用它；业务用下面那个。
        {
          provide: PUSH_DELIVERY_PORT,
          useFactory: (tokens: DeviceTokensPort) => createPushAdapter(pushWebhook, tokens),
          inject: [DEVICE_TOKENS_REPOSITORY]
        },
        // ★ W6-B：业务入口 = 原始适配器 + 「失败即入队」。无库时不套装饰器 ——
        //   没有队列可写，套上只会让每一次推送失败都多一条「入队失败」的 warn。
        {
          provide: PUSH_PORT,
          useFactory: (
            delivery: PushPort,
            repository: PushRetryPort,
            config: PushRetryConfig,
            metrics: PushRetryMetrics
          ): PushPort =>
            hasDatabase ? new PushRetryAdapter(delivery, repository, config, metrics) : delivery,
          inject: [PUSH_DELIVERY_PORT, PUSH_RETRY_REPOSITORY, PUSH_RETRY_CONFIG, PushRetryMetrics]
        },
        // ★ W6-B：计时器**不**在这里启动 —— 只有 `main.ts` 调 `start()`
        //   （与 `ApprovalsExpiryService` 同一纪律：`npm test` 不留下 setInterval）。
        PushRetryWorker
      ],
      exports: [NotificationsService, PUSH_PORT, PUSH_DELIVERY_PORT, PUSH_RETRY_CONFIG, PushRetryWorker]
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

/**
 * 重试队列的装配结论（W6-B）。
 *
 * ★ `enabled=false` 用 **warn**：它是「队列存在但不工作」，与「没配网关」不同 ——
 *   失败推送会一直停在 `pending` 直到有人翻 `.env`。悄悄不启动是最糟的默认值。
 */
function logPushRetrySelection(hasDatabase: boolean, config: PushRetryConfig): void {
  if (!config.enabled) {
    Logger.warn(
      `PUSH_RETRY_ENABLED=0 —— 失败推送只入队不重试（worker 不启动）`,
      'NotificationsModule'
    )
    return
  }
  if (!hasDatabase) {
    Logger.warn(
      '推送重试已启用，但没有数据库连接 —— 队列端点为 501，失败推送不会入队',
      'NotificationsModule'
    )
    return
  }
  Logger.log(
    `推送重试队列已装配（每 ${config.intervalMs}ms，批量 ${config.batchSize}，` +
      `TTL ${config.ttlMs}ms，渠道故障上限 ${config.maxAttempts} 次）`,
    'NotificationsModule'
  )
}




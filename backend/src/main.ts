// ★ 必须放在**最前**：NestJS 不会自动读取 .env（未装 @nestjs/config），
//   而 PrismaService 在构造时就要求 DATABASE_URL 存在（缺失即抛错，不静默降级）。
//   没有这一行时 `npm start` 会直接抛「DATABASE_URL 未设置」，即使 .env 就在旁边
//   —— 实测踩到，见 docs/design/06-w0-report.md §2。
import 'dotenv/config'

import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ApprovalsExpiryService } from './approvals/approvals-expiry.service'
import { applyGlobalPipes, logBootstrap } from './app.setup'
import { PushRetryWorker } from './notifications/push-retry.worker'
import { NotificationsReconcileWorker } from './notifications/notifications.reconcile.worker'
import { PushRetryRetentionWorker } from './notifications/push-retry.retention.worker'

/**
 * 入口。
 *
 * 注意：W0 阶段只保证「能启动 + schema 已就绪」。
 * 真正上线前必须先解决 05 §6 的日历型阻塞项：
 *   L1 数据库 ／ L2 微信 AppID 主体认证 ／ L4 域名 + HTTPS + 备案。
 * 其中 L2/L4 是**纯等待时间**（1–7 工作日 / 7–20 工作日），必须在 Day 1 并行启动。
 *
 * 全局管道经 `applyGlobalPipes()` 装配（与 `test/approvals-http.test.ts` **共用**同一函数），
 * 免得「测试里搭的 app」与「真实启动的 app」是两份配置（见 app.setup.ts 的说明）。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)

  // 关闭 Nest 的隐式 200 —— 审批创建必须显式返回 202（见 02 §9.3）。
  applyGlobalPipes(app)

  // 账本写入不可回滚于推送失败 —— 优雅关闭确保事务不被中途切断（01 §4）。
  app.enableShutdownHooks()

  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port)
  logBootstrap(`http://localhost:${port}`)

  // ★ W3-C：审批 TTL 后台扫描（02 §4.3）。计时器在无库装配下自动 no-op；
  //   `enableShutdownHooks()` 已在上方注册，进程退出时 `onApplicationShutdown` 清理计时器。
  app.get(ApprovalsExpiryService).start()

  // ★ W6-B：推送失败重试 worker。`start()` 内部自己判断 `PUSH_RETRY_ENABLED`，
  //   无库时 `PUSH_RETRY_REPOSITORY` 是 501 实现 —— 这里**不**再复写一遍开关条件，
  //   否则「模块装配说的」与「main 说的」会成为两处真相。
  app.get(PushRetryWorker).start()

  // ★ W6-D：对账与保留清理。两者各自判断自己的开关；无库时端口是 501 实现
  //   —— 与上面同一纪律：开关只在一个地方解释。
  app.get(NotificationsReconcileWorker).start()
  app.get(PushRetryRetentionWorker).start()
}

void bootstrap()


// ★ 必须放在**最前**：NestJS 不会自动读取 .env（未装 @nestjs/config），
//   而 PrismaService 在构造时就要求 DATABASE_URL 存在（缺失即抛错，不静默降级）。
//   没有这一行时 `npm start` 会直接抛「DATABASE_URL 未设置」，即使 .env 就在旁边
//   —— 实测踩到，见 docs/design/06-w0-report.md §2。
import 'dotenv/config'

import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { ApprovalsExpiryService } from './approvals/approvals-expiry.service'
import { applyGlobalPipes, logBootstrap } from './app.setup'
import { applyCors } from './cors.setup'
import { FamilyDeletionWorker } from './deletion/deletion.worker'
import { assertAuthBootConfig } from './identity/auth-config'
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
  // ★ W9-A（`40` §9.4）：认证层的启动自检，**必须在建 app 之前**。
  //   它只判会成为**洞**的配置：生产环境开着 `AUTH_DEVICE_ID_FALLBACK=1`
  //   （把客户端自报的 `x-kp-device-id` 当凭据用）⇒ 抛错，进程不该起来。
  //   放在 `NestFactory.create` 之前而不是之后：起得来的 app 会先监听端口，
  //   而"先对公网开放、再因为配置崩掉"这一段正是配置错误最贵的时候。
  assertAuthBootConfig()

  const app = await NestFactory.create(AppModule)

  // 关闭 Nest 的隐式 200 —— 审批创建必须显式返回 202（见 02 §9.3）。
  applyGlobalPipes(app)

  // ★ W10-A：Flutter Web 版跑在 `http://localhost:<随机端口>`，接口在
  //   `http://127.0.0.1:3000` ⇒ 跨源 + 预检。没有这一步时浏览器**不会发出**
  //   真正的请求，客户端只能看到「连不上服务器」（`cors.setup.ts` 文件头）。
  //   放在 `listen()` 之前：中间件顺序在监听那一刻就固定了。
  applyCors(app)

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

  // ★ W7-D：家庭数据删除的执行 worker（冷却期到期后就地匿名化）。
  //   开关只在 `resolveDeletionWorkerConfig()` 一处解释（`FAMILY_DELETION_WORKER_ENABLED`）；
  //   无库装配下它被模块强制禁用 —— 端口本来就是 501，空转只会刷错误日志。
  app.get(FamilyDeletionWorker).start()
}

// ★ W9-A：启动失败的**显式**退出。没有这段时，`assertAuthBootConfig()` 抛出的
//   `AuthBootConfigError` 会变成一个未处理的 Promise rejection —— Node 会退出
//   （非 0），但日志里是"unhandled rejection"堆栈，运维看不出那句话是**配置判据**，
//   而不是"服务器坏了"。这里把它显式打成一行人话 + 退出码 1。
void bootstrap().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error)
  Logger.error(`启动失败，进程退出：${detail}`, undefined, 'Bootstrap')
  process.exitCode = 1
})


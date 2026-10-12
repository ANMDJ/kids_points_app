// ★ 必须放在**最前**：NestJS 不会自动读取 .env（未装 @nestjs/config），
//   而 PrismaService 在构造时就要求 DATABASE_URL 存在（缺失即抛错，不静默降级）。
//   没有这一行时 `npm start` 会直接抛「DATABASE_URL 未设置」，即使 .env 就在旁边
//   —— 实测踩到，见 docs/design/06-w0-report.md §2。
import 'dotenv/config'

import { Logger, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

/**
 * 入口。
 *
 * 注意：W0 阶段只保证「能启动 + schema 已就绪」。
 * 真正上线前必须先解决 05 §6 的日历型阻塞项：
 *   L1 数据库 ／ L2 微信 AppID 主体认证 ／ L4 域名 + HTTPS + 备案。
 * 其中 L2/L4 是**纯等待时间**（1–7 工作日 / 7–20 工作日），必须在 Day 1 并行启动。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)

  // 关闭 Nest 的隐式 200 —— 审批创建必须显式返回 202（见 02 §9.3）。
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  )

  // 账本写入不可回滚于推送失败 —— 优雅关闭确保事务不被中途切断（01 §4）。
  app.enableShutdownHooks()

  const port = Number(process.env.PORT ?? 3000)
  await app.listen(port)
  Logger.log(`kids_points_api 已启动：http://localhost:${port}`, 'Bootstrap')
}

void bootstrap()

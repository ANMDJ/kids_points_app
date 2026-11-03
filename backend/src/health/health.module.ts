import { DynamicModule, Module } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import {
  DEFAULT_HEALTH_READY_TIMEOUT_MS,
  HealthController,
  HEALTH_READY_TIMEOUT_MS
} from './health.controller'
import {
  HEALTH_PROBE,
  NoDatabaseHealthProbe,
  PrismaHealthProbe
} from './health.probe'

/**
 * 探活模块（P0-5，2026-11-03）。
 *
 * ── 为什么是动态模块（`register()`）而不是普通 `@Module` ─────────────────────
 *   `PrismaHealthProbe` 注入 `PrismaService`，而 `PrismaService` 的构造函数
 *   在 `DATABASE_URL` 缺失时会**直接抛错**（`prisma.service.ts:27-32`，故意响亮）。
 *   无库装配下如果无条件提供一个需要 Prisma 的 provider，整个进程就起不来 ——
 *   「配置错了」会表现成「服务反复重启」，而这正是最贵的一类故障（`05` §6 L1）。
 *   所以这里按环境换实现，判据与 `IdentityModule.register()` 等完全同源：
 *   `hasDatabaseUrl()`（`DATABASE_URL` 非空）。
 *
 * ── 三条纪律（改这里的代码前先看）──────────────────────────────────────────────
 *   ① 控制器**只在这里**注册一次：`HealthModule` 不被任何业务模块导入，
 *      否则同一条路由会被注册多遍（`device-tokens-http.module.ts` 踩过的坑）；
 *   ② 超时走 DI 令牌（`HEALTH_READY_TIMEOUT_MS`），测试才能用 10ms 验超时分支，
 *      而不是让 `npm test` 真的等 2 秒；
 *   ③ `hasDatabaseUrl(env)` 接受显式 env —— 用例不许靠 `process.env` 推断
 *      「自己跑在哪个世界里」（与 `IdentityModule.register(env)` 同一口径）。
 */
@Module({})
export class HealthModule {
  static register(
    env: NodeJS.ProcessEnv = process.env,
    options: { readyTimeoutMs?: number } = {}
  ): DynamicModule {
    const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_HEALTH_READY_TIMEOUT_MS
    return {
      module: HealthModule,
      // ★ 有库才导入 PrismaModule：无库时导入它不会**立即**实例化 PrismaService，
      //   但没有必要把一条「注定抛错」的 provider 挂进依赖图。
      imports: hasDatabaseUrl(env) ? [PrismaModule] : [],
      controllers: [HealthController],
      providers: [
        {
          provide: HEALTH_PROBE,
          useClass: hasDatabaseUrl(env) ? PrismaHealthProbe : NoDatabaseHealthProbe
        },
        { provide: HEALTH_READY_TIMEOUT_MS, useValue: readyTimeoutMs }
      ]
    }
  }
}

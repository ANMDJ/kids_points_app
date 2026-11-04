import { Logger, ValidationPipe, type INestApplication } from '@nestjs/common'

import { AllExceptionsFilter } from './common/all-exceptions.filter'
import { requestIdMiddleware } from './common/request-id'

/**
 * 全局管道的**唯一装配点** —— `main.ts` 与 HTTP 测试**共用**它。
 *
 * 为什么必须抽出来：如果测试自己 `new ValidationPipe(...)` 拼一份，测的就是
 * 「我自己在测试里搭的 app」，不是真装配 —— 管道配置一旦漂移，测试**照样全绿**
 * （本仓库反复踩过的「两份手抄必然漂移」，见 `02` §2 与 D9 的教训）。
 *
 * `whitelist` + `forbidNonWhitelisted`：未知键**一律 400**，与
 * `member-restrictions.ts`（D3b）的多余键拒绝**同一口径** —— 形状 = 集合封闭，
 * 不静默吞掉无意义参数。
 *
 * ⚠️ 这套校验依赖 `emitDecoratorMetadata`（Nest 靠 `design:paramtypes` 判断
 *    「这个参数要不要校验」）。**esbuild / tsx 不产出它**，用 tsx 跑测试时
 *    管道会**静默整体失效**（多余键返回 201 而不是 400）—— 详见
 *    `scripts/run-tests.mjs` 文件头的实测记录（2026-10-14，阶段 B4）。
 */
export function applyGlobalPipes(app: INestApplication): void {
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  )
}

/**
 * 请求追踪 ＋ 全局异常过滤的**唯一装配点**（P2，2026-11-04）。
 *
 * 与 `applyGlobalPipes()` 分开的原因（不是洁癖，是顺序）：
 *   · 管道在 **路由之后** 执行（参数校验靠 `design:paramtypes`），
 *   · 中间件必须在 **路由之前**（`app.use` 的顺序就是执行顺序），
 *   · 全局过滤器只影响"抛出去之后"。
 * 三者时机不同，所以 `main.ts` 里的调用顺序是
 * `applyHttpFoundation` → `applyCors` →（listen）。测试若想验 500 报文，
 * 也必须调这一个函数 —— 否则"测的还是我自己在测试里搭的 app"。
 *
 * ★ 为什么 requestId 中间件排在 CORS **之前**：预检请求（OPTIONS）也要能被追踪，
 *   而且 CORS 中间件在拒绝来源时直接短路返回，晚挂就永远拿不到 id。
 */
export function applyHttpFoundation(app: INestApplication): void {
  app.use(requestIdMiddleware)
  app.useGlobalFilters(new AllExceptionsFilter())
}

/** 只在 `main.ts` 里用的启动日志（测试不需要它，故不进 `applyGlobalPipes`）。 */
export function logBootstrap(url: string): void {
  Logger.log(`kids_points_api 已启动：${url}`, 'Bootstrap')
}

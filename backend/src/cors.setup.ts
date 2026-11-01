import { Logger, type INestApplication } from '@nestjs/common'
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface'

/**
 * CORS 的**唯一**装配点（W10-A，2026-10-30）。
 *
 * ── 为什么需要它（不是「顺手打开」）──────────────────────────────────────────
 *   Flutter Web 版把页面跑在 `http://localhost:<任意端口>`，而接口在
 *   `http://127.0.0.1:3000` —— 属于**跨源**。本仓库的请求都带
 *   `authorization` / `x-kp-device-id` / `content-type: application/json`，
 *   浏览器因此会先发 `OPTIONS` 预检；预检没有 `Access-Control-Allow-*` 响应头时
 *   浏览器**根本不会发出**真正的请求，Dart 侧只能看到「连不上服务器」。
 *   ⇒ 这不是可选的体验优化：没有它，Web 版登录永远失败，且失败原因会被
 *     报成网络错误（正是 `42` §5 反复强调要避免的「假象」）。
 *
 * ── ★ 默认只放行「本机任意端口」，生产必须显式配置 ────────────────────────────
 *   `flutter run -d chrome` 每次挑的端口都可能不同，写死 `http://localhost:5173`
 *   会让「换个端口就登不上」重演成一次玄学排查；而 `origin: true`（回显任意源）
 *   等于放弃同源策略 —— 任何网站都能拿用户浏览器里的 token 读本接口。
 *   所以：
 *     · `CORS_ALLOWED_ORIGINS` 已配置 ⇒ 只认这份白名单（`,` 分隔；`*` 表全部，仅限明确要求时）；
 *     · 未配置且 `NODE_ENV !== 'production'` ⇒ 只放行 `localhost` / `127.0.0.1` / `[::1]`
 *       的**任意端口**（本机开发，跨源风险＝0）；
 *     · 未配置且 `NODE_ENV === 'production'` ⇒ **不启用**并 warn 一条 ——
 *       生产环境默认放开 CORS 才是事故，缺配置应当是「明确关着」。
 *
 * ── `credentials: false` 是刻意的 ─────────────────────────────────────────────
 *   本 App 的凭据走 `authorization` 头（`AuthSession` token），**不用 cookie**。
 *   打开 `credentials` 会让 `Access-Control-Allow-Origin` 不允许 `*`，
 *   并允许浏览器在跨源请求里带上 cookie —— 那是给"没在用"的能力付真实的安全账。
 *
 * ── 为什么列 `allowedHeaders` 而不是回显 `Access-Control-Request-Headers` ─────
 *   回显的写法更"兼容"，但也意味着任何客户端随便发明的头都会被放行；
 *   显式列表让「哪些头是接口契约」只有一处真相（`read_api.dart` 的两个常量
 *   `x-kp-device-id` / `x-kp-child-id`）。新增头时必须同时改这里 —— 忘了会
 *   表现为「预检失败」，而不是静默放行。
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

/** 与 CORS 无关的公共选项：只解释一次，白名单分支共用。 */
const BASE_OPTIONS: CorsOptions = {
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['accept', 'content-type', 'authorization', 'x-kp-device-id', 'x-kp-child-id'],
  // 客户端不读任何自定义响应头（只看状态码 + JSON body）⇒ 不需要 exposedHeaders。
  credentials: false,
  // 预检结果缓存 10 分钟：登录页连续输入时不该每次都多一个往返。
  maxAge: 600
}

/**
 * 把 `CORS_ALLOWED_ORIGINS` 解析成 `cors` 包要的 `origin` 选项。
 *
 * 返回 `null` 表示**不要调用** `enableCors()`（生产且未配置）。
 */
export function resolveCorsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions | null {
  const raw = (env.CORS_ALLOWED_ORIGINS ?? '').trim()
  const configured = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  if (configured.length > 0) {
    if (configured.includes('*')) {
      return { ...BASE_OPTIONS, origin: true }
    }
    return { ...BASE_OPTIONS, origin: configured }
  }

  if (env.NODE_ENV === 'production') return null

  return {
    ...BASE_OPTIONS,
    // 没有 `origin` 头（同源请求、服务端调用、curl）时 cors 传 `undefined`：
    // 放行 —— 它们本来就不是跨源请求，这里的判断不适用。
    origin: (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void): void => {
      callback(null, origin === undefined || LOCAL_ORIGIN.test(origin))
    }
  }
}

/**
 * 装配 CORS。必须在 `app.listen()` **之前**调用 —— 中间件顺序在监听时就固定了。
 */
export function applyCors(app: INestApplication, env: NodeJS.ProcessEnv = process.env): void {
  const options = resolveCorsOptions(env)
  if (options === null) {
    Logger.warn(
      '未启用 CORS（NODE_ENV=production 且未设置 CORS_ALLOWED_ORIGINS）：' +
        'Flutter Web 版会因预检失败而显示「连不上服务器」。',
      'Bootstrap'
    )
    return
  }

  app.enableCors(options)
  const scope =
    (env.CORS_ALLOWED_ORIGINS ?? '').trim() === ''
      ? '本机 localhost / 127.0.0.1 / [::1] 任意端口（开发默认）'
      : env.CORS_ALLOWED_ORIGINS
  Logger.log(`CORS 已启用：${scope}`, 'Bootstrap')
}

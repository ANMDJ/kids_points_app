import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 请求追踪 id（P2，2026-11-04）—— `43` §5「requestId ＋ 全局异常过滤器」。
 *
 * ── 为什么必须有一个服务端 id，而不是让用户截 `code` ────────────────────────
 *   线上一次 500 的事故现场通常只有两样东西：一张手机截图 + 一句「刚才点提交就报错了」。
 *   没有 id 时，日志里同一分钟可能有几十条 `POST /records/adjust`，**对不上是哪一条**。
 *   id 同时出现在「响应头 / 500 报文体 / 日志行」三处，截图里的那一串就成了索引键。
 *
 * ── 为什么接受客户端传 `x-request-id`，但先校验形状 ──────────────────────────
 *   链路追踪（App → Caddy → API）要求同一 id 一路传下去，所以客户端 / 反代给的 id
 *   要尊重；但**直接回显任意字符串**是日志注入（换行能把一行日志切成两行，
 *   伪造出一条别人看不懂的「记录」）与存储污染。这里只放行
 *   `[A-Za-z0-9._:-]{1,64}`（UUID / 雪花 / `req-1` 都覆盖），其余一律丢弃并重新生成。
 *
 * ── 为什么挂在 `node:http` 的类型上，而不是 express ─────────────────────────
 *   仓库没装 `@types/express`（`backend/package.json` 的 devDependencies 里没有）。
 *   中间件只用 `headers / method / url`，用 `IncomingMessage` 就够了；
 *   为了一个中间件引入一整套 express 类型不值得。
 */

/** 客户端 / 反代可用的追踪头（小写：Node 的 headers 键一律小写）。 */
export const REQUEST_ID_HEADER = 'x-request-id'

/** 长度上限：UUID 36，雪花 19；64 留足 `traceId-spanId` 这类组合。 */
export const REQUEST_ID_MAX_LENGTH = 64

/**
 * 只放行「不会破坏日志行与 JSON」的字符集：
 * 不含空格 / 换行 / 引号 / 反斜杠 / 中文 ⇒ 不需要再做转义。
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

/** 挂在请求对象上的可选 id（`IncomingMessage` 的扩展，只用一次）。 */
export interface TracedRequest extends IncomingMessage {
  requestId?: string
  /**
   * express 在挂载中间件之前会把原始 URL（含 query）写到这里。
   * `node:http` 的 `IncomingMessage` 没有这个字段 —— 所以是可选的，读不到就退回 `url`。
   */
  originalUrl?: string
}

/**
 * 从请求头里挑一个**可信**的 id；不合格返回 `undefined`（调用方生成新的）。
 *
 * 数组（同一个头出现两次）一律视为不可信：Node 会把它给成 `string[]`，
 * 那种情况下「用第一个还是最后一个」没有正确答案，重新生成最安全。
 */
export function pickRequestId(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!REQUEST_ID_PATTERN.test(trimmed)) return undefined
  return trimmed
}

/**
 * 中间件：**先**给请求与响应都写上 id，再交给下游。
 *
 * ★ 必须在 `app.use()` 的最前面（`main.ts` 里排在 CORS 之前）：排查问题最需要的
 *   恰恰是「连 Guard 都没过」的那些请求，晚挂一步它们就没有 id。
 */
export function requestIdMiddleware(
  req: TracedRequest,
  res: ServerResponse,
  next: () => void
): void {
  const requestId = pickRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID()
  req.requestId = requestId
  // 响应头在错误过滤器里也可能被写，但正常路径（200/201/4xx）全靠这一行 ——
  // 过滤器不负责「成功请求"的 id，两处都写会变成两份真相。
  if (!res.headersSent) res.setHeader(REQUEST_ID_HEADER, requestId)
  next()
}

/** 日志里那句「谁在什么时候打的」—— 与 `requestId` 同一行，方便 grep。 */
export function describeRequest(req: TracedRequest): string {
  const method = req.method ?? 'UNKNOWN'
  const url = req.originalUrl ?? req.url ?? '/'
  return `${method} ${url}`
}

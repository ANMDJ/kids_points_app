/**
 * 推送网关的环境配置（W6-A，2026-10-24）—— **纯函数**，不读 `process.env`。
 *
 * ── 为什么把「配置解析」单独抽出来 ──────────────────────────────────────────
 *   ① 校验规则必须能被**离线证伪**（URL 写错 / 生产用了 http / 超时写了 `abc`），
 *      而这些情形不可能靠「起一个真网关」来覆盖；
 *   ② 装配层（`NotificationsModule`）只该做一件事：**拿结论、选实现**。
 *
 * ── 四种结论，两种是「安静」的 ──────────────────────────────────────────────
 *   · `disabled` —— 没配（当前常态）：回落到 `NoopPushAdapter`，日志用 debug；
 *   · `invalid`  —— 配了但**不能用**：回落到 `NoopPushAdapter`，日志必须用 **error**。
 *     这一支最危险：如果把它当成 `disabled` 静默处理，「我明明配了 URL」与
 *     「一条推送都没发」会长期共存而没人知道（`28` §2.2 的同一类假绿）。
 *
 * ── 为什么生产环境强制 https ────────────────────────────────────────────────
 *   请求体里有**设备 token**（可直接用来推送的凭据）和「谁收到了什么」。明文
 *   http 会把它们交给路上任何一个代理。开发机的 localhost 网关允许 http，
 *   否则本地联调必须自签证书 —— 那条路只会让人把校验关掉。
 */

/** 网关地址；空 / 未设置 ⇒ `disabled`。 */
export const PUSH_WEBHOOK_URL_ENV = 'PUSH_WEBHOOK_URL'
/** 网关凭据（可选）；放进 `authorization: Bearer <token>`。空 ⇒ 不带该头。 */
export const PUSH_WEBHOOK_TOKEN_ENV = 'PUSH_WEBHOOK_TOKEN'
/** 单次调用上限（毫秒）；非法 / 缺省 ⇒ 800，夹在 [100, 5000]。 */
export const PUSH_WEBHOOK_TIMEOUT_ENV = 'PUSH_WEBHOOK_TIMEOUT_MS'

/**
 * 默认 800ms —— 必须**小于** `NotificationsService` 的 1000ms 兜底。
 * 反过来的话 service 会先超时返回，而适配器还在后台跑并可能改写 token 状态；
 * 那条「已经宣布失败、却又成功了」的路径没有任何人观察。
 */
export const DEFAULT_PUSH_WEBHOOK_TIMEOUT_MS = 800
export const MIN_PUSH_WEBHOOK_TIMEOUT_MS = 100
export const MAX_PUSH_WEBHOOK_TIMEOUT_MS = 5000

export interface WebhookPushConfig {
  /** 已校验：http(s)、生产必为 https。 */
  url: string
  /** `null` ⇒ 不发送 `authorization` 头（网关未开启鉴权）。 */
  token: string | null
  timeoutMs: number
}

export type WebhookPushConfigResult =
  | { kind: 'disabled'; reason: 'not_configured' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; config: WebhookPushConfig }

export function readWebhookPushConfig(env: NodeJS.ProcessEnv): WebhookPushConfigResult {
  const rawUrl = env[PUSH_WEBHOOK_URL_ENV]
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { kind: 'disabled', reason: 'not_configured' }
  }

  const url = rawUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { kind: 'invalid', reason: `${PUSH_WEBHOOK_URL_ENV} 不是合法 URL：${url}` }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      kind: 'invalid',
      reason: `${PUSH_WEBHOOK_URL_ENV} 只支持 http(s)，收到 ${parsed.protocol}`
    }
  }
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    return {
      kind: 'invalid',
      reason: `生产环境的 ${PUSH_WEBHOOK_URL_ENV} 必须是 https（请求体含设备 token）`
    }
  }

  const rawToken = env[PUSH_WEBHOOK_TOKEN_ENV]
  const token = typeof rawToken === 'string' && rawToken.trim() !== '' ? rawToken.trim() : null

  return {
    kind: 'ok',
    config: { url, token, timeoutMs: readTimeoutMs(env[PUSH_WEBHOOK_TIMEOUT_ENV]) }
  }
}

/** 非法值**不抛错也不静默**：回落到默认值，并把实际采用的数字交给调用方记录。 */
function readTimeoutMs(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PUSH_WEBHOOK_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return DEFAULT_PUSH_WEBHOOK_TIMEOUT_MS
  const rounded = Math.floor(parsed)
  if (rounded < MIN_PUSH_WEBHOOK_TIMEOUT_MS) return MIN_PUSH_WEBHOOK_TIMEOUT_MS
  if (rounded > MAX_PUSH_WEBHOOK_TIMEOUT_MS) return MAX_PUSH_WEBHOOK_TIMEOUT_MS
  return rounded
}

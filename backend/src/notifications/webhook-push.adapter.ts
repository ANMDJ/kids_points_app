import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  DEVICE_TOKENS_REPOSITORY,
  type DeviceTokensPort
} from '../device-tokens/device-tokens.repository'
import type { ActivePushToken } from '../device-tokens/device-tokens.types'
import { NoopPushAdapter } from './noop-push.adapter'
import type { PushMessage, PushPort, PushResult } from './push.port'
import type { WebhookPushConfig, WebhookPushConfigResult } from './push-webhook.config'

/**
 * **真实**的推送适配器：把一个 `PushMessage` 交给外部推送网关（W6-A，2026-10-24）。
 *
 * ── 为什么是「webhook 网关」而不是直接调 APNs / FCM / 微信 ──────────────────
 *   三条渠道的凭据、签名、token 失效语义完全不同，而 L2 / L3 的凭据今天都没有
 *   （`05` §6）。若现在把 APNs 写进仓库，它只能是一条**从未被执行过**的代码 ——
 *   正是本仓库反复记过的「看起来接好了」。所以本阶段只钉一件事：
 *   **一条可测试、可换网关的 HTTP 契约**。真正选型后要改的只有本文件，
 *   `NotificationsService` / 审批链路 / 账本一行都不用动。
 *
 * ── 契约（发给网关的 POST body）─────────────────────────────────────────────
 *   ```json
 *   {
 *     "version": 1,
 *     "event": "approval.status_changed",
 *     "message": { ...原样转发 PushMessage... },
 *     "tokens": [{ "token": "…", "platform": "ios" }]
 *   }
 *   ```
 *   · `message` **原样转发**：适配器不加工内容，换渠道时消息语义只有一处定义；
 *   · `tokens` 一次全给：网关负责扇出（它是唯一知道平台差异的一方）；
 *   · 响应 `2xx` ⇒ 已受理；body 里 `messageId` 是字符串就带回，否则 `null`
 *     （**不编造**一个 id）。
 *
 * ── 三种失败，必须区分开 ──────────────────────────────────────────────────
 *   · 没有 token ⇒ `no_device_token`（不是故障：这个人还没上报过设备）；
 *   · `410 Gone` ⇒ `provider_error` **且**把 token 置为 inactive
 *     （否则每次审批都要带上一批死 token 重试一遍，还会拖慢其他设备）；
 *   · 其它网络 / 超时 / 非 2xx ⇒ `provider_error`（不改任何状态 —— 401 可能只是
 *     我们配错凭据，把用户的 token 全删掉是灾难）。
 *
 * ── 本实现**不做重试** ────────────────────────────────────────────────────
 *   重试需要 outbox 与幂等键（`PushMessage` 目前没有 `dedupeKey`），
 *   在事务外同步重试只会把一次审批请求拖长。留作下一步，见 29 号交接单 §5。
 */
export interface WebhookPushPayload {
  version: 1
  event: PushMessage['type']
  message: PushMessage
  tokens: ActivePushToken[]
}

/** 网关回 410 时可以只列出**失效的那几条**（结构与 body 一起被校验）。 */
const INVALID_TOKENS_FIELD = 'invalidTokens'

@Injectable()
export class WebhookPushAdapter implements PushPort {
  private readonly log = new Logger(WebhookPushAdapter.name)

  constructor(
    private readonly config: WebhookPushConfig,
    @Inject(DEVICE_TOKENS_REPOSITORY) private readonly tokens: DeviceTokensPort
  ) {}

  async send(message: PushMessage): Promise<PushResult> {
    let active: ActivePushToken[]
    try {
      active = await this.tokens.listActiveForUser(message.recipientUserId)
    } catch (error) {
      // 读 token 都失败（无库 / 连接池耗尽）⇒ 如实回答，绝不「当成没有设备」。
      return {
        delivered: false,
        reason: 'provider_error',
        detail: `读取设备 token 失败：${describe(error)}`
      }
    }
    if (active.length === 0) return { delivered: false, reason: 'no_device_token' }

    const payload: WebhookPushPayload = {
      version: 1,
      event: message.type,
      message,
      tokens: active
    }

    let response: Response
    try {
      response = await fetch(this.config.url, {
        method: 'POST',
        headers: this.headers(message.type),
        body: JSON.stringify(payload),
        // 见 `push-webhook.config.ts`：本上限必须**小于** service 的 1s 兜底。
        signal: AbortSignal.timeout(this.config.timeoutMs)
      })
    } catch (error) {
      // 网络不可达 / DNS / 超时（AbortError）。**绝不**外抛：审批已经提交了。
      return {
        delivered: false,
        reason: 'provider_error',
        detail: `推送网关不可达：${describe(error)}`
      }
    }

    if (response.status === 410) {
      const invalid = await this.readInvalidTokens(response, active)
      const deactivated = await this.deactivate(invalid)
      return {
        delivered: false,
        reason: 'provider_error',
        detail: `网关判定设备 token 失效（410），已置 ${deactivated} 条为 inactive`
      }
    }

    if (!response.ok) {
      // 把响应体读掉，避免连接被挂住（undici 会一直占着 socket）。
      await response.text().catch(() => '')
      return {
        delivered: false,
        reason: 'provider_error',
        detail: `推送网关返回 HTTP ${response.status}`
      }
    }

    const body = await response.json().catch(() => null)
    return { delivered: true, providerMessageId: readProviderMessageId(body) }
  }

  private headers(event: PushMessage['type']): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // 网关可以据此分流（省掉解析 body 才能知道事件类型）。
      'x-kp-event': event
    }
    if (this.config.token !== null) headers.authorization = `Bearer ${this.config.token}`
    return headers
  }

  /**
   * 410 时该把哪些 token 标成失效。
   *
   * 默认 = **本次发送的全部**（网关说「这批都没了」）；若响应体给出
   * `invalidTokens: string[]`，只处理**确实发出去过**的那些 ——
   * 否则一个坏网关可以让我们把任意 token 下线（请求体是它给的）。
   * 解析失败 / 结构不符 ⇒ 回落到「全部」并记 warn。
   */
  private async readInvalidTokens(
    response: Response,
    sent: ActivePushToken[]
  ): Promise<string[]> {
    const body = await response.json().catch(() => null)
    if (body === null || typeof body !== 'object') {
      return sent.map((row) => row.token)
    }
    const listed = (body as Record<string, unknown>)[INVALID_TOKENS_FIELD]
    if (!Array.isArray(listed)) {
      return sent.map((row) => row.token)
    }
    const sentSet = new Set(sent.map((row) => row.token))
    const filtered = listed.filter(
      (value): value is string => typeof value === 'string' && sentSet.has(value)
    )
    if (filtered.length === 0) {
      this.log.warn(
        `推送网关回 410 但 ${INVALID_TOKENS_FIELD} 里没有本次发送的 token —— 按「全部失效」处理`
      )
      return sent.map((row) => row.token)
    }
    return filtered
  }

  /** 把失效 token 置为 inactive。失败只记 warn：状态写不进去不该让推送结果变成异常。 */
  private async deactivate(tokens: string[]): Promise<number> {
    if (tokens.length === 0) return 0
    try {
      return await this.tokens.deactivateTokens(tokens)
    } catch (error) {
      this.log.warn(`把失效设备 token 置为 inactive 失败：${describe(error)}`)
      return 0
    }
  }
}

/**
 * 从网关响应里读 `messageId`。
 *
 * ★ 只认**非空字符串**：数字 / 空串一律当没有，不 `String(...)` 硬转 ——
 *   `providerMessageId` 是用来对账的，一个编出来的值比 `null` 更糟。
 */
function readProviderMessageId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const value = (body as Record<string, unknown>)['messageId']
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 错误 → 一行可读文本（`AbortError` 的 message 是空串，必须带上 name）。 */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * 按配置选择实现的**唯一分叉点**（生产与用例共用）。
 *
 * ── 为什么 `invalid` 与 `disabled` 都回落到 no-op、却必须分开记日志 ──────────
 *   `invalid` 若静默落回 no-op，「配了但配错」就会以 `provider_not_configured`
 *   的面目出现 —— 运营看到的是「没配」，于是去配第二遍。装配层对 invalid 记 **error**。
 */
export function createPushAdapter(
  result: WebhookPushConfigResult,
  tokens: DeviceTokensPort
): PushPort {
  if (result.kind === 'ok') return new WebhookPushAdapter(result.config, tokens)
  return new NoopPushAdapter()
}


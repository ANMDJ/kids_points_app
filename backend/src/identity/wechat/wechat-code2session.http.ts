import { Injectable } from '@nestjs/common'

import { classifyWechatErrcode } from './wechat-errors'
import type { Code2SessionOutcome, WechatCode2SessionPort } from './wechat-code2session.port'

/**
 * 微信 `code2session` 的**真实现**（W9-A，2026-10-29）—— `WechatCode2SessionPort` 的 HTTP 适配器。
 *
 * ── 三处刻意的做法（每一条都有具体事故对应）──────────────────────────────────
 *   ① **POST form，不用 GET query**：微信两种都支持，但 GET 会把 `secret` 写进
 *      访问日志 / 反代日志 / APM 的 URL 记录 —— 那是"哪天接了 APM 才炸"的那类泄漏。
 *   ② **不记录任何请求细节**：`detail` 里**绝不**带 URL（URL 里有 secret）与 `code`
 *      （5 分钟有效，日志泄露即可被抢登）。只记 HTTP 状态与 errcode。
 *   ③ **不抛异常**：超时 / 非 JSON / HTTP 5xx 全部折成 `UNAVAILABLE`
 *      —— 让服务层把它翻成 502（可退避重试），而不是 500 堆栈。
 *
 * ── 配置从哪来 ──────────────────────────────────────────────────────────────
 *   `WECHAT_MP_APPID` / `WECHAT_MP_SECRET`（`backend/.env`，**不入库**）。
 *   缺任一项时模块绑的是 `UnconfiguredWechatCode2Session`（503），
 *   本文件构造时也会再判一次 —— 两个世界的分支判据只有一处：
 *   `resolveWechatCode2SessionClass()`（`identity.module.ts`）。
 */

export const WECHAT_MP_APPID_ENV = 'WECHAT_MP_APPID'
export const WECHAT_MP_SECRET_ENV = 'WECHAT_MP_SECRET'

/** 微信文档的地址；写死而不是配置项 —— 换地址是微信的事，不是我们的部署参数。 */
export const CODE2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session'

/** 超时：登录是用户**正在等**的动作，5 秒还拿不到就让客户端退避重试（502）。 */
export const CODE2SESSION_TIMEOUT_MS = 5_000

export interface WechatConfig {
  appId: string
  secret: string
}

/** 读配置。缺失项按**名字**返回，便于 503 的 `missing` 字段如实点名（不回显值）。 */
export function readWechatConfig(
  env: NodeJS.ProcessEnv = process.env
): { kind: 'OK'; config: WechatConfig } | { kind: 'MISSING'; missing: string[] } {
  const appId = typeof env[WECHAT_MP_APPID_ENV] === 'string' ? env[WECHAT_MP_APPID_ENV]!.trim() : ''
  const secret = typeof env[WECHAT_MP_SECRET_ENV] === 'string' ? env[WECHAT_MP_SECRET_ENV]!.trim() : ''
  const missing: string[] = []
  if (appId === '') missing.push(WECHAT_MP_APPID_ENV)
  if (secret === '') missing.push(WECHAT_MP_SECRET_ENV)
  if (missing.length > 0) return { kind: 'MISSING', missing }
  return { kind: 'OK', config: { appId, secret } }
}

interface Code2SessionResponseBody {
  openid?: unknown
  errcode?: unknown
  errmsg?: unknown
}

@Injectable()
export class HttpWechatCode2Session implements WechatCode2SessionPort {
  async exchange(code: string): Promise<Code2SessionOutcome> {
    const resolved = readWechatConfig()
    if (resolved.kind === 'MISSING') return { kind: 'NOT_CONFIGURED', missing: resolved.missing }

    const body = new URLSearchParams({
      appid: resolved.config.appId,
      secret: resolved.config.secret,
      js_code: code,
      grant_type: 'authorization_code'
    })

    let payload: Code2SessionResponseBody
    try {
      const response = await fetch(CODE2SESSION_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(CODE2SESSION_TIMEOUT_MS)
      })
      if (!response.ok) {
        // ★ 只说状态码：响应体可能回显参数，**不**把它拼进 detail。
        return { kind: 'UNAVAILABLE', detail: `code2session 返回 HTTP ${response.status}` }
      }
      payload = (await response.json()) as Code2SessionResponseBody
    } catch (error) {
      const name = error instanceof Error ? error.name : 'unknown'
      return {
        kind: 'UNAVAILABLE',
        detail: `code2session 请求失败（${name}）—— 超时或非 JSON 响应，可退避重试`
      }
    }

    // ── 成功形态：`{ openid, session_key }`。★ 只取 openid，session_key 就地丢弃。
    if (typeof payload.openid === 'string' && payload.openid !== '') {
      return { kind: 'OK', openId: payload.openid }
    }

    const errcode = typeof payload.errcode === 'number' ? payload.errcode : null
    if (errcode === null) {
      return {
        kind: 'UNAVAILABLE',
        detail: 'code2session 的响应既没有 openid 也没有 errcode（契约变了？）'
      }
    }

    switch (classifyWechatErrcode(errcode)) {
      case 'CODE_INVALID':
        return { kind: 'CODE_INVALID', errcode }
      case 'RATE_LIMITED':
        return { kind: 'RATE_LIMITED', errcode }
      case 'CREDENTIAL_INVALID':
        return { kind: 'CREDENTIAL_INVALID', errcode }
      case 'UNAVAILABLE':
        return { kind: 'UNAVAILABLE', detail: `code2session errcode=${errcode}` }
    }
  }
}

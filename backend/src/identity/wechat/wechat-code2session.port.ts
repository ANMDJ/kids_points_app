import { Injectable } from '@nestjs/common'

/**
 * 微信 `code2session` 的**端口**（W9-A，2026-10-29 / `docs/design/40-login-and-session-design.md` §8.2、§13 S2）。
 *
 * ── 为什么端口只回答"这串 code 是谁"，不回答 HTTP 状态码 ────────────────────
 *   外部世界的失败要**分类**，但"哪一类翻成 401 / 429 / 500 / 502"是服务层的决定
 *   （见 `identity.service.ts` 的映射表）。把状态码塞进端口，会让
 *   `test/support/wechat-fake.ts` 变成"另一个 HTTP 层"，两套映射迟早漂移
 *   （与账本适配器 / 会员适配器同一条纪律）。
 *
 * ── 五个结局，每一个都有对应的客户端动作 ────────────────────────────────────
 *   OK                → 继续签发 token
 *   CODE_INVALID      → 401，客户端重新 `wx.login()` 后再试**一次**
 *   RATE_LIMITED      → 429，退避，**不要**自动重试（微信侧限流，再打只会更糟）
 *   CREDENTIAL_INVALID→ 500 **且告警给运维**（`40125` / `40013`）。
 *                       ★ 2026-10-29 真实发生过一次（`.env` 里的旧 secret）——
 *                       把它报成"用户登录失败"，会让所有人以为问题在用户侧
 *   NOT_CONFIGURED    → 503（服务端没配 AppID/Secret）
 *   UNAVAILABLE       → 502（超时 / 非 JSON / 未知 errcode），退避重试
 *
 * ── 绝不返回 `session_key` ──────────────────────────────────────────────────
 *   微信每次登录都会给，但本项目**不解密用户信息**。端口只取 `openId`：
 *   存 `session_key` 等于存一把能解密的密钥（`40` §6.3）。
 */
export const WECHAT_CODE2SESSION = Symbol('WECHAT_CODE2SESSION')

export type Code2SessionOutcome =
  /** 成功：只带 `openId` —— 端口签名里**没有**能接收 `session_key` 的参数。 */
  | { kind: 'OK'; openId: string }
  | { kind: 'CODE_INVALID'; errcode: number | null }
  | { kind: 'RATE_LIMITED'; errcode: number | null }
  | { kind: 'CREDENTIAL_INVALID'; errcode: number | null }
  | { kind: 'NOT_CONFIGURED'; missing: string[] }
  | { kind: 'UNAVAILABLE'; detail: string }

export interface WechatCode2SessionPort {
  /**
   * 用一次性 `js_code` 换 openId。
   *
   * ★ 实现**不得**抛异常表达外网失败：所有失败都是一种 `Code2SessionOutcome`
   *   （守卫/服务层才决定 HTTP）。否则"网络抖动"会变成 500 堆栈，
   *   而它本来是 502（可以退避重试）。
   */
  exchange(code: string): Promise<Code2SessionOutcome>
}

/**
 * **没配凭据**时的实现：一律 `NOT_CONFIGURED`（服务层翻 503）。
 *
 * ★ 为什么不是 501：501 的语义是"这个功能还没写"；而这里功能**写了**，
 *   缺的是部署配置。503 才会被客户端读成"服务暂时不可用"，
 *   501 会被读成"这个接口不存在"（永久性），两者对用户的指引完全不同。
 * ★ 为什么不在这里读 `.env` 后"假装成功"：那会把登录变成一个
 *   **只在回包里成立**的事实（与 `NotImplementedAuthRepository` 同一条理由）。
 */
@Injectable()
export class UnconfiguredWechatCode2Session implements WechatCode2SessionPort {
  async exchange(_code: string): Promise<Code2SessionOutcome> {
    return { kind: 'NOT_CONFIGURED', missing: ['WECHAT_MP_APPID', 'WECHAT_MP_SECRET'] }
  }
}

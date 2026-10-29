/**
 * 微信 `errcode` 的**归类内核**（W9-A，2026-10-29）—— 纯函数，可离线穷举。
 *
 * 判据来源：`docs/design/40-login-and-session-design.md` §8.2 的映射表
 * （逐条来自微信文档，**不是**凭直觉排的）。
 *
 * ── ★ 这张表最容易做错的一处 ────────────────────────────────────────────────
 *   `40125 invalid appsecret` / `40013 invalid appid` 是**我们自己的配置坏了**，
 *   不是用户输错了什么。把它报成 401「登录失败」会让三方（用户 / 客服 / 开发）
 *   一致地朝错的方向排查 —— 2026-10-29 就真实发生过一次（`.env` 里的旧 secret）。
 *   故它们归 `CREDENTIAL_INVALID` ⇒ **500 + 运维告警**，客户端看到的是"服务异常"。
 *
 * ── 为什么未知 errcode 归 `UNAVAILABLE`（502）而不是 500 ─────────────────────
 *   微信会新增错误码。未知值的正确姿态是"暂时不可用、可退避重试"，
 *   而不是"我们代码有 bug"（500 会让告警指向应用层，而病在外部契约）。
 *   但 `-1`（system busy）与它同归，因为它们对客户端是**同一个动作**：等一会儿。
 */

export type WechatFailure = 'CODE_INVALID' | 'RATE_LIMITED' | 'CREDENTIAL_INVALID' | 'UNAVAILABLE'

/** 归类一张表 —— 新增码值时**只改这一处**，并在此处写清判据。 */
const ERRCODE_TABLE: Readonly<Record<number, WechatFailure>> = {
  // 一次性 code 无效 / 已用过 / 已过期：用户重新 wx.login() 就有新 code。
  40029: 'CODE_INVALID',
  40163: 'CODE_INVALID',
  // 微信侧的频率限制：**我们**要退避，重试会把更多流量引到微信。
  45011: 'RATE_LIMITED',
  // 配置坏了 —— 不是用户的问题。必须 500 + 告警（见文件头）。
  40125: 'CREDENTIAL_INVALID',
  40013: 'CREDENTIAL_INVALID',
  // 微信系统繁忙。
  [-1]: 'UNAVAILABLE'
}

export function classifyWechatErrcode(errcode: number): WechatFailure {
  return ERRCODE_TABLE[errcode] ?? 'UNAVAILABLE'
}

/**
 * `errcode === 0` 之外的统一入口：调用方拿到 JSON 后问"这个码是什么"。
 * 单独导出是为了让 `errcode === 0`（成功）不被误当作失败分类。
 */
export function isWechatSuccess(errcode: number | undefined | null): boolean {
  return errcode === 0 || errcode === undefined || errcode === null
}

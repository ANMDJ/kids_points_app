import { Injectable } from '@nestjs/common'

/**
 * 登录端点的**最小限流器**（W9-A，2026-10-29 / `docs/design/40-login-and-session-design.md` §11.1）。
 *
 * ── 为什么必须有它（三条都不是理论风险）─────────────────────────────────────
 *   `POST /auth/login` 是全仓库**唯一**免认证的写路由。没有限流时它可以被用来：
 *     ① 刷 openid 探测（每次一次外网请求 ⇒ 我们成了探测代理）；
 *     ② 刷 CPU / 连接（每次一条 TCP + TLS 握手到微信）；
 *     ③ 把微信的 `45011`（频率限制）直接引到自己身上 —— 那是**账号级**的惩罚，
 *        触发之后所有用户都登不上，包括我们自己排查时。
 *
 * ── 判据（`40` §11.1，两条都要）────────────────────────────────────────────
 *   每 IP 每分钟 20 次 / 每 deviceId 每分钟 10 次；超限 **429**（不是 503：
 *   503 会被读成"服务挂了"，让客户端退避 30 秒，而 429 才是"你太快了"）。
 *
 * ── ★ 它的边界（写清，不许被读成"限流已有"）─────────────────────────────────
 *   · **单进程内存**：多实例部署时每个实例各算一份 ⇒ 实际额度 × 实例数。
 *     真正上线（L4 之后）应在反代加 `limit_req`，本类只作为"最后一道"；
 *   · **进程重启即清零**：重启后额度重置，这对攻击者反而是"可以等"的 —— 所以它
 *     不是防线，只是**减速带**；
 *   · key 是客户端自报的 IP / deviceId，**都可伪造**（`x-forwarded-for` / 头）。
 *     它唯一不可伪造的收益是"同一来源不能无限刷同一份额度"，故**两条都查**：
 *     伪造 IP 的人会撞 device 额度，伪造 device 的人会撞 IP 额度。
 *
 * ── 为什么用滑动窗口而不是令牌桶 ────────────────────────────────────────────
 *   判据写的是"每分钟 N 次"，滑动窗口与它**逐字一致**；令牌桶要解释"容量 / 速率"
 *   两个参数，而那两个数在文档里不存在（多出来的自由度会被随手调）。
 */

export const LOGIN_RATE_LIMIT_PER_IP = 20
export const LOGIN_RATE_LIMIT_PER_DEVICE = 10
export const LOGIN_RATE_WINDOW_MS = 60_000

export interface RateVerdict {
  allowed: boolean
  /** 还要等几秒（`allowed=false` 时有效，向上取整，最少 1）。 */
  retryAfterSeconds: number
}

/** 单个 key 的命中时刻（毫秒）。用数组而不是计数器：滑动窗口需要"哪一次最老"。 */
type Hits = number[]

@Injectable()
export class LoginRateLimiter {
  private readonly hits = new Map<string, Hits>()

  /**
   * 记一次尝试并返回是否放行。
   *
   * ★ **先判后记**：被拒的请求**不**写入时间戳（否则持续攻击会让窗口永远满，
   *   正常用户在攻击结束后还要多等一分钟 —— 那是把惩罚落在受害者身上）。
   *   代价是"被拒的请求不消耗额度"，所以攻击者可以一直打，但**打不出结果**：
   *   目标已经达成（不放大到微信）。
   */
  consume(key: string, limit: number, now: Date): RateVerdict {
    const nowMs = now.getTime()
    const windowStart = nowMs - LOGIN_RATE_WINDOW_MS

    const existing = this.hits.get(key) ?? []
    const recent = existing.filter((at) => at > windowStart)

    if (recent.length >= limit) {
      this.hits.set(key, recent)
      const oldest = recent[0] ?? nowMs
      const waitMs = oldest + LOGIN_RATE_WINDOW_MS - nowMs
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) }
    }

    recent.push(nowMs)
    this.hits.set(key, recent)
    return { allowed: true, retryAfterSeconds: 0 }
  }

  /**
   * 一次登录尝试要过**两道**：IP 与 deviceId。
   *
   * 返回 `null` 表示放行；否则返回触发的那一道（`scope` 只用于日志/响应说明，
   * 不区分两者的**文案**对用户没有意义 —— 客户端动作都一样：等）。
   */
  check(
    input: { ip?: string; deviceId?: string | null },
    now: Date
  ): { scope: 'ip' | 'device'; retryAfterSeconds: number } | null {
    if (typeof input.ip === 'string' && input.ip !== '') {
      const ipVerdict = this.consume(`ip:${input.ip}`, LOGIN_RATE_LIMIT_PER_IP, now)
      if (!ipVerdict.allowed) {
        return { scope: 'ip', retryAfterSeconds: ipVerdict.retryAfterSeconds }
      }
    }
    if (typeof input.deviceId === 'string' && input.deviceId !== '') {
      const deviceVerdict = this.consume(
        `device:${input.deviceId}`,
        LOGIN_RATE_LIMIT_PER_DEVICE,
        now
      )
      if (!deviceVerdict.allowed) {
        return { scope: 'device', retryAfterSeconds: deviceVerdict.retryAfterSeconds }
      }
    }
    return null
  }

  /** 只给用例用：清空（进程内单例在多个 `describe` 之间会互相影响）。 */
  reset(): void {
    this.hits.clear()
  }
}

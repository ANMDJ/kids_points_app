import { Injectable, type OnModuleDestroy } from '@nestjs/common'

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
/**
 * 命中表 key 数上限（抗压加固，2026-11-01）—— 内存炸弹保护。
 *
 * ── 为什么必须有它 ───────────────────────────────────────────────────────
 *   key 由客户端自报的 IP / deviceId 组成（都可伪造），而 Map 原本只增不删：
 *   攻击者随机换 `deviceId` 可在 1 分钟内灌进数十万 key（实测换算：1 万 req/s
 *   约 150–200MB）——在 2C4G 上那是重启级事故。上限=1 万 key 时最坏占用
 *   仍以百 KB 计，质变。
 *
 * ── 超限时的驱逐策略（为什么是 LRU 而不是「谁最老谁走」）─────────────────
 *   满员时先删「已过窗口」的 key（免费内存），再按「最后一次命中时刻」从早
 *   到晚驱逐。一次性攻击 key 只命中过一次，会随时间老化 → 永远最先被驱逐；
 *   活跃用户的 key 刚刚命中过，last-at 是现在 → 不受影响。
 */
export const LOGIN_RATE_LIMITER_MAX_KEYS = 10_000
export const LOGIN_RATE_LIMITER_CLEANUP_INTERVAL_MS = 30_000

export interface RateVerdict {
  allowed: boolean
  /** 还要等几秒（`allowed=false` 时有效，向上取整，最少 1）。 */
  retryAfterSeconds: number
}

/** 单个 key 的命中时刻（毫秒）。用数组而不是计数器：滑动窗口需要"哪一次最老"。 */
type Hits = number[]

@Injectable()
export class LoginRateLimiter implements OnModuleDestroy {
  private readonly hits = new Map<string, Hits>()

  /** 周期清理器（`unref`：不阻塞进程退出；`onModuleDestroy` 里显式清掉）。 */
  private readonly cleanupTimer: NodeJS.Timeout

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.sweep(Date.now()),
      LOGIN_RATE_LIMITER_CLEANUP_INTERVAL_MS
    )
    this.cleanupTimer.unref()
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer)
  }

  /**
   * 记一次尝试并返回是否放行。
   *
   * ★ **先判后记**：被拒的请求**不**写入时间戳（否则持续攻击会让窗口永远满，
   *   正常用户在攻击结束后还要多等一分钟 —— 那是把惩罚落在受害者身上）。
   *   代价是"被拒的请求不消耗额度"，所以攻击者可以一直打，但**打不出结果**：
   *   目标已经达成（不放大到微信）。
   *
   * ★ 容量保护（抗压加固）：key 数到达上限时先清过期、再按 LRU 驱逐。
   *   驱逐**先于**本次记账 —— 保证 Map 永不超出上限（内存有硬顶）。
   */
  consume(key: string, limit: number, now: Date): RateVerdict {
    const nowMs = now.getTime()
    const windowStart = nowMs - LOGIN_RATE_WINDOW_MS

    if (this.hits.size >= LOGIN_RATE_LIMITER_MAX_KEYS) {
      this.evictExpired(nowMs)
      if (this.hits.size >= LOGIN_RATE_LIMITER_MAX_KEYS) {
        this.evictOldest(nowMs, Math.max(1, Math.ceil(LOGIN_RATE_LIMITER_MAX_KEYS / 10)))
      }
    }

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

  /**
   * 删除所有「窗口内已经没有任何命中」的 key（免费内存，先于 LRU 驱逐执行）。
   *
   * 数组按时间升序存 → 判空只看最后一个元素是否在窗口内。若 key 只擦过
   * 窗口边缘（首元素过期而尾元素未过），顺手重跑一次过滤，保持数组紧凑。
   */
  private evictExpired(nowMs: number): void {
    const windowStart = nowMs - LOGIN_RATE_WINDOW_MS
    for (const [key, arr] of this.hits) {
      const last = arr[arr.length - 1]
      if (last === undefined || last <= windowStart) {
        this.hits.delete(key)
        continue
      }
      const first = arr[0]
      if (first !== undefined && first <= windowStart) {
        const recent = arr.filter((at) => at > windowStart)
        if (recent.length === 0) {
          this.hits.delete(key)
        } else {
          arr.length = 0
          arr.push(...recent)
        }
      }
    }
  }

  /**
   * 容量仍超限时的兜底：按「最后一次命中」从早到晚驱逐 `count` 个 key（LRU）。
   *
   * 已经过期的 key 在此直接删除（顺路）。驱逐目标是最久没再命中的 ——
   * 攻击者批量制造的一次性 key 只命中过一次、一直在老化，永远排在最前；
   * 活跃用户的 key 刚刚命中，last-at 是现在，不会撞上。
   */
  private evictOldest(nowMs: number, count: number): void {
    const windowStart = nowMs - LOGIN_RATE_WINDOW_MS
    const byLastAt: Array<[key: string, lastAt: number]> = []
    for (const [key, arr] of this.hits) {
      const last = arr[arr.length - 1]
      if (last === undefined || last <= windowStart) {
        this.hits.delete(key)
        continue
      }
      byLastAt.push([key, last])
    }
    byLastAt.sort((a, b) => a[1] - b[1])
    const victims = Math.min(count, byLastAt.length)
    for (let i = 0; i < victims; i++) {
      this.hits.delete(byLastAt[i][0])
    }
  }

  /** 只给用例用：当前 key 数（抗压用例断言内存上限，生产路径不取）。 */
  keyCount(): number {
    return this.hits.size
  }

  /**
   * 驱逐一轮过期 key。周期清理定时器与抗压用例共用同一入口 ——
   * 「测的就是在跑的那份逻辑」，不许再写一份测试专用的清理。
   */
  sweep(nowMs: number): void {
    this.evictExpired(nowMs)
  }

  /** 只给用例用：清空（进程内单例在多个 `describe` 之间会互相影响）。 */
  reset(): void {
    this.hits.clear()
  }
}

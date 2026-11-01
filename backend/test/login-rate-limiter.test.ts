/**
 * login-rate-limiter.test.ts —— **限流器 hits Map 的内存上限**抗压单测（2026-11-01）
 *
 * ── 在修什么 ─────────────────────────────────────────────────────────────
 *   `hits` Map 原来只增不删：key 由客户端自报的 IP / deviceId 组成（可伪造），
 *   攻击者随机换 `deviceId` 灌请求即可让 Map 无界增长 —— 1 万 req/s 下一分钟
 *   约 150–200MB，在 2C4G 上是重启级事故（见 `login-rate-limiter.ts` 文件头）。
 *   加固后：key 数上限 `LOGIN_RATE_LIMITER_MAX_KEYS`，满了先清过期、再按 LRU
 *   兜底驱逐；周期清理器每 30s 过一遍（测试经 `sweep()` 同入口验证）。
 *
 * ── 三条用例各钉什么 ─────────────────────────────────────────────────────
 *   ① 灌 2×上限的一次性 key：`keyCount()` 每一步都断言不超上限 —— 内存硬顶；
 *   ② 窗口内灌爆后，活跃用户下一笔仍放行 —— 驱逐只重置额度、绝不清成拒绝；
 *   ③ `sweep()`（即周期清理）能回收窗口外的 key —— Map 会回缩，不只涨不落。
 *
 * ── 与集成测试的分工 ─────────────────────────────────────────────────────
 *   `test/identity-http.test.ts` 证「限流真的挡在 /auth/login 上（429）」；
 *   本文件只钉「内存不爆」这一层，两者都不碰真微信。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import {
  LoginRateLimiter,
  LOGIN_RATE_LIMITER_MAX_KEYS,
  LOGIN_RATE_WINDOW_MS
} from '../src/identity/login-rate-limiter'

describe('LoginRateLimiter 抗压加固：hits Map 内存上限', () => {
  const T0 = Date.UTC(2026, 10, 1, 0, 0, 0, 0)
  const limiter = new LoginRateLimiter()

  before(() => limiter.reset())
  after(() => limiter.reset())

  it(`灌 ${LOGIN_RATE_LIMITER_MAX_KEYS * 2} 个一次性 deviceId，key 数恒不超上限`, () => {
    for (let i = 0; i < LOGIN_RATE_LIMITER_MAX_KEYS * 2; i++) {
      limiter.check({ deviceId: `batch-${i}` }, new Date(T0 + i))
      assert.ok(
        limiter.keyCount() <= LOGIN_RATE_LIMITER_MAX_KEYS,
        `第 ${i} 个 key 灌入后 size=${limiter.keyCount()} 已超上限`
      )
    }
  })

  it('窗口内灌爆后，活跃用户仍能放行（不被攻击流量挤成拒绝）', () => {
    limiter.reset()

    // 活跃用户窗口内正在用：先占 8 次额度（limit=10）。
    for (let i = 0; i < 8; i++) {
      assert.equal(limiter.check({ deviceId: 'active-family' }, new Date(T0 + i)), null)
    }

    // 攻击者在同一窗口内（T0+10s 起）灌 2×上限个一次性 deviceId。
    for (let i = 0; i < LOGIN_RATE_LIMITER_MAX_KEYS * 2; i++) {
      limiter.check({ deviceId: `flood-${i}` }, new Date(T0 + 10_000 + i))
    }

    // 活跃用户下一笔必须放行（被驱逐 ⇒ 额度重置；没被驱逐 ⇒ 还有 2 次额度）。
    const verdict = limiter.check({ deviceId: 'active-family' }, new Date(T0 + 60_000 - 5_000))
    assert.equal(verdict, null, '活跃用户在攻击灌爆后反而被拒了（被误伤）')
  })

  it('周期清理（sweep）能回收窗口外的 key，Map 会回缩', () => {
    limiter.reset()

    for (let i = 0; i < 500; i++) {
      limiter.check({ deviceId: `stale-${i}` }, new Date(T0 + i))
    }
    assert.equal(limiter.keyCount(), 500, '500 个窗口内 key 没全部记账')

    // 时间快进两个窗口，点一个新鲜 key 再 sweep —— stale 应全部过期回收。
    const later = T0 + LOGIN_RATE_WINDOW_MS * 2
    limiter.check({ deviceId: 'fresh' }, new Date(later))
    limiter.sweep(later)
    assert.ok(
      limiter.keyCount() < 500,
      `过期 key 没被回收，size=${limiter.keyCount()}（回调的时间基准没对齐？）`
    )
  })
})
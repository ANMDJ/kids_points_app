/**
 * kid-mode-policy.test.ts —— 孩子模式的**规则内核**（W14，2026-11-03）
 *
 * 全部是纯函数，不需要 Nest、不需要库、不需要时钟：`now` 一律由用例给。
 * 逐条钉住 `docs/design/51-kid-mode-window.md` 的验收数字与三个边界：
 *   ① 1–30 分钟，默认 15；`31 / 0 / -1 / 小数 / NaN` 的夹法**互不相同**；
 *   ② 到期时刻是**绝对时刻**（`now + N 分钟`），不是"本地倒计时"；
 *   ③ `kidModeUntil === now` 即**已到期**（`locked`），**不是** `off` ——
 *      这是 A 方案的全部意义：到期不回家长模式；
 *   ④ 剩余秒数向上取整（与 `parent-mode.policy.ts` 同口径）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  KID_MODE_DEFAULT_MINUTES,
  KID_MODE_MAX_MINUTES,
  KID_MODE_MIN_MINUTES,
  clampKidModeMinutes,
  isKidModeDurationValid,
  kidModeExpiresAt,
  kidModeRemainingSeconds,
  kidModeStateOf
} from '../src/auth/kid-mode.policy'

const T0 = new Date('2026-11-03T10:00:00.000Z')

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs)
}

describe('常量：产品口径只有这一处', () => {
  it('一次 1–30 分钟，默认 15（不是"默认即上限"）', () => {
    assert.equal(KID_MODE_MIN_MINUTES, 1)
    assert.equal(KID_MODE_MAX_MINUTES, 30)
    assert.equal(KID_MODE_DEFAULT_MINUTES, 15)
  })
})

describe('isKidModeDurationValid：整数 1–30（DTO 用它写出 @Min/@Max）', () => {
  it('边界内为真', () => {
    for (const value of [1, 2, 15, 29, 30]) {
      assert.equal(isKidModeDurationValid(value), true, `value=${value}`)
    }
  })

  it('0 / 31 / 负数 / 小数 / NaN 一律为假', () => {
    for (const value of [0, 31, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(isKidModeDurationValid(value), false, `value=${String(value)}`)
    }
  })
})

describe('clampKidModeMinutes：服务端的最后一道夹子', () => {
  it('窗口内原样返回（取整）', () => {
    assert.equal(clampKidModeMinutes(1), 1)
    assert.equal(clampKidModeMinutes(15), 15)
    assert.equal(clampKidModeMinutes(30), 30)
    assert.equal(clampKidModeMinutes(20.9), 20)
  })

  it('31 ⇒ 30、0 / 负数 ⇒ 1（不因为"填错了"就多给时间）', () => {
    assert.equal(clampKidModeMinutes(31), 30)
    assert.equal(clampKidModeMinutes(999), 30)
    assert.equal(clampKidModeMinutes(0), 1)
    assert.equal(clampKidModeMinutes(-5), 1)
  })

  it('NaN / Infinity ⇒ 默认 15（解析失败不该自动拿到最大窗口）', () => {
    assert.equal(clampKidModeMinutes(Number.NaN), KID_MODE_DEFAULT_MINUTES)
    assert.equal(clampKidModeMinutes(Number.POSITIVE_INFINITY), KID_MODE_DEFAULT_MINUTES)
    assert.equal(clampKidModeMinutes(Number.NEGATIVE_INFINITY), KID_MODE_DEFAULT_MINUTES)
  })
})

describe('kidModeExpiresAt：绝对时刻，从"这次操作"起算', () => {
  it('15 分钟 ⇒ now + 900000ms', () => {
    assert.equal(kidModeExpiresAt(T0, 15).toISOString(), '2026-11-03T10:15:00.000Z')
  })

  it('夹子对它同样生效（内部不再有第二份上限）', () => {
    assert.equal(kidModeExpiresAt(T0, 31).toISOString(), '2026-11-03T10:30:00.000Z')
  })

  it('是新对象（不原地改 now）', () => {
    const expiresAt = kidModeExpiresAt(T0, 15)
    assert.notEqual(expiresAt, T0)
    assert.equal(T0.toISOString(), '2026-11-03T10:00:00.000Z')
  })
})

describe('kidModeStateOf：三态与到期边界', () => {
  it('null ⇒ off（没开过 / 已被 PIN 收回）', () => {
    assert.equal(kidModeStateOf(null, T0), 'off')
  })

  it('窗口内 ⇒ active（1ms 也算）', () => {
    assert.equal(kidModeStateOf(at(1), T0), 'active')
    assert.equal(kidModeStateOf(at(15 * 60_000), T0), 'active')
  })

  it('★ 边界：kidModeUntil === now ⇒ locked（不是 off、也不回家长模式）', () => {
    assert.equal(kidModeStateOf(at(0), T0), 'locked')
  })

  it('已经过去 ⇒ 仍然是 locked（等家长输 PIN）', () => {
    assert.equal(kidModeStateOf(at(-1), T0), 'locked')
    assert.equal(kidModeStateOf(at(-86_400_000), T0), 'locked')
  })

  it('接受 ISO 字符串以外的 Date（Prisma 给的就是 Date）', () => {
    assert.equal(kidModeStateOf(new Date('2026-11-03T10:05:00.000Z'), T0), 'active')
  })
})

describe('kidModeRemainingSeconds：向上取整，过期即 0', () => {
  it('整分钟', () => {
    assert.equal(kidModeRemainingSeconds(at(15 * 60_000), T0), 900)
  })

  it('不足一秒向上取整（否则倒计时会跳）', () => {
    assert.equal(kidModeRemainingSeconds(at(1), T0), 1)
    assert.equal(kidModeRemainingSeconds(at(999), T0), 1)
    assert.equal(kidModeRemainingSeconds(at(1_001), T0), 2)
  })

  it('到期 / 过期 / 没开 ⇒ 0', () => {
    assert.equal(kidModeRemainingSeconds(at(0), T0), 0)
    assert.equal(kidModeRemainingSeconds(at(-1), T0), 0)
    assert.equal(kidModeRemainingSeconds(null, T0), 0)
  })
})

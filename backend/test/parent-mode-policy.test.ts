/**
 * parent-mode-policy.test.ts —— 家长模式 / 家长 PIN 的**规则内核**（W8-C，2026-10-27）
 *
 * 全部是纯函数，不需要 Nest、不需要库、不需要时钟：`now` 一律由用例给。
 * 逐条钉住 `docs/design/02` §7 / §9.18 的**验收数字**与三个刻意的边界口径：
 *   ① TTL 5 分钟，`expiresAt === now` **已过期**（与 `session.gate.ts` 同一个边界）；
 *   ② 连错 5 次 ⇒ 锁 15 分钟，**达阈值时计数清零**（否则解锁后一错又锁，形同永久锁死）；
 *   ③ 锁的边界与 TTL **相反**：`pinLockedUntil === now` 即**已解锁**
 *      （"锁到此刻为止"，到点就该能试）。
 *
 * ★ 这里**不**证明「格式错的 PIN 不计次」—— 那条在 `auth.service.ts` 的分支里
 *   （`isPinFormatValid()` 为假时根本不调用 `recordPinFailure`），
 *   由 `auth-http.test.ts` 的组 D 从 HTTP 侧验证。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PARENT_MODE_TTL_MS,
  PIN_LOCK_MS,
  PIN_MAX_FAILURES,
  isPinLocked,
  lockRemainingSeconds,
  nextPinFailureState,
  parentModeExpiresAt,
  parentModeSourceOf,
  remainingAttempts,
  remainingSeconds
} from '../src/auth/parent-mode.policy'

const T0 = new Date('2026-10-27T10:00:00.000Z')

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs)
}

describe('常量：规格里的数字只有这一处', () => {
  it('家长模式 5 分钟（02 §7）', () => {
    assert.equal(PARENT_MODE_TTL_MS, 5 * 60 * 1000)
  })

  it('连错 5 次、锁 15 分钟（§9.18）', () => {
    assert.equal(PIN_MAX_FAILURES, 5)
    assert.equal(PIN_LOCK_MS, 15 * 60 * 1000)
  })
})

describe('parentModeExpiresAt：TTL 从"这次操作的那一刻"起算', () => {
  it('now + 5 分钟', () => {
    assert.equal(parentModeExpiresAt(T0).toISOString(), '2026-10-27T10:05:00.000Z')
  })

  it('是**新对象**（不原地改 now —— 否则调用方手里的 now 会被悄悄推后）', () => {
    const expiresAt = parentModeExpiresAt(T0)
    assert.notEqual(expiresAt, T0)
    assert.equal(T0.toISOString(), '2026-10-27T10:00:00.000Z')
  })
})

describe('remainingSeconds：向上取整，过期即 0', () => {
  it('整 5 分钟 ⇒ 300', () => {
    assert.equal(remainingSeconds(at(PARENT_MODE_TTL_MS), T0), 300)
  })

  it('剩 0.3 秒 ⇒ 1（不是 0：还没过期就不能显示"已结束"）', () => {
    assert.equal(remainingSeconds(at(300), T0), 1)
  })

  it('剩 4 分 0.3 秒 ⇒ 241（向上取整，倒计时不会在 04:00 之后跳一下）', () => {
    assert.equal(remainingSeconds(at(240_300), T0), 241)
  })

  it('★ 边界：expiresAt === now ⇒ 0（与 isSessionActive 同一口径）', () => {
    assert.equal(remainingSeconds(T0, T0), 0)
  })

  it('已经过期 ⇒ 0，不是负数', () => {
    assert.equal(remainingSeconds(at(-60_000), T0), 0)
  })
})

describe('parentModeSourceOf：超过 5 分钟的剩余时间只可能来自登录会话', () => {
  it('正好 TTL ⇒ pin（PIN 路径写进库的就是 now+5min）', () => {
    assert.equal(parentModeSourceOf(at(PARENT_MODE_TTL_MS), T0), 'pin')
  })

  it('★ 多 1 毫秒 ⇒ session（邀请码加入的家长设备：30 天登录会话）', () => {
    assert.equal(parentModeSourceOf(at(PARENT_MODE_TTL_MS + 1), T0), 'session')
    // 客户端据此做交叉校验：`session ⇒ remainingSeconds > 300`，两边必须对得上。
    assert.equal(remainingSeconds(at(PARENT_MODE_TTL_MS + 1), T0), 301)
  })

  it('30 天 ⇒ session；剩 1 秒 ⇒ pin（来源只看剩余长度）', () => {
    assert.equal(parentModeSourceOf(at(30 * 24 * 60 * 60 * 1000), T0), 'session')
    assert.equal(parentModeSourceOf(at(1000), T0), 'pin')
  })
})

describe('isPinLocked / lockRemainingSeconds', () => {
  it('null ⇒ 未锁定', () => {
    assert.equal(isPinLocked(null, T0), false)
    assert.equal(lockRemainingSeconds(null, T0), 0)
  })

  it('锁到未来 ⇒ 锁定中', () => {
    assert.equal(isPinLocked(at(PIN_LOCK_MS), T0), true)
    assert.equal(lockRemainingSeconds(at(PIN_LOCK_MS), T0), 900)
  })

  it('★ 边界：lockedUntil === now ⇒ 已解锁（"锁到此刻为止"，与 TTL 相反的视角）', () => {
    assert.equal(isPinLocked(T0, T0), false)
    assert.equal(lockRemainingSeconds(T0, T0), 0)
  })

  it('锁定时间已过 ⇒ 已解锁', () => {
    assert.equal(isPinLocked(at(-1), T0), false)
  })
})

describe('remainingAttempts：给界面看的"还剩 N 次"', () => {
  it('0 次失败 ⇒ 5', () => {
    assert.equal(remainingAttempts(0), 5)
  })

  it('4 次失败 ⇒ 1（下一次错就锁）', () => {
    assert.equal(remainingAttempts(4), 1)
  })

  it('5 / 99 次 ⇒ 0，不是负数', () => {
    assert.equal(remainingAttempts(5), 0)
    assert.equal(remainingAttempts(99), 0)
  })

  it('负数（数据病）⇒ 仍按 5 算，绝不放大成 >5', () => {
    assert.equal(remainingAttempts(-3), 5)
  })
})

describe('nextPinFailureState：一次"格式合法但值不对"之后', () => {
  it('第 1 次 ⇒ count=1，lockedUntil 明确为 null（清掉可能残留的旧锁定）', () => {
    const outcome = nextPinFailureState(0, T0)
    assert.deepEqual(outcome, { failedCount: 1, lockedUntil: null, justLocked: false })
  })

  it('第 2 / 3 / 4 次 ⇒ 逐次 +1，都不锁', () => {
    assert.equal(nextPinFailureState(1, T0).failedCount, 2)
    assert.equal(nextPinFailureState(2, T0).failedCount, 3)
    const fourth = nextPinFailureState(3, T0)
    assert.equal(fourth.failedCount, 4)
    assert.equal(fourth.lockedUntil, null)
    assert.equal(fourth.justLocked, false)
  })

  it('★ 第 5 次 ⇒ 计数**清零** + 锁到 now+15min + justLocked', () => {
    const outcome = nextPinFailureState(4, T0)
    assert.equal(outcome.failedCount, 0)
    assert.equal(outcome.lockedUntil?.toISOString(), '2026-10-27T10:15:00.000Z')
    assert.equal(outcome.justLocked, true)
  })

  it('★ 清零是为了"解锁后从 0 重新数"：解锁后再错一次 ⇒ count=1，不是立刻再锁', () => {
    const locked = nextPinFailureState(4, T0)
    const afterUnlock = nextPinFailureState(locked.failedCount, at(PIN_LOCK_MS))
    assert.equal(afterUnlock.failedCount, 1)
    assert.equal(afterUnlock.lockedUntil, null)
  })

  it('计数已经超过阈值（数据病）⇒ 仍然只锁一次，不会累加成 30 分钟', () => {
    const outcome = nextPinFailureState(12, T0)
    assert.equal(outcome.failedCount, 0)
    assert.equal(outcome.lockedUntil?.toISOString(), '2026-10-27T10:15:00.000Z')
  })

  it('负数基数（数据病）⇒ 当成 0，第一次失败就是 1', () => {
    assert.equal(nextPinFailureState(-5, T0).failedCount, 1)
  })
})

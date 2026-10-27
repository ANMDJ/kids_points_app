/**
 * deletion-policy.test.ts —— 家庭数据删除的**纯规则**（W7-D，2026-10-27）
 *
 * 这里断言的都是「不需要数据库、不需要时钟」的事实：
 *   · 冷却期 = 7 天，截止时刻 = 申请时刻 + 7 天；
 *   · 「还剩几天」向上取整（0.2 天要说 1 天，不能说 0 天）；
 *   · `toDeletionState()` 的时间一律 ISO、`null` 不塌缩、只有 pending 能撤销；
 *   · 落库摘要形状不符 ⇒ `null`（**不猜**）；
 *   · `redactPayload()` 只抹描述性叶子，保留 key / 数值 / 数组形状。
 *
 * ★ 这些函数不读 `new Date()`，所以「7 天」这条承诺可以被逐毫秒钉住；
 *   若把时钟塞进函数内部，测试就只能断言「大约」。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  coolingDeadline,
  daysRemaining,
  DELETION_KEPT_NOTE,
  parseSummary,
  redactPayload,
  toDeletionState,
  type DeletionRequestRow
} from '../src/deletion/deletion.policy'
import {
  FAMILY_DELETION_COOLING_DAYS,
  REDACTED_TEXT,
  type FamilyDeletionSummary
} from '../src/deletion/deletion.repository'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-27T00:00:00.000Z')

function row(overrides: Partial<DeletionRequestRow> = {}): DeletionRequestRow {
  return {
    id: 'req-1',
    status: 'pending',
    requestedAt: NOW,
    scheduledFor: new Date(NOW.getTime() + 7 * DAY_MS),
    cancelledAt: null,
    executedAt: null,
    summary: null,
    ...overrides
  }
}

function summary(): FamilyDeletionSummary {
  return {
    coolingDays: 7,
    redacted: {
      child: 1,
      members: 2,
      rules: 1,
      ruleVersions: 3,
      habits: 1,
      wishes: 1,
      records: 4,
      approvals: 1,
      consents: 1,
      notifications: 2
    },
    kept: { records: 4, pointsBalance: 12 },
    note: DELETION_KEPT_NOTE
  }
}

describe('冷却期：7 天，且截止时刻是算术而不是「大约」', () => {
  it('常数就是 7（改它必须同时改文档与双端文案）', () => {
    assert.equal(FAMILY_DELETION_COOLING_DAYS, 7)
  })

  it('coolingDeadline：申请时刻 + 7×24h（含跨月）', () => {
    assert.equal(coolingDeadline(NOW).toISOString(), '2026-11-03T00:00:00.000Z')
    assert.equal(
      coolingDeadline(new Date('2026-12-28T10:00:00.000Z')).toISOString(),
      '2027-01-04T10:00:00.000Z'
    )
  })

  it('daysRemaining：向上取整；到期 / 过期固定 0（worker 可能还没跑）', () => {
    assert.equal(daysRemaining(new Date(NOW.getTime() + 7 * DAY_MS), NOW), 7)
    // 6 天零 1 毫秒 ⇒ 仍要说 7 天：说 6 会让家长以为比实际更早执行。
    assert.equal(daysRemaining(new Date(NOW.getTime() + 6 * DAY_MS + 1), NOW), 7)
    assert.equal(daysRemaining(new Date(NOW.getTime() + DAY_MS / 2), NOW), 1)
    assert.equal(daysRemaining(NOW, NOW), 0)
    assert.equal(daysRemaining(new Date(NOW.getTime() - DAY_MS), NOW), 0)
  })
})

describe('toDeletionState：时间 ISO、null 不塌缩、只有 pending 能撤销', () => {
  it('没有请求 ⇒ none（不是一条空 pending）', () => {
    assert.deepEqual(toDeletionState('child-1', null, NOW), {
      childId: 'child-1',
      status: 'none',
      requestedAt: null,
      scheduledFor: null,
      cancelledAt: null,
      executedAt: null,
      daysRemaining: null,
      canCancel: false,
      summary: null
    })
  })

  it('pending ⇒ 给出剩余天数、可撤销、无摘要', () => {
    const state = toDeletionState('child-1', row(), NOW)
    assert.equal(state.status, 'pending')
    assert.equal(state.daysRemaining, 7)
    assert.equal(state.canCancel, true)
    assert.equal(state.summary, null)
    assert.equal(state.requestedAt, '2026-10-27T00:00:00.000Z')
    assert.equal(state.cancelledAt, null)
    assert.equal(state.executedAt, null)
  })

  it('cancelled ⇒ 保留撤销时刻、不可再撤销、无剩余天数', () => {
    const state = toDeletionState(
      'child-1',
      row({ status: 'cancelled', cancelledAt: new Date('2026-10-28T00:00:00.000Z') }),
      NOW
    )
    assert.equal(state.status, 'cancelled')
    assert.equal(state.canCancel, false)
    assert.equal(state.daysRemaining, null)
    assert.equal(state.cancelledAt, '2026-10-28T00:00:00.000Z')
  })

  it('executed ⇒ 回放摘要（形状不符则 null，绝不补默认值）', () => {
    const good = toDeletionState(
      'child-1',
      row({ status: 'executed', executedAt: NOW, summary: summary() }),
      NOW
    )
    assert.equal(good.canCancel, false)
    assert.deepEqual(good.summary, summary())
    assert.equal(good.summary?.kept.records, 4)

    const broken = toDeletionState(
      'child-1',
      row({ status: 'executed', executedAt: NOW, summary: { coolingDays: 7 } }),
      NOW
    )
    assert.equal(broken.summary, null)
  })
})

describe('parseSummary：只认完整形状', () => {
  it('完整对象 ⇒ 原样（含 0 行也是合法数字）', () => {
    const zero = summary()
    zero.redacted.members = 0
    assert.deepEqual(parseSummary(zero), zero)
  })

  it('缺字段 / 类型不对 / 数组 / null ⇒ null', () => {
    const base = summary()
    assert.equal(parseSummary(null), null)
    assert.equal(parseSummary([]), null)
    assert.equal(parseSummary('executed'), null)
    assert.equal(parseSummary({ ...base, coolingDays: '7' }), null)
    assert.equal(parseSummary({ ...base, redacted: { ...base.redacted, rules: undefined } }), null)
    assert.equal(parseSummary({ ...base, kept: { records: 1 } }), null)
    assert.equal(parseSummary({ ...base, note: 1 }), null)
  })
})

describe('redactPayload：抹掉「写了什么」，保留「发生了什么」', () => {
  it('顶层描述性文本被替换；数值 / id / 布尔原样', () => {
    assert.deepEqual(
      redactPayload({ wishId: 'w-1', costSnapshot: 20, approved: true, note: '想去看电影' }),
      { wishId: 'w-1', costSnapshot: 20, approved: true, note: REDACTED_TEXT }
    )
  })

  it('嵌套对象与数组：形状不变，叶子被抹（数组仍是数组）', () => {
    assert.deepEqual(
      redactPayload({
        rule: { title: '完成作业', points: 3, tags: ['study', 'chores'] },
        list: [{ name: '小满' }, 7, null]
      }),
      {
        rule: { title: REDACTED_TEXT, points: 3, tags: [REDACTED_TEXT, REDACTED_TEXT] },
        list: [{ name: REDACTED_TEXT }, 7, null]
      }
    )
  })

  it('★ 白名单是 fail-closed：没见过的字段一律抹（新增字段不会悄悄漏出去）', () => {
    assert.deepEqual(
      redactPayload({ childName: '小满', futureFreeText: '随便写的', threshold: 5 }),
      { childName: REDACTED_TEXT, futureFreeText: REDACTED_TEXT, threshold: 5 }
    )
  })

  it('null / 数值原样（不把「没有 payload」变成一段文本）', () => {
    assert.equal(redactPayload(null), null)
    assert.equal(redactPayload(3), 3)
  })
})

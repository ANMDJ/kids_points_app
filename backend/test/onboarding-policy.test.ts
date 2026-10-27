/**
 * onboarding-policy.test.ts —— 首启引导的**纯规则**（W8-A，2026-10-27）
 *
 * ── 它与另外三份用例的分工 ──────────────────────────────────────────────────
 *   · **本文件**：排序 / 去重 / 合并 / PIN 格式 / 哈希可验回 —— 无 IO、无 Nest；
 *   · `test/onboarding-http.test.ts`：真 HTTP，端口是替身（屏障 / 闸门 / 400 / 409）；
 *   · `test/onboarding-wiring.test.ts`：装配与守卫元数据；
 *   · `test-db/onboarding-db.dbtest.ts`：真库（规则 / v1 版本行 / 审计 / TOCTOU）。
 *
 * ── 为什么排序要在这里逐级证 ────────────────────────────────────────────────
 *   `rankTemplates` 的比较链有四段。若只在 HTTP 层断言「第一个是 X」，那么
 *   删掉第 3、4 段也可能恰好通过（数据碰巧不并列）。这里的用例**故意造并列**
 *   （同分 / 同命中），让每一级都被单独钉住；最后一条还证明**输入数组不被改写**。
 *
 * ── 为什么 PIN 哈希也要单测 ──────────────────────────────────────────────────
 *   `ChildMember` 只有 `pinHash` 一列（无独立 salt），所以「写进去的字符串能不能
 *   验回原 PIN」是**格式是否正确**的唯一证据。只断言「以 scrypt$ 开头」会放过
 *   「salt 常量 / 长度算错」这类 bug —— 那种哈希永远验不过，而用户只会看到
 *   「PIN 不对」。`verifyPin` 目前**只有测试在用**（切家长模式端点本轮未实现）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AgeBand } from '@prisma/client'

import {
  AGE_BANDS,
  FOCUS_AREAS,
  isAgeBandName,
  isFocusAreaName
} from '../src/contracts/onboarding'
import {
  FOCUS_AREA_COUNT,
  PIN_PATTERN,
  isKnownAgeBand,
  isPinFormatValid,
  mergeProfile,
  normalizeFocusAreas,
  normalizeTemplateSlugs,
  rankTemplates,
  type RuleTemplateRow
} from '../src/onboarding/onboarding.policy'
import {
  PIN_HASH_PREFIX,
  PIN_KEY_LENGTH,
  PIN_SCRYPT_N,
  PIN_SCRYPT_P,
  PIN_SCRYPT_R,
  hashPin,
  pinAuditValue,
  verifyPin
} from '../src/onboarding/pin-hash'

function row(slug: string, overrides: Partial<RuleTemplateRow> = {}): RuleTemplateRow {
  return {
    slug,
    title: `约定 ${slug}`,
    condition: `条件 ${slug}`,
    dailyLimit: 1,
    points: 2,
    direction: 'reward',
    icon: 'star',
    color: '#7bb0e8',
    ageBand: 'primary_low',
    focusAreas: [],
    sortWeight: 0,
    ...overrides
  }
}

const slugsOf = (rows: readonly RuleTemplateRow[]): string[] => rows.map((item) => item.slug)

// ══ 契约常量 ═══════════════════════════════════════════════════════════════════
describe('契约：学段 / 关注点', () => {
  it('4 个学段与 Prisma enum AgeBand 逐字一致（schema 改了这里必须红）', () => {
    assert.deepEqual([...AGE_BANDS].sort(), Object.keys(AgeBand).sort())
  })

  it('6 个关注点，唯一且非空（改名等于改数据，只允许追加）', () => {
    assert.equal(FOCUS_AREA_COUNT, 6)
    assert.equal(FOCUS_AREAS.length, 6)
    assert.equal(new Set(FOCUS_AREAS).size, 6)
    assert.equal(FOCUS_AREAS.every((area) => area.trim().length > 0), true)
  })

  it('isAgeBandName / isKnownAgeBand 只认枚举值', () => {
    assert.equal(isAgeBandName('preschool'), true)
    assert.equal(isAgeBandName('phd'), false)
    assert.equal(isKnownAgeBand('junior_high'), true)
    assert.equal(isKnownAgeBand('primary_mid'), false)
  })

  it('isFocusAreaName 只认 6 个标签（大小写 / 空格都不放宽）', () => {
    assert.equal(isFocusAreaName('阅读'), true)
    assert.equal(isFocusAreaName(' 阅读'), false)
    assert.equal(isFocusAreaName('打游戏'), false)
  })
})

// ══ 排序 ═══════════════════════════════════════════════════════════════════════
describe('rankTemplates：四级比较链', () => {
  it('第 1 级：学段精确相等优先，即使对方 sortWeight 更高', () => {
    const rows = [
      row('other-heavy', { ageBand: 'primary_high', sortWeight: 999 }),
      row('wanted-light', { ageBand: 'primary_low', sortWeight: 1 })
    ]
    assert.deepEqual(
      slugsOf(rankTemplates(rows, { ageBand: 'primary_low', focusAreas: [] })),
      ['wanted-light', 'other-heavy']
    )
  })

  it('第 1 级是**排序**不是过滤：其它学段仍然出现（幼儿园家长看不到空白列表）', () => {
    const rows = [
      row('preschool-only', { ageBand: 'preschool' }),
      row('junior', { ageBand: 'junior_high' })
    ]
    const ranked = rankTemplates(rows, { ageBand: 'preschool', focusAreas: [] })
    assert.equal(ranked.length, 2)
    assert.deepEqual(slugsOf(ranked), ['preschool-only', 'junior'])
  })

  it('第 2 级：同一学段内，关注点命中数降序', () => {
    const rows = [
      row('one-hit', { focusAreas: ['阅读'], sortWeight: 500 }),
      row('two-hits', { focusAreas: ['阅读', '运动'], sortWeight: 1 }),
      row('no-hit', { focusAreas: ['家务'], sortWeight: 900 })
    ]
    assert.deepEqual(
      slugsOf(rankTemplates(rows, { ageBand: null, focusAreas: ['阅读', '运动'] })),
      ['two-hits', 'one-hit', 'no-hit']
    )
  })

  it('第 3 级：命中数相同 ⇒ sortWeight 降序', () => {
    const rows = [
      row('light', { focusAreas: ['阅读'], sortWeight: 10 }),
      row('heavy', { focusAreas: ['阅读'], sortWeight: 90 })
    ]
    assert.deepEqual(
      slugsOf(rankTemplates(rows, { ageBand: null, focusAreas: ['阅读'] })),
      ['heavy', 'light']
    )
  })

  it('第 4 级：全并列 ⇒ slug 升序（同一份输入两次调用顺序必须相同）', () => {
    const rows = [
      row('c', { sortWeight: 50 }),
      row('a', { sortWeight: 50 }),
      row('b', { sortWeight: 50 })
    ]
    assert.deepEqual(slugsOf(rankTemplates(rows, { ageBand: null, focusAreas: [] })), [
      'a',
      'b',
      'c'
    ])
  })

  it('未选学段 / 关注点 ⇒ 等价于纯 sortWeight 降序（③④ 可跳过的语义）', () => {
    const rows = [
      row('low', { sortWeight: 1, ageBand: 'preschool' }),
      row('high', { sortWeight: 100, ageBand: 'junior_high' }),
      row('mid', { sortWeight: 50, ageBand: 'primary_high' })
    ]
    assert.deepEqual(slugsOf(rankTemplates(rows, { ageBand: null, focusAreas: [] })), [
      'high',
      'mid',
      'low'
    ])
  })

  it('不改写入参数组（否则缓存同一份模板会被悄悄重排）', () => {
    const rows = [row('b', { sortWeight: 1 }), row('a', { sortWeight: 2 })]
    const before = slugsOf(rows)
    rankTemplates(rows, { ageBand: null, focusAreas: [] })
    assert.deepEqual(slugsOf(rows), before)
  })
})

// ══ 去重 ═══════════════════════════════════════════════════════════════════════
describe('normalizeFocusAreas：保序去重 + 静默丢弃未知值', () => {
  it('保持提交顺序并去重（多选器的顺序就是家长看到的顺序）', () => {
    assert.deepEqual(normalizeFocusAreas(['运动', '阅读', '运动', '家务']), ['运动', '阅读', '家务'])
  })

  it('未知标签被丢弃，合法值仍保留（库里的旧数据不应让整次读取变红）', () => {
    assert.deepEqual(normalizeFocusAreas(['打游戏', '阅读', 'phd']), ['阅读'])
  })

  it('两端空白被 trim 后再判合法性', () => {
    assert.deepEqual(normalizeFocusAreas(['  阅读  ']), ['阅读'])
  })

  it('空数组 ⇒ 空数组（「一个都不选」是合法意图）', () => {
    assert.deepEqual(normalizeFocusAreas([]), [])
  })
})

describe('normalizeTemplateSlugs：保序去重，空白项直接丢弃', () => {
  it('去重保序（重复采纳会重复生成规则，必须先在这里收口）', () => {
    assert.deepEqual(normalizeTemplateSlugs(['a', 'b', 'a']), ['a', 'b'])
  })

  it('空串 / 纯空白 ⇒ 丢弃（不是「模板名叫空」）', () => {
    assert.deepEqual(normalizeTemplateSlugs(['', '   ', 'a']), ['a'])
  })

  it('不校验存在性 —— 那是仓储层在事务内的事（防 TOCTOU）', () => {
    assert.deepEqual(normalizeTemplateSlugs(['not-in-db']), ['not-in-db'])
  })

  it('全空白 ⇒ 空数组（service 据此 400 ONBOARDING_NO_TEMPLATE）', () => {
    assert.deepEqual(normalizeTemplateSlugs(['  ', '']), [])
  })
})


// ══ 合并 ═══════════════════════════════════════════════════════════════════════
describe('mergeProfile：undefined 沿用 / null 清空 / [] 一个都不选', () => {
  it('两个字段都 undefined ⇒ 完全沿用（只改一步不该抹掉另一步）', () => {
    assert.deepEqual(mergeProfile(undefined, 'primary_low', undefined, ['阅读']), {
      ageBand: 'primary_low',
      focusAreas: ['阅读']
    })
  })

  it('ageBand: null ⇒ 显式清空（从已选退回未选择）', () => {
    assert.deepEqual(mergeProfile(null, 'primary_low', undefined, ['阅读']), {
      ageBand: null,
      focusAreas: ['阅读']
    })
  })

  it('focusAreas: [] ⇒ 清空（与 undefined 不同：这是「一个都不选」）', () => {
    assert.deepEqual(mergeProfile(undefined, 'primary_low', [], ['阅读']), {
      ageBand: 'primary_low',
      focusAreas: []
    })
  })

  it('本次提交优先，并顺手清洗（trim / 去重 / 剔非法）', () => {
    assert.deepEqual(
      mergeProfile('junior_high', 'primary_low', [' 运动 ', '运动', '打游戏'], ['阅读']),
      { ageBand: 'junior_high', focusAreas: ['运动'] }
    )
  })

  it('库里的关注点是**拷贝**，不是同一个数组引用', () => {
    const stored = ['阅读']
    const merged = mergeProfile(undefined, null, undefined, stored)
    merged.focusAreas.push('运动')
    assert.deepEqual(stored, ['阅读'])
  })
})

// ══ PIN 格式与哈希 ══════════════════════════════════════════════════════════════
describe('PIN：4–6 位数字', () => {
  it('4 / 5 / 6 位通过', () => {
    for (const pin of ['1234', '12345', '123456']) {
      assert.equal(isPinFormatValid(pin), true, `${pin} 应通过`)
    }
  })

  it('3 位 / 7 位 / 非数字 / 空串 / 带空格 ⇒ 拒绝', () => {
    for (const pin of ['123', '1234567', 'abcd', '12a4', '', ' 1234', '1234 ']) {
      assert.equal(isPinFormatValid(pin), false, `${JSON.stringify(pin)} 不该通过`)
    }
  })

  it('PIN_PATTERN 是全串匹配（不是「包含 4 位数字」）', () => {
    assert.equal(PIN_PATTERN.source, '^\\d{4,6}$')
    assert.equal(PIN_PATTERN.test('x1234'), false)
  })
})

describe('pin-hash：自描述 scrypt 哈希能被验回', () => {
  it('格式为 scrypt$N$r$p$keylen$salt$hash，参数与常量一致', async () => {
    const hashed = await hashPin('1234')
    const parts = hashed.split('$')
    assert.equal(parts.length, 7)
    assert.equal(parts[0], PIN_HASH_PREFIX)
    assert.equal(Number(parts[1]), PIN_SCRYPT_N)
    assert.equal(Number(parts[2]), PIN_SCRYPT_R)
    assert.equal(Number(parts[3]), PIN_SCRYPT_P)
    assert.equal(Number(parts[4]), PIN_KEY_LENGTH)
    assert.equal(Buffer.from(parts[5], 'base64url').length, 16, '盐 16 字节')
    assert.equal(Buffer.from(parts[6], 'base64url').length, PIN_KEY_LENGTH)
  })

  it('哈希串里不含明文 PIN（4 位数字很容易被肉眼认出来）', async () => {
    const hashed = await hashPin('246810')
    assert.equal(hashed.includes('246810'), false)
  })

  it('verifyPin 对原 PIN 为 true，对其它 PIN 为 false', async () => {
    const hashed = await hashPin('1234')
    assert.equal(await verifyPin('1234', hashed), true)
    assert.equal(await verifyPin('4321', hashed), false)
    assert.equal(await verifyPin('12345', hashed), false)
  })

  it('同一 PIN 两次哈希不同（盐是随机的），但都能验回', async () => {
    const first = await hashPin('1234')
    const second = await hashPin('1234')
    assert.notEqual(first, second)
    assert.equal(await verifyPin('1234', first), true)
    assert.equal(await verifyPin('1234', second), true)
  })

  it('损坏的哈希 ⇒ false，不抛错（把损坏当匹配等于绕开 PIN）', async () => {
    for (const broken of [
      '',
      'scrypt',
      'scrypt$16384$8$1$32$only-five',
      'bcrypt$16384$8$1$32$c2FsdA$aGFzaA',
      'scrypt$NaN$8$1$32$c2FsdA$aGFzaA',
      'scrypt$16384$8$1$0$c2FsdA$aGFzaA'
    ]) {
      assert.equal(await verifyPin('1234', broken), false, JSON.stringify(broken))
    }
  })

  it('pinAuditValue 只回布尔 —— 不泄漏长度、不泄漏哈希', () => {
    assert.equal(pinAuditValue(null), false)
    assert.equal(pinAuditValue('scrypt$...'), true)
  })
})


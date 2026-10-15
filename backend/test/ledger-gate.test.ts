/**
 * ledger-gate.test.ts —— 账本内核（`ledger.gate.ts`）的**纯函数用例**（W2-A）
 *
 * ── 为什么账本内核要单独测（而不是等 W2-B 的真库用例顺带覆盖）──────────────────
 *   ① 真库用例只能喂**代表性**输入；而账本的病几乎全在**边界**上：
 *      余额恰好扣到 0、规则方向是 penalty、原记录被冲正过两次、同一毫秒的两笔……
 *      这些用真库每样造一遍既慢又容易漏，离线穷举才划算；
 *   ② 内核是**两端语义的收口处**（Taro / Flutter 的 `store.ts` / `app_store.dart`
 *      已经把语义定死了）。它错了，真库也会忠实地把错的东西存下来 —— 而且存得很好看。
 *   分工：本文件管「判定与构造对不对」；`02` §9.11–§9.14 的 I1–I6 真库套件（W2-B）
 *   管「落进 Postgres 之后还成立不成立」。
 *
 * ── 判据来源 ───────────────────────────────────────────────────────────────
 *   02 §5.1–§5.2（字段与快照）、§5.7（I1–I6）、§4.4（幂等）
 *   ＋ 前端修复台账 A1（负分被 `Math.abs` 抹平）、A4（流水硬编码"家长记录"）、
 *     B6（扣分静默截断 ⇒ 账本不平）、B7（删除式撤销 ⇒ 改冲正）、B8（标题被截断）。
 *
 * ── ★ 本文件刻意**不**断言"落库成功"────────────────────────────────────────
 *   内核只产出**草稿**。端口的默认实现是 501（组 G 钉住这件事）——
 *   "账本内核已落地"说的是判定语义，不是"积分已经能记账了"。
 *   W2-B 之后这条收窄了一层：**有** DATABASE_URL 时装配的是真 Prisma 适配器
 *   （读路径的约定见 `ledger-wiring.test.ts`），**没有**时仍是 501；
 *   而"接了真库真的通"由 `test-db/ledger-db.dbtest.ts` 组 J 在真库上证明。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NotImplementedException } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import {
  KNOWN_CATEGORIES,
  KNOWN_SOURCES,
  LedgerDeniedError,
  LedgerShapeError,
  assertSnapshotMatchesVersion,
  buildRecordDraft,
  findSnapshotMismatches,
  resolveBalanceAfter,
  reverseRecordDraft,
  signedDelta,
  verifyBalanceChain,
  type LedgerChainRow,
  type LedgerOperator,
  type PointRecordDraft,
  type RecordDraftInput,
  type ReversibleRecord,
  type RuleVersionSnapshot,
  type SnapshotLike
} from '../src/ledger/ledger.gate'
import { LedgerModule } from '../src/ledger/ledger.module'
import {
  LEDGER_REPOSITORY,
  NotImplementedLedgerRepository,
  type LedgerPort
} from '../src/ledger/ledger.repository'

const NOW = new Date('2026-10-15T09:00:00.000Z')
const GUARDIAN: LedgerOperator = { userId: 'u-dad', role: 'guardian' }
const CHILD: LedgerOperator = { userId: 'u-kid', role: 'child' }
const VIEWER: LedgerOperator = { userId: 'u-grandma', role: 'viewer' }

/** 一个合法的规则版本行（各用例按需改字段）。 */
function version(overrides: Partial<RuleVersionSnapshot> = {}): RuleVersionSnapshot {
  return {
    ruleId: 'rule-1',
    version: 1,
    title: '番茄钟写作业',
    condition: '专注 25 分钟',
    dailyLimit: 2,
    points: 1,
    direction: 'reward',
    ...overrides
  }
}

/** 合法的打卡输入（各用例按需改字段）。 */
function input(overrides: Partial<RecordDraftInput> = {}): RecordDraftInput {
  return {
    childId: 'child-1',
    ruleVersionRow: version(),
    category: 'praise',
    source: 'child_self',
    operator: CHILD,
    currentBalance: 0,
    now: NOW,
    ...overrides
  }
}

/** 跑一段必然抛错的代码，把错误交出来（没抛 ⇒ 用例自己红）。 */
function expectThrow(fn: () => unknown): Error {
  try {
    fn()
  } catch (err) {
    return err as Error
  }
  throw new Error('预期抛错，但没有抛 —— 这条 fail-closed 是假的')
}

/** 断言抛的是**形状错误**（500 家族）并返回它的 code。 */
function shapeCode(fn: () => unknown): string {
  const err = expectThrow(fn)
  assert.ok(
    err instanceof LedgerShapeError,
    `预期 LedgerShapeError（数据/装配问题 ⇒ 500），收到 ${err.name}: ${err.message}`
  )
  return (err as LedgerShapeError).code
}

/** 断言抛的是**业务拒绝**（400/409 家族）并返回它的 code。 */
function deniedCode(fn: () => unknown): string {
  const err = expectThrow(fn)
  assert.ok(
    err instanceof LedgerDeniedError,
    `预期 LedgerDeniedError（正常业务分支 ⇒ 400/409），收到 ${err.name}: ${err.message}`
  )
  return (err as LedgerDeniedError).code
}

/** 一条链上的行（`verifyBalanceChain` 的输入）。 */
function chainRow(
  id: string,
  pointsDelta: number,
  balanceAfter: number,
  minutesOffset = 0,
  childId = 'child-1'
): LedgerChainRow {
  return {
    id,
    childId,
    pointsDelta,
    balanceAfter,
    createdAt: new Date(NOW.getTime() + minutesOffset * 60_000)
  }
}

// ── 组 A：方向 × 符号（修 A1：负分规则被 `Math.abs` 抹平）─────────────────────
describe('组 A：signedDelta —— 符号只有一个来源', () => {
  it('reward ⇒ 正', () => {
    assert.equal(signedDelta(5, 'reward'), 5)
    assert.equal(signedDelta(1, 'reward'), 1)
  })

  it('★ penalty ⇒ **负**（"扣 5 分"不许变成"+5 分"）', () => {
    assert.equal(signedDelta(5, 'penalty'), -5, '负分规则被抹平了 —— 这正是 A1 的原病')
  })

  it('规则积分为 0 / 负 / 小数 ⇒ INVALID_RULE_POINTS（符号由 direction 表达，points 恒为正）', () => {
    for (const bad of [0, -3, 1.5]) {
      const err = expectThrow(() => signedDelta(bad, 'reward'))
      assert.ok(err instanceof LedgerShapeError, `points=${bad} 被接受了`)
      assert.equal((err as LedgerShapeError).code, 'INVALID_RULE_POINTS')
      assert.ok(err.message.includes(String(bad)), '错误必须点名收到的值')
    }
  })

  it('★ 未知方向（如将来新增的 `bonus`）⇒ INVALID_DIRECTION（不认识 ≠ 按 reward 处理）', () => {
    const err = expectThrow(() => signedDelta(5, 'bonus'))
    assert.ok(err instanceof LedgerShapeError)
    assert.equal(
      (err as LedgerShapeError).code,
      'INVALID_DIRECTION',
      '一个没见过的方向被当成了 reward —— 它会静默地给所有规则加分'
    )
  })
})

// ── 组 B：余额（修 B6：拒绝，绝不静默截断）────────────────────────────────────
describe('组 B：resolveBalanceAfter —— 要么算得出来，要么拒绝', () => {
  it('余额够：10 + 5 = 15', () => {
    const v = resolveBalanceAfter(10, 5)
    if (v.kind !== 'OK') assert.fail(`本该通过，却被拒绝：${v.message}`)
    assert.equal(v.balanceAfter, 15)
  })

  it('恰好扣完：5 − 5 = 0（"刚好够"是合法操作，不是边界 bug）', () => {
    const v = resolveBalanceAfter(5, -5)
    if (v.kind !== 'OK') assert.fail(`恰好扣完被拒了：${v.message}`)
    assert.equal(v.balanceAfter, 0)
  })

  it('★ 余额 124、扣 9999 ⇒ **拒绝**（不是截断到 0 —— 修 B6）', () => {
    const v = resolveBalanceAfter(124, -9999)
    if (v.kind !== 'DENY') {
      assert.fail(
        `被"静默截断"了：前端旧实现在这里把余额改成 ${v.balanceAfter}，而流水会照记 −9999 ` +
          '⇒ Σ流水 ≠ 余额，账本再也对不上（B6 原病复发）'
      )
    }
    assert.equal(v.code, 'INSUFFICIENT_POINTS')
    assert.ok(v.message.includes('积分不足'), '拒绝的话必须让用户看得懂')
    assert.ok(v.message.includes('124'), '必须点名"最多能扣多少"')
  })

  it('0 余额想扣 1 ⇒ 拒绝（不许出现负余额）', () => {
    const v = resolveBalanceAfter(0, -1)
    if (v.kind !== 'DENY') assert.fail('负余额被放行了 —— I2 从这一刻起就不成立')
    assert.equal(v.code, 'INSUFFICIENT_POINTS')
  })

  it('当前余额为负 ⇒ INVALID_CURRENT_BALANCE（历史坏数据 ⇒ 500，不是用户操作不对）', () => {
    assert.equal(shapeCode(() => resolveBalanceAfter(-1, 5)), 'INVALID_CURRENT_BALANCE')
  })

  it('当前余额非整数（12.5）/ 变动非整数 ⇒ 形状错误（点数只允许整数）', () => {
    assert.equal(shapeCode(() => resolveBalanceAfter(12.5, 1)), 'INVALID_CURRENT_BALANCE')
    assert.equal(shapeCode(() => resolveBalanceAfter(12, 0.5)), 'INVALID_AMOUNT')
  })
})



// ── 组 C：草稿构造（快照 / 操作人 / 来源 / 幂等键；修 A4、B8）──────────────────
describe('组 C：buildRecordDraft —— 落库前把话说清楚', () => {
  it('规则派生：快照、版本、操作人、余额**全部**来自权威来源', () => {
    const row = version({
      title: '番茄钟写作业（完整标题，不许截断）',
      condition: '专注 25 分钟',
      dailyLimit: 3,
      points: 4,
      direction: 'reward'
    })
    const draft: PointRecordDraft = buildRecordDraft(
      input({ ruleVersionRow: row, currentBalance: 10 })
    )
    assert.equal(draft.titleSnapshot, row.title)
    assert.equal(draft.conditionSnapshot, row.condition)
    assert.equal(draft.dailyLimitSnapshot, 3)
    assert.equal(draft.ruleId, 'rule-1')
    assert.equal(draft.ruleVersion, 1)
    assert.equal(draft.pointsDelta, 4)
    assert.equal(draft.balanceAfter, 14)
    assert.equal(draft.category, 'praise')
    assert.equal(draft.source, 'child_self')
    assert.equal(draft.operatorUserId, 'u-kid', '操作人必须是**真实**操作人')
    assert.equal(draft.operatorRole, 'child')
    assert.equal(draft.idempotencyKey, null)
    assert.equal(draft.reversesRecordId, null)
    assert.equal(draft.createdAt.getTime(), NOW.getTime(), '时钟由调用方注入 ⇒ 判定可复现')
  })

  it('★ 调用方自己拼的 titleSnapshot 与版本行不符 ⇒ 拒绝（快照不是调用方的自由）', () => {
    assert.equal(
      shapeCode(() => buildRecordDraft(input({ titleSnapshot: '我随手写的标题' }))),
      'SNAPSHOT_VERSION_MISMATCH'
    )
  })

  it('调用方传了与版本行**一致**的 titleSnapshot ⇒ 允许（一致的重复不算撒谎）', () => {
    const draft = buildRecordDraft(input({ titleSnapshot: version().title }))
    assert.equal(draft.titleSnapshot, version().title)
  })

  it('★ 负分规则：调用方按 `Math.abs` 算成 +5 ⇒ DELTA_RULE_MISMATCH（修 A1）', () => {
    const penalty = version({ points: 5, direction: 'penalty' })
    assert.equal(
      shapeCode(() =>
        buildRecordDraft(input({ ruleVersionRow: penalty, pointsDelta: 5, currentBalance: 10 }))
      ),
      'DELTA_RULE_MISMATCH',
      '负分被记成了加分 —— 这就是 A1，内核必须拦住它'
    )
    const draft = buildRecordDraft(
      input({ ruleVersionRow: penalty, pointsDelta: -5, currentBalance: 10 })
    )
    assert.equal(draft.pointsDelta, -5)
    assert.equal(draft.balanceAfter, 5)
  })

  it('负分规则 + 不传 pointsDelta ⇒ 内核算出 −5（符号只有一个来源）', () => {
    const draft = buildRecordDraft(
      input({ ruleVersionRow: version({ points: 5, direction: 'penalty' }), currentBalance: 10 })
    )
    assert.equal(draft.pointsDelta, -5)
  })
})

// ── 组 C2：手工流水、兑换、操作人、白名单（修 A4、B8、幂等）────────────────────
describe('组 C2：手工流水与操作人', () => {
  const manual = {
    childId: 'child-1',
    ruleVersionRow: null,
    titleSnapshot: '一次性奖励：主动整理书桌，并把玩具全部归位（共 3 项）',
    category: 'adjust',
    source: 'guardian',
    operator: GUARDIAN,
    currentBalance: 2,
    now: NOW
  } as const

  it('★ "记一笔"：标题**完整**落库（修 B8：截断只允许发生在渲染层）', () => {
    const draft = buildRecordDraft({ ...manual, pointsDelta: 3 })
    assert.equal(draft.titleSnapshot, manual.titleSnapshot)
    assert.equal(
      draft.titleSnapshot.length,
      manual.titleSnapshot.length,
      '标题被截断了 —— 截断后的标题无法解释这笔分是怎么来的（B8）'
    )
    assert.equal(draft.ruleId, null)
    assert.equal(draft.ruleVersion, null)
    assert.equal(draft.conditionSnapshot, null)
    assert.equal(draft.dailyLimitSnapshot, null)
    assert.equal(draft.costSnapshot, null)
    assert.equal(draft.balanceAfter, 5)
    assert.equal(draft.operatorUserId, 'u-dad', '★ 记真实操作人，不许硬编码成"家长记录"')
    assert.equal(draft.operatorRole, 'guardian')
  })

  it('"记一笔"填 0 ⇒ ZERO_DELTA（正常输入错误 ⇒ 400，不是 500）', () => {
    const err = expectThrow(() => buildRecordDraft({ ...manual, pointsDelta: 0 }))
    assert.ok(err instanceof LedgerDeniedError, `预期业务拒绝，收到 ${err.name}`)
    assert.equal((err as LedgerDeniedError).code, 'ZERO_DELTA')
  })

  it('"记一笔"没给标题 / 只给空白标题 ⇒ MISSING_TITLE_SNAPSHOT（修 B8）', () => {
    for (const bad of [undefined, '', '   ']) {
      assert.equal(
        shapeCode(() => buildRecordDraft({ ...manual, titleSnapshot: bad, pointsDelta: 1 })),
        'MISSING_TITLE_SNAPSHOT',
        `titleSnapshot=${JSON.stringify(bad)} 被放行了`
      )
    }
  })

  it('"记一笔"必须显式给 pointsDelta（内核不替调用方猜金额）', () => {
    assert.equal(shapeCode(() => buildRecordDraft({ ...manual })), 'INVALID_AMOUNT')
  })

  it('"记一笔"余额不足 ⇒ INSUFFICIENT_POINTS（与兑换同一条纪律 —— 修 B6）', () => {
    assert.equal(deniedCode(() => buildRecordDraft({ ...manual, pointsDelta: -5 })), 'INSUFFICIENT_POINTS')
  })

  it('兑换：成本快照 = 扣分额，两样都落库（修 B8：心愿被删后这笔分仍解释得清）', () => {
    const draft = buildRecordDraft({
      childId: 'child-1',
      ruleVersionRow: null,
      titleSnapshot: '兑换：多玩 30 分钟游戏',
      pointsDelta: -10,
      costSnapshot: 10,
      category: 'exchange',
      source: 'guardian',
      operator: GUARDIAN,
      wishId: 'wish-1',
      currentBalance: 12,
      now: NOW
    })
    assert.equal(draft.category, 'exchange')
    assert.equal(draft.pointsDelta, -10)
    assert.equal(draft.costSnapshot, 10)
    assert.equal(draft.wishId, 'wish-1')
    assert.equal(draft.balanceAfter, 2)
  })

  it('兑换：缺成本快照 / 成本 ≠ 扣分额 / 正数 ⇒ 拒绝（否则这笔扣分永久无法解释）', () => {
    const base = {
      childId: 'child-1',
      ruleVersionRow: null,
      titleSnapshot: '兑换：看电影',
      category: 'exchange',
      source: 'guardian',
      operator: GUARDIAN,
      currentBalance: 12,
      now: NOW
    }
    assert.equal(
      shapeCode(() => buildRecordDraft({ ...base, pointsDelta: -10 })),
      'MISSING_COST_SNAPSHOT'
    )
    assert.equal(
      shapeCode(() => buildRecordDraft({ ...base, pointsDelta: -10, costSnapshot: 8 })),
      'DELTA_CATEGORY_MISMATCH'
    )
    assert.equal(
      shapeCode(() => buildRecordDraft({ ...base, pointsDelta: 10, costSnapshot: 10 })),
      'DELTA_CATEGORY_MISMATCH',
      '兑换给正数：成本必须等于扣分额，正数永远凑不出这个等式 ⇒ 必须拒绝'
    )
  })
})


// ── 组 C3：白名单与幂等键（枚举外取值不许被"当成熟人"放行）────────────────────
describe('组 C3：白名单与幂等键', () => {
  it('白名单与 Prisma 枚举一一对应（枚举加值时这里会先红 —— 被迫做决定）', () => {
    assert.deepEqual([...KNOWN_CATEGORIES].sort(), ['adjust', 'exchange', 'praise'])
    assert.deepEqual(
      [...KNOWN_SOURCES].sort(),
      ['agent', 'approval', 'child_self', 'correction', 'guardian', 'system']
    )
  })

  it('枚举外的类别 / 来源 ⇒ INVALID_CATEGORY / INVALID_SOURCE（不认识 ≠ 当 praise 放行）', () => {
    assert.equal(shapeCode(() => buildRecordDraft(input({ category: 'bonus' }))), 'INVALID_CATEGORY')
    assert.equal(shapeCode(() => buildRecordDraft(input({ source: 'rewards' }))), 'INVALID_SOURCE')
  })

  it('★ 操作人来源与真实角色不符 ⇒ 拒绝（修 A4：流水里"谁干的"不许撒谎）', () => {
    // 孩子自己完成，却由家长署名
    assert.equal(
      shapeCode(() => buildRecordDraft(input({ source: 'child_self', operator: GUARDIAN }))),
      'SOURCE_OPERATOR_MISMATCH'
    )
    // 家长奖励，却挂在孩子头上
    assert.equal(
      shapeCode(() => buildRecordDraft(input({ source: 'guardian', operator: CHILD }))),
      'SOURCE_OPERATOR_MISMATCH'
    )
    // viewer 是只读角色：不许产生家长署名的流水
    assert.equal(
      shapeCode(() => buildRecordDraft(input({ source: 'guardian', operator: VIEWER }))),
      'SOURCE_OPERATOR_MISMATCH'
    )
  })

  it('该带操作人的来源没带 / userId 为空 / 角色非法 ⇒ 形状错误（500 家族）', () => {
    assert.equal(
      shapeCode(() => buildRecordDraft(input({ source: 'child_self', operator: null }))),
      'MISSING_ACTOR'
    )
    assert.equal(
      shapeCode(() => buildRecordDraft(input({ operator: { userId: '  ', role: 'child' } }))),
      'MISSING_ACTOR'
    )
    assert.equal(
      shapeCode(() =>
        buildRecordDraft(input({ operator: { userId: 'u-x', role: 'owner' as LedgerOperator['role'] } }))
      ),
      'INVALID_OPERATOR_ROLE'
    )
  })

  it('system 来源：必须**不带**操作人（"系统干的"与"某人干的"要分得开）', () => {
    assert.equal(
      shapeCode(() => buildRecordDraft(input({ source: 'system', operator: CHILD }))),
      'UNEXPECTED_ACTOR'
    )
    const draft = buildRecordDraft(
      input({ source: 'system', operator: null, category: 'adjust', currentBalance: 3 })
    )
    assert.equal(draft.operatorUserId, null)
    assert.equal(draft.operatorRole, null)
    assert.equal(draft.balanceAfter, 4)
  })

  it('幂等键归一：空白串**不是**"给了键"（否则重放保护形同虚设）', () => {
    const keyOf = (raw: string | null | undefined): string | null =>
      buildRecordDraft(input({ idempotencyKey: raw })).idempotencyKey
    assert.equal(keyOf('  k-1  '), 'k-1')
    assert.equal(keyOf(''), null)
    assert.equal(keyOf('   '), null)
    assert.equal(keyOf(null), null)
    assert.equal(keyOf(undefined), null)
  })
})



// ── 组 D：I4 尺子（快照 == 版本行的对应值）────────────────────────────────────
/** 从草稿取"与版本有关的那几列"，对应真库里的 `PointRecord` 行。 */
function snapshotOf(draft: PointRecordDraft, overrides: Partial<SnapshotLike> = {}): SnapshotLike {
  return {
    ruleId: draft.ruleId,
    ruleVersion: draft.ruleVersion,
    titleSnapshot: draft.titleSnapshot,
    conditionSnapshot: draft.conditionSnapshot,
    dailyLimitSnapshot: draft.dailyLimitSnapshot,
    pointsDelta: draft.pointsDelta,
    category: draft.category,
    source: draft.source,
    ...overrides
  }
}

describe('组 D：findSnapshotMismatches —— I4 的读侧尺子（真库套件复用同一把）', () => {
  const row = version()
  const draft = buildRecordDraft(input({ ruleVersionRow: row, currentBalance: 0 }))

  it('刚由内核构造出来的记录 ⇒ 一把过（构造保证 I4，尺子只是复核）', () => {
    assert.deepEqual(findSnapshotMismatches(snapshotOf(draft), row), [])
  })

  it('标题 / 条件 / 每日上限任一不符 ⇒ 点名到具体列（不是笼统一句"数据不一致"）', () => {
    const titleHit = findSnapshotMismatches(
      snapshotOf(draft, { titleSnapshot: '被改过的标题' }),
      row
    )
    assert.equal(titleHit.length, 1)
    assert.ok(titleHit[0].includes('titleSnapshot'))

    assert.ok(
      findSnapshotMismatches(snapshotOf(draft, { conditionSnapshot: '别的条件' }), row)[0].includes(
        'conditionSnapshot'
      )
    )
    assert.ok(
      findSnapshotMismatches(snapshotOf(draft, { dailyLimitSnapshot: 9 }), row)[0].includes(
        'dailyLimitSnapshot'
      )
    )
  })

  it('★ 负分规则被记成加分 ⇒ 点名 pointsDelta（修 A1 的历史数据能靠它查出来）', () => {
    const penalty = version({ points: 5, direction: 'penalty' })
    const wrong = snapshotOf(
      buildRecordDraft(input({ ruleVersionRow: penalty, pointsDelta: -5, currentBalance: 10 })),
      { pointsDelta: 5 }
    )
    const problems = findSnapshotMismatches(wrong, penalty)
    assert.equal(problems.length, 1)
    assert.ok(problems[0].includes('pointsDelta'), problems[0])
  })

  it('指向的版本行对不上 ⇒ 只报一条"不符"（不去比一堆必然不同的列）', () => {
    const problems = findSnapshotMismatches(snapshotOf(draft), version({ version: 2 }))
    assert.equal(problems.length, 1)
    assert.ok(problems[0].includes('不符'))
  })

  it('(ruleId, ruleVersion) 只给一半 ⇒ 点名"不成对"', () => {
    const problems = findSnapshotMismatches(snapshotOf(draft, { ruleVersion: null }), row)
    assert.equal(problems.length, 1)
    assert.ok(problems[0].includes('不成对'))
  })

  it('与规则无关的手工流水（两列都为 null）⇒ I4 不适用，不报假病', () => {
    const manual = buildRecordDraft({
      childId: 'child-1',
      ruleVersionRow: null,
      titleSnapshot: '手工调整',
      pointsDelta: 1,
      category: 'adjust',
      source: 'guardian',
      operator: GUARDIAN,
      currentBalance: 0,
      now: NOW
    })
    assert.deepEqual(findSnapshotMismatches(snapshotOf(manual), row), [])
  })

  it('★ 冲正记录例外：标题是"撤销：…"（必然 ≠ 版本标题），只查规则指向', () => {
    const correction = snapshotOf(draft, {
      source: 'correction',
      titleSnapshot: '撤销：番茄钟写作业',
      pointsDelta: -1
    })
    assert.deepEqual(
      findSnapshotMismatches(correction, row),
      [],
      '拿"撤销：…"去比版本标题必然红 —— 那是尺子错，不是数据错'
    )
    assert.ok(
      findSnapshotMismatches({ ...correction, ruleVersion: 7 }, row)[0].includes('不符'),
      '冲正记录仍需继承正确的 (ruleId, ruleVersion)'
    )
  })

  it('版本行自己坏了（direction 不在枚举内）⇒ 报"版本行本身非法"，**不抛异常**', () => {
    const broken = version({ direction: 'bonus' })
    const problems = findSnapshotMismatches(snapshotOf(draft), broken)
    assert.equal(problems.length, 1)
    assert.ok(problems[0].includes('版本行本身非法'), problems.join(' | '))
    assert.ok(
      problems[0].includes('bonus'),
      '必须点名那个非法取值 —— 否则运维在库里根本找不到这行'
    )
  })

// ── 组 E：冲正（I6 / 修 B7：撤销是"新增一条"，不是"删掉一条"）─────────────────
/** 原记录（从库里读出的一行）。 */
function original(overrides: Partial<ReversibleRecord> = {}): ReversibleRecord {
  return {
    id: 'rec-1',
    childId: 'child-1',
    titleSnapshot: '番茄钟写作业',
    pointsDelta: 2,
    source: 'child_self',
    ruleId: 'rule-1',
    ruleVersion: 1,
    habitId: 'habit-1',
    wishId: null,
    reversesRecordId: null,
    ...overrides
  }
}

describe('组 E：reverseRecordDraft —— 撤销 = 冲正，不是删除（I6，修 B7）', () => {
  it('★ 冲正草稿：金额取反、来源 correction、指向原记录、继承规则版本', () => {
    const orig = original()
    const before = JSON.parse(JSON.stringify(orig)) as ReversibleRecord

    const draft = reverseRecordDraft(orig, {
      operator: GUARDIAN,
      currentBalance: 10,
      alreadyReversedIds: [],
      ruleVersionRow: version(),
      now: NOW
    })

    assert.equal(draft.pointsDelta, -2, '冲正必须把原变动取反')
    assert.equal(draft.balanceAfter, 8)
    assert.equal(draft.category, 'adjust')
    assert.equal(draft.source, 'correction')
    assert.equal(draft.reversesRecordId, 'rec-1', 'I6：冲正记录必须指向原记录')
    assert.equal(draft.titleSnapshot, '撤销：番茄钟写作业')
    assert.equal(draft.note, '番茄钟写作业', '备注默认取原标题')
    assert.equal(draft.ruleId, 'rule-1', '★ 继承：哪一版规则产生的这笔分，留在账上')
    assert.equal(draft.ruleVersion, 1)
    assert.equal(draft.habitId, 'habit-1')
    assert.equal(draft.conditionSnapshot, version().condition)
    assert.equal(draft.dailyLimitSnapshot, version().dailyLimit)
    assert.equal(draft.costSnapshot, null)
    assert.equal(draft.operatorUserId, 'u-dad', '撤销是**这一次**的操作人干的，不是原记录的人')
    assert.equal(draft.operatorRole, 'guardian')
    assert.equal(draft.createdAt.getTime(), NOW.getTime())

    assert.deepEqual(
      JSON.parse(JSON.stringify(orig)),
      before,
      '★ 原记录被改动了 —— append-only 被破坏（B7 的原病是直接删掉它）'
    )
  })

  it('★ 原记录 + 冲正记录 一起仍是一条**自洽**的链（撤销让流水条数 +1 而非 −1）', () => {
    const draft = reverseRecordDraft(original(), {
      operator: GUARDIAN,
      currentBalance: 2,
      alreadyReversedIds: [],
      ruleVersionRow: version(),
      now: new Date(NOW.getTime() + 60_000)
    })
    // 账本从 0 开始：+2 ⇒ 2，冲正 −2 ⇒ 0（两笔都在账上，谁都抹不掉谁）
    const rows: LedgerChainRow[] = [
      chainRow('rec-1', 2, 2),
      chainRow('rec-1-rev', draft.pointsDelta, draft.balanceAfter, 1)
    ]
    assert.equal(rows.length, 2, 'I6：撤销之后历史**还在**（旧实现把今天的流水 filter 掉了）')
    assert.equal(draft.balanceAfter, 0)
    assert.deepEqual(verifyBalanceChain(rows), [])
  })

  it('冲正一条"扣分"记录 ⇒ 把分加回来（符号取反，不做特判）', () => {
    const draft = reverseRecordDraft(original({ pointsDelta: -5, titleSnapshot: '超时未完成' }), {
      operator: GUARDIAN,
      currentBalance: 7,
      alreadyReversedIds: [],
      ruleVersionRow: version(),
      now: NOW
    })
    assert.equal(draft.pointsDelta, 5)
    assert.equal(draft.balanceAfter, 12)
  })

  it('★ 冲正记录不能再被冲正 ⇒ CANNOT_REVERSE_REVERSAL（"撤销的撤销"语义失控）', () => {
    assert.equal(
      deniedCode(() =>
        reverseRecordDraft(original({ reversesRecordId: 'rec-1-orig' }), {
          operator: GUARDIAN,
          currentBalance: 10,
          alreadyReversedIds: [],
          ruleVersionRow: version(),
          now: NOW
        })
      ),
      'CANNOT_REVERSE_REVERSAL'
    )
  })

  it('★ 已被冲正过的记录再冲 ⇒ ALREADY_REVERSED（再冲一次这笔分就翻倍了）', () => {
    assert.equal(
      deniedCode(() =>
        reverseRecordDraft(original(), {
          operator: GUARDIAN,
          currentBalance: 10,
          alreadyReversedIds: ['rec-1'],
          ruleVersionRow: version(),
          now: NOW
        })
      ),
      'ALREADY_REVERSED'
    )
  })

  it('原记录变动为 0 ⇒ INVALID_AMOUNT（账本里不该有 0 变动的记录 —— 数据坏了）', () => {
    assert.equal(
      shapeCode(() =>
        reverseRecordDraft(original({ pointsDelta: 0 }), {
          operator: GUARDIAN,
          currentBalance: 10,
          alreadyReversedIds: [],
          ruleVersionRow: version(),
          now: NOW
        })
      ),
      'INVALID_AMOUNT'
    )
  })

  it('原记录带 ruleId 却没给 / 给错版本行 ⇒ SNAPSHOT_VERSION_MISMATCH（不许落解释不清的记录）', () => {
    const inputWithoutVersion = {
      operator: GUARDIAN,
      currentBalance: 10,
      alreadyReversedIds: [],
      now: NOW
    }
    assert.equal(
      shapeCode(() => reverseRecordDraft(original(), inputWithoutVersion)),
      'SNAPSHOT_VERSION_MISMATCH'
    )
    assert.equal(
      shapeCode(() =>
        reverseRecordDraft(original(), { ...inputWithoutVersion, ruleVersionRow: version({ version: 2 }) })
      ),
      'SNAPSHOT_VERSION_MISMATCH'
    )
  })

  it('冲正后余额不足（原记录 +2 但余额只剩 1）⇒ INSUFFICIENT_POINTS（与普通写入同一条纪律）', () => {
    assert.equal(
      deniedCode(() =>
        reverseRecordDraft(original(), {
          operator: GUARDIAN,
          currentBalance: 1,
          alreadyReversedIds: [],
          ruleVersionRow: version(),
          now: NOW
        })
      ),
      'INSUFFICIENT_POINTS',
      '分已经花掉了却还能撤销 ⇒ 余额变负 —— 修 B6 必须连这里一起管住'
    )
  })

  it('手工流水（ruleId 为 null）的冲正：不需要版本行，快照列留空', () => {
    const draft = reverseRecordDraft(original({ ruleId: null, ruleVersion: null, habitId: null }), {
      operator: GUARDIAN,
      currentBalance: 5,
      alreadyReversedIds: [],
      now: NOW
    })
    assert.equal(draft.ruleId, null)
    assert.equal(draft.ruleVersion, null)
    assert.equal(draft.conditionSnapshot, null)
    assert.equal(draft.dailyLimitSnapshot, null)
    assert.equal(draft.pointsDelta, -2)
    assert.equal(draft.balanceAfter, 3)
  })

  it('冲正必须有人（A4：冲正也是"某人干的"）', () => {
    assert.equal(
      shapeCode(() =>
        reverseRecordDraft(original(), {
          operator: null,
          currentBalance: 10,
          alreadyReversedIds: [],
          ruleVersionRow: version(),
          now: NOW
        })
      ),
      'MISSING_ACTOR'
    )
  })
})


  it('写侧 assertSnapshotMatchesVersion：不一致 ⇒ 抛 SNAPSHOT_VERSION_MISMATCH（宁可 500）', () => {
    assert.equal(
      shapeCode(() =>
        assertSnapshotMatchesVersion(snapshotOf(draft, { titleSnapshot: '被改过的标题' }), row)
      ),
      'SNAPSHOT_VERSION_MISMATCH'
    )
    assert.doesNotThrow(() => assertSnapshotMatchesVersion(snapshotOf(draft), row))
  })
})

// ── 组 F：I2 尺子（Σ流水 == balanceAfter，逐步）────────────────────────────────
describe('组 F：verifyBalanceChain —— I2 的对账器（真库套件复用同一把）', () => {
  it('自洽的链 ⇒ 空数组（且函数自己排序，不要求调用方先排好）', () => {
    const rows = [
      chainRow('r3', 1, 4, 3),
      chainRow('r1', 5, 5, 1),
      chainRow('r2', -2, 3, 2)
    ]
    assert.deepEqual(verifyBalanceChain(rows), [])
  })

  it('★ 中部断裂 ⇒ 点名"期望多少、实际多少"（运维照着这一行就能定位）', () => {
    const rows = [chainRow('r1', 5, 5, 1), chainRow('r2', -2, 3, 2), chainRow('r3', 1, 5, 3)]
    const problems = verifyBalanceChain(rows)
    assert.equal(problems.length, 1, problems.join(' | '))
    assert.ok(problems[0].includes('期望 balanceAfter=4'), problems[0])
    assert.ok(problems[0].includes('实际 5'), problems[0])
    assert.ok(problems[0].includes('r3'), '必须点名是哪一条记录')
  })

  it('多处断裂 ⇒ **每一处**都点亮（不是第一处就收工）', () => {
    const rows = [
      chainRow('r1', 5, 5, 1),
      chainRow('r2', 1, 3, 2),
      chainRow('r3', 1, 7, 3)
    ]
    const problems = verifyBalanceChain(rows)
    assert.equal(problems.length, 2, problems.join(' | '))
    assert.ok(problems[0].includes('r2'))
    assert.ok(problems[1].includes('r3'))
  })

  it('★ 链条"自洽但余额为负" ⇒ I2 尺子**判不出来**（它的可见边界，写清楚免得被当真）', () => {
    // 从 0 起：−5 ⇒ −5；再 −5 ⇒ −10。滚动求与 balanceAfter 处处一致 ⇒ 它认为"这链没问题"。
    const rows = [chainRow('r1', -5, -5, 1), chainRow('r2', -5, -10, 2)]
    assert.deepEqual(
      verifyBalanceChain(rows),
      [],
      'I2 只管"Σ流水 == balanceAfter"，管不了"余额本身是否合法"'
    )
    // ⇒ "余额不许为负"必须由**另外两道**守：
    //   ① 写入侧拒绝（组 B 的 INSUFFICIENT_POINTS —— 修 B6）；
    //   ② 真库层面再加一把尺子（`Child.pointsBalance >= 0`）—— 属 W2-B 的真库套件。
  })

  it('多个孩子各自从 0 起算，互不串味', () => {
    const rows = [
      chainRow('a1', 5, 5, 1, 'child-1'),
      chainRow('b1', 2, 2, 1, 'child-2'),
      chainRow('a2', -1, 4, 2, 'child-1')
    ]
    assert.deepEqual(verifyBalanceChain(rows), [])
  })

  it('★★ 同一时间戳（事务内 now() 相同）⇒ 报"顺序不可判"，**不报断裂**', () => {
    const sameTime = [
      { ...chainRow('r1', 3, 3, 0), createdAt: NOW },
      { ...chainRow('r2', -1, 2, 0), createdAt: NOW }
    ]
    const problems = verifyBalanceChain(sameTime)
    assert.equal(problems.length, 1, problems.join(' | '))
    assert.ok(problems[0].includes('顺序不可判'), problems[0])
    assert.ok(
      !problems[0].includes('断裂'),
      '顺序不定时报"断裂"是报**假病**：换个排序就可能自洽 —— 假病比不报更糟'
    )
  })

  it('★★ 并列时间戳 + 真断裂 ⇒ 仍然只说"顺序不可判"（先修写入侧，别猜顺序）', () => {
    const sameTime = [
      { ...chainRow('r1', 3, 999, 0), createdAt: NOW },
      { ...chainRow('r2', -1, 998, 0), createdAt: NOW }
    ]
    const problems = verifyBalanceChain(sameTime)
    assert.equal(problems.length, 1, problems.join(' | '))
    assert.ok(problems[0].includes('顺序不可判'), problems[0])
  })

  it('坏数据（非整数 / 时间解析不出）⇒ 单列"不可判定"，不参与滚动求和', () => {
    const rows = [
      chainRow('r1', 5, 5, 1),
      { ...chainRow('bad1', 1, 6, 2), pointsDelta: 1.5 },
      { ...chainRow('bad2', 1, 7, 3), createdAt: '不是时间' }
    ]
    const problems = verifyBalanceChain(rows)
    assert.equal(problems.length, 2, problems.join(' | '))
    assert.ok(problems.every((p) => p.includes('不可判定')), problems.join(' | '))
    assert.ok(problems[0].includes('bad1'))
    assert.ok(problems[1].includes('bad2'))
  })

  it('空账本 ⇒ 空数组（"从没记过账"不是违反不变量）', () => {
    assert.deepEqual(verifyBalanceChain([]), [])
  })
})


// ── 组 G：持久化端口（**无库**装配时 501 —— "账本内核已落地" ≠ "积分能记账了"）──
describe('组 G：LedgerPort 默认实现 fail-closed', () => {
  /** 断言"这次调用没有假装成功"。 */
  async function expect501(run: () => Promise<unknown>, what: string): Promise<void> {
    try {
      await run()
    } catch (err) {
      assert.ok(
        err instanceof NotImplementedException,
        `${what} 抛的不是 501：${String(err)}`
      )
      const body = (err as NotImplementedException).getResponse()
      assert.ok(typeof body === 'object' && body !== null, `${what} 的 501 响应体应是结构化对象`)
      assert.equal((body as { code?: string }).code, 'LEDGER_PERSISTENCE_NOT_IMPLEMENTED')
      assert.ok(
        (err as Error).message.includes(what),
        `${what} 的报错必须点名是**哪个**操作没实现：${(err as Error).message}`
      )
      return
    }
    assert.fail(
      `${what} 既没成功也没抛错 —— 更糟的情况是它"成功"了：` +
        '孩子的积分会看起来扣了却根本没落库（所以默认实现必须响亮地失败）'
    )
  }

  it('六个方法**全部**抛 501（没有任何一条写入路径是通的）', async () => {
    const port: LedgerPort = new NotImplementedLedgerRepository()
    await expect501(() => port.readBalance('child-1'), 'readBalance(child-1)')
    await expect501(() => port.readRecord('rec-1'), 'readRecord(rec-1)')
    await expect501(() => port.readReversedIds('child-1'), 'readReversedIds(child-1)')
    await expect501(() => port.readRuleVersion('rule-1', 1), 'readRuleVersion(rule-1#1)')
    await expect501(() => port.readChain('child-1'), 'readChain(child-1)')
    const draft = buildRecordDraft(input({ currentBalance: 0 }))
    await expect501(() => port.append(draft), 'append(childId=child-1)')
  })

  it('注入令牌是 symbol（避免与字符串令牌撞名）', () => {
    assert.equal(typeof LEDGER_REPOSITORY, 'symbol')
    assert.equal(LEDGER_REPOSITORY.toString(), 'Symbol(LEDGER_REPOSITORY)')
  })

  it('LedgerModule 真的装配了这个端口（**无库** ⇒ 501；有库分支见 ledger-wiring.test.ts）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LedgerModule.register({ hasDatabase: false })]
    }).compile()
    try {
      const port = moduleRef.get<LedgerPort>(LEDGER_REPOSITORY)
      assert.ok(
        port instanceof NotImplementedLedgerRepository,
        '默认装配必须是不落地的实现 —— 否则"没有真实现"这句话就变成了谎言'
      )
      await expect501(() => port.append(buildRecordDraft(input({ currentBalance: 0 }))), 'append(childId=child-1)')
    } finally {
      await moduleRef.close()
    }
  })
})


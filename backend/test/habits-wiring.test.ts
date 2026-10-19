/**
 * habits-wiring.test.ts —— 习惯端口的**装配口径** ＋ Prisma 适配器的**写入键**（W4-D）
 *
 * 两半证据：
 *   ① 有库 ⇒ `PrismaHabitsRepository`；无库 ⇒ `NotImplementedHabitsRepository`（501）；
 *      且无库图里**没有** `PrismaModule`（离线用例能跑完的前提）。
 *   ② 适配器把哪些条件交给 Prisma：习惯必须同孩子 + active、每日上限只数
 *      **仍有效**的打卡（排除 correction 与已被冲正的原记录）、窗口来自**库钟**，
 *      撤销写 `source='correction'` + `reversesRecordId` + `undo:<id>` 幂等键。
 *
 * 它不能证明「接了真库写得对」—— 那由 `test-db/habits-db.dbtest.ts` 证明。
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { DynamicModule } from '@nestjs/common'

import { HabitsModule, resolveHabitsRepositoryClass } from '../src/habits/habits.module'
import { PrismaHabitsRepository } from '../src/habits/habits.prisma.repository'
import {
  HABITS_REPOSITORY,
  NotImplementedHabitsRepository,
  type HabitsPort
} from '../src/habits/habits.repository'
import { PrismaModule } from '../src/prisma/prisma.module'
import type { PrismaService } from '../src/prisma/prisma.service'
import type { RecordRow } from '../src/read/read.repository'

interface PrismaCall {
  model: string
  method: string
  args: unknown
}

function boundClassOf(dynamic: DynamicModule, token: symbol): unknown {
  const providers = (dynamic.providers ?? []) as { provide: unknown; useClass?: unknown }[]
  const hit = providers.find((provider) => provider.provide === token)
  assert.ok(hit !== undefined, `register() 的 providers 里没有 ${String(token)}`)
  return hit.useClass
}

function recordOf(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: 'rec-new',
    titleSnapshot: '番茄钟写作业',
    pointsDelta: 1,
    category: 'praise',
    source: 'child_self',
    operatorRole: 'child',
    note: '',
    habitId: 'habit-1',
    ruleId: null,
    ruleVersion: null,
    wishId: null,
    reversesRecordId: null,
    reversedAt: null,
    balanceAfter: 101,
    createdAt: new Date('2026-10-19T01:00:00.000Z'),
    ...overrides
  }
}

/** 撤销用例的服务端时钟：业务日窗口由数据库决定，这里只要求 deterministic。 */
const NOW = new Date('2026-10-19T01:00:00.000Z')

// ══ 组 A：装配分叉 ═══════════════════════════════════════════════════════════
describe('组 A：有库 ⇒ Prisma；无库 ⇒ 501（两个分支不许是同一个类）', () => {
  it('resolveHabitsRepositoryClass 的映射唯一且互斥', () => {
    assert.equal(resolveHabitsRepositoryClass(true), PrismaHabitsRepository)
    assert.equal(resolveHabitsRepositoryClass(false), NotImplementedHabitsRepository)
    assert.notEqual(
      resolveHabitsRepositoryClass(true),
      resolveHabitsRepositoryClass(false)
    )
  })

  it('有库：绑定 PrismaHabitsRepository，且 imports 里有 PrismaModule', () => {
    const dynamic = HabitsModule.register({ hasDatabase: true })
    assert.equal(boundClassOf(dynamic, HABITS_REPOSITORY), PrismaHabitsRepository)
    assert.ok((dynamic.imports ?? []).includes(PrismaModule))
  })

  it('无库：绑定 501 实现，且**不**导入 PrismaModule', () => {
    const dynamic = HabitsModule.register({ hasDatabase: false })
    assert.equal(boundClassOf(dynamic, HABITS_REPOSITORY), NotImplementedHabitsRepository)
    assert.ok(!(dynamic.imports ?? []).includes(PrismaModule))
  })

  it('501 实现两个方法都抛 NotImplementedException（不返回假记录）', async () => {
    const port: HabitsPort = new NotImplementedHabitsRepository()
    for (const run of [
      () => port.checkIn({
        childId: 'c',
        habitId: 'h',
        operatorUserId: 'u',
        operatorRole: 'child',
        source: 'child_self',
        now: new Date()
      }),
      () => port.reverse({
        childId: 'c',
        recordId: 'r',
        operatorUserId: 'u',
        operatorRole: 'guardian',
        now: new Date()
      })
    ]) {
      await assert.rejects(run, (err: unknown) => {
        const response = (err as { getResponse?: () => { code?: string } }).getResponse?.()
        assert.equal(response?.code, 'HABITS_PERSISTENCE_NOT_IMPLEMENTED')
        return true
      })
    }
  })
})


// ══ 组 B：Prisma 适配器的写入键 ═══════════════════════════════════════════════
interface FakeOptions {
  balance?: number
  dbNow?: Date
  habit?: Record<string, unknown> | null
  rule?: Record<string, unknown> | null
  version?: Record<string, unknown> | null
  checkedCount?: number
  original?: Record<string, unknown> | null
  existingReversal?: Record<string, unknown> | null
  createdRow?: RecordRow
}

function makeFakePrisma(options: FakeOptions = {}) {
  const calls: PrismaCall[] = []
  const sql: string[] = []
  let findFirstCalls = 0
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const text = strings.join('?')
      sql.push(text)
      if (text.includes('clock_timestamp')) {
        return [{ ts: options.dbNow ?? new Date('2026-10-19T01:00:00.000Z') }]
      }
      if (text.includes('MAX(')) return [{ latest: null }]
      if (text.includes('pointsBalance')) return [{ pointsBalance: options.balance ?? 100 }]
      throw new Error(`未预期的 $queryRaw：${text}`)
    },
    habit: {
      findFirst: async (args: unknown) => {
        calls.push({ model: 'habit', method: 'findFirst', args })
        return (
          options.habit ?? {
            id: 'habit-1',
            title: '番茄钟写作业',
            condition: '专注 25 分钟',
            points: 1,
            dailyLimit: 2,
            sourceRuleId: null
          }
        )
      }
    },
    pointRule: {
      findFirst: async (args: unknown) => {
        calls.push({ model: 'pointRule', method: 'findFirst', args })
        return options.rule ?? null
      }
    },
    pointRuleVersion: {
      findUnique: async (args: unknown) => {
        calls.push({ model: 'pointRuleVersion', method: 'findUnique', args })
        return options.version ?? null
      }
    },
    pointRecord: {
      count: async (args: unknown) => {
        calls.push({ model: 'pointRecord', method: 'count', args })
        return options.checkedCount ?? 0
      },
      findFirst: async (args: unknown) => {
        calls.push({ model: 'pointRecord', method: 'findFirst', args })
        findFirstCalls += 1
        if (findFirstCalls === 1) return options.original ?? null
        return options.existingReversal ?? null
      },
      create: async (args: unknown) => {
        calls.push({ model: 'pointRecord', method: 'create', args })
        return options.createdRow ?? recordOf()
      }
    },
    child: {
      updateMany: async (args: unknown) => {
        calls.push({ model: 'child', method: 'updateMany', args })
        return { count: 1 }
      }
    },
    auditLog: {
      create: async (args: unknown) => {
        calls.push({ model: 'auditLog', method: 'create', args })
        return { id: 'audit-1' }
      }
    }
  }

  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)
  }

  return {
    prisma: prisma as unknown as PrismaService,
    calls,
    sql,
    callFor(model: string, method: string): PrismaCall {
      const hit = calls.find((call) => call.model === model && call.method === method)
      assert.ok(hit !== undefined, `没有调用 ${model}.${method}`)
      return hit
    }
  }
}

describe('组 B：checkIn —— 同孩子/active、仍有效打卡计数、库钟窗口、CAS', () => {
  const previousTimeZone = process.env.KP_TIMEZONE

  afterEach(() => {
    if (previousTimeZone === undefined) delete process.env.KP_TIMEZONE
    else process.env.KP_TIMEZONE = previousTimeZone
  })

  it('习惯查询带 childId + active；每日上限只数未被冲正的 praise', async () => {
    process.env.KP_TIMEZONE = 'Asia/Shanghai'
    const fake = makeFakePrisma()
    await new PrismaHabitsRepository(fake.prisma).checkIn({
      childId: 'child-1',
      habitId: 'habit-1',
      operatorUserId: 'u-kid',
      operatorRole: 'child',
      source: 'child_self',
      now: new Date('2026-10-19T01:00:00.000Z')
    })

    assert.deepEqual(fake.callFor('habit', 'findFirst').args, {
      where: { id: 'habit-1', childId: 'child-1', status: 'active' },
      select: {
        id: true,
        title: true,
        condition: true,
        points: true,
        dailyLimit: true,
        sourceRuleId: true
      }
    })

    const countArgs = fake.callFor('pointRecord', 'count').args as { where: Record<string, unknown> }
    assert.deepEqual(countArgs.where, {
      childId: 'child-1',
      habitId: 'habit-1',
      category: 'praise',
      source: { not: 'correction' },
      reversesRecordId: null,
      reversedBy: { none: {} },
      createdAt: {
        gte: new Date('2026-10-18T16:00:00.000Z'),
        lt: new Date('2026-10-19T16:00:00.000Z')
      }
    })
  })

  it('每日上限已满 ⇒ 409，不写流水、不改余额、不写审计', async () => {
    process.env.KP_TIMEZONE = 'Asia/Shanghai'
    const fake = makeFakePrisma({ checkedCount: 2 })
    await assert.rejects(
      () =>
        new PrismaHabitsRepository(fake.prisma).checkIn({
          childId: 'child-1',
          habitId: 'habit-1',
          operatorUserId: 'u-kid',
          operatorRole: 'child',
          source: 'child_self',
          now: new Date('2026-10-19T01:00:00.000Z')
        }),
      (err: unknown) => {
        const response = (err as { getResponse?: () => { code?: string } }).getResponse?.()
        assert.equal(response?.code, 'HABIT_DAILY_LIMIT_REACHED')
        return true
      }
    )
    assert.equal(
      fake.calls.some((call) => call.model === 'pointRecord' && call.method === 'create'),
      false
    )
    assert.equal(fake.calls.some((call) => call.model === 'child'), false)
    assert.equal(fake.calls.some((call) => call.model === 'auditLog'), false)
  })
})

describe('组 B（续）：checkIn 的草稿字段与规则版本快照', () => {
  const previousTimeZone = process.env.KP_TIMEZONE

  afterEach(() => {
    if (previousTimeZone === undefined) delete process.env.KP_TIMEZONE
    else process.env.KP_TIMEZONE = previousTimeZone
  })

  it('写入草稿：praise / 正分 / 余额 CAS / 幂等键原样落库', async () => {
    process.env.KP_TIMEZONE = 'Asia/Shanghai'
    const fake = makeFakePrisma({ balance: 100 })
    await new PrismaHabitsRepository(fake.prisma).checkIn({
      childId: 'child-1',
      habitId: 'habit-1',
      operatorUserId: 'u-dad',
      operatorRole: 'guardian',
      source: 'guardian',
      idempotencyKey: 'client-key-1',
      now: new Date('2026-10-19T01:00:00.000Z')
    })

    const create = fake.callFor('pointRecord', 'create').args as { data: Record<string, unknown> }
    assert.equal(create.data.category, 'praise')
    assert.equal(create.data.source, 'guardian')
    assert.equal(create.data.pointsDelta, 1)
    assert.equal(create.data.balanceAfter, 101)
    assert.equal(create.data.habitId, 'habit-1')
    assert.equal(create.data.idempotencyKey, 'client-key-1')
    assert.equal(create.data.operatorRole, 'guardian')
    assert.equal(create.data.titleSnapshot, '番茄钟写作业')

    assert.deepEqual(fake.callFor('child', 'updateMany').args, {
      where: { id: 'child-1', pointsBalance: 100 },
      data: { pointsBalance: 101 }
    })

    const audit = fake.callFor('auditLog', 'create').args as { data: Record<string, unknown> }
    assert.equal(audit.data.action, 'point_record.check_in')
    assert.equal(audit.data.targetId, 'rec-new')
  })

  it('习惯来自规则：写入 ruleId/ruleVersion 与版本行快照', async () => {
    process.env.KP_TIMEZONE = 'Asia/Shanghai'
    const fake = makeFakePrisma({
      habit: {
        id: 'habit-1',
        title: '旧标题（不得写进快照）',
        condition: '旧条件',
        points: 1,
        dailyLimit: 2,
        sourceRuleId: 'rule-1'
      },
      rule: { id: 'rule-1', currentVersion: 3 },
      version: {
        ruleId: 'rule-1',
        version: 3,
        title: '规则标题',
        condition: '规则条件',
        dailyLimit: 2,
        points: 1,
        direction: 'reward'
      }
    })
    await new PrismaHabitsRepository(fake.prisma).checkIn({
      childId: 'child-1',
      habitId: 'habit-1',
      operatorUserId: 'u-kid',
      operatorRole: 'child',
      source: 'child_self',
      now: new Date('2026-10-19T01:00:00.000Z')
    })

    assert.deepEqual(fake.callFor('pointRuleVersion', 'findUnique').args, {
      where: { ruleId_version: { ruleId: 'rule-1', version: 3 } },
      select: {
        ruleId: true,
        version: true,
        title: true,
        condition: true,
        dailyLimit: true,
        points: true,
        direction: true
      }
    })
    const create = fake.callFor('pointRecord', 'create').args as { data: Record<string, unknown> }
    assert.equal(create.data.ruleId, 'rule-1')
    assert.equal(create.data.ruleVersion, 3)
    assert.equal(create.data.titleSnapshot, '规则标题')
    assert.equal(create.data.conditionSnapshot, '规则条件')
  })
})


describe('组 C：reverse —— 追加冲正、继承版本、undo 幂等键', () => {
  const previousTimeZone = process.env.KP_TIMEZONE

  afterEach(() => {
    if (previousTimeZone === undefined) delete process.env.KP_TIMEZONE
    else process.env.KP_TIMEZONE = previousTimeZone
  })

  function originalOf(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rec-1',
      childId: 'child-1',
      titleSnapshot: '番茄钟写作业',
      pointsDelta: 1,
      source: 'child_self',
      ruleId: null,
      ruleVersion: null,
      habitId: 'habit-1',
      wishId: null,
      reversesRecordId: null,
      category: 'praise',
      ...overrides
    }
  }

  it('原记录查询按 (id, childId) 收窄；冲正草稿是 adjust/correction/-1', async () => {
    process.env.KP_TIMEZONE = 'Asia/Shanghai'
    const fake = makeFakePrisma({
      balance: 100,
      original: originalOf(),
      createdRow: recordOf({
        id: 'rec-rev',
        titleSnapshot: '撤销：番茄钟写作业',
        pointsDelta: -1,
        category: 'adjust',
        source: 'correction',
        note: '点错了',
        reversesRecordId: 'rec-1',
        balanceAfter: 99
      })
    })
    await new PrismaHabitsRepository(fake.prisma).reverse({
      childId: 'child-1',
      recordId: 'rec-1',
      operatorUserId: 'u-dad',
      operatorRole: 'guardian',
      note: '点错了',
      now: NOW
    })

    assert.deepEqual(
      (fake.callFor('pointRecord', 'findFirst').args as { where: unknown }).where,
      { id: 'rec-1', childId: 'child-1' }
    )

    const create = fake.callFor('pointRecord', 'create').args as { data: Record<string, unknown> }
    assert.equal(create.data.category, 'adjust')
    assert.equal(create.data.source, 'correction')
    assert.equal(create.data.pointsDelta, -1)
    assert.equal(create.data.balanceAfter, 99)
    assert.equal(create.data.reversesRecordId, 'rec-1')
    assert.equal(create.data.idempotencyKey, 'undo:rec-1')
    assert.equal(create.data.note, '点错了')
    assert.equal(create.data.titleSnapshot, '撤销：番茄钟写作业')

    assert.deepEqual(fake.callFor('child', 'updateMany').args, {
      where: { id: 'child-1', pointsBalance: 100 },
      data: { pointsBalance: 99 }
    })
    const audit = fake.callFor('auditLog', 'create').args as { data: Record<string, unknown> }
    assert.equal(audit.data.action, 'point_record.undo_check_in')
    assert.equal(audit.data.targetId, 'rec-rev')
  })

  it('原记录带 ruleId：按 (ruleId, ruleVersion) 取**同一版**并继承到冲正', async () => {
    process.env.KP_TIMEZONE = 'Asia/Shanghai'
    const fake = makeFakePrisma({
      balance: 100,
      original: originalOf({ ruleId: 'rule-1', ruleVersion: 2 }),
      version: {
        ruleId: 'rule-1',
        version: 2,
        title: '规则标题',
        condition: '规则条件',
        dailyLimit: 3,
        points: 1,
        direction: 'reward'
      }
    })
    await new PrismaHabitsRepository(fake.prisma).reverse({
      childId: 'child-1',
      recordId: 'rec-1',
      operatorUserId: 'u-dad',
      operatorRole: 'guardian',
      now: NOW
    })

    assert.deepEqual(
      (fake.callFor('pointRuleVersion', 'findUnique').args as { where: unknown }).where,
      { ruleId_version: { ruleId: 'rule-1', version: 2 } }
    )
    const create = fake.callFor('pointRecord', 'create').args as { data: Record<string, unknown> }
    assert.equal(create.data.ruleId, 'rule-1')
    assert.equal(create.data.ruleVersion, 2)
    assert.equal(create.data.conditionSnapshot, '规则条件')
    assert.equal(create.data.dailyLimitSnapshot, 3)
  })

  it('原记录不存在 / 跨孩子 ⇒ 404 RECORD_NOT_FOUND，且不写任何东西', async () => {
    process.env.KP_TIMEZONE = 'Asia/Shanghai'
    const fake = makeFakePrisma({ original: null })
    await assert.rejects(
      () =>
        new PrismaHabitsRepository(fake.prisma).reverse({
          childId: 'child-1',
          recordId: 'ghost',
          operatorUserId: 'u-dad',
          operatorRole: 'guardian',
          now: NOW
        }),
      (err: unknown) => {
        const response = (err as { getResponse?: () => { code?: string } }).getResponse?.()
        assert.equal(response?.code, 'RECORD_NOT_FOUND')
        return true
      }
    )
    assert.equal(fake.calls.some((call) => call.method === 'create'), false)
  })

  it('不是打卡（adjust + wishId）⇒ 409 NOT_A_HABIT_CHECK_IN', async () => {
    process.env.KP_TIMEZONE = 'Asia/Shanghai'
    const fake = makeFakePrisma({
      original: originalOf({ category: 'adjust', habitId: null, wishId: 'wish-1' })
    })
    await assert.rejects(
      () =>
        new PrismaHabitsRepository(fake.prisma).reverse({
          childId: 'child-1',
          recordId: 'rec-1',
          operatorUserId: 'u-dad',
          operatorRole: 'guardian',
          now: NOW
        }),
      (err: unknown) => {
        const response = (err as { getResponse?: () => { code?: string } }).getResponse?.()
        assert.equal(response?.code, 'NOT_A_HABIT_CHECK_IN')
        return true
      }
    )
  })
})

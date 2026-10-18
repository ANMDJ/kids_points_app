/**
 * read-wiring.test.ts —— 只读端口的**装配口径** ＋ Prisma 适配器的**查询键**（W4-A）
 *
 * ── 两半证据，缺一不可 ──────────────────────────────────────────────────────
 *   `read-http.test.ts` 证明「HTTP 路径上的三道屏障 / 拒绝 / 映射」；
 *   本文件证明 **谁来读**：
 *     · 有库 ⇒ `PrismaReadRepository`；无库 ⇒ `NotImplementedReadRepository`（501）；
 *     · 无库装配的图里**没有** `PrismaModule`（否则离线用例会因为缺 DATABASE_URL 在装配阶段崩）；
 *     · Prisma 适配器把哪些键交给 Prisma —— 尤其是：
 *         `child.findFirst({ where: { id, status: 'active' } })`（软删 ≠ 空数据）、
 *         `goodHabitCount` 的 `reversedBy: { none: {} }`（撤销后战绩必须回落）、
 *         `take: limit + 1`（分页 `hasMore` 不能靠“本页正好满”猜）。
 *
 * ── 它不能证明的事 ──────────────────────────────────────────────────────────
 *   「接了真库读得对」只能由 `test-db/read-db.dbtest.ts` 证明。替身只能证明
 *   「交出去的键长什么样」，证明不了 Postgres 上 `reversedBy` 关系过滤真的生效。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { DynamicModule } from '@nestjs/common'

import { PrismaReadRepository } from '../src/read/read.prisma.repository'
import {
  READ_REPOSITORY,
  NotImplementedReadRepository,
  type HomeSnapshotRow,
  type ReadPort,
  type RecordRow
} from '../src/read/read.repository'
import { ReadModule, resolveReadRepositoryClass } from '../src/read/read.module'
import { PrismaModule } from '../src/prisma/prisma.module'
import type { PrismaService } from '../src/prisma/prisma.service'

interface PrismaCall {
  model: string
  method: string
  args: unknown
}

function recordOf(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: 'rec-1',
    titleSnapshot: '番茄钟写作业',
    pointsDelta: 1,
    category: 'praise',
    source: 'child_self',
    operatorRole: 'child',
    note: '',
    habitId: 'h-1',
    ruleId: null,
    ruleVersion: null,
    wishId: null,
    reversesRecordId: null,
    reversedAt: null,
    balanceAfter: 124,
    createdAt: new Date('2026-10-18T01:00:00.000Z'),
    ...overrides
  }
}

function makePrismaFake(options: { recordRows?: RecordRow[]; count?: number } = {}): {
  prisma: PrismaService
  calls: PrismaCall[]
} {
  const calls: PrismaCall[] = []
  const take = (model: string, method: string) => (args: unknown) => {
    calls.push({ model, method, args })
  }

  const prisma = {
    child: {
      findFirst: async (args: unknown) => {
        take('child', 'findFirst')(args)
        return { id: 'child-1', name: '小满', pointsBalance: 124 }
      }
    },
    habit: {
      findMany: async (args: unknown) => {
        take('habit', 'findMany')(args)
        return [
          {
            id: 'h-1',
            title: '番茄钟写作业',
            points: 1,
            condition: '专注 25 分钟',
            dailyLimit: 2,
            icon: 'timer',
            color: '#FFB74D',
            sourceRuleId: 'r-1'
          }
        ]
      }
    },
    pointRule: {
      findMany: async (args: unknown) => {
        take('pointRule', 'findMany')(args)
        return [
          {
            id: 'r-1',
            title: '完成作业',
            condition: '当天作业全部完成',
            dailyLimit: 2,
            points: 3,
            direction: 'reward',
            icon: 'book',
            color: '#81C784',
            currentVersion: 1
          }
        ]
      }
    },
    wish: {
      findMany: async (args: unknown) => {
        take('wish', 'findMany')(args)
        return []
      },
      count: async (args: unknown) => {
        take('wish', 'count')(args)
        return 4
      }
    },
    pointRecord: {
      count: async (args: unknown) => {
        take('pointRecord', 'count')(args)
        return options.count ?? 324
      },
      findMany: async (args: unknown) => {
        take('pointRecord', 'findMany')(args)
        return options.recordRows ?? [recordOf()]
      }
    },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
  } as unknown as PrismaService

  return { prisma, calls }
}

function callFor(calls: PrismaCall[], model: string, method: string): PrismaCall {
  const hit = calls.find((call) => call.model === model && call.method === method)
  assert.ok(hit !== undefined, `没有调用 ${model}.${method} —— 适配器换了一套读法？`)
  return hit
}

/** 从 `register()` 的装配声明里取出某个端口实际绑定的类。 */
function boundClassOf(dynamic: DynamicModule, token: symbol): unknown {
  const providers = (dynamic.providers ?? []) as { provide: unknown; useClass?: unknown }[]
  const hit = providers.find((provider) => provider.provide === token)
  assert.ok(hit !== undefined, `register() 的 providers 里没有 ${String(token)}`)
  return hit.useClass
}

// ══ 组 A：装配分叉 ═══════════════════════════════════════════════════════════
describe('组 A：有库 ⇒ Prisma；无库 ⇒ 501（两个分支不许是同一个类）', () => {
  it('resolveReadRepositoryClass 的映射唯一且互斥', () => {
    assert.equal(resolveReadRepositoryClass(true), PrismaReadRepository)
    assert.equal(resolveReadRepositoryClass(false), NotImplementedReadRepository)
    assert.notEqual(resolveReadRepositoryClass(true), resolveReadRepositoryClass(false))
  })

  it('有库：绑定 PrismaReadRepository，且 imports 里有 PrismaModule', () => {
    const dynamic = ReadModule.register({ hasDatabase: true })
    assert.equal(boundClassOf(dynamic, READ_REPOSITORY), PrismaReadRepository)
    assert.ok(
      (dynamic.imports ?? []).includes(PrismaModule),
      '有库装配没有导入 PrismaModule —— PrismaService 不会被实例化/生命周期管理'
    )
  })

  it('无库：绑定 501 实现，且**不**导入 PrismaModule（离线用例能跑完的前提）', () => {
    const dynamic = ReadModule.register({ hasDatabase: false })
    assert.equal(boundClassOf(dynamic, READ_REPOSITORY), NotImplementedReadRepository)
    assert.ok(
      !(dynamic.imports ?? []).includes(PrismaModule),
      '无库装配把 PrismaModule 拉进图 —— 缺 DATABASE_URL 时会在装配阶段崩'
    )
  })

  it('501 实现两个方法都抛 NotImplementedException（不是空数据）', async () => {
    const port: ReadPort = new NotImplementedReadRepository()
    for (const run of [
      () => port.loadHome('child-1'),
      () => port.listRecords({ childId: 'child-1', limit: 50 })
    ]) {
      await assert.rejects(run, (err: unknown) => {
        assert.equal((err as { getStatus?: () => number }).getStatus?.(), 501)
        assert.equal(
          (err as { getResponse: () => { code?: string } }).getResponse().code,
          'READ_MODEL_NOT_IMPLEMENTED'
        )
        return true
      })
    }
  })
})

// ══ 组 B：Prisma 适配器交出去的键 ════════════════════════════════════════════
describe('组 B：loadHome —— 软删过滤 / 冲正剔除 / 派生来源字段', () => {
  it('child 用 (id, status:active) 查；三张配置表只查 active', async () => {
    const fake = makePrismaFake()
    const port = new PrismaReadRepository(fake.prisma)
    const home = await port.loadHome('child-1')

    assert.ok(home !== null)
    assert.deepEqual(callFor(fake.calls, 'child', 'findFirst').args, {
      where: { id: 'child-1', status: 'active' },
      select: { id: true, name: true, pointsBalance: true }
    })
    assert.deepEqual(
      (callFor(fake.calls, 'habit', 'findMany').args as { where: unknown }).where,
      { childId: 'child-1', status: 'active' }
    )
    assert.deepEqual(
      (callFor(fake.calls, 'pointRule', 'findMany').args as { where: unknown }).where,
      { childId: 'child-1', status: 'active' }
    )
    assert.deepEqual(
      (callFor(fake.calls, 'wish', 'findMany').args as { where: unknown }).where,
      { childId: 'child-1', status: 'active' }
    )
  })

  it('goodHabitCount 排除 correction 与已被冲正的记录；rewardCount 数 redeemed', async () => {
    const fake = makePrismaFake()
    await new PrismaReadRepository(fake.prisma).loadHome('child-1')

    assert.deepEqual(
      (callFor(fake.calls, 'pointRecord', 'count').args as { where: unknown }).where,
      {
        childId: 'child-1',
        category: 'praise',
        source: { not: 'correction' },
        reversedBy: { none: {} }
      }
    )
    assert.deepEqual(
      (callFor(fake.calls, 'wish', 'count').args as { where: unknown }).where,
      { childId: 'child-1', redeemed: true }
    )
  })

  it('行的形状转换：sourceRuleId → ruleId，计数原样返回', async () => {
    const fake = makePrismaFake({ count: 7 })
    const home = (await new PrismaReadRepository(fake.prisma).loadHome('child-1')) as HomeSnapshotRow
    assert.equal(home.habits[0].ruleId, 'r-1')
    assert.equal(home.goodHabitCount, 7)
    assert.equal(home.rewardCount, 4)
  })

  it('孩子不存在（findFirst 返回 null）⇒ null，不去查其它表', async () => {
    const fake = makePrismaFake()
    const prisma = fake.prisma as unknown as { child: { findFirst: () => Promise<null> } }
    prisma.child.findFirst = async () => null
    const port = new PrismaReadRepository(fake.prisma)
    assert.equal(await port.loadHome('ghost'), null)
    assert.equal(
      fake.calls.some((call) => call.model !== 'child'),
      false,
      '孩子都没找到却继续查了习惯/规则 —— 会给出一份“空孩子”的假快照'
    )
  })
})

// ══ 组 C：listRecords 的分页与筛选 ══════════════════════════════════════════
describe('组 C：listRecords —— limit+1 判 hasMore，category 真进 where', () => {
  it('不传 category：where 只有 childId；take = limit + 1', async () => {
    const fake = makePrismaFake({ recordRows: [recordOf()] })
    const page = await new PrismaReadRepository(fake.prisma).listRecords({
      childId: 'child-1',
      limit: 50
    })
    assert.ok(page !== null, '夹具里的孩子是 active，不该返回 null')

    const args = callFor(fake.calls, 'pointRecord', 'findMany').args as {
      where: unknown
      take: number
      orderBy: unknown
    }
    assert.deepEqual(args.where, { childId: 'child-1' })
    assert.equal(args.take, 51)
    assert.deepEqual(args.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }])
    assert.equal(page.hasMore, false)
    assert.equal(page.rows.length, 1)
  })

  it('category=praise：进 where；返回 limit 条且 hasMore=true（多取到一条）', async () => {
    const fake = makePrismaFake({
      recordRows: [recordOf({ id: 'rec-1' }), recordOf({ id: 'rec-2' }), recordOf({ id: 'rec-3' })]
    })
    const page = await new PrismaReadRepository(fake.prisma).listRecords({
      childId: 'child-1',
      category: 'praise',
      limit: 2
    })
    assert.ok(page !== null, '夹具里的孩子是 active，不该返回 null')

    assert.deepEqual(
      (callFor(fake.calls, 'pointRecord', 'findMany').args as { where: unknown }).where,
      { childId: 'child-1', category: 'praise' }
    )
    assert.equal(page.rows.length, 2, '适配器必须丢掉多取的那一条')
    assert.equal(page.hasMore, true)
  })

  it('before 游标：进 where 的是 (createdAt, id) 的**双层**条件，不是 offset', async () => {
    const fake = makePrismaFake({ recordRows: [recordOf()] })
    await new PrismaReadRepository(fake.prisma).listRecords({
      childId: 'child-1',
      limit: 50,
      before: {
        createdAt: new Date('2026-10-18T01:00:00.000Z'),
        id: 'rec-9'
      }
    })

    assert.deepEqual(
      (callFor(fake.calls, 'pointRecord', 'findMany').args as { where: unknown }).where,
      {
        childId: 'child-1',
        OR: [
          { createdAt: { lt: new Date('2026-10-18T01:00:00.000Z') } },
          { createdAt: new Date('2026-10-18T01:00:00.000Z'), id: { lt: 'rec-9' } }
        ]
      },
      '游标只比时间 —— 同一毫秒的剩余行会被漏掉（第二页丢行）'
    )
  })

  it('孩子不存在 / 已软删 ⇒ null，且**不**去查流水（/records 也要 404 而不是空页）', async () => {
    const fake = makePrismaFake({ recordRows: [recordOf()] })
    const prisma = fake.prisma as unknown as { child: { findFirst: () => Promise<null> } }
    prisma.child.findFirst = async () => null

    const page = await new PrismaReadRepository(fake.prisma).listRecords({
      childId: 'ghost',
      limit: 50
    })

    assert.equal(page, null)
    assert.equal(
      fake.calls.some((call) => call.model === 'pointRecord'),
      false,
      '孩子都没找到却继续查了流水 —— 会给出「还没有任何记录」的假空页'
    )
  })
})


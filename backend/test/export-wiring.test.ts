/**
 * export-wiring.test.ts —— 导出端口的**装配口径** ＋ Prisma 查询键 ＋ 纯函数映射
 * （W7-C，2026-10-27）
 *
 * ── 三半证据，缺一不可 ──────────────────────────────────────────────────────
 *   `export-http.test.ts` 证明「HTTP 上三道屏障 / 拒绝 / 形状 / 响应头」；
 *   本文件证明：
 *     ① **谁来读**：有库 ⇒ `PrismaExportRepository`；无库 ⇒ 501（不是空文件）；
 *        无库装配的图里**没有** `PrismaModule`（否则离线用例装配阶段就崩）；
 *     ② **交给 Prisma 的键**：`where: { id, status: 'active' }`（软删 ≠ 空）、
 *        `$transaction` 只开一次（同刻快照）、**只选白名单列**（绝不带
 *        `openId` / `pinHash` / `ipHash` / `idempotencyKey`）、限额 `take` 生效；
 *     ③ **快照 → 文件**是纯函数：时间 ISO 化、`null` 不塌缩、截断写在 `summary` 里。
 *
 * ── 它**不**证明的事 ────────────────────────────────────────────────────────
 *   「接了真库读得对」只能由 `test-db/export-db.dbtest.ts` 证明。替身只能证明
 *   「交出去的键长什么样」，证明不了 Postgres 上这些关系真的连得起来。
 *
 * ★ 还额外钉住一条**豁免**：`ExportController` 的守卫列表里**没有** `ConsentGuard`。
 *   这条若不写，将来有人“顺手统一守卫顺序”把同意闸门加进来，撤回同意的家长
 *   就再也导不出自己的数据 —— 而所有现有用例仍然全绿（因为都跑在 granted 上）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NotImplementedException, RequestMethod, type DynamicModule } from '@nestjs/common'
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'

import { ChildrenController } from '../src/children/children.controller'
import { ConsentGuard } from '../src/consent/consent.guard'
import { DeviceSessionGuard } from '../src/device-session/device-session.guard'
import { ExportController } from '../src/export/export.controller'
import { EXPORT_SCHEMA_VERSION, buildExportDocument } from '../src/export/export.document'
import { ExportModule, resolveExportRepositoryClass } from '../src/export/export.module'
import { PrismaExportRepository } from '../src/export/export.prisma.repository'
import {
  EXPORT_LIMITS,
  EXPORT_REPOSITORY,
  NotImplementedExportRepository,
  type ExportPort
} from '../src/export/export.repository'
import { MembershipGuard } from '../src/membership/membership.guard'
import { PrismaModule } from '../src/prisma/prisma.module'
import type { PrismaService } from '../src/prisma/prisma.service'
import { PermissionsGuard } from '../src/permissions/permissions.guard'
import { REQUIRED_ACTION_KEY } from '../src/permissions/require-action.decorator'
import { makeExportSnapshot } from './support/export-fake'


interface PrismaCall {
  model: string
  method: string
  args: unknown
}

interface FakeOptions {
  /** `undefined` ⇒ 给一个正常的档案行；显式的 `null` ⇒ 模拟「档案已软删」。 */
  child?: Record<string, unknown> | null
  counts?: Partial<Record<'pointRecord' | 'approvalRequest' | 'auditLog', number>>
}

/**
 * 记录调用的 Prisma 替身。
 *
 * ★ 每个 delegate 都返回 **Promise**：真实现里 `$transaction([...])` 收到的是
 *   已经启动的 Promise 数组，替身若返回同步值，`Promise.all` 的行数与顺序
 *   就对不上 —— 用例会以为「事务里有 11 项」而实际上漏了。
 */
function makePrismaFake(options: FakeOptions = {}): {
  prisma: PrismaService
  calls: PrismaCall[]
} {
  const calls: PrismaCall[] = []
  const at = (day: string): Date => new Date(`${day}T01:00:00.000Z`)

  const defaultChild = {
    id: 'child-1',
    name: '小满',
    pointsBalance: 4,
    ageBand: 'primary_low',
    focusAreas: ['study'],
    onboardedAt: at('2026-09-01'),
    createdAt: at('2026-08-15')
  }

  const rows: Record<string, unknown[]> = {
    childMember: [
      {
        userId: 'u-dad',
        role: 'guardian',
        status: 'active',
        joinedAt: at('2026-08-15'),
        removedAt: null,
        user: { displayName: '爸爸' }
      }
    ],
    // ★ 两条：一条**软删**的规则也必须在导出里（否则流水里的 ruleId 指向虚空）。
    pointRule: [
      {
        id: 'r-1',
        title: '完成作业',
        condition: '当天作业全部完成',
        dailyLimit: 2,
        points: 3,
        direction: 'reward',
        icon: 'book',
        color: '#81C784',
        currentVersion: 2,
        status: 'active',
        deletedAt: null,
        createdAt: at('2026-09-02'),
        updatedAt: at('2026-09-10'),
        versions: [
          {
            version: 1,
            title: '完成作业',
            condition: '当天作业全部完成',
            dailyLimit: 1,
            points: 2,
            direction: 'reward',
            changeNote: null,
            changedByUserId: 'u-dad',
            changedAt: at('2026-09-02')
          },
          {
            version: 2,
            title: '完成作业',
            condition: '当天作业全部完成',
            dailyLimit: 2,
            points: 3,
            direction: 'reward',
            changeNote: '每天 2 次',
            changedByUserId: 'u-dad',
            changedAt: at('2026-09-10')
          }
        ]
      },
      {
        id: 'r-9',
        title: '旧规则',
        condition: '已删除',
        dailyLimit: 1,
        points: 1,
        direction: 'penalty',
        icon: 'clock',
        color: '#E57373',
        currentVersion: 1,
        status: 'deleted',
        deletedAt: at('2026-09-20'),
        createdAt: at('2026-09-01'),
        updatedAt: at('2026-09-20'),
        versions: []
      }
    ],
    habit: [],
    wish: [],
    pointRecord: [
      {
        id: 'rec-1',
        titleSnapshot: '完成作业',
        conditionSnapshot: null,
        dailyLimitSnapshot: 2,
        costSnapshot: null,
        pointsDelta: 3,
        category: 'praise',
        source: 'guardian',
        note: '',
        operatorUserId: 'u-dad',
        operatorRole: 'guardian',
        balanceAfter: 3,
        ruleId: 'r-1',
        ruleVersion: 2,
        habitId: null,
        wishId: null,
        reversesRecordId: null,
        reversedAt: null,
        createdAt: at('2026-09-11')
      }
    ],
    approvalRequest: [],
    guardianConsent: [],
    auditLog: []
  }

  const delegate = (model: string): Record<string, (args: unknown) => Promise<unknown>> => ({
    findFirst: async (args: unknown) => {
      calls.push({ model, method: 'findFirst', args })
      return 'child' in options ? options.child : defaultChild
    },
    findMany: async (args: unknown) => {
      calls.push({ model, method: 'findMany', args })
      return rows[model] ?? []
    },
    count: async (args: unknown) => {
      calls.push({ model, method: 'count', args })
      const override = options.counts?.[model as 'pointRecord' | 'approvalRequest' | 'auditLog']
      return override ?? (rows[model] ?? []).length
    }
  })

  const prisma = {
    child: delegate('child'),
    childMember: delegate('childMember'),
    pointRule: delegate('pointRule'),
    habit: delegate('habit'),
    wish: delegate('wish'),
    pointRecord: delegate('pointRecord'),
    approvalRequest: delegate('approvalRequest'),
    guardianConsent: delegate('guardianConsent'),
    auditLog: delegate('auditLog'),
    $transaction: async (ops: Promise<unknown>[]) => {
      calls.push({ model: '$transaction', method: 'array', args: ops.length })
      return Promise.all(ops)
    }
  } as unknown as PrismaService

  return { prisma, calls }
}

function classProviderOf(graph: DynamicModule): { provide: unknown; useClass: unknown } {
  const providers: unknown[] = graph.providers ?? []
  const found = providers.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { provide?: unknown }).provide === EXPORT_REPOSITORY
  )
  assert.ok(found !== undefined, '装配图里没有 EXPORT_REPOSITORY 的 provider')
  return found as { provide: unknown; useClass: unknown }
}

// ══ 组 A：装配 —— 谁来读 ═════════════════════════════════════════════════════
describe('组 A：装配 —— 有库走 Prisma，无库响亮 501（不是空文件）', () => {
  it('唯一分叉点：两个分支**不许是同一个类**', () => {
    assert.equal(resolveExportRepositoryClass(true), PrismaExportRepository)
    assert.equal(resolveExportRepositoryClass(false), NotImplementedExportRepository)
    assert.notEqual(resolveExportRepositoryClass(true), resolveExportRepositoryClass(false))
  })

  it('无库装配：EXPORT_REPOSITORY 绑 501 实现，且图里没有 PrismaModule', () => {
    const graph = ExportModule.register({ hasDatabase: false })
    assert.deepEqual(graph.controllers, [ExportController])

    const provider = classProviderOf(graph)
    assert.equal(provider.provide, EXPORT_REPOSITORY)
    assert.equal(provider.useClass, NotImplementedExportRepository)

    // 无库时导入 PrismaModule ⇒ 离线 `npm test` 在装配阶段就崩（PrismaService 刻意抛错）。
    assert.equal(((graph.imports ?? []) as unknown[]).includes(PrismaModule), false)
  })

  it('有库装配：EXPORT_REPOSITORY 绑 Prisma 实现，并导入 PrismaModule', () => {
    const graph = ExportModule.register({ hasDatabase: true })
    const provider = classProviderOf(graph)
    assert.equal(provider.useClass, PrismaExportRepository)
    assert.equal(((graph.imports ?? []) as unknown[]).includes(PrismaModule), true)
  })

  it('无库的端口是 501 EXPORT_MODEL_NOT_IMPLEMENTED —— 绝不返回空快照', async () => {
    const port: ExportPort = new NotImplementedExportRepository()
    await assert.rejects(
      () => port.collect('child-1', EXPORT_LIMITS),
      (error: unknown) => {
        assert.ok(error instanceof NotImplementedException)
        assert.equal(
          (error.getResponse() as { code?: string }).code,
          'EXPORT_MODEL_NOT_IMPLEMENTED'
        )
        return true
      }
    )
  })
})


// ══ 组 B：守卫与路由 ═════════════════════════════════════════════════════════
describe('组 B：三道屏障挂在路由上，且**没有**同意闸门', () => {
  it('守卫顺序 = 身份 → 成员 → 矩阵（与 /home 一致）', () => {
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, ExportController), [
      DeviceSessionGuard,
      MembershipGuard,
      PermissionsGuard
    ])
  })

  it('★ 对照：写端点**有** ConsentGuard —— 证明下面那条断言看的不是空数组', () => {
    const writeGuards = Reflect.getMetadata(GUARDS_METADATA, ChildrenController) as unknown[]
    assert.equal(writeGuards.includes(ConsentGuard), true)
  })

  it('★ 导出**不**挂 ConsentGuard：撤回同意后仍能把自己提供的数据带走（04 §5）', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ExportController) as unknown[]
    assert.equal(
      guards.includes(ConsentGuard),
      false,
      '导出被接进同意闸门 ⇒ 撤回同意的家长再也导不出数据，可携带权变相被扣住'
    )
  })

  it('路由：GET /export → 动作 export_family_data', () => {
    assert.equal(Reflect.getMetadata(PATH_METADATA, ExportController), 'export')
    const handler = ExportController.prototype.family
    assert.equal(Reflect.getMetadata(REQUIRED_ACTION_KEY, handler), 'export_family_data')
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET)
  })
})

// ══ 组 C：交给 Prisma 的键 ═══════════════════════════════════════════════════
describe('组 C：Prisma 适配器 —— 同刻快照、最小列、限额', () => {
  it('孩子已软删 ⇒ null（不是空快照：家长会以为数据全丢了）', async () => {
    const { prisma } = makePrismaFake({ child: null })
    const snapshot = await new PrismaExportRepository(prisma).collect('child-1', EXPORT_LIMITS)
    assert.equal(snapshot, null)
  })

  it('一个事务读全份；每个查询的 where 都收口在 childId', async () => {
    const { prisma, calls } = makePrismaFake()
    const snapshot = await new PrismaExportRepository(prisma).collect('child-1', EXPORT_LIMITS)
    assert.ok(snapshot !== null)

    assert.equal(calls.filter((call) => call.model === '$transaction').length, 1, '分成多次查询就不是同刻快照了')
    const childCall = calls.find((call) => call.model === 'child' && call.method === 'findFirst')
    assert.deepEqual((childCall?.args as { where?: unknown }).where, {
      id: 'child-1',
      status: 'active'
    })
    for (const call of calls.filter(
      (candidate) => candidate.method === 'findMany' || candidate.method === 'count'
    )) {
      assert.deepEqual(
        (call.args as { where?: unknown }).where,
        { childId: 'child-1' },
        `${call.model}.${call.method} 的 where 没有收口在 childId —— 一次导出可能跨到别人家`
      )
    }
  })

  it('★ 软删项照样导出（否则流水里的 ruleId 指向文件里不存在的行）', async () => {
    const { prisma } = makePrismaFake()
    const snapshot = await new PrismaExportRepository(prisma).collect('child-1', EXPORT_LIMITS)
    assert.ok(snapshot !== null)
    assert.equal(snapshot.rules.length, 2)
    assert.equal(snapshot.rules[1]?.status, 'deleted')
    assert.equal(snapshot.rules[1]?.deletedAt?.toISOString(), '2026-09-20T01:00:00.000Z')
    // 规则必须带整条变更史（02 §5.6），且按版本升序。
    assert.deepEqual(
      snapshot.rules[0]?.versions.map((version) => version.version),
      [1, 2]
    )
  })

  it('★ 数据最小化：select 里没有登录凭据 / 口令材料 / 重放键', async () => {
    const { prisma, calls } = makePrismaFake()
    await new PrismaExportRepository(prisma).collect('child-1', EXPORT_LIMITS)
    const serialized = JSON.stringify(calls)
    for (const secret of ['openId', 'pinHash', 'ipHash', 'idempotencyKey', 'passwordHash']) {
      assert.equal(
        serialized.includes(secret),
        false,
        `导出的查询里出现 ${secret} —— 文件会被转发，凭据不该随数据出门`
      )
    }
  })

  it('限额：大表 take = 上限、并 count 出全量；小集合多取一条来判定截断', async () => {
    const { prisma, calls } = makePrismaFake({ counts: { pointRecord: 60000 } })
    const snapshot = await new PrismaExportRepository(prisma).collect('child-1', EXPORT_LIMITS)
    assert.ok(snapshot !== null)

    const takeOf = (model: string): unknown =>
      (calls.find((call) => call.model === model && call.method === 'findMany')?.args as {
        take?: unknown
      }).take

    assert.equal(takeOf('pointRecord'), EXPORT_LIMITS.records)
    assert.equal(takeOf('approvalRequest'), EXPORT_LIMITS.approvals)
    assert.equal(takeOf('auditLog'), EXPORT_LIMITS.auditLogs)
    // +1 是“是真的正好 N 条，还是还有更多”的判据；等于 N 会把满页误报成截断。
    assert.equal(takeOf('childMember'), EXPORT_LIMITS.small + 1)
    assert.equal(takeOf('pointRule'), EXPORT_LIMITS.small + 1)

    assert.equal(snapshot.totals.records, 60000)
    assert.equal(calls.filter((call) => call.method === 'count').length, 3)
  })

  it('账本按时间**正序**取（家长要按滚动求和核 balanceAfter，倒序极易算错）', async () => {
    const { prisma, calls } = makePrismaFake()
    await new PrismaExportRepository(prisma).collect('child-1', EXPORT_LIMITS)
    const recordCall = calls.find(
      (call) => call.model === 'pointRecord' && call.method === 'findMany'
    )
    assert.deepEqual((recordCall?.args as { orderBy?: unknown }).orderBy, [
      { createdAt: 'asc' },
      { id: 'asc' }
    ])
  })
})


// ══ 组 D：快照 → 导出文件（纯函数） ═══════════════════════════════════════════
describe('组 D：导出文件 —— 九段齐全、时间 ISO、截断写在文件里', () => {
  const generatedAt = new Date('2026-10-27T09:00:00.000Z')
  const document = buildExportDocument(makeExportSnapshot(), generatedAt)

  it('版本号 + 生成时间来自入参（纯函数不读时钟）', () => {
    assert.equal(document.schemaVersion, EXPORT_SCHEMA_VERSION)
    assert.equal(document.generator, 'kids-points-backend')
    assert.equal(document.generatedAt, '2026-10-27T09:00:00.000Z')
  })

  it('九段齐全：档案 / 成员 / 规则与版本 / 习惯 / 心愿 / 流水 / 审批 / 同意 / 审计', () => {
    assert.deepEqual(Object.keys(document).sort(), [
      'approvals',
      'auditLogs',
      'child',
      'consents',
      'generatedAt',
      'generator',
      'habits',
      'members',
      'records',
      'rules',
      'schemaVersion',
      'summary',
      'wishes'
    ])
    assert.equal(document.rules[0]?.versions.length, 2)
    assert.equal(document.members.length, 2)
    assert.equal(document.records.length, 2)
    assert.equal(document.approvals.length, 1)
    assert.equal(document.consents.length, 1)
    assert.equal(document.auditLogs.length, 1)
  })

  it('★ 时间全部 ISO 字符串、Date 一个不剩（JSON 往返不变形）', () => {
    assert.equal(document.child.createdAt, '2026-08-15T01:00:00.000Z')
    assert.equal(document.records[0]?.createdAt, '2026-09-11T01:00:00.000Z')
    assert.equal(document.rules[0]?.versions[1]?.changedAt, '2026-09-10T01:00:00.000Z')
    // 若还有 Date 实例，序列化后会变成字符串 ⇒ 与原文不相等。
    assert.deepEqual(JSON.parse(JSON.stringify(document)), document)
  })

  it('`null` 保持 `null`（不塌缩成空串）：没有值 ≠ 空值', () => {
    assert.equal(document.wishes[0]?.redeemedAt, null)
    assert.equal(document.records[0]?.reversedAt, null)
    assert.equal(document.approvals[0]?.decidedAt, null)
    assert.equal(document.members[0]?.removedAt, null)
  })

  it('summary：counts 是本文件条数，totals 是库里全量；未截断', () => {
    assert.deepEqual(document.summary.counts, {
      members: 2,
      rules: 1,
      habits: 1,
      wishes: 1,
      records: 2,
      approvals: 1,
      consents: 1,
      auditLogs: 1
    })
    assert.deepEqual(document.summary.totals, { records: 2, approvals: 1, auditLogs: 1 })
    assert.equal(document.summary.truncated, false)
    assert.deepEqual(document.summary.truncatedSections, [])
  })

  it('★ 截断必须写在文件里，且段名顺序固定（文件 diff 不该漂移）', () => {
    const truncated = buildExportDocument(
      {
        ...makeExportSnapshot(),
        totals: { records: 9, approvals: 9, auditLogs: 2 },
        truncatedSmall: ['wishes', 'members']
      },
      generatedAt
    ).summary
    assert.equal(truncated.truncated, true)
    assert.deepEqual(truncated.truncatedSections, [
      'members',
      'wishes',
      'records',
      'approvals',
      'auditLogs'
    ])
  })

  it('审批的 payload 原样透出（含 costSnapshot，02 §4.3）', () => {
    assert.deepEqual(document.approvals[0]?.payload, { wishId: 'w-1', costSnapshot: 20 })
    assert.deepEqual(document.auditLogs[0]?.before, { points: 2 })
    assert.deepEqual(document.auditLogs[0]?.after, { points: 3 })
  })

  it('★ 文件里不出现登录凭据 / 口令 / 重放键（数据最小化）', () => {
    const serialized = JSON.stringify(document)
    for (const secret of ['openId', 'pinHash', 'ipHash', 'idempotencyKey', 'passwordHash']) {
      assert.equal(serialized.includes(secret), false, `导出文件里出现 ${secret}`)
    }
  })

  it('同意记录含 withdrawn 行 —— 撤回后仍可导出，且状态原样呈现', () => {
    assert.equal(document.consents[0]?.status, 'withdrawn')
    assert.equal(document.consents[0]?.withdrawnAt, '2026-10-01T01:00:00.000Z')
  })
})


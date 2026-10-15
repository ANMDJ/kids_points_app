/**
 * ledger-wiring.test.ts —— **装配口径**的用例（W2-C，2026-10-15）
 *
 * ── 这个文件回答的问题，与 `ledger-gate.test.ts` 完全不同 ────────────────────
 *   `ledger-gate.test.ts` 管「判定语义对不对」（纯函数、离线穷举）；
 *   本文件管「**谁来落库**这件事，各情形下各绑到了谁」：
 *     无库 ⇒ 显式 501（响亮失败，不是静默 no-op）
 *     有库 ⇒ 真 Prisma 适配器
 *   ⇒ 「账本内核已落地」≠「积分能记账了」。中间差的就是这个文件钉的东西。
 *
 * ── ★ 为什么"有库"那条**不连库**也能钉住它 ────────────────────────────────────
 *   把 `PrismaService` **替换成替身**（`.overrideProvider(PrismaService)`），
 *   于是可以断言三件只有真装配才有的事：
 *     ① 注入器里 `LEDGER_REPOSITORY` 绑的是 `PrismaLedgerRepository`（不是 501）；
 *     ② 它**走的是注入进来的那个客户端** —— 替身返回 7，`readBalance()` 就得是 7
 *        （这条抓的是"在工厂里自己 `new PrismaService()`"：那样会绕开全仓唯一的连接池，
 *         并让同一次请求的多表写入落在两个事务域上）；
 *     ③ 无库时**图里根本没有 `PrismaService`** —— 这才是"离线用例能跑完"的真正机制
 *        （若改回静态 `imports: [PrismaModule]`，`compile()` 会在构造 `PrismaService` 时抛
 *         「DATABASE_URL 未设置」，本文件立刻红）。
 *
 * ── 它**不**能证明的事（别把绿读多了）──────────────────────────────────────
 *   「接上真库之后读写真的通」只能由 `test-db/ledger-db.dbtest.ts` 组 J 证明：
 *   那里用真 `register()` 建图、从注入器取端口、**读出的余额等于库里的那一行**。
 *   只测装配声明的话，「接了一条断线」照样全绿 —— 这正是本仓库反复出现的假绿形态。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NotFoundException, NotImplementedException, type DynamicModule } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { buildRecordDraft, type PointRecordDraft } from '../src/ledger/ledger.gate'
import { LedgerModule, resolveLedgerRepositoryClass } from '../src/ledger/ledger.module'
import { PrismaLedgerRepository } from '../src/ledger/ledger.prisma.repository'
import {
  LEDGER_REPOSITORY,
  NotImplementedLedgerRepository,
  type LedgerPort
} from '../src/ledger/ledger.repository'
import { hasDatabaseUrl } from '../src/prisma/database-enabled'
import { PrismaService } from '../src/prisma/prisma.service'

const NOW = new Date('2026-10-15T09:00:00.000Z')

/** 一个合法草稿（`append()` 的入参；内容无关紧要，这里只关心它被怎么处理）。 */
function draft(childId = 'child-1'): PointRecordDraft {
  return buildRecordDraft({
    childId,
    ruleVersionRow: null,
    titleSnapshot: '帮忙摆碗筷',
    pointsDelta: 1,
    category: 'adjust',
    source: 'guardian',
    operator: { userId: 'u-dad', role: 'guardian' },
    currentBalance: 0,
    now: NOW,
    idempotencyKey: null
  })
}

/**
 * 从 `register()` 返回的**装配声明**里取出实际绑定的类。
 *
 * 为什么敢断言这个裸对象：动态模块返回的就是 Nest 真正拿去建图的配置 ——
 * 它不是"实现细节"，而是本文件要验的那件事本身（"声明绑了谁"）。
 */
function boundClassOf(dynamic: DynamicModule): unknown {
  const providers = (dynamic.providers ?? []) as { provide: unknown; useClass?: unknown }[]
  const hit = providers.find((p) => p.provide === LEDGER_REPOSITORY)
  assert.ok(hit !== undefined, 'register() 的 providers 里没有 LEDGER_REPOSITORY —— 端口没被导出')
  return hit.useClass
}

/** 断言"这次调用没有假装成功"。 */
async function expect501(run: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await run()
  } catch (err) {
    assert.ok(err instanceof NotImplementedException, `${what} 抛的不是 501：${String(err)}`)
    const body = (err as NotImplementedException).getResponse()
    assert.equal((body as { code?: string }).code, 'LEDGER_PERSISTENCE_NOT_IMPLEMENTED')
    assert.ok(
      (err as Error).message.includes(what),
      `${what} 的报错必须点名是**哪个**操作没实现：${(err as Error).message}`
    )
    return
  }
  assert.fail(
    `${what} 既没成功也没抛错 —— 更糟的情况是它"成功"了：` +
      '孩子的积分会看起来扣了却根本没落库（所以缺实现时必须响亮地失败）'
  )
}

// ── 组 A：判据本身（纯函数，不连库、不建图）──────────────────────────────────
describe('组 A：hasDatabaseUrl / resolveLedgerRepositoryClass —— 判据只有一处', () => {
  it('"有库" = DATABASE_URL 非空（空串 / 全空白都算没有，与 PrismaService 同一口径）', () => {
    assert.equal(hasDatabaseUrl({}), false, '完全没有 DATABASE_URL ⇒ 无库')
    assert.equal(hasDatabaseUrl({ DATABASE_URL: '' }), false, '空串 ⇒ 无库')
    assert.equal(hasDatabaseUrl({ DATABASE_URL: '   ' }), false, '全空白 ⇒ 无库')
    assert.equal(
      hasDatabaseUrl({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db' }),
      true,
      '非空连接串 ⇒ 有库'
    )
    // ★ 两处口径必须一致：`PrismaService` 也把 `''` 当缺失。若这里认 `''` 为"有库"，
    //   就会出现"装配说接了真实现、PrismaService 却说没有连接串"的错位 —— 建图时崩。
    assert.equal(hasDatabaseUrl({ DATABASE_URL: '' }), hasDatabaseUrl({}), '两处判空口径不许漂移')
  })

  it('映射：有库 ⇒ Prisma 适配器；无库 ⇒ 501（两个分支**不许是同一个类**）', () => {
    assert.equal(resolveLedgerRepositoryClass(true), PrismaLedgerRepository)
    assert.equal(resolveLedgerRepositoryClass(false), NotImplementedLedgerRepository)
    assert.notEqual(
      resolveLedgerRepositoryClass(true),
      resolveLedgerRepositoryClass(false),
      '两个分支返回了同一个类 —— 那说明其中一个分支是装饰性的（"有库"其实还是 501）'
    )
  })

  it('register() 的绑定跟着 options 走（显式传参 ≥ 环境，用例靠它把"在哪个世界"钉死）', () => {
    assert.equal(
      boundClassOf(LedgerModule.register({ hasDatabase: false })),
      NotImplementedLedgerRepository
    )
    assert.equal(boundClassOf(LedgerModule.register({ hasDatabase: true })), PrismaLedgerRepository)
    // 「显式传参压过环境」在下面那条用例里（那里才动了环境变量）——
    // 否则本机有 `.env` 的人跑的"有库"替身用例与 CI 上跑的不是同一件事。
  })

  it('★ register() 不带参 ⇒ 按**环境**推断（临时改环境变量，装配跟着变）', () => {
    // 这条是"生产路径走环境"的可执行证明：`main.ts` 第一行 `import 'dotenv/config'`
    // 之后 `AppModule` 才被加载，所以 `register()` 一定能看到 .env 里的 DATABASE_URL。
    // 用完即还原 —— 本仓库的纪律是共享状态不留给下一条用例（runner 也是串行的）。
    const saved = process.env.DATABASE_URL
    try {
      delete process.env.DATABASE_URL
      assert.equal(
        boundClassOf(LedgerModule.register()),
        NotImplementedLedgerRepository,
        '没有 DATABASE_URL 时 register() 绑了真实现 —— 那会让无库 CI 在装配阶段就崩'
      )

      process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/db'
      assert.equal(
        boundClassOf(LedgerModule.register()),
        PrismaLedgerRepository,
        '有 DATABASE_URL 时 register() 仍绑 501 —— 生产环境会"看起来装好了却没落库"'
      )
      assert.equal(
        boundClassOf(LedgerModule.register({ hasDatabase: false })),
        NotImplementedLedgerRepository,
        '显式传的 options 被环境覆盖了 —— 那"用例把世界钉死"就做不到'
      )
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
    }
  })
})


// ── 组 B：真建图（DI 解析出来的到底是谁）─────────────────────────────────────
describe('组 B：DI 真装配 —— 无库 501 / 有库走注入的客户端', () => {
  it('无库：能建图（不炸），端口是 501，且**图里没有 PrismaService**', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LedgerModule.register({ hasDatabase: false })]
    }).compile()
    try {
      const port = moduleRef.get<LedgerPort>(LEDGER_REPOSITORY)
      assert.ok(
        port instanceof NotImplementedLedgerRepository,
        '无库时端口不是 501 实现 —— 那"没有真实现"这句话就成了假话'
      )
      await expect501(() => port.append(draft()), 'append(childId=child-1)')

      // ★ 机制层：无库时**连 PrismaService 都不该存在于图里**。
      //   否则 Nest 会在装配阶段实例化它 → 构造函数抛「DATABASE_URL 未设置」→ 离线用例整体跑不起来。
      assert.throws(
        () => moduleRef.get(PrismaService, { strict: false }),
        `无库时图里竟然有 PrismaService —— 说明 PrismaModule 被静态导入了：` +
          '那会让 `npm run test` 在装配阶段就崩（而不是安静地用 501 跑完）'
      )
    } finally {
      await moduleRef.close()
    }
  })

  it('★ 有库：端口是 PrismaLedgerRepository，且**走的是注入进来的客户端**（替身接管 Prisma）', async () => {
    const seen: unknown[] = []
    const stub = {
      child: {
        findUnique: async (args: unknown) => {
          seen.push(args)
          return { pointsBalance: 7 }
        }
      }
    } as unknown as PrismaService

    const moduleRef = await Test.createTestingModule({
      imports: [LedgerModule.register({ hasDatabase: true })]
    })
      .overrideProvider(PrismaService)
      .useValue(stub)
      .compile()
    try {
      const port = moduleRef.get<LedgerPort>(LEDGER_REPOSITORY)
      assert.ok(
        port instanceof PrismaLedgerRepository,
        `有库时端口是 ${port.constructor.name}，不是 Prisma 适配器 —— 真实现写出来了却没人用它`
      )
      assert.equal(
        moduleRef.get(PrismaService),
        stub,
        '端口用的不是注入的那个 PrismaService（有人自己 new 了一个 ⇒ 绕过全仓唯一的连接池）'
      )

      assert.equal(await port.readBalance('child-1'), 7, '读到的余额不是替身给的值 ⇒ 没走注入的客户端')
      const first = seen[0] as { where?: { id?: string } } | undefined
      assert.equal(seen.length, 1, `readBalance 应当只查一次库，实际查了 ${seen.length} 次`)
      assert.equal(first?.where?.id, 'child-1', `查询没按孩子 id 走：${JSON.stringify(first)}`)
    } finally {
      await moduleRef.close()
    }
  })
})

// ── 组 C：适配器读路径的两条约定（"0 分"与"孩子不存在"必须分得开）──────────────
describe('组 C：PrismaLedgerRepository 的读路径约定（替身 Prisma，不连库）', () => {
  /** 造一个只实现 `child.findUnique` 的替身。 */
  function repoWithChildRow(row: { pointsBalance: number } | null): PrismaLedgerRepository {
    return new PrismaLedgerRepository({
      child: { findUnique: async () => row }
    } as unknown as PrismaService)
  }

  it('查不到孩子 ⇒ 404（`LEDGER_CHILD_NOT_FOUND`），**绝不返回 0**', async () => {
    await assert.rejects(
      async () => repoWithChildRow(null).readBalance('child-ghost'),
      (err: unknown) => {
        assert.ok(err instanceof NotFoundException, `抛的不是 404：${String(err)}`)
        const body = (err as NotFoundException).getResponse() as { code?: string }
        assert.equal(body.code, 'LEDGER_CHILD_NOT_FOUND')
        return true
      },
      '孩子不存在却"返回 0 分" —— 那会让"这个孩子没有账本"看起来像"这个孩子有 0 分"'
    )
  })

  it('孩子存在 ⇒ 原样返回 pointsBalance（0 分是合法余额，不是"不存在"）', async () => {
    assert.equal(await repoWithChildRow({ pointsBalance: 0 }).readBalance('child-1'), 0)
    assert.equal(await repoWithChildRow({ pointsBalance: 42 }).readBalance('child-1'), 42)
  })
})


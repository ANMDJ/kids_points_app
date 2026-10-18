/**
 * membership-wiring.test.ts —— 屏障一的**装配口径**用例（W2-D，2026-10-16）
 *
 * ── 与另外两份屏障一用例的分工（三者互不覆盖）──────────────────────────────
 *   · `membership-gate.test.ts`：「**判定**对不对」——纯函数穷举：
 *     `null ⇒ MEMBER_NOT_FOUND`、`status !== active ⇒ MEMBER_REMOVED`、
 *     `restrictions` 形状坏 ⇒ `MemberRowShapeError`（500）；
 *   · `membership-http.test.ts`：「链条上**顺序与翻码**对不对」——真 HTTP、替身端口；
 *   · 本文件：「**那一行是谁去读的**」——
 *       无库 ⇒ 显式 501（响亮失败，不是"那就当成员放行吧"）
 *       有库 ⇒ 真 Prisma 适配器，用**复合唯一键** `(childId, userId)` 查，
 *              且**不筛 `status`**、**不改 `restrictions`**
 *   ⇒ 内核再对，装到 501 上照样没人查；HTTP 顺序再对，适配器若把 `removed` 行筛掉，
 *     `MEMBER_REMOVED` 就**永远不会发生**。
 *
 * ── ★ 为什么最要紧的一条是"不筛 status"（而不是"能查出来就行"）────────────────
 *   两条 403 的**成因与话术都不同**：没有那一行 = 你不是这个孩子的成员；
 *   有行但非 active = 你的成员位已失效。适配器若写成 `where: { …, status: 'active' }`，
 *   被移出的成员会收到"你不是成员"—— 对一个刚刚被移出的人，这句话在语义上是错的（他曾经是），
 *   在排查上也是误导（`ChildMember.removedAt` 明明有值）。
 *   组 C 用替身钉死这一条；真库那一半在 `test-db/identity-db.dbtest.ts`
 *   （写一行 `status='removed'`，读回来仍是它，内核判成 `MEMBER_REMOVED`）。
 *
 * ── 它**不能**证明的事（别把绿读多了）──────────────────────────────────────
 *   「接上真库之后真的读得到那一行、默认 `restrictions`（`{}`）能过形状校验」
 *   只能由 `test-db/identity-db.dbtest.ts` 证明：那里写真的行、用真 `register()` 建图、
 *   从注入器里取端口去读。只测装配声明的话，「接了一条断线」照样全绿。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NotImplementedException, type DynamicModule } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import {
  MemberRowShapeError,
  resolveMembership,
  toMembership,
  type MembershipLookupRow
} from '../src/membership/membership.gate'
import { MembershipModule, resolveMembershipRepositoryClass } from '../src/membership/membership.module'
import { PrismaMembershipRepository } from '../src/membership/membership.prisma.repository'
import {
  MEMBERSHIP_REPOSITORY,
  NotImplementedMembershipRepository,
  type MembershipPort
} from '../src/membership/membership.repository'
import { PrismaModule } from '../src/prisma/prisma.module'
import { PrismaService } from '../src/prisma/prisma.service'

/** 一行合法成员位（内容无关紧要：本文件只关心它**怎么被查出来**、有没有被中途改过）。 */
function memberRow(over: Partial<MembershipLookupRow> = {}): MembershipLookupRow {
  return {
    childId: 'child-1',
    userId: 'u-dad',
    role: 'guardian',
    status: 'active',
    restrictions: {},
    ...over
  }
}

/**
 * 从 `register()` 返回的**装配声明**里取出实际绑到端口的类。
 * （动态模块返回的就是 Nest 真正拿去建图的配置 —— 本文件要验的正是它。）
 */
function boundClassOf(dynamic: DynamicModule): unknown {
  const providers = (dynamic.providers ?? []) as { provide: unknown; useClass?: unknown }[]
  const hit = providers.find((p) => p.provide === MEMBERSHIP_REPOSITORY)
  assert.ok(
    hit !== undefined,
    'register() 的 providers 里没有 MEMBERSHIP_REPOSITORY —— 端口没被导出（MembershipGuard 会注入失败）'
  )
  return hit.useClass
}

/** 断言"这次调用没有假装读到了成员位"。 */
async function expect501(run: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await run()
  } catch (err) {
    assert.ok(err instanceof NotImplementedException, `${what} 抛的不是 501：${String(err)}`)
    const body = (err as NotImplementedException).getResponse() as { code?: string }
    assert.equal(body.code, 'MEMBERSHIP_QUERY_NOT_IMPLEMENTED')
    assert.ok((err as Error).message.includes(what), `${what} 的报错必须点名是**哪个**查询没实现`)
    return
  }
  assert.fail(
    `${what} 既没成功也没抛错 —— 更糟的是它"成功"了：屏障一看起来查过了，其实没人查（fail-open）`
  )
}

/**
 * 一个**按唯一键取行**的 Prisma 替身（同 `device-session-wiring.test.ts` 的设计思路）。
 *
 * ★ 它真的按 `(childId, userId)` 索引取值，且**只认复合键** `where.childId_userId`；
 *   若适配器改成单键查（`where: { userId }`），替身会交出**另一个孩子**的成员位 ⇒
 *   下面「同一个人在另一个孩子上没有成员位」立刻红。
 *   真库里那个错的后果更重：拿着 A 家的资格去改 B 家的孩子。
 */
function indexStub(rows: MembershipLookupRow[]): { stub: PrismaService; calls: unknown[] } {
  const calls: unknown[] = []
  const stub = {
    childMember: {
      findUnique: async (args: unknown) => {
        calls.push(args)
        const where = (args as { where: Record<string, unknown> }).where
        const composite = where.childId_userId as { childId: string; userId: string } | undefined
        if (composite !== undefined) {
          return (
            rows.find((r) => r.childId === composite.childId && r.userId === composite.userId) ?? null
          )
        }
        // ★ 走到这里说明适配器**没用复合键**：替身按单个 userId 交行（= "childId 被忽略"）。
        //   这是刻意的证伪通道 —— 让它红，而不是静默返回 null 把问题藏起来。
        const userId = where.userId as string | undefined
        return userId === undefined ? null : (rows.find((r) => r.userId === userId) ?? null)
      }
    }
  } as unknown as PrismaService
  return { stub, calls }
}

// ── 组 A：判据本身（纯函数，不连库、不建图）──────────────────────────────────
//   ★ `hasDatabaseUrl()` 的判空口径（空串 / 全空白 ⇒ 无库）由 `ledger-wiring.test.ts` 组 A 钉着 ——
//     本文件不重复一遍：判据只有一处，重复断言只会让以后改口径时漏掉一处。
describe('组 A：装配判据 —— 两个分支不许是同一个类，且只有一个来源', () => {
  it('映射：有库 ⇒ Prisma 适配器；无库 ⇒ 501', () => {
    assert.equal(resolveMembershipRepositoryClass(true), PrismaMembershipRepository)
    assert.equal(resolveMembershipRepositoryClass(false), NotImplementedMembershipRepository)
    assert.notEqual(
      resolveMembershipRepositoryClass(true),
      resolveMembershipRepositoryClass(false),
      '两个分支返回了同一个类 —— 那说明其中一个分支是装饰性的（"有库"其实还是 501）'
    )
  })

  it('register() 的绑定跟着 options 走（显式传参 ≥ 环境，用例靠它把"在哪个世界"钉死）', () => {
    assert.equal(
      boundClassOf(MembershipModule.register({ hasDatabase: false })),
      NotImplementedMembershipRepository
    )
    assert.equal(
      boundClassOf(MembershipModule.register({ hasDatabase: true })),
      PrismaMembershipRepository
    )
  })

  it('★ register() 不带参 ⇒ 按**环境**推断（临时改环境变量，装配跟着变）', () => {
    const saved = process.env.DATABASE_URL
    try {
      delete process.env.DATABASE_URL
      assert.equal(
        boundClassOf(MembershipModule.register()),
        NotImplementedMembershipRepository,
        '没有 DATABASE_URL 时 register() 绑了真实现 —— 那会让无库的 `npm test` 在装配阶段就崩'
      )

      process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/db'
      assert.equal(
        boundClassOf(MembershipModule.register()),
        PrismaMembershipRepository,
        '有 DATABASE_URL 时 register() 仍绑 501 —— 生产会"看起来装好了、其实没人查库"'
      )
      assert.equal(
        boundClassOf(MembershipModule.register({ hasDatabase: false })),
        NotImplementedMembershipRepository,
        '显式传的 options 被环境覆盖了 —— 那"用例把世界钉死"就做不到'
      )
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
    }
  })

  it('★ `PrismaModule` 只在**有库**时进 imports（无库进它 = 离线用例在装配阶段就崩）', () => {
    assert.deepEqual(
      MembershipModule.register({ hasDatabase: false }).imports ?? [],
      [],
      '无库时 imports 非空 —— 里面一旦有 PrismaModule，`npm test` 会在构造 PrismaService 时炸'
    )
    assert.ok(
      (MembershipModule.register({ hasDatabase: true }).imports ?? []).includes(PrismaModule),
      '有库时没导入 PrismaModule —— 适配器将拿不到 PrismaService（那是它唯一的构造依赖）'
    )
  })
})

// ── 组 B：真建图（DI 解析出来的到底是谁）─────────────────────────────────────
describe('组 B：DI 真装配 —— 无库 501 / 有库走注入的客户端', () => {
  it('无库：能建图（不炸），端口是 501，且**图里没有 PrismaService**', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MembershipModule.register({ hasDatabase: false })]
    }).compile()
    try {
      const port = moduleRef.get<MembershipPort>(MEMBERSHIP_REPOSITORY)
      assert.ok(
        port instanceof NotImplementedMembershipRepository,
        '无库时端口不是 501 实现 —— 那"屏障一还没查过库"这句话就成了假话'
      )
      await expect501(
        () => port.findMembership('child-1', 'u-dad'),
        'findMembership(child-1, u-dad)'
      )

      assert.throws(
        () => moduleRef.get(PrismaService, { strict: false }),
        '无库时图里竟然有 PrismaService —— 说明 PrismaModule 被静态导入了：' +
          '那会让 `npm test` 在装配阶段就崩（而不是安静地用 501 跑完）'
      )
    } finally {
      await moduleRef.close()
    }
  })

  it('★ 有库：端口是 PrismaMembershipRepository，且**走的是注入进来的客户端**', async () => {
    const row = memberRow()
    const { stub, calls } = indexStub([row])
    const moduleRef = await Test.createTestingModule({
      imports: [MembershipModule.register({ hasDatabase: true })]
    })
      .overrideProvider(PrismaService)
      .useValue(stub)
      .compile()
    try {
      const port = moduleRef.get<MembershipPort>(MEMBERSHIP_REPOSITORY)
      assert.ok(
        port instanceof PrismaMembershipRepository,
        `有库时端口是 ${port.constructor.name}，不是 Prisma 适配器 —— 真实现写出来了却没人用它`
      )
      assert.equal(
        moduleRef.get(PrismaService),
        stub,
        '端口用的不是注入的那个 PrismaService（有人自己 new 了一个 ⇒ 绕过全仓唯一的连接池）'
      )

      assert.deepEqual(
        await port.findMembership('child-1', 'u-dad'),
        row,
        '读回来的不是替身给的那一行 ⇒ 没走注入的客户端'
      )
      assert.equal(calls.length, 1, `findMembership 应当只查一次库，实际查了 ${calls.length} 次`)
    } finally {
      await moduleRef.close()
    }
  })
})

// ── 组 C：适配器读路径的三条约定（替身 Prisma，不连库）───────────────────────
//   ★ 这三条是 `membership.prisma.repository.ts` 文件头"两处不判"的可执行版本：
//     不筛 `status`（`MEMBER_REMOVED` 不许塌成 `MEMBER_NOT_FOUND`）、
//     不改 `restrictions`（形状校验的唯一权威是 `toMembership()`）、
//     不把"查不到"抛成异常（403 归内核翻码）。
describe('组 C：PrismaMembershipRepository 的读路径约定', () => {
  /** 造一个只有 `childMember` 的替身 ＋ 一份调用记录。 */
  function withRows(...rows: MembershipLookupRow[]): {
    repo: PrismaMembershipRepository
    calls: unknown[]
  } {
    const { stub, calls } = indexStub(rows)
    return { repo: new PrismaMembershipRepository(stub), calls }
  }

  it('★ 用**复合唯一键**查：where 里只有 `childId_userId`，没有单键 userId', async () => {
    const { repo, calls } = withRows(memberRow())
    await repo.findMembership('child-1', 'u-dad')
    const where = (calls[0] as { where: Record<string, unknown> }).where
    assert.deepEqual(
      Object.keys(where),
      ['childId_userId'],
      `where 的键不只有复合键：${JSON.stringify(where)} —— ` +
        '单键查时 childId 会退化成"过滤器"，同一个账号在别的孩子那里也会被判成成员'
    )
    assert.deepEqual(
      where.childId_userId,
      { childId: 'child-1', userId: 'u-dad' },
      '复合键的**值**不对（键名对、内容错）—— 例如把 userId 填成了 childId：' +
        '编译期过得去，但语义上 userId 已经不在键里了（谁都能拿别人的成员位）'
    )
  })

  it('★ `select` **恰好**读内核要用的五列（多读的列会被守卫塞进 `req.kpMember`）', async () => {
    const { repo, calls } = withRows(memberRow())
    await repo.findMembership('child-1', 'u-dad')
    const select = (calls[0] as { select: Record<string, unknown> }).select
    assert.deepEqual(Object.keys(select).sort(), [
      'childId',
      'restrictions',
      'role',
      'status',
      'userId'
    ])
    assert.ok(
      Object.values(select).every((v) => v === true),
      'select 里出现了 false / 嵌套写法 —— 那读回来的行会缺字段（形状校验会在运行时才发现）'
    )
  })

  it('★ 同一个人在**另一个孩子**上 ⇒ null（childId 是查询键，不是过滤器）', async () => {
    const { repo } = withRows(memberRow())
    assert.equal(
      await repo.findMembership('child-2', 'u-dad'),
      null,
      '同一个账号在另一个孩子那里读到了成员位 —— 适配器把 childId 当过滤器用了' +
        '（那是拿着 A 家的资格去改 B 家的孩子）'
    )
    assert.equal((await repo.findMembership('child-1', 'u-dad'))?.childId, 'child-1')
  })

  it('查不到 ⇒ `null`，**不是异常**（403 归内核翻码；抛 404 会把"不是成员"报成服务端故障）', async () => {
    const { repo } = withRows()
    assert.equal(await repo.findMembership('child-1', 'u-stranger'), null)
  })

  it('★ 非 active（`status: "removed"`）的行**原样**交出，内核才判得出 `MEMBER_REMOVED`', async () => {
    const removed = memberRow({ status: 'removed' })
    const { repo, calls } = withRows(removed)
    const row = (await repo.findMembership('child-1', 'u-dad')) as MembershipLookupRow

    assert.deepEqual(row, removed, '适配器改写了成员位（它只许读；判定一律归内核）')
    assert.deepEqual(
      Object.keys((calls[0] as { where: Record<string, unknown> }).where),
      ['childId_userId'],
      'where 里被加了 status 过滤 —— 那两条 403 会塌成一条：被移出的人会收到"你不是这个孩子的成员"'
    )

    const verdict = resolveMembership(row)
    assert.equal(verdict.kind, 'DENY')
    assert.equal(
      verdict.kind === 'DENY' ? verdict.code : '?',
      'MEMBER_REMOVED',
      '非 active 的成员位必须判成 MEMBER_REMOVED（"成员位已失效"），不是 MEMBER_NOT_FOUND'
    )

    // 反向旁证：同样是读出来的行，active 的必须判 ALLOW —— 否则"两条 403"其实只剩一条，
    // 上面那条断言就可能是"恰好也过"（红不了的那种绿）。
    const { repo: activeRepo } = withRows(memberRow())
    const active = (await activeRepo.findMembership('child-1', 'u-dad')) as MembershipLookupRow
    assert.equal(resolveMembership(active).kind, 'ALLOW')
  })

  it('★ 形状坏的 `restrictions` **原样**交出 ⇒ `toMembership()` 抛 500（不许"顺手过滤成 {}"）', async () => {
    const typo = memberRow({ restrictions: { childCannotAddwis: true } })
    const { repo } = withRows(typo)
    const row = (await repo.findMembership('child-1', 'u-dad')) as MembershipLookupRow

    assert.deepEqual(
      row.restrictions,
      { childCannotAddwis: true },
      '适配器把非法 restrictions 过滤成了 {} —— 那样一条写坏的限制会**静默失效**（D3b 的病）'
    )
    assert.throws(
      () => toMembership(row),
      (err: unknown) => {
        assert.ok(err instanceof MemberRowShapeError, `抛的不是形状错误：${String(err)}`)
        assert.equal((err as MemberRowShapeError).code, 'INVALID_MEMBER_RESTRICTIONS')
        return true
      },
      'restrictions 形状坏必须 500（数据病），而不是被当成"没有限制"继续'
    )
  })

  it('默认 `{}` 是**合法**形状（否则库里每一行默认值都会 500 —— 真库旁证在 identity-db 套件里）', async () => {
    const { repo } = withRows(memberRow())
    const row = (await repo.findMembership('child-1', 'u-dad')) as MembershipLookupRow
    const membership = toMembership(row)
    assert.deepEqual(membership.restrictions, {}, '默认 {} 没通过形状校验 —— 那屏障一会把整库的默认行判成 500')
    assert.equal(membership.childId, 'child-1')
    assert.equal(membership.userId, 'u-dad')
    assert.equal(membership.role, 'guardian')
  })
})

/**
 * device-session-wiring.test.ts —— 身份层的**装配口径**用例（W2-D，2026-10-16）
 *
 * ── 这个文件回答的问题，与 `session-gate.test.ts` 完全不同 ────────────────────
 *   `session-gate.test.ts` 管「**判定**对不对」（纯函数、离线穷举：角色白名单、
 *   TTL 到期回落 child、childId 同源校验）；
 *   本文件管「**那一行是谁去读的**，各情形下各绑到了谁」：
 *     无库 ⇒ 显式 501（响亮失败，不是"当作匿名放行"）
 *     有库 ⇒ 真 Prisma 适配器，且**用复合唯一键 `(deviceId, childId)` 查**
 *   ⇒ 「身份内核已落地」≠「请求路径真的知道我是谁」。中间差的就是这个文件钉的东西。
 *
 * ── ★ 为什么"有库"那条**不连库**也能钉住它 ────────────────────────────────────
 *   把 `PrismaService` 换成替身（`.overrideProvider(PrismaService)`），于是能断言三件
 *   只有真装配才有的事：
 *     ① 注入器里 `DEVICE_SESSION_REPOSITORY` 绑的是 `PrismaDeviceSessionRepository`（不是 501）；
 *     ② 它**走的是注入进来的那个客户端**（替身怎么答，端口就怎么答）——
 *        这条抓的是"在工厂里自己 `new PrismaService()`"（绕过全仓唯一的连接池，
 *        并让同一次请求里的多表读取落在两个事务域上）；
 *     ③ 无库时**图里根本没有 `PrismaService`** —— 这才是"离线用例能跑完"的真正机制
 *        （若改回静态 `imports: [PrismaModule]`，`compile()` 会在构造 `PrismaService` 时抛
 *         「DATABASE_URL 未设置」，本文件立刻红）。
 *
 * ── 它**不能**证明的事（别把绿读多了）──────────────────────────────────────
 *   「接上真库之后真的读得到那一行」只能由 `test-db/identity-db.dbtest.ts` 证明：
 *   那里写**真的** `DeviceSession` 行（含"同一台设备 + 另一个孩子"），用真 `register()` 建图、
 *   从注入器里取端口去读。只测装配声明的话，「接了一条断线」照样全绿 ——
 *   这正是本仓库反复出现的假绿形态。两半证据的证伪脚本见 `tools/_scratch/w2d-canfail.mjs`。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { NotImplementedException, type DynamicModule } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import {
  DeviceSessionModule,
  resolveDeviceSessionRepositoryClass
} from '../src/device-session/device-session.module'
import { PrismaDeviceSessionRepository } from '../src/device-session/device-session.prisma.repository'
import {
  DEVICE_SESSION_REPOSITORY,
  NotImplementedDeviceSessionRepository,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import { effectiveRole, type SessionLookupRow } from '../src/device-session/session.gate'
import { PrismaModule } from '../src/prisma/prisma.module'
import { PrismaService } from '../src/prisma/prisma.service'

/** 固定"现在"。TTL 边界本身在 `session-gate.test.ts` 穷举，这里只拿它做**旁证**。 */
const NOW = new Date('2026-10-16T09:00:00.000Z')

/** 一行合法会话（内容无关紧要：本文件只关心它**怎么被查出来**、有没有被中途改过）。 */
function sessionRow(over: Partial<SessionLookupRow> = {}): SessionLookupRow {
  return {
    deviceId: 'dev-1',
    childId: 'child-1',
    userId: 'u-dad',
    activeRole: 'guardian',
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...over
  }
}

/**
 * 从 `register()` 返回的**装配声明**里取出实际绑到端口的类。
 *
 * 为什么敢断言这个裸对象：动态模块返回的就是 Nest 真正拿去建图的配置 ——
 * 它不是"实现细节"，而是本文件要验的那件事本身（"声明绑了谁"）。
 */
function boundClassOf(dynamic: DynamicModule): unknown {
  const providers = (dynamic.providers ?? []) as { provide: unknown; useClass?: unknown }[]
  const hit = providers.find((p) => p.provide === DEVICE_SESSION_REPOSITORY)
  assert.ok(
    hit !== undefined,
    'register() 的 providers 里没有 DEVICE_SESSION_REPOSITORY —— 端口根本没被导出（宿主模块会注入失败）'
  )
  return hit.useClass
}

/** 断言"这次调用没有假装读到了会话"。 */
async function expect501(run: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await run()
  } catch (err) {
    assert.ok(err instanceof NotImplementedException, `${what} 抛的不是 501：${String(err)}`)
    const body = (err as NotImplementedException).getResponse() as { code?: string }
    assert.equal(body.code, 'SESSION_LOOKUP_NOT_IMPLEMENTED')
    assert.ok((err as Error).message.includes(what), `${what} 的报错必须点名是**哪个**查询没实现`)
    return
  }
  assert.fail(
    `${what} 既没成功也没抛错 —— 更糟的是它"成功"了：身份层看起来查过了，其实没人查（fail-open）`
  )
}

/**
 * 一个**按唯一键取行**的 Prisma 替身（不是"随便返回一行"的假客户端）。
 *
 * ★ 它为什么必须按 `(deviceId, childId)` 索引取值：让用例有牙齿 ——
 *   若适配器把 childId 退化成过滤器（`findFirst({ where: { deviceId } })`，
 *   见 `device-session.prisma.repository.ts` 文件头的 ❌），替身会按 deviceId 交出
 *   **另一个孩子**的那一行 ⇒ 下面「同一台设备在另一个孩子上必须是 null」立刻红。
 *   （真库那一半证据在 `test-db/identity-db.dbtest.ts`：同样两行数据，真索引不接受那个错。）
 */
function indexStub(rows: SessionLookupRow[]): { stub: PrismaService; calls: unknown[] } {
  const calls: unknown[] = []
  const stub = {
    deviceSession: {
      findUnique: async (args: unknown) => {
        calls.push(args)
        const where = (args as { where: Record<string, unknown> }).where
        const composite = where.deviceId_childId as { deviceId: string; childId: string } | undefined
        if (composite !== undefined) {
          return (
            rows.find((r) => r.deviceId === composite.deviceId && r.childId === composite.childId) ??
            null
          )
        }
        // ★ 走到这里说明适配器**没用复合键**：替身按单个 deviceId 交行（= "childId 被忽略"）。
        //   这不是宽容，是**刻意的证伪通道** —— 让它红，而不是让它静默返回 null。
        const deviceId = where.deviceId as string | undefined
        return deviceId === undefined ? null : (rows.find((r) => r.deviceId === deviceId) ?? null)
      }
    }
  } as unknown as PrismaService
  return { stub, calls }
}

// ── 组 A：判据本身（纯函数，不连库、不建图）──────────────────────────────────
describe('组 A：装配判据 —— 两个分支不许是同一个类，且只有一个来源', () => {
  it('映射：有库 ⇒ Prisma 适配器；无库 ⇒ 501', () => {
    assert.equal(resolveDeviceSessionRepositoryClass(true), PrismaDeviceSessionRepository)
    assert.equal(resolveDeviceSessionRepositoryClass(false), NotImplementedDeviceSessionRepository)
    assert.notEqual(
      resolveDeviceSessionRepositoryClass(true),
      resolveDeviceSessionRepositoryClass(false),
      '两个分支返回了同一个类 —— 那说明其中一个分支是装饰性的（"有库"其实还是 501）'
    )
  })

  it('register() 的绑定跟着 options 走（显式传参 ≥ 环境，用例靠它把"在哪个世界"钉死）', () => {
    assert.equal(
      boundClassOf(DeviceSessionModule.register({ hasDatabase: false })),
      NotImplementedDeviceSessionRepository
    )
    assert.equal(
      boundClassOf(DeviceSessionModule.register({ hasDatabase: true })),
      PrismaDeviceSessionRepository
    )
  })

  it('★ register() 不带参 ⇒ 按**环境**推断（临时改环境变量，装配跟着变）', () => {
    // 这条是"生产走环境"的可执行证明：`main.ts` 第一行 `import 'dotenv/config'`，
    // 之后 `app.module.ts` 才被加载 ⇒ `register()` 一定看得到 .env 里的 DATABASE_URL。
    // 用完即还原 —— 本仓库的纪律是共享状态不留给下一条用例（runner 也是串行的）。
    const saved = process.env.DATABASE_URL
    try {
      delete process.env.DATABASE_URL
      assert.equal(
        boundClassOf(DeviceSessionModule.register()),
        NotImplementedDeviceSessionRepository,
        '没有 DATABASE_URL 时 register() 绑了真实现 —— 那会让无库的 `npm test` 在装配阶段就崩'
      )

      process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/db'
      assert.equal(
        boundClassOf(DeviceSessionModule.register()),
        PrismaDeviceSessionRepository,
        '有 DATABASE_URL 时 register() 仍绑 501 —— 生产会"看起来装好了、其实没人查库"'
      )
      assert.equal(
        boundClassOf(DeviceSessionModule.register({ hasDatabase: false })),
        NotImplementedDeviceSessionRepository,
        '显式传的 options 被环境覆盖了 —— 那"用例把世界钉死"就做不到'
      )
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved
    }
  })

  it('★ `PrismaModule` 只在**有库**时进 imports（无库进它 = 离线用例在装配阶段就崩）', () => {
    assert.deepEqual(
      DeviceSessionModule.register({ hasDatabase: false }).imports ?? [],
      [],
      '无库时 imports 非空 —— 里面一旦有 PrismaModule，`npm test` 会在构造 PrismaService 时炸'
    )
    assert.ok(
      (DeviceSessionModule.register({ hasDatabase: true }).imports ?? []).includes(PrismaModule),
      '有库时没导入 PrismaModule —— 适配器将拿不到 PrismaService（那是它唯一的构造依赖）'
    )
  })
})

// ── 组 B：真建图（DI 解析出来的到底是谁）─────────────────────────────────────
describe('组 B：DI 真装配 —— 无库 501 / 有库走注入的客户端', () => {
  it('无库：能建图（不炸），端口是 501，且**图里没有 PrismaService**', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [DeviceSessionModule.register({ hasDatabase: false })]
    }).compile()
    try {
      const port = moduleRef.get<DeviceSessionPort>(DEVICE_SESSION_REPOSITORY)
      assert.ok(
        port instanceof NotImplementedDeviceSessionRepository,
        '无库时端口不是 501 实现 —— 那"身份层还没查过库"这句话就成了假话'
      )
      await expect501(() => port.findSession('dev-1', 'child-1'), 'findSession(dev-1, child-1)')

      // ★ 机制层：无库时**连 PrismaService 都不该存在于图里**。
      //   否则 Nest 会在装配阶段实例化它 → 构造函数抛「DATABASE_URL 未设置」→ 离线用例整体跑不起来。
      assert.throws(
        () => moduleRef.get(PrismaService, { strict: false }),
        '无库时图里竟然有 PrismaService —— 说明 PrismaModule 被静态导入了：' +
          '那会让 `npm test` 在装配阶段就崩（而不是安静地用 501 跑完）'
      )
    } finally {
      await moduleRef.close()
    }
  })

  it('★ 有库：端口是 PrismaDeviceSessionRepository，且**走的是注入进来的客户端**', async () => {
    const row = sessionRow()
    const { stub, calls } = indexStub([row])
    const moduleRef = await Test.createTestingModule({
      imports: [DeviceSessionModule.register({ hasDatabase: true })]
    })
      .overrideProvider(PrismaService)
      .useValue(stub)
      .compile()
    try {
      const port = moduleRef.get<DeviceSessionPort>(DEVICE_SESSION_REPOSITORY)
      assert.ok(
        port instanceof PrismaDeviceSessionRepository,
        `有库时端口是 ${port.constructor.name}，不是 Prisma 适配器 —— 真实现写出来了却没人用它`
      )
      assert.equal(
        moduleRef.get(PrismaService),
        stub,
        '端口用的不是注入的那个 PrismaService（有人自己 new 了一个 ⇒ 绕过全仓唯一的连接池）'
      )

      assert.deepEqual(
        await port.findSession('dev-1', 'child-1'),
        row,
        '读回来的不是替身给的那一行 ⇒ 没走注入的客户端'
      )
      assert.equal(calls.length, 1, `findSession 应当只查一次库，实际查了 ${calls.length} 次`)
    } finally {
      await moduleRef.close()
    }
  })
})

// ── 组 C：适配器读路径的四条约定（替身 Prisma，不连库）───────────────────────
//   ★ 这四条也正是 `device-session.prisma.repository.ts` 文件头"三处不判"的可执行版本：
//     不筛 `expiresAt`（降级）、不筛 `activeRole`（数据病要 500）、不把查不到抛成异常。
describe('组 C：PrismaDeviceSessionRepository 的读路径约定', () => {
  /** 造一个只有 `deviceSession` 的替身 ＋ 一份调用记录。 */
  function withRows(...rows: SessionLookupRow[]): {
    repo: PrismaDeviceSessionRepository
    calls: unknown[]
  } {
    const { stub, calls } = indexStub(rows)
    return { repo: new PrismaDeviceSessionRepository(stub), calls }
  }

  it('★ 用**复合唯一键**查：where 里只有 `deviceId_childId`，没有单键 deviceId', async () => {
    const { repo, calls } = withRows(sessionRow())
    await repo.findSession('dev-1', 'child-1')
    const where = (calls[0] as { where: Record<string, unknown> }).where
    assert.deepEqual(
      Object.keys(where),
      ['deviceId_childId'],
      `where 的键不只有复合键：${JSON.stringify(where)} —— ` +
        '单键查时 childId 会退化成"过滤器"，另一个孩子的请求会命中这一行（内核的 SESSION_CHILD_MISMATCH 正是为它存在）'
    )
    assert.deepEqual(
      where.deviceId_childId,
      { deviceId: 'dev-1', childId: 'child-1' },
      '复合键的**值**不对（键名对、内容错）—— 例如把 childId 填成了 deviceId：' +
        '编译期过得去，但语义上 childId 已经不在键里了（谁都能拿别人的会话）'
    )
  })

  it('★ `select` **恰好**读内核要用的六列（多读的列会被守卫带进请求上下文）', async () => {
    const { repo, calls } = withRows(sessionRow())
    await repo.findSession('dev-1', 'child-1')
    const select = (calls[0] as { select: Record<string, unknown> }).select
    assert.deepEqual(Object.keys(select).sort(), [
      'activeRole',
      'childId',
      'deviceId',
      'expiresAt',
      // W14（2026-11-03）：孩子模式的降级判定要用它。少这一列 ⇒ 内核把
      // `undefined` 当成"没开孩子模式"⇒ 孩子直接拿到家长权限（静默提权）。
      'kidModeUntil',
      'userId'
    ])
    assert.ok(
      Object.values(select).every((v) => v === true),
      'select 里出现了 false / 嵌套写法 —— 那读回来的行会缺字段（形状校验会在运行时才发现）'
    )
  })

  it('★ 同一 deviceId 在**另一个孩子**上 ⇒ null（childId 是查询键，不是过滤器）', async () => {
    const { repo } = withRows(sessionRow())
    assert.equal(
      await repo.findSession('dev-1', 'child-2'),
      null,
      '同一台设备在另一个孩子上读到了会话 —— 适配器把 childId 当过滤器用了' +
        '（"在哪个孩子的档案上"这一半身份又回到客户端手里）'
    )
    assert.equal(
      (await repo.findSession('dev-1', 'child-1'))?.childId,
      'child-1',
      '本该命中的那一行反而读不到了 —— 查询键拼得不对'
    )
  })

  it('查不到 ⇒ `null`，**不是异常**（401 归守卫；抛 404 会把"没登录"报成服务端故障）', async () => {
    const { repo } = withRows()
    assert.equal(await repo.findSession('dev-nobody', 'child-1'), null)
  })

  it('★ 过期行**原样**交出（在 SQL 里筛 `expiresAt` 会让 TTL 降级永远不发生）', async () => {
    const expired = sessionRow({ expiresAt: new Date(NOW.getTime() - 1_000) })
    const { repo, calls } = withRows(expired)
    const row = await repo.findSession('dev-1', 'child-1')
    assert.deepEqual(row, expired, '适配器改写了会话行（它只许读；判定一律归内核）')
    assert.deepEqual(
      Object.keys((calls[0] as { where: Record<string, unknown> }).where),
      ['deviceId_childId'],
      'where 里被加了时间/状态过滤 —— 那会把"过期 ⇒ 回落 child"吃成 401 SESSION_NOT_FOUND'
    )
    assert.equal(
      effectiveRole(row as SessionLookupRow, NOW),
      'child',
      '过期 guardian 的有效角色必须是 child（§9.19 的降级口径）—— 这正是"不筛"的理由本身'
    )
  })

  it('★ 枚举外的 `activeRole` 原样交出 ⇒ 内核 500（数据病不许伪装成 401）', async () => {
    const { repo } = withRows(sessionRow({ activeRole: 'wizard' }))
    const row = (await repo.findSession('dev-1', 'child-1')) as SessionLookupRow
    assert.equal(row.activeRole, 'wizard', '适配器把非法角色"修正"成了合法值 —— 那是把数据病静默抹掉')
    assert.throws(
      () => effectiveRole(row, NOW),
      /activeRole 非法/,
      '枚举外的角色必须在内核里响亮（500），而不是被适配器筛成"查不到会话"（401）'
    )
  })
})

/**
 * ledger-db.dbtest.ts —— 账本 **真库不变量套件**（W2-B，2026-10-15）
 *
 * 与 `test/ledger-gate.test.ts`（离线用例）的分工：
 *   · 离线用例回答"**判定语义**对不对"（负分不许记成加分、余额不足必须拒绝……）；
 *   · 本文件回答"**落到 Postgres 之后**不变量还成立吗"（I1–I6）。
 *     这些恰恰是纯函数**永远证明不了**的东西：复合外键、`REVOKE`、事务顺序、并发。
 *
 * ── 三个"必须真库"的理由（也是本文件存在的理由）─────────────────────────────
 *   ① **I2 的定序**：PostgreSQL 的 `now()` 在**同一事务内恒定** ⇒ 同事务写两笔
 *      `createdAt` 完全并列 ⇒ 滚动求和没有唯一解。离线用例只能"假设"时间戳可定序，
 *      真库才会把这件事摆到脸上（详见 W2-A 记录的真库陷阱）；
 *   ② **I3 / I5 是库层机制**：复合外键与 `REVOKE` 生效与否，只有连上库才能断言
 *      （写一句"我们改了权限"是空承诺 —— D12 同类）；
 *   ③ **并发与 CAS**：`SELECT … FOR UPDATE` ＋ 余额 CAS 是否真的挡住"两笔同时扣分"，
 *      只有两条真连接并发跑才看得见。
 *
 * ── ★ 两处刻意的"不干净"，都要读清楚 ────────────────────────────────────────
 *   ① **本套件会永久留下实验数据**：`PointRecord` 的 `DELETE` 被 REVOKE（I5 生效的证据），
 *      而 `Child` 上的外键是 `onDelete: Restrict` ⇒ 作为测试夹具的孩子/流水**删不掉**。
 *      因此每个用例用**全新 id**（`dbtest-<run>-<label>`），"链从 0 开始"这个前提才成立；
 *   ② **全库级检查只做计数类红线**（负余额、孤儿版本引用），**不做全库 I2 链**：
 *      本套件**故意**会在专用孩子上造"并列时间戳""未来时间戳"的行（用来证明尺子与
 *      定序修复的边界）—— 全库跑 I2 会把那些刻意造的行判红 ⇒ 套件自我污染、第二次运行必红。
 *      这个取舍写在这里，是为了别让后来者把"全库 I2"当成遗漏。
 *
 *   ③ **装配也是真库才验得完**：组 J 用真的 `LedgerModule.register()` 建图、从 DI 取端口 ——
 *      若 `LEDGER_REPOSITORY` 还绑着 501 实现，前面各组全是 `new` 出来的实例，会**全部照绿**。
 *
 * 入口：`npm run test:db`（= `scripts/run-db-tests.mjs`；缺 `DATABASE_URL` 直接红）。
 * 只许对着**开发/实验库**跑（脚本里有 `NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { HttpException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Prisma } from '@prisma/client'

import {
  LedgerDeniedError,
  buildRecordDraft,
  findSnapshotMismatches,
  reverseRecordDraft,
  verifyBalanceChain,
  type LedgerChainRow,
  type LedgerOperator,
  type PointRecordDraft,
  type RuleVersionSnapshot,
  type SnapshotLike
} from '../src/ledger/ledger.gate'
import { LedgerModule } from '../src/ledger/ledger.module'
import { PrismaLedgerRepository } from '../src/ledger/ledger.prisma.repository'
import { LEDGER_REPOSITORY, type LedgerPort } from '../src/ledger/ledger.repository'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 —— 保证每次跑都是"新孩子、新规则、空账本"。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

/**
 * 调用方时钟：**故意**设成 2020 年。
 * 用途是常设断言"落库的 `createdAt` 由**端口**决定，不是照抄调用方的 `now`" ——
 * 内核要求调用方注入 `now`（判定要可复现），但那只是"业务意义上的发生时间"，
 * 账本**顺序**必须由持库连接的人给（见 `resolveAppendCreatedAt()`）。
 */
const CALLER_CLOCK = new Date('2020-01-01T00:00:00.000Z')

let prisma: PrismaService
let repo: LedgerPort
let guardian: LedgerOperator
let guardianUserId: string

/** 建一个全新的孩子（id 带运行前缀 ⇒ 不会与历史数据混链）。 */
async function makeChild(label: string): Promise<string> {
  const id = `dbtest-${RUN}-${label}`
  await prisma.child.create({ data: { id, name: `DB 套件 ${label}` } })
  return id
}

/** 建一条规则 ＋ 它的 v1 版本行（版本行才是真相之源）。 */
async function makeRule(
  childId: string,
  label: string,
  points: number,
  direction: 'reward' | 'penalty'
): Promise<{ ruleId: string; v1: RuleVersionSnapshot }> {
  const ruleId = `dbtest-${RUN}-rule-${label}`
  const title = `规则 ${label}`
  const condition = '完成一次'
  await prisma.pointRule.create({
    data: {
      id: ruleId,
      childId,
      title,
      condition,
      dailyLimit: 1,
      points,
      direction,
      icon: 'star',
      color: '#f59e0b'
    }
  })
  await prisma.pointRuleVersion.create({
    data: {
      ruleId,
      version: 1,
      title,
      condition,
      dailyLimit: 1,
      points,
      direction,
      changedByUserId: guardianUserId
    }
  })
  return {
    ruleId,
    v1: { ruleId, version: 1, title, condition, dailyLimit: 1, points, direction }
  }
}

/** 走内核构造一笔"记一笔"（与规则无关）—— 与 HTTP 路径将来用的是同一个构造器。 */
async function draftFor(
  childId: string,
  delta: number,
  title: string,
  extra: Partial<{ idempotencyKey: string; now: Date }> = {}
): Promise<PointRecordDraft> {
  const currentBalance = await repo.readBalance(childId)
  return buildRecordDraft({
    childId,
    ruleVersionRow: null,
    titleSnapshot: title,
    pointsDelta: delta,
    category: 'adjust',
    source: 'guardian',
    operator: guardian,
    currentBalance,
    now: extra.now ?? CALLER_CLOCK,
    idempotencyKey: extra.idempotencyKey ?? null
  })
}

/** 一笔 = 内核构造 ＋ 端口落库（与将来服务层要做的事一模一样）。 */
async function appendOne(
  childId: string,
  delta: number,
  title: string,
  extra: Partial<{ idempotencyKey: string; now: Date }> = {}
): Promise<{ recordId: string; balanceAfter: number }> {
  return repo.append(await draftFor(childId, delta, title, extra))
}

/** I2 必须自洽 —— 几乎每个用例都要用到（尺子只有一把，见 `verifyBalanceChain`）。 */
async function expectChainIntact(childId: string): Promise<LedgerChainRow[]> {
  const rows = await repo.readChain(childId)
  assert.deepEqual(verifyBalanceChain(rows), [], `I2 在真库上断了（childId=${childId}）`)
  return rows
}

/** 键排序 + 值归一（Date ⇒ ISO），于是两次快照可以直接 `deepEqual`。 */
function canonical(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(row).sort()) {
    const value = row[key]
    out[key] = value instanceof Date ? value.toISOString() : value
  }
  return out
}

/** 单行快照：`SELECT *` ⇒ 将来 schema 加字段也自动纳入"逐字段 diff"。 */
async function rawRow(id: string): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "PointRecord" WHERE "id" = ${id}`
  assert.equal(rows.length, 1, `记录 ${id} 应当存在（找不到就无法做逐字段 diff）`)
  return canonical(rows[0])
}

/** 结构化错误的 `code`（本项目所有 4xx 都带 `{ code, message }`）。 */
function codeOf(err: unknown): string | undefined {
  if (err instanceof HttpException) {
    const body = err.getResponse()
    if (typeof body === 'object' && body !== null && 'code' in body) {
      return String((body as { code: unknown }).code)
    }
  }
  return undefined
}

/** 断言"这次写入被拒，且理由是 code"。 */
async function expectRejected(
  run: () => Promise<unknown>,
  code: string,
  what: string
): Promise<void> {
  try {
    await run()
  } catch (err) {
    assert.equal(codeOf(err), code, `${what} 被拒了，但理由不对：${String(err)}`)
    return
  }
  assert.fail(`${what} 竟然成功了 —— 该被拒的写入落库了`)
}

/** 权限拒绝：以 **SQLSTATE 42501** 为准（本机 PG 报错是中文，不能靠英文文案）。 */
async function expectPermissionDenied(run: () => Promise<unknown>, what: string): Promise<void> {
  try {
    await run()
  } catch (err) {
    const text = `${(err as { code?: string }).code ?? ''} ${String(err)}`
    assert.ok(
      text.includes('42501') || /permission denied|权限不够/.test(text),
      `${what} 被拒了，但理由不是"权限不足"：${text}`
    )
    return
  }
  assert.fail(`${what} 竟然成功了 —— I5（账本不可变）在**真实数据**上没有生效`)
}

before(async () => {
  prisma = new PrismaService()
  repo = new PrismaLedgerRepository(prisma)
  guardianUserId = `dbtest-${RUN}-u-guardian`
  await prisma.user.create({ data: { id: guardianUserId, displayName: 'DB 套件·家长' } })
  guardian = { userId: guardianUserId, role: 'guardian' }
})

// ══ 组 A：I2 —— 真库链自洽 ＋「顺序由端口负责」═══════════════════════════════
describe('组 A：I2 真库链路（对账 ＋ 定序）', () => {
  it('三笔之后：滚动求和自洽、余额等于链尾、时间戳严格递增且不照抄调用方时钟', async () => {
    const childId = await makeChild('chain')
    assert.deepEqual(await repo.readChain(childId), [], '新孩子的账本必须是空的')
    assert.equal(await repo.readBalance(childId), 0)

    await appendOne(childId, 5, '帮忙摆碗筷')
    await appendOne(childId, -2, '没收拾玩具')
    await appendOne(childId, 10, '主动读完一章书')

    const rows = await expectChainIntact(childId)
    assert.equal(rows.length, 3, '流水条数必须等于写入次数（append-only：只增不减）')
    assert.deepEqual(
      rows.map((r) => r.balanceAfter),
      [5, 3, 13]
    )
    assert.equal(
      await repo.readBalance(childId),
      13,
      'Child.pointsBalance 必须等于链尾 balanceAfter（两者不一致就是 B6 那种"账不平"）'
    )

    const stamps = rows.map((r) => new Date(r.createdAt).getTime())
    assert.ok(
      stamps.every((t) => t !== CALLER_CLOCK.getTime()),
      'createdAt 照抄了调用方时钟（2020）—— 顺序就不再由端口负责了'
    )
    assert.ok(
      stamps.every((t, i) => i === 0 || t > stamps[i - 1]),
      `同一孩子的 createdAt 必须**严格**递增：${stamps.join()}`
    )

    // ★ 这一条抓的是"静默偏移一个时区"这类 bug（无时区列 ＋ 带时区的库钟）。
    //   已发生过的实例：`clock_timestamp()` 直接落进 `timestamp without time zone` 列，
    //   被 PG 按会话时区（Asia/Shanghai）换算 ⇒ 全部流水"来自 8 小时后的未来"。
    const last = stamps[stamps.length - 1]
    const skew = Math.abs(Date.now() - last)
    assert.ok(
      skew < 60_000,
      `端口写出的 createdAt（${new Date(last).toISOString()}）偏离真实时间 ${Math.round(skew / 1000)}s` +
        ' —— 典型成因：把 timestamptz 塞进 timestamp without time zone 列（整体偏移一个时区）'
    )
  })

  it('已有"未来时间戳"的行时，端口仍写出严格更晚的时间戳（定序守卫的边界）', async () => {
    const childId = await makeChild('future')
    await appendOne(childId, 1, '正常的一笔')

    // 人为造一条"未来"的行：app 角色能 INSERT，但**不能** UPDATE/DELETE（I5）⇒ 只能这样造。
    // 它模拟的是"库钟回退 / 有人手写过未来时间戳"这类真实存在的脏场景。
    const balanceBefore = await repo.readBalance(childId)
    const future = new Date(Date.now() + 3600_000)
    const futureId = `dbtest-${RUN}-future-row`
    await prisma.pointRecord.create({
      data: {
        id: futureId,
        childId,
        titleSnapshot: '手工写入的未来行',
        pointsDelta: 1,
        category: 'adjust',
        source: 'guardian',
        note: '',
        balanceAfter: balanceBefore + 1,
        createdAt: future
      }
    })
    await prisma.child.update({
      where: { id: childId },
      data: { pointsBalance: balanceBefore + 1 }
    })

    const { recordId } = await appendOne(childId, 1, '未来行之后的一笔')
    const rows = await expectChainIntact(childId)
    const written = rows.find((r) => r.id === recordId)
    assert.ok(written !== undefined, `端口写出的那一笔必须在链里（${recordId}）`)
    assert.ok(
      new Date(written.createdAt).getTime() > future.getTime(),
      `端口写出的 createdAt（${new Date(written.createdAt).toISOString()}）必须**晚于**已有的最新（未来）行` +
        `（${future.toISOString()}）—— 否则它会插到未来行**前面**，滚动求和立刻断裂。`
    )
    assert.equal(rows[rows.length - 1].id, recordId, '端口写出的那一笔必须是链尾')
  })
})

// ══ 组 B：并列时间戳 —— 尺子说"不可判"，而不是假报"断裂"═══════════════════════
describe('组 B：并列 createdAt 的诚实边界', () => {
  it('两行时间戳完全相同时：报「顺序不可判」，且**不**报断裂', async () => {
    const childId = await makeChild('tie')
    const tie = new Date()
    const base = {
      childId,
      titleSnapshot: '并列行',
      category: 'adjust' as const,
      source: 'guardian' as const,
      note: ''
    }
    // 两行并列（模拟"同一事务里写两笔"在真库里的样子）
    await prisma.pointRecord.create({
      data: { ...base, id: `dbtest-${RUN}-tie-a`, pointsDelta: 2, balanceAfter: 2, createdAt: tie }
    })
    await prisma.pointRecord.create({
      data: { ...base, id: `dbtest-${RUN}-tie-b`, pointsDelta: 3, balanceAfter: 5, createdAt: tie }
    })
    await prisma.child.update({ where: { id: childId }, data: { pointsBalance: 5 } })

    const problems = verifyBalanceChain(await repo.readChain(childId))
    assert.ok(problems.length >= 1, '并列时间戳必须被**报告**（不能静默当成通过）')
    assert.ok(
      problems.every((p) => p.includes('顺序不可判')),
      `并列时应当报"顺序不可判"（顺序不定时断裂可能是排序假象）：${problems.join(' | ')}`
    )
    assert.ok(
      problems.every((p) => !p.includes('断裂')),
      `并列时**不该**报断裂（那是把尺子的能力边界说成数据错误）：${problems.join(' | ')}`
    )
  })
})

// ══ 组 C：I1 —— 改规则不改历史（真库逐字段 diff）═════════════════════════════
describe('组 C：I1 改规则不改历史', () => {
  it('规则升到 v2 之后：老记录**逐字段不变**，且仍指向 v1', async () => {
    const childId = await makeChild('i1')
    const { ruleId, v1 } = await makeRule(childId, 'i1', 2, 'reward')

    const draft = buildRecordDraft({
      childId,
      ruleVersionRow: v1,
      category: 'praise',
      source: 'guardian',
      operator: guardian,
      currentBalance: 0,
      now: CALLER_CLOCK
    })
    const { recordId } = await repo.append(draft)
    const before = await rawRow(recordId)

    // "改规则"：新增 v2（版本行**只增不删**）＋ 主体指向 v2 —— 与 02 §5.3 同一事务的要求一致
    await prisma.$transaction(async (tx) => {
      await tx.pointRuleVersion.create({
        data: {
          ruleId,
          version: 2,
          title: '规则 i1（改过）',
          condition: '完成三次',
          dailyLimit: 3,
          points: 5,
          direction: 'reward',
          changedByUserId: guardianUserId
        }
      })
      await tx.pointRule.update({
        where: { id: ruleId },
        data: {
          title: '规则 i1（改过）',
          condition: '完成三次',
          dailyLimit: 3,
          points: 5,
          currentVersion: 2
        }
      })
    })

    const after = await rawRow(recordId)
    assert.deepEqual(
      after,
      before,
      '改规则动了历史记录 —— I1 不成立（"逐字段"diff 里有差异，见上一条断言的对象）'
    )

    const v1Again = await repo.readRuleVersion(ruleId, 1)
    assert.equal(v1Again?.title, v1.title, 'v1 的标题必须原样可读（历史要能解释）')
    assert.equal(v1Again?.points, 2)
    assert.equal(v1Again?.dailyLimit, 1)
    assert.equal((await repo.readRuleVersion(ruleId, 2))?.points, 5, '新版本行必须可读')
    assert.equal(
      await repo.readRuleVersion(ruleId, 99),
      null,
      '"没有这版" ⇒ null（正常分支，不是异常；但**不能**被当成"版本匹配"）'
    )

    const record = await repo.readRecord(recordId)
    assert.equal(record?.ruleVersion, 1, '老记录不该被"升级"到最新版本 —— 它记的是当时那一版')
    assert.equal(record?.ruleId, ruleId)
  })
})

// ══ 组 D：I3 —— 复合外键由**数据库**强制（不是靠应用先查后写）════════════════
describe('组 D：I3 记录必能命中版本行', () => {
  it('全库扫：指向空版本的记录数 = 0（孤儿引用红线）', async () => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM "PointRecord" r
      LEFT JOIN "PointRuleVersion" v
        ON r."ruleId" = v."ruleId" AND r."ruleVersion" = v."version"
      WHERE r."ruleId" IS NOT NULL AND v."id" IS NULL`
    assert.equal(Number(rows[0].n), 0, '存在指向空版本的流水 —— I3 不成立')
  })

  it('反向证明：写一条指向不存在版本的记录 ⇒ 数据库拒绝（P2003）', async () => {
    const childId = await makeChild('i3')
    const { ruleId } = await makeRule(childId, 'i3', 1, 'reward')
    await assert.rejects(
      () =>
        prisma.pointRecord.create({
          data: {
            id: `dbtest-${RUN}-i3-bad`,
            childId,
            ruleId,
            ruleVersion: 99,
            titleSnapshot: '指向空版本',
            pointsDelta: 1,
            category: 'praise',
            source: 'guardian',
            note: '',
            balanceAfter: 1
          }
        }),
      (err: unknown) =>
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003',
      '复合外键没拦住"指向空版本"的记录 —— I3 只是文档里的一句话'
    )
  })

  it('经端口写坏版本 ⇒ 409 LEDGER_RULE_VERSION_MISSING，且**整体回滚**（余额不变、零记录）', async () => {
    const childId = await makeChild('i3-port')
    const { v1 } = await makeRule(childId, 'i3-port', 1, 'reward')
    const draft = buildRecordDraft({
      childId,
      ruleVersionRow: { ...v1, version: 42 },
      category: 'praise',
      source: 'guardian',
      operator: guardian,
      currentBalance: 0,
      now: CALLER_CLOCK
    })

    await expectRejected(
      () => repo.append(draft),
      'LEDGER_RULE_VERSION_MISSING',
      '指向不存在版本的写入'
    )
    assert.deepEqual(await repo.readChain(childId), [], '被拒的写入不许留下半条记录')
    assert.equal(
      await repo.readBalance(childId),
      0,
      '被拒的写入必须**整体回滚** —— 余额在 INSERT 之前已经被 CAS 改过了，若没回滚就会留下"余额变了但没流水"'
    )
  })
// ══ 组 E：I4 —— 快照 == 版本行（**同一把尺子**，不是另写一套校验）═════════════
describe('组 E：I4 快照与版本行一致', () => {
  it('逐行跑 findSnapshotMismatches：带规则的记录全部一致（含负分规则）', async () => {
    const childId = await makeChild('i4')
    await appendOne(childId, 10, '先给点分（否则负分规则会被余额不足拒绝）')
    // ★ 负分规则：A1 的病发区（`Math.abs` 抹平后"扣 3 分"会变"+3 分"）
    const { v1 } = await makeRule(childId, 'i4', 3, 'penalty')
    await repo.append(
      buildRecordDraft({
        childId,
        ruleVersionRow: v1,
        category: 'praise',
        source: 'guardian',
        operator: guardian,
        currentBalance: 10,
        now: CALLER_CLOCK
      })
    )
    await expectChainIntact(childId)

    const records = await prisma.pointRecord.findMany({
      where: { childId, ruleId: { not: null } },
      select: {
        id: true,
        ruleId: true,
        ruleVersion: true,
        titleSnapshot: true,
        conditionSnapshot: true,
        dailyLimitSnapshot: true,
        pointsDelta: true,
        category: true,
        source: true
      }
    })
    assert.equal(records.length, 1, '本用例应当只有一条带规则的记录')

    for (const record of records) {
      if (record.ruleId === null || record.ruleVersion === null) continue
      const version = await repo.readRuleVersion(record.ruleId, record.ruleVersion)
      assert.ok(version !== null, `I3：记录 ${record.id} 的版本行必须存在`)
      const problems = findSnapshotMismatches(record as SnapshotLike, version)
      assert.deepEqual(problems, [], `记录 ${record.id} 的快照与版本行不一致：${problems.join(' | ')}`)
      assert.equal(record.pointsDelta, -3, '负分规则必须记成 -3（不是 +3）—— 修 A1')
    }
  })

  it('尺子本身有牙齿：喂一份"被改过的版本行"必须有输出', async () => {
    const childId = await makeChild('i4-tooth')
    const { v1 } = await makeRule(childId, 'i4-tooth', 2, 'reward')
    const { recordId } = await repo.append(
      buildRecordDraft({
        childId,
        ruleVersionRow: v1,
        category: 'praise',
        source: 'guardian',
        operator: guardian,
        currentBalance: 0,
        now: CALLER_CLOCK
      })
    )
    const record = await prisma.pointRecord.findUnique({
      where: { id: recordId },
      select: {
        titleSnapshot: true,
        conditionSnapshot: true,
        dailyLimitSnapshot: true,
        pointsDelta: true,
        category: true,
        source: true,
        ruleId: true,
        ruleVersion: true
      }
    })
    assert.ok(record !== null)
    const problems = findSnapshotMismatches(record as SnapshotLike, {
      ...v1,
      title: '被人改过的标题',
      points: 99
    })
    assert.ok(
      problems.length >= 2,
      `尺子对"改过的版本行"必须报出问题（否则它只是装饰）：${problems.join(' | ')}`
    )
    assert.ok(problems.some((p) => p.includes('titleSnapshot')))
  })
})


})


// ══ 组 F：I6 / 修 B7 —— 冲正（真库）═════════════════════════════════════════
describe('组 F：I6 冲正只增不减', () => {
  it('冲正后：原记录逐字段不动、条数 +1、余额复原、二次冲正被拒', async () => {
    const childId = await makeChild('i6')
    const { ruleId, v1 } = await makeRule(childId, 'i6', 4, 'reward')
    await appendOne(childId, 10, '打底')
    const target = await repo.append(
      buildRecordDraft({
        childId,
        ruleVersionRow: v1,
        category: 'praise',
        source: 'guardian',
        operator: guardian,
        currentBalance: 10,
        now: CALLER_CLOCK
      })
    )

    const originalBefore = await rawRow(target.recordId)
    const chainBefore = await repo.readChain(childId)
    const balanceBefore = await repo.readBalance(childId)
    assert.equal(balanceBefore, 14)

    const original = await repo.readRecord(target.recordId)
    assert.ok(original !== null, '冲正的前提：读得到原记录')
    const already = await repo.readReversedIds(childId)
    assert.deepEqual(already, [], '还没冲正过 —— 集合必须是空的（否则下面的判定被喂了假输入）')
    const version = await repo.readRuleVersion(ruleId, 1)

    const reversal = await repo.append(
      reverseRecordDraft(original, {
        operator: guardian,
        currentBalance: balanceBefore,
        alreadyReversedIds: already,
        ruleVersionRow: version,
        now: CALLER_CLOCK
      })
    )

    const rows = await expectChainIntact(childId)
    assert.equal(
      rows.length,
      chainBefore.length + 1,
      '冲正必须是"条数 +1"（修 B7：前端旧实现把流水 filter 掉 ⇒ 条数 −1，历史被物理抹掉）'
    )
    assert.deepEqual(
      await rawRow(target.recordId),
      originalBefore,
      '冲正动了原记录 —— append-only 被破坏（原记录必须**完全不动**）'
    )
    const originalAfter = await rawRow(target.recordId)
    assert.equal(
      originalAfter.reversedAt,
      null,
      '★ `PointRecord.reversedAt` 永远是 null：应用角色对 PointRecord **没有 UPDATE 权限**（I5）' +
        '⇒ "已被冲正"只能从新记录反查（readReversedIds）——按 reversedAt 判断的代码会永远认为"没被冲正过"'
    )
    assert.equal(await repo.readBalance(childId), balanceBefore - 4, '冲正后余额必须复原到加分之前')
    assert.deepEqual(await repo.readReversedIds(childId), [target.recordId])

    const reversalRecord = await repo.readRecord(reversal.recordId)
    assert.equal(reversalRecord?.source, 'correction')
    assert.equal(reversalRecord?.reversesRecordId, target.recordId)
    assert.equal(reversalRecord?.ruleId, ruleId, '冲正记录必须继承"哪一版规则产生了这笔分"')
    assert.equal(reversalRecord?.ruleVersion, 1)
    assert.equal(reversalRecord?.pointsDelta, -4, '冲正的变动必须是原变动的相反数')

    // ① 已冲正过的记录不能再冲（否则余额翻倍）
    const reversedNow = await repo.readReversedIds(childId)
    await assert.rejects(
      async () =>
        reverseRecordDraft(original, {
          operator: guardian,
          currentBalance: await repo.readBalance(childId),
          alreadyReversedIds: reversedNow,
          ruleVersionRow: version,
          now: CALLER_CLOCK
        }),
      (err: unknown) => err instanceof LedgerDeniedError && err.code === 'ALREADY_REVERSED',
      '同一笔能被冲正两次 —— 余额会翻倍'
    )

    // ② 冲正记录本身不能再被冲正
    const reversalAsOriginal = await repo.readRecord(reversal.recordId)
    assert.ok(reversalAsOriginal !== null)
    await assert.rejects(
      async () =>
        reverseRecordDraft(reversalAsOriginal, {
          operator: guardian,
          currentBalance: await repo.readBalance(childId),
          alreadyReversedIds: reversedNow,
          ruleVersionRow: version,
          now: CALLER_CLOCK
        }),
      (err: unknown) =>
        err instanceof LedgerDeniedError && err.code === 'CANNOT_REVERSE_REVERSAL',
      '"撤销的撤销"被放行了 —— 语义失控'
    )

    // ③ 上面两条都只是"构造被拒"⇒ 库里必须什么都没变
    assert.equal((await repo.readChain(childId)).length, rows.length)
    assert.equal(await repo.readBalance(childId), balanceBefore - 4)
  })
})


// ══ 组 G：I5 —— 应用角色写得进、改不动、删不掉（**真实数据**上）══════════════
describe('组 G：I5 账本不可变（REVOKE 生效）', () => {
  it('对刚写入的流水：UPDATE / DELETE / Prisma update 全部被权限拒绝（42501）', async () => {
    const childId = await makeChild('i5')
    const { recordId } = await appendOne(childId, 3, 'I5 的目标记录')

    await expectPermissionDenied(
      () =>
        prisma.$executeRaw`UPDATE "PointRecord" SET "balanceAfter" = 999 WHERE "id" = ${recordId}`,
      'UPDATE "PointRecord".balanceAfter'
    )
    await expectPermissionDenied(
      () => prisma.$executeRaw`DELETE FROM "PointRecord" WHERE "id" = ${recordId}`,
      'DELETE FROM "PointRecord"'
    )
    await expectPermissionDenied(
      () => prisma.pointRecord.update({ where: { id: recordId }, data: { note: '被改了' } }),
      'Prisma 客户端 pointRecord.update（应用层视角）'
    )
    await expectPermissionDenied(
      () => prisma.$executeRaw`UPDATE "PointRuleVersion" SET "points" = 0`,
      'UPDATE "PointRuleVersion"（历史真相之源同样不可改）'
    )

    // 被拒的操作**一个字节都没改**
    const row = await rawRow(recordId)
    assert.equal(row.balanceAfter, 3)
    assert.equal(row.note, '')
    assert.equal((await expectChainIntact(childId)).length, 1)
  })
})

// ══ 组 H：并发与幂等（锁 ＋ CAS ＋ 唯一约束）═════════════════════════════════
describe('组 H：并发与幂等', () => {
  it('两笔并发扣分（同一 currentBalance 的草稿）⇒ 恰好一笔成功、另一笔 409', async () => {
    const childId = await makeChild('race')
    await appendOne(childId, 10, '打底')
    const first = await draftFor(childId, -3, '并发甲')
    const second = await draftFor(childId, -4, '并发乙')

    const results = await Promise.allSettled([repo.append(first), repo.append(second)])
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<{ recordId: string; balanceAfter: number }> =>
        r.status === 'fulfilled'
    )
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    assert.equal(
      ok.length,
      1,
      `两笔基于同一余额的写入"都成功"了 —— CAS 没生效（孩子会平白少分）：${JSON.stringify(results.map((r) => r.status))}`
    )
    assert.equal(failed.length, 1)
    assert.equal(
      codeOf(failed[0].reason),
      'LEDGER_BALANCE_CHANGED',
      `被拒的理由不对（应当是"余额已被改过"）：${String(failed[0].reason)}`
    )

    const rows = await expectChainIntact(childId)
    assert.equal(rows.length, 2, '只有一笔并发扣分能落库')
    assert.equal(rows[1].balanceAfter, ok[0].value.balanceAfter)
    assert.equal(await repo.readBalance(childId), ok[0].value.balanceAfter)
  })

  it('幂等键重复 ⇒ 第二次 409（库层唯一约束），且只落一笔、余额不动', async () => {
    const childId = await makeChild('idem')
    const key = `dbtest-${RUN}-idem-key`
    const first = await appendOne(childId, 2, '同一次请求', { idempotencyKey: key })
    assert.ok(first.recordId !== '')

    await expectRejected(
      () => appendOne(childId, 2, '同一次请求', { idempotencyKey: key }),
      'LEDGER_DUPLICATE_IDEMPOTENCY_KEY',
      '重复幂等键的写入'
    )
    // ★ 第二次是**重新读余额**构造的草稿（CAS 会通过），拦住它的是 INSERT 时的唯一约束 ⇒
    //   没有它，重放就会真的多扣一次分。
    assert.equal(await repo.readBalance(childId), 2, '被拒的重放不许动余额（整笔回滚）')
    assert.equal((await expectChainIntact(childId)).length, 1)
  })

  it('幂等键为 null 的多笔互不冲突（NULL 不参与唯一约束 —— 别误以为"有键去重"）', async () => {
    const childId = await makeChild('nullkey')
    await appendOne(childId, 1, '第一笔')
    await appendOne(childId, 1, '第二笔')
    const rows = await expectChainIntact(childId)
    assert.equal(rows.length, 2, '两笔无键的写入都该落库（内核把空白键归一成 null，见组 C3 的离线用例）')
  })
})


// ══ 组 I：B6 红线（全库扫 ＋ "拒绝 ≠ 截断到 0"）══════════════════════════════
describe('组 I：B6 余额红线', () => {
  it('全库扫：不存在负余额的孩子（"截断到 0"的病已被"拒绝"取代）', async () => {
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM "Child" WHERE "pointsBalance" < 0`
    assert.equal(
      Number(rows[0].n),
      0,
      '库里出现了负余额 —— 有人在放行（或截断）本该被拒的扣分：Σ流水 与 余额 已经无法对账'
    )
  })

  it('余额不足：内核拒绝，且库里**一条记录都没多**、余额不变', async () => {
    const childId = await makeChild('b6')
    await appendOne(childId, 5, '只有 5 分')
    const before = await repo.readChain(childId)

    await assert.rejects(
      () => draftFor(childId, -999, '想扣 999 分'),
      (err: unknown) => err instanceof LedgerDeniedError && err.code === 'INSUFFICIENT_POINTS',
      '余额不足必须**拒绝**（B6：旧实现是 `if (points < 0) points = 0` 静默截断 ⇒ 流水与余额对不上）'
    )

    assert.deepEqual(await repo.readChain(childId), before, '被拒的扣分不许留下记录')
    assert.equal(await repo.readBalance(childId), 5)
    await expectChainIntact(childId)
  })
})

// ══ 组 J：装配口径（W2-C）—— 从**注入器**里取端口，读写的是真库 ══════════
//   上面每一组都是 `new PrismaLedgerRepository(prisma)` **手工实例化**的。
//   那证明了"适配器能用"，但**证明不了"它被接上了"**：`LedgerModule` 里若还绑着 501 实现，
//   组 A–I 会**全部照绿**。本组补的正是这一段 —— 用真的 `LedgerModule.register()` 建图，
//   从 DI 取出 `LEDGER_REPOSITORY`，再让**它**去读写这个真库。
describe('组 J：装配口径 —— DI 取到的端口真的查库', () => {
  it('register() 建图（按环境推断）⇒ 端口是 Prisma 适配器，读出的余额等于库里那一行', async () => {
    // ★ 这里**刻意不传** `{ hasDatabase: true }`：要验的正是**生产那条路** ——
    //   `main.ts` 先 `import 'dotenv/config'`，于是 `register()` 能看到 DATABASE_URL。
    //   若这条红（而不是"没库"那条红），说明环境推断这条线断了。
    const moduleRef = await Test.createTestingModule({
      imports: [LedgerModule.register()]
    }).compile()
    await moduleRef.init()
    try {
      const port = moduleRef.get<LedgerPort>(LEDGER_REPOSITORY)
      assert.ok(
        port instanceof PrismaLedgerRepository,
        `有库的环境下端口是 ${port.constructor.name} —— 真实现写出来了却没人用它（装配没接上）`
      )
      // 本组刻意用**另一个** PrismaService 实例（装配自己建的那个），不是上面的 `prisma`：
      // 验的是"应用真的建起来的图"，而不是"套件手工拼的替身"。

      const childId = await makeChild('wired')
      assert.equal(await port.readBalance(childId), 0, '新孩子的余额必须是 0（读的是真库，不是内存）')

      const { recordId, balanceAfter } = await port.append(
        buildRecordDraft({
          childId,
          ruleVersionRow: null,
          titleSnapshot: '装配后的第一笔',
          pointsDelta: 5,
          category: 'adjust',
          source: 'guardian',
          operator: guardian,
          currentBalance: await port.readBalance(childId),
          now: CALLER_CLOCK,
          idempotencyKey: null
        })
      )
      assert.equal(balanceAfter, 5)

      // ① 用**这个端口**读回来：链自洽（尺子与本套件其它组用的是同一把）
      const rows = await port.readChain(childId)
      assert.deepEqual(rows.map((r) => r.id), [recordId], 'DI 装配的端口写出的那一笔必须在链里')
      assert.deepEqual(verifyBalanceChain(rows), [], 'I2 在 DI 装配出的端口上也要自洽')

      // ② 再用**另一条路径**（本套件自己的 prisma）复核：这一笔真的落到了库里，
      //    而不是"只活在返回对象里"（后者正是最贵的假绿：看起来扣了，其实没落库）。
      assert.equal(await repo.readBalance(childId), 5, 'DI 端口写的那一笔，换一条连接读不到 ⇒ 根本没落库')
      const child = await prisma.child.findUnique({
        where: { id: childId },
        select: { pointsBalance: true }
      })
      assert.equal(child?.pointsBalance, 5, 'Child.pointsBalance 没跟着改 —— CAS 的目标列没被更新')
    } finally {
      // 关掉本组自己建的那个图（PrismaService.onModuleDestroy ⇒ 断开它自己的连接池）。
      await moduleRef.close()
    }
  })
})


after(async () => {
  await prisma.$disconnect()
})


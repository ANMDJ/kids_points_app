/**
 * habits-db.dbtest.ts —— 打卡 / 撤销打卡 **真库 × 真 HTTP** 套件（W4-D，2026-10-19）
 *
 * ── 与另外两份用例的分工 ────────────────────────────────────────────────────
 *   · `test/habits-http.test.ts` —— 真 HTTP，端口是替身：证明屏障、入参封闭、幂等语义；
 *     证明不了「Postgres 上每日上限真的按业务日数」「余额 CAS 真的排队」。
 *   · `test/habits-wiring.test.ts` —— 证明适配器交给 Prisma 的键长什么样；
 *     证明不了唯一约束、行锁、复合外键真的生效。
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `fetch`：
 *       打卡 → 流水 ＋ 余额 ＋ 审计同一事务；重放只执行一次；
 *       上限按 `[业务日 start, end)` 数且**撤销释放名额**；冲正不 UPDATE 原行（I5）；
 *       跨孩子一律 404。
 *
 * ── 业务日边界怎么造 ────────────────────────────────────────────────────────
 *   日期窗口由**数据库** `clock_timestamp()` 决定，所以夹具也用数据库算 start/end，
 *   而不是 JavaScript 的 `new Date()`：两边差几毫秒就会让「昨天 23:59:59.999」变成今天。
 *   三条边界行分别落在 `start - 1ms`（算昨天）、`start`（算今天）、`end`（算明天）。
 *
 * ── ★ 数据不清理（与 identity / ledger / read 套件同一纪律）──────────────────
 *   账本表 `DELETE` 被 REVOKE（I5）且 `Child` 外键是 `Restrict` ⇒ 本套件写下的流水删不掉。
 *   每次运行用全新 `dbtest-<run>` 前缀，于是「从零开始」这个前提成立。
 *
 * 入口：`npm run test:db`（缺 `DATABASE_URL` 直接红；`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import type { Prisma } from '@prisma/client'

import { AppModule } from '../src/app.module'
import { applyGlobalPipes } from '../src/app.setup'
import { HABITS_REPOSITORY } from '../src/habits/habits.repository'
import { PrismaHabitsRepository } from '../src/habits/habits.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'

process.env.KP_TIMEZONE = 'Asia/Shanghai'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-habit-dad`,
  kid: `dbtest-${RUN}-habit-kid`,
  main: `dbtest-${RUN}-habit-main`,
  other: `dbtest-${RUN}-habit-other`,
  devDad: `dbtest-${RUN}-habit-dev-dad`,
  devKid: `dbtest-${RUN}-habit-dev-kid`,
  devOther: `dbtest-${RUN}-habit-dev-other`,
  mainHabit: `dbtest-${RUN}-habit-main-habit`,
  replayHabit: `dbtest-${RUN}-habit-replay-habit`,
  doubleHabit: `dbtest-${RUN}-habit-double-habit`,
  limitHabit: `dbtest-${RUN}-habit-limit-habit`,
  undoHabit: `dbtest-${RUN}-habit-undo-habit`,
  yesterdayHabit: `dbtest-${RUN}-habit-yesterday`,
  todayHabit: `dbtest-${RUN}-habit-today`,
  tomorrowHabit: `dbtest-${RUN}-habit-tomorrow`,
  ruleHabit: `dbtest-${RUN}-habit-rule-habit`,
  otherHabit: `dbtest-${RUN}-habit-other-habit`,
  rule: `dbtest-${RUN}-habit-rule`,
  otherRecord: `dbtest-${RUN}-habit-other-record`
} as const

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.main },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.main },
  other: { 'x-kp-device-id': ID.devOther, 'x-kp-child-id': ID.other }
} as const

let prisma: PrismaService
let app: INestApplication
let url = ''

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function post(
  path: string,
  headers: Record<string, string>,
  body: unknown = {}
): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed }
}

async function balanceOf(childId: string): Promise<number> {
  const row = await prisma.child.findUniqueOrThrow({
    where: { id: childId },
    select: { pointsBalance: true }
  })
  return row.pointsBalance
}

async function businessBounds(): Promise<{ start: Date; end: Date }> {
  // ★ PointRecord.createdAt 是 **naive timestamp**，Prisma 的约定是「列里的墙钟 = UTC」。
  //   而 `AT TIME ZONE 'Asia/Shanghai'` 的中间结果若直接当结果返回，会把 timestamptz
  //   再经驱动读成 +8h 偏移的 Date —— 夹具就会把「昨天 23:59:59.999」写成今天 07:59。
  //   所以最后再 `AT TIME ZONE 'UTC'`：把真正的 UTC 瞬间折成列里该有的 naive 墙钟。
  const [row] = await prisma.$queryRaw<{ start: Date; end: Date }[]>`
    SELECT
      ((date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Shanghai')
        AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS start,
      (((date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Shanghai') + interval '1 day')
        AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC') AS end`
  return row
}


/** 业务日边界行：`createdAt` 用**库钟算出的 naive-UTC**，不是 JS 本地时间。 */
function boundaryRecord(
  id: string,
  habitId: string,
  createdAt: Date
): Prisma.PointRecordUncheckedCreateInput {
  return {
    id,
    childId: ID.main,
    habitId,
    titleSnapshot: `边界 ${habitId.slice(-8)}`,
    pointsDelta: 1,
    category: 'praise',
    source: 'child_self',
    operatorUserId: ID.kid,
    operatorRole: 'child',
    balanceAfter: 0,
    createdAt
  }
}

/**
 * 「明天 00:00」的边界行必须**最后**插：`appendDraftInTx()` 会让新流水严格晚于
 * 该孩子已有的 `MAX(createdAt)`。提前把它种进库，后面每一笔打卡都会被推到
 * 「明天」之后 —— 今天的上限就永远数不到（这正是本套件第一版假红的原因）。
 */
async function insertTomorrowBoundary(): Promise<void> {
  const { end } = await businessBounds()
  await prisma.pointRecord.create({
    data: boundaryRecord(`${ID.tomorrowHabit}-rec`, ID.tomorrowHabit, end)
  })
}

async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)
  const habit = (id: string, childId: string, points: number, dailyLimit: number) => ({
    id,
    childId,
    title: `习惯 ${id.slice(-8)}`,
    points,
    condition: '完成一次',
    dailyLimit,
    icon: 'star',
    color: '#FFB74D'
  })

  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: `打卡套件 爸爸 ${RUN}` },
      { id: ID.kid, displayName: `打卡套件 孩子 ${RUN}` }
    ]
  })
  await prisma.child.createMany({
    data: [
      { id: ID.main, name: `打卡套件主孩子 ${RUN}`, pointsBalance: 0 },
      { id: ID.other, name: `打卡套件另一个孩子 ${RUN}`, pointsBalance: 0 }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.main, userId: ID.dad, role: 'guardian', status: 'active' },
      { childId: ID.main, userId: ID.kid, role: 'child', status: 'active' },
      { childId: ID.other, userId: ID.dad, role: 'guardian', status: 'active' }
    ]
  })
  await prisma.deviceSession.createMany({
    data: [
      {
        deviceId: ID.devDad,
        childId: ID.main,
        userId: ID.dad,
        activeRole: 'guardian',
        expiresAt: future
      },
      {
        deviceId: ID.devKid,
        childId: ID.main,
        userId: ID.kid,
        activeRole: 'child',
        expiresAt: future
      },
      {
        deviceId: ID.devOther,
        childId: ID.other,
        userId: ID.dad,
        activeRole: 'guardian',
        expiresAt: future
      }
    ]
  })

  // 规则 + v1 版本行：打卡必须写「哪一版规则产生了这笔分」（C10）。
  await prisma.pointRule.create({
    data: {
      id: ID.rule,
      childId: ID.main,
      title: '完成作业',
      condition: '当天作业全部完成',
      dailyLimit: 2,
      points: 1,
      direction: 'reward',
      icon: 'book',
      color: '#81C784',
      currentVersion: 1
    }
  })
  await prisma.pointRuleVersion.create({
    data: {
      ruleId: ID.rule,
      version: 1,
      title: '完成作业',
      condition: '当天作业全部完成',
      dailyLimit: 2,
      points: 1,
      direction: 'reward',
      changedByUserId: ID.dad
    }
  })

  await prisma.habit.createMany({
    data: [
      habit(ID.mainHabit, ID.main, 1, 5),
      habit(ID.replayHabit, ID.main, 1, 5),
      habit(ID.doubleHabit, ID.main, 1, 5),
      habit(ID.limitHabit, ID.main, 1, 2),
      habit(ID.undoHabit, ID.main, 2, 5),
      habit(ID.yesterdayHabit, ID.main, 1, 1),
      habit(ID.todayHabit, ID.main, 1, 1),
      habit(ID.tomorrowHabit, ID.main, 1, 1),
      {
        ...habit(ID.ruleHabit, ID.main, 1, 2),
        sourceRuleId: ID.rule,
        title: '番茄钟写作业',
        condition: '专注 25 分钟'
      },
      habit(ID.otherHabit, ID.other, 1, 1)
    ]
  })

  // ── 业务日边界：两条记录分别落在 start-1ms / start ─────────────────────
  //    `end`（明天 00:00）留到组 D 最后再插，见 insertTomorrowBoundary() 的注释。
  const { start } = await businessBounds()
  await prisma.pointRecord.createMany({
    data: [
      boundaryRecord(`${ID.yesterdayHabit}-rec`, ID.yesterdayHabit, new Date(start.getTime() - 1)),
      boundaryRecord(`${ID.todayHabit}-rec`, ID.todayHabit, start)
    ]
  })

  // 另一个孩子的打卡：用主孩子会话撤销它必须 404（不能跨孩子）。
  await prisma.pointRecord.create({
    data: {
      id: ID.otherRecord,
      childId: ID.other,
      habitId: ID.otherHabit,
      titleSnapshot: '另一个孩子的打卡',
      pointsDelta: 1,
      category: 'praise',
      source: 'child_self',
      operatorUserId: ID.dad,
      operatorRole: 'guardian',
      balanceAfter: 1
    }
  })
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()

  // ★ 不传 `hasDatabase`：本文件要验的正是生产那条路（由 DATABASE_URL 推断）。
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
})

// ══ 组 A：装配 —— 下面的 201 必须来自 Prisma 适配器 ══════════════════════════
describe('组 A：真 AppModule 里 `HABITS_REPOSITORY` 绑的是 Prisma 适配器', () => {
  it('DI 取到的端口是真适配器（否则 501 会让所有 201 断言无从谈起）', () => {
    const port = app.get<object>(HABITS_REPOSITORY)
    assert.ok(
      port instanceof PrismaHabitsRepository,
      `习惯端口是 ${port.constructor.name} —— 装配没接上，生产会以「每笔打卡 501」的样子活着`
    )
  })
})

// ══ 组 B：打卡成功路径 —— 流水 ＋ 余额 ＋ 审计同一事务 ══════════════════════
describe('组 B：check-in —— 201、余额、审计、幂等', () => {
  it('孩子打卡：201，余额 +1，流水 source=child_self，审计动作已落库', async () => {
    const before = await balanceOf(ID.main)
    const res = await post('/records/check-in', H.kid, { habitId: ID.mainHabit })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)

    const record = res.body.record as Record<string, unknown>
    assert.equal(res.body.executedRecordId, record.id)
    assert.equal(record.points, 1)
    assert.equal(record.source, 'child_self')
    assert.equal(record.operatorRole, 'child')
    assert.equal(record.category, 'praise')
    assert.equal(record.habitId, ID.mainHabit)
    assert.equal(record.reversesRecordId, null)
    assert.equal(record.balanceAfter, before + 1)
    assert.equal(await balanceOf(ID.main), before + 1)

    const row = await prisma.pointRecord.findUniqueOrThrow({
      where: { id: String(record.id) }
    })
    assert.equal(row.operatorUserId, ID.kid)
    assert.equal(row.pointsDelta, 1)
    assert.equal(row.balanceAfter, before + 1)

    const audit = await prisma.auditLog.findFirst({
      where: { targetId: String(record.id), action: 'point_record.check_in' }
    })
    assert.ok(audit !== null, '打卡没有写审计 —— 「谁在什么时候加的分」将无法回答')
    assert.equal(audit.actorUserId, ID.kid)
    assert.equal(audit.childId, ID.main)
  })

  it('家长打卡规则习惯：source=guardian，流水写入 ruleId + ruleVersion + 版本快照', async () => {
    const res = await post('/records/check-in', H.dad, { habitId: ID.ruleHabit })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)

    const record = res.body.record as Record<string, unknown>
    assert.equal(record.source, 'guardian')
    assert.equal(record.operatorRole, 'guardian')
    assert.equal(record.ruleId, ID.rule)
    assert.equal(record.ruleVersion, 1)
    // ★ 快照来自**版本行**，不是习惯上另起的标题：习惯可以叫「番茄钟写作业」，
    //   但这笔分由「完成作业」v1 产生 ⇒ 历史必须能对上版本行（I4）。
    assert.equal(record.title, '完成作业')

    const row = await prisma.pointRecord.findUniqueOrThrow({
      where: { id: String(record.id) }
    })
    assert.equal(row.conditionSnapshot, '当天作业全部完成')
    assert.equal(row.dailyLimitSnapshot, 2)
    assert.equal(row.ruleId, ID.rule)
    assert.equal(row.ruleVersion, 1)

    const version = await prisma.pointRuleVersion.findUniqueOrThrow({
      where: { ruleId_version: { ruleId: ID.rule, version: 1 } }
    })
    assert.equal(version.points, 1)
    assert.equal(version.direction, 'reward')
  })

  it('不带 key 连点两次 ⇒ 两笔流水（显式产品语义）', async () => {
    const first = await post('/records/check-in', H.kid, { habitId: ID.doubleHabit })
    const second = await post('/records/check-in', H.kid, { habitId: ID.doubleHabit })
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.notEqual(first.body.executedRecordId, second.body.executedRecordId)

    const count = await prisma.pointRecord.count({
      where: { childId: ID.main, habitId: ID.doubleHabit }
    })
    assert.equal(count, 2)
  })

  it('同一个 Idempotency-Key 重放 ⇒ 只执行一次，第二次原样返回首次响应', async () => {
    const key = `replay-${RUN}`
    const headers = { ...H.kid, 'idempotency-key': key }
    const first = await post('/records/check-in', headers, { habitId: ID.replayHabit })
    const second = await post('/records/check-in', headers, { habitId: ID.replayHabit })

    assert.equal(first.status, 201, `首次 ${first.status}：${JSON.stringify(first.body)}`)
    assert.equal(second.status, 201)
    assert.deepEqual(second.body, first.body)

    const rows = await prisma.pointRecord.findMany({
      where: { childId: ID.main, idempotencyKey: key }
    })
    assert.equal(rows.length, 1, '重放却写了两笔 —— 幂等层没有生效')

    const idem = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { childId_key: { childId: ID.main, key } }
    })
    assert.equal(idem.responseStatus, 201)
    assert.equal(idem.recordId, rows[0].id)
    assert.equal(idem.actionType, 'check_in_habit')
  })

  it('同一个 key 换请求体 ⇒ 409 IDEMPOTENCY_KEY_REUSED，且不写第二笔', async () => {
    const key = `reuse-${RUN}`
    const headers = { ...H.kid, 'idempotency-key': key }
    const first = await post('/records/check-in', headers, { habitId: ID.mainHabit })
    assert.equal(first.status, 201)

    const res = await post('/records/check-in', headers, { habitId: ID.doubleHabit })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.main, idempotencyKey: key } }),
      1
    )
  })

  it('每日上限：第 3 次 409，且不写流水、不改余额', async () => {
    const first = await post('/records/check-in', H.kid, { habitId: ID.limitHabit })
    const second = await post('/records/check-in', H.kid, { habitId: ID.limitHabit })
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)

    const before = await balanceOf(ID.main)
    const third = await post('/records/check-in', H.kid, { habitId: ID.limitHabit })
    assert.equal(third.status, 409)
    assert.equal(third.body.code, 'HABIT_DAILY_LIMIT_REACHED')
    assert.equal(await balanceOf(ID.main), before)

    const count = await prisma.pointRecord.count({
      where: { childId: ID.main, habitId: ID.limitHabit }
    })
    assert.equal(count, 2)
  })
})


// ══ 组 C：撤销 —— 追加冲正（不 UPDATE 原行）、幂等、释放名额 ════════════════
describe('组 C：reverse —— 冲正记录、原行不变、重放、每日名额释放', () => {
  it('撤销：201，新冲正行 -2/correction，原行一字未改，余额回落', async () => {
    const first = await post('/records/check-in', H.kid, { habitId: ID.undoHabit })
    const second = await post('/records/check-in', H.kid, { habitId: ID.undoHabit })
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)

    const originalId = String(second.body.executedRecordId)
    const before = await balanceOf(ID.main)
    const res = await post(`/records/${originalId}/reverse`, H.dad, { note: '点错了' })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)

    const correction = res.body.record as Record<string, unknown>
    assert.notEqual(correction.id, originalId)
    assert.equal(res.body.executedRecordId, correction.id)
    assert.equal(correction.source, 'correction')
    assert.equal(correction.category, 'adjust')
    assert.equal(correction.points, -2)
    assert.equal(correction.reversesRecordId, originalId)
    assert.equal(correction.note, '点错了')
    assert.equal(correction.balanceAfter, before - 2)
    assert.equal(await balanceOf(ID.main), before - 2)

    const original = await prisma.pointRecord.findUniqueOrThrow({
      where: { id: originalId }
    })
    assert.equal(original.pointsDelta, 2, '原记录的分数被改了 —— 违反 I5（append-only）')
    assert.equal(original.reversedAt, null, '原记录被 UPDATE 了（reversedAt）—— 违反 I5')
    assert.equal(original.source, 'child_self')

    const reversals = await prisma.pointRecord.findMany({
      where: { reversesRecordId: originalId }
    })
    assert.equal(reversals.length, 1)
    assert.equal(reversals[0].id, String(correction.id))

    const audit = await prisma.auditLog.findFirst({
      where: { targetId: String(correction.id), action: 'point_record.undo_check_in' }
    })
    assert.ok(audit !== null, '撤销没有写审计')
  })

  it('同一个 Idempotency-Key 重放撤销 ⇒ 返回首次响应，不写第二条冲正', async () => {
    const created = await post('/records/check-in', H.kid, { habitId: ID.undoHabit })
    assert.equal(created.status, 201)
    const originalId = String(created.body.executedRecordId)

    const key = `undo-replay-${RUN}`
    const headers = { ...H.dad, 'idempotency-key': key }
    const first = await post(`/records/${originalId}/reverse`, headers, {})
    const second = await post(`/records/${originalId}/reverse`, headers, {})

    assert.equal(first.status, 201, `首次 ${first.status}：${JSON.stringify(first.body)}`)
    assert.equal(second.status, 201)
    assert.deepEqual(second.body, first.body)
    assert.equal(
      await prisma.pointRecord.count({ where: { reversesRecordId: originalId } }),
      1,
      '重放却写了两条冲正 —— 撤销不幂等'
    )
    assert.equal(
      await prisma.auditLog.count({
        where: {
          targetId: String(first.body.executedRecordId),
          action: 'point_record.undo_check_in'
        }
      }),
      1
    )
  })

  it('不带 key 再撤同一条 ⇒ 409 ALREADY_REVERSED（库层/内核兜底，不会翻倍）', async () => {
    const created = await post('/records/check-in', H.kid, { habitId: ID.undoHabit })
    const originalId = String(created.body.executedRecordId)

    const first = await post(`/records/${originalId}/reverse`, H.dad, {})
    assert.equal(first.status, 201)

    const before = await balanceOf(ID.main)
    const second = await post(`/records/${originalId}/reverse`, H.dad, {})
    assert.equal(second.status, 409, `实际 ${second.status}：${JSON.stringify(second.body)}`)
    assert.ok(
      second.body.code === 'ALREADY_REVERSED' || second.body.code === 'RECORD_ALREADY_REVERSED',
      `实际 code=${String(second.body.code)}`
    )
    assert.equal(await balanceOf(ID.main), before)
    assert.equal(
      await prisma.pointRecord.count({ where: { reversesRecordId: originalId } }),
      1
    )
  })

  it('★ 撤销后每日名额释放：上限 2 的孩子撤掉一笔后可以再打一次', async () => {
    const rows = await prisma.pointRecord.findMany({
      where: { childId: ID.main, habitId: ID.limitHabit, reversesRecordId: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    assert.ok(rows.length >= 1, '前置用例没有留下可撤销的打卡')
    const target = rows[0]

    const reversed = await post(`/records/${target.id}/reverse`, H.dad, {})
    assert.equal(reversed.status, 201, `实际 ${reversed.status}：${JSON.stringify(reversed.body)}`)

    const again = await post('/records/check-in', H.kid, { habitId: ID.limitHabit })
    assert.equal(
      again.status,
      201,
      `撤销后仍被上限拦住（${JSON.stringify(again.body)}）——「仍有效的打卡」口径没实现`
    )
  })
})


// ══ 组 D：业务日边界 ＋ 跨孩子 404 ══════════════════════════════════════════
describe('组 D：`[业务日 start, end)` 与跨孩子一律 404', () => {
  it('昨天 23:59:59.999 的打卡不占今天名额（窗口左开）', async () => {
    const res = await post('/records/check-in', H.kid, { habitId: ID.yesterdayHabit })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)
  })

  it('今天 00:00:00 的打卡占满 1 次名额 ⇒ 409', async () => {
    const res = await post('/records/check-in', H.kid, { habitId: ID.todayHabit })
    assert.equal(res.status, 409, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(res.body.code, 'HABIT_DAILY_LIMIT_REACHED')
  })

  it('明天 00:00:00 的打卡不占今天名额（窗口右开）', async () => {
    await insertTomorrowBoundary()
    const res = await post('/records/check-in', H.kid, { habitId: ID.tomorrowHabit })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)
  })

  it('打卡另一个孩子的习惯 ⇒ 404 HABIT_NOT_FOUND（不泄露存在性）', async () => {
    const before = await balanceOf(ID.main)
    const res = await post('/records/check-in', H.dad, { habitId: ID.otherHabit })
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'HABIT_NOT_FOUND')
    assert.equal(await balanceOf(ID.main), before)
  })

  it('撤销另一个孩子的流水 ⇒ 404 RECORD_NOT_FOUND', async () => {
    const res = await post(`/records/${ID.otherRecord}/reverse`, H.dad, {})
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'RECORD_NOT_FOUND')
    assert.equal(
      await prisma.pointRecord.count({ where: { reversesRecordId: ID.otherRecord } }),
      0
    )
  })
})

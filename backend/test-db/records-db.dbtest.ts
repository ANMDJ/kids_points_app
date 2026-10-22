/**
 * records-db.dbtest.ts —— 「记一笔」**真库 × 真 HTTP** 套件（W5-B，2026-10-20）
 *
 * ── 与另外三份用例的分工 ────────────────────────────────────────────────────
 *   · `test/records-http.test.ts` —— 真 HTTP，端口是替身：证明屏障、入参封闭、幂等语义；
 *     证明不了「余额真的加了」「审计真的同事务落库」「扣成负数真的被拒」。
 *   · `test-db/habits-db.dbtest.ts` —— 打卡 / 撤销的同类证据（同一根账本内核）；
 *     记一笔没有习惯，所以它那 8 步里的 ③–⑤ 在这里**故意不存在**。
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `fetch`：
 *       记一笔 → 流水 ＋ 余额 ＋ 审计同一事务；同一 `Idempotency-Key` 只写一笔；
 *       扣成负数 ⇒ 409 且**零副作用**；孩子 ⇒ 403；已删孩子 ⇒ 404。
 *
 * ── ★ 数据不清理（与 identity / ledger / habits 套件同一纪律）────────────────
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

import { AppModule } from '../src/app.module'
import { applyGlobalPipes } from '../src/app.setup'
import { PrismaService } from '../src/prisma/prisma.service'
import { PrismaRecordsRepository } from '../src/records/records.prisma.repository'
import { RECORDS_REPOSITORY } from '../src/records/records.repository'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-adjust-dad`,
  kid: `dbtest-${RUN}-adjust-kid`,
  main: `dbtest-${RUN}-adjust-main`,
  gone: `dbtest-${RUN}-adjust-gone`,
  devDad: `dbtest-${RUN}-adjust-dev-dad`,
  devKid: `dbtest-${RUN}-adjust-dev-kid`,
  devGone: `dbtest-${RUN}-adjust-dev-gone`
} as const

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.main },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.main },
  gone: { 'x-kp-device-id': ID.devGone, 'x-kp-child-id': ID.gone }
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

async function countAdjustRecords(childId: string): Promise<number> {
  return prisma.pointRecord.count({ where: { childId, category: 'adjust' } })
}

async function countAdjustAudits(childId: string): Promise<number> {
  return prisma.auditLog.count({ where: { childId, action: 'point_record.adjust' } })
}

async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)

  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: `记一笔套件 爸爸 ${RUN}` },
      { id: ID.kid, displayName: `记一笔套件 孩子 ${RUN}` }
    ]
  })
  await prisma.child.createMany({
    data: [
      // 起始余额 120：足以演示 +5 / −30，也足以演示「扣成负数被拒」。
      { id: ID.main, name: `记一笔套件主孩子 ${RUN}`, pointsBalance: 120 },
      { id: ID.gone, name: `记一笔套件已删孩子 ${RUN}`, status: 'deleted', deletedAt: new Date() }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.main, userId: ID.dad, role: 'guardian', status: 'active' },
      { childId: ID.main, userId: ID.kid, role: 'child', status: 'active' },
      { childId: ID.gone, userId: ID.dad, role: 'guardian', status: 'active' }
    ]
  })
  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.main, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.main, userId: ID.kid, activeRole: 'child', expiresAt: future },
      { deviceId: ID.devGone, childId: ID.gone, userId: ID.dad, activeRole: 'guardian', expiresAt: future }
    ]
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
describe('组 A：真 AppModule 里 `RECORDS_REPOSITORY` 绑的是 Prisma 适配器', () => {
  it('DI 取到的端口是真适配器（否则 501 会让所有 201 断言无从谈起）', () => {
    const port = app.get<object>(RECORDS_REPOSITORY)
    assert.ok(
      port instanceof PrismaRecordsRepository,
      `记一笔端口是 ${port.constructor.name} —— 装配没接上，生产会以「每次记一笔 501」的样子活着`
    )
  })
})


// ══ 组 B：成功路径 —— 流水 ＋ 余额 ＋ 审计同一事务 ══════════════════════════
describe('组 B：adjust —— 201、余额、审计、带符号分值', () => {
  it('加分：201，余额 +5，流水 category=adjust / source=guardian，审计同事务落库', async () => {
    const before = await balanceOf(ID.main)
    const res = await post('/records/adjust', H.dad, {
      title: '  主动帮妈妈洗碗  ',
      points: 5,
      note: '今天特别主动'
    })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)

    const record = res.body.record as Record<string, unknown>
    assert.equal(res.body.executedRecordId, record.id)
    assert.equal(record.points, 5)
    assert.equal(record.category, 'adjust')
    assert.equal(record.source, 'guardian')
    assert.equal(record.operatorRole, 'guardian')
    assert.equal(record.habitId, null)
    assert.equal(record.ruleId, null)
    assert.equal(record.reversesRecordId, null)
    assert.equal(record.balanceAfter, before + 5)
    // 标题完整落库（修 B8），且 trim 过
    assert.equal(record.title, '主动帮妈妈洗碗')
    assert.equal(record.note, '今天特别主动')
    assert.equal(await balanceOf(ID.main), before + 5)

    const row = await prisma.pointRecord.findUniqueOrThrow({ where: { id: String(record.id) } })
    assert.equal(row.childId, ID.main)
    assert.equal(row.operatorUserId, ID.dad)
    assert.equal(row.pointsDelta, 5)
    assert.equal(row.category, 'adjust')
    assert.equal(row.source, 'guardian')
    assert.equal(row.balanceAfter, before + 5)

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { targetType: 'PointRecord', targetId: String(record.id) }
    })
    assert.equal(audit.action, 'point_record.adjust')
    assert.equal(audit.actorUserId, ID.dad)
    assert.equal(audit.childId, ID.main)
    const after = audit.after as Record<string, unknown>
    assert.equal(after.recordId, record.id)
    assert.equal(after.pointsDelta, 5)
    assert.equal(after.balanceAfter, before + 5)
  })

  it('扣分：points=-30 ⇒ 余额 −30，流水记的是负数（不取绝对值）', async () => {
    const before = await balanceOf(ID.main)
    const res = await post('/records/adjust', H.dad, { title: '顶嘴', points: -30 })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)

    const record = res.body.record as Record<string, unknown>
    assert.equal(record.points, -30)
    assert.equal(record.balanceAfter, before - 30)
    assert.equal(await balanceOf(ID.main), before - 30)

    const row = await prisma.pointRecord.findUniqueOrThrow({ where: { id: String(record.id) } })
    assert.equal(row.pointsDelta, -30)
  })
})

// ══ 组 C：业务拒绝 —— 余额不许扣成负数，且拒绝时零副作用 ════════════════════
describe('组 C：INSUFFICIENT_POINTS ⇒ 409 且不留任何痕迹', () => {
  it('扣掉全部余额 + 1 ⇒ 409，余额不变、无新流水、无新审计（修 B6）', async () => {
    const before = await balanceOf(ID.main)
    const recordsBefore = await countAdjustRecords(ID.main)
    const auditsBefore = await countAdjustAudits(ID.main)

    const res = await post('/records/adjust', H.dad, { title: '扣光', points: -(before + 1) })
    assert.equal(res.status, 409, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(res.body.code, 'INSUFFICIENT_POINTS')

    assert.equal(await balanceOf(ID.main), before, '拒绝后余额必须一字未改')
    assert.equal(await countAdjustRecords(ID.main), recordsBefore)
    assert.equal(await countAdjustAudits(ID.main), auditsBefore)
  })

  it('余额正好扣到 0 ⇒ 201（边界是「不能为负」，不是「不能为 0」）', async () => {
    const before = await balanceOf(ID.main)
    assert.ok(before > 0, `前置余额应当 > 0，实际 ${before}`)

    const res = await post('/records/adjust', H.dad, { title: '清零', points: -before })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(await balanceOf(ID.main), 0)

    // 复原：把余额加回去，后面的用例仍按「有余量」的前提跑。
    const restore = await post('/records/adjust', H.dad, { title: '复原余额', points: before })
    assert.equal(restore.status, 201)
    assert.equal(await balanceOf(ID.main), before)
  })
})


// ══ 组 D：幂等 —— 同一 key 只写一笔 ═════════════════════════════════════════
describe('组 D：Idempotency-Key', () => {
  it('同一 key 重放 ⇒ 同一响应、只写一笔流水、只写一条审计、余额只加一次', async () => {
    const key = `dbtest-${RUN}-adjust-replay`
    const headers = { ...H.dad, 'idempotency-key': key }
    const body = { title: '重复提交', points: 7 }

    const before = await balanceOf(ID.main)
    const first = await post('/records/adjust', headers, body)
    assert.equal(first.status, 201, `实际 ${first.status}：${JSON.stringify(first.body)}`)
    const afterFirst = await balanceOf(ID.main)
    assert.equal(afterFirst, before + 7)

    const callsBefore = await countAdjustRecords(ID.main)
    const auditsBefore = await countAdjustAudits(ID.main)

    const second = await post('/records/adjust', headers, body)
    assert.equal(second.status, 201)
    assert.deepEqual(second.body, first.body)

    assert.equal(await balanceOf(ID.main), afterFirst, '重放不得再加一次分')
    assert.equal(await countAdjustRecords(ID.main), callsBefore, '重放不得再写一笔流水')
    assert.equal(await countAdjustAudits(ID.main), auditsBefore, '重放不得再写一条审计')
  })

  it('同一 key 换请求体 ⇒ 409 IDEMPOTENCY_KEY_REUSED（不拿上一笔结果冒充）', async () => {
    const key = `dbtest-${RUN}-adjust-reused`
    const headers = { ...H.dad, 'idempotency-key': key }
    const first = await post('/records/adjust', headers, { title: '第一次', points: 3 })
    assert.equal(first.status, 201)

    const second = await post('/records/adjust', headers, { title: '第一次', points: 4 })
    assert.equal(second.status, 409, `实际 ${second.status}：${JSON.stringify(second.body)}`)
    assert.equal(second.body.code, 'IDEMPOTENCY_KEY_REUSED')
  })
})

// ══ 组 E：屏障 —— 孩子不能记分；已删孩子 ⇒ 404（不是记到它名下）═════════════
describe('组 E：孩子 ⇒ 403；已删孩子 ⇒ 404', () => {
  it('孩子记一笔 ⇒ 403，余额不变、无流水（矩阵 adjust_points = DENY）', async () => {
    const before = await balanceOf(ID.main)
    const recordsBefore = await countAdjustRecords(ID.main)

    const res = await post('/records/adjust', H.kid, { title: '给自己加分', points: 10 })
    assert.equal(res.status, 403, `实际 ${res.status}：${JSON.stringify(res.body)}`)

    assert.equal(await balanceOf(ID.main), before)
    assert.equal(await countAdjustRecords(ID.main), recordsBefore)
  })

  it('孩子行 status=deleted ⇒ 404 CHILD_NOT_FOUND（绝不造一条无主流水）', async () => {
    const res = await post('/records/adjust', H.gone, { title: '给已删孩子加分', points: 5 })
    assert.equal(res.status, 404, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(res.body.code, 'CHILD_NOT_FOUND')
  })
})


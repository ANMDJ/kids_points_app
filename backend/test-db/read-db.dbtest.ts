/**
 * read-db.dbtest.ts —— 只读端点 **真库 × 真 HTTP** 套件（W4-A，2026-10-18）
 *
 * ── 它与另外两份用例的分工（缺哪份都算没验完）────────────────────────────────
 *   · `test/read-http.test.ts` —— 真 HTTP，但只读端口是**替身**：
 *       证明三道屏障、拒绝、入参封闭、映射；证明不了 SQL 在 Postgres 上读出了什么。
 *   · `test/read-wiring.test.ts` —— 证明适配器「把哪些键交给 Prisma」（`where` 里
 *       有没有 `reversedBy: none`、`take` 是不是 `limit + 1`）；证明不了关系过滤真的生效。
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `fetch`，断言最终的
 *       状态码 / JSON 与「夹具里刻意制造的软删、冲正、第二个孩子」是否一致。
 *
 * ── 夹具刻意制造的四种「会读错」的情形 ──────────────────────────────────────
 *   ① 一笔表扬被冲正：`goodHabitCount` 必须只数**未被冲正**的那笔（撤销要回落）；
 *   ② 软删的习惯 / 规则 / 心愿：不得出现在首页快照里；
 *   ③ 第二个孩子也有流水与已兑换心愿：绝不能串到第一个孩子的计数里；
 *   ④ 孩子行 `status=deleted`、但成员位仍在：必须是 404 `CHILD_NOT_FOUND`，
 *      不是「空首页」、也不是从屏障一漏成 403 的另一条语义。
 *
 * ── ★ 数据不清理（与 identity / ledger 套件同一纪律）──────────────────────────
 *   账本行 `DELETE` 被 REVOKE（I5）且 `Child` 外键是 `Restrict` ⇒ 本套件写下的流水
 *   删不掉。每次运行用全新 `dbtest-<run>` 前缀，于是「从零开始」这个前提成立，
 *   也不会误删别的套件的行。跑完留下的行本身就是可复核的证据。
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
import { READ_REPOSITORY } from '../src/read/read.repository'
import { PrismaReadRepository } from '../src/read/read.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-read-dad`,
  kid: `dbtest-${RUN}-read-kid`,
  stranger: `dbtest-${RUN}-read-stranger`,
  main: `dbtest-${RUN}-read-main`,
  other: `dbtest-${RUN}-read-other`,
  gone: `dbtest-${RUN}-read-gone`,
  devDad: `dbtest-${RUN}-read-dev-dad`,
  devKid: `dbtest-${RUN}-read-dev-kid`,
  devOther: `dbtest-${RUN}-read-dev-other`,
  devGone: `dbtest-${RUN}-read-dev-gone`,
  devNoMember: `dbtest-${RUN}-read-dev-no-member`,
  devUnknown: `dbtest-${RUN}-read-dev-unknown`,
  rewardRule: `dbtest-${RUN}-read-rule-reward`,
  penaltyRule: `dbtest-${RUN}-read-rule-penalty`,
  deletedRule: `dbtest-${RUN}-read-rule-deleted`,
  habit: `dbtest-${RUN}-read-habit`,
  deletedHabit: `dbtest-${RUN}-read-habit-deleted`,
  wishOpen: `dbtest-${RUN}-read-wish-open`,
  wishRedeemed: `dbtest-${RUN}-read-wish-redeemed`,
  deletedWish: `dbtest-${RUN}-read-wish-deleted`,
  otherWish: `dbtest-${RUN}-read-wish-other`,
  recReversed: `dbtest-${RUN}-read-rec-1`,
  recCorrection: `dbtest-${RUN}-read-rec-2`,
  recPraise: `dbtest-${RUN}-read-rec-3`,
  recExchange: `dbtest-${RUN}-read-rec-4`,
  recAdjust: `dbtest-${RUN}-read-rec-5`,
  recOther: `dbtest-${RUN}-read-rec-other`
} as const

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.main },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.main },
  other: { 'x-kp-device-id': ID.devOther, 'x-kp-child-id': ID.other },
  gone: { 'x-kp-device-id': ID.devGone, 'x-kp-child-id': ID.gone },
  noMember: { 'x-kp-device-id': ID.devNoMember, 'x-kp-child-id': ID.main },
  unknown: { 'x-kp-device-id': ID.devUnknown, 'x-kp-child-id': ID.main },
  deviceOnly: { 'x-kp-device-id': ID.devDad },
  crossChild: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.other }
} as const

/** 五笔流水的时间：严格递增，于是「按 createdAt desc, id desc」有唯一答案。 */
const T = {
  reversed: new Date('2026-10-01T01:00:00.000Z'),
  correction: new Date('2026-10-02T01:00:00.000Z'),
  praise: new Date('2026-10-03T01:00:00.000Z'),
  exchange: new Date('2026-10-04T01:00:00.000Z'),
  adjust: new Date('2026-10-05T01:00:00.000Z')
}

let prisma: PrismaService
let app: INestApplication
let url = ''
let seeded = false

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function get(path: string, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, { headers })
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: `只读 DB 套件 爸爸 ${RUN}` },
      { id: ID.kid, displayName: `只读 DB 套件 孩子 ${RUN}` },
      { id: ID.stranger, displayName: `只读 DB 套件 路人 ${RUN}` }
    ]
  })
  await prisma.child.createMany({
    data: [
      { id: ID.main, name: `只读套件主孩子 ${RUN}`, pointsBalance: 30 },
      { id: ID.other, name: `只读套件另一个孩子 ${RUN}`, pointsBalance: 999 },
      { id: ID.gone, name: `只读套件已删孩子 ${RUN}`, status: 'deleted', deletedAt: new Date() }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.main, userId: ID.dad, role: 'guardian', status: 'active' },
      { childId: ID.main, userId: ID.kid, role: 'child', status: 'active' },
      { childId: ID.other, userId: ID.dad, role: 'guardian', status: 'active' },
      { childId: ID.gone, userId: ID.dad, role: 'guardian', status: 'active' }
      // ID.stranger 刻意**没有**成员位：屏障一必须给出 403（§9.21）。
    ]
  })
  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.main, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.main, userId: ID.kid, activeRole: 'child', expiresAt: future },
      { deviceId: ID.devOther, childId: ID.other, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devGone, childId: ID.gone, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devNoMember, childId: ID.main, userId: ID.stranger, activeRole: 'viewer', expiresAt: future }
    ]
  })
  await prisma.pointRule.createMany({
    data: [
      {
        id: ID.rewardRule,
        childId: ID.main,
        title: '完成作业',
        condition: '当天作业全部完成',
        dailyLimit: 2,
        points: 3,
        direction: 'reward',
        icon: 'book',
        color: '#81C784',
        currentVersion: 1
      },
      {
        id: ID.penaltyRule,
        childId: ID.main,
        title: '超时未完成',
        condition: '约定时间内未完成',
        dailyLimit: 1,
        points: 5,
        direction: 'penalty',
        icon: 'clock',
        color: '#E57373',
        currentVersion: 1
      },
      {
        id: ID.deletedRule,
        childId: ID.main,
        title: '已删规则',
        condition: '不应出现',
        dailyLimit: 1,
        points: 99,
        direction: 'reward',
        icon: 'star',
        color: '#000000',
        status: 'deleted',
        deletedAt: new Date()
      }
    ]
  })
  await prisma.habit.createMany({
    data: [
      {
        id: ID.habit,
        childId: ID.main,
        sourceRuleId: ID.rewardRule,
        title: '番茄钟写作业',
        points: 1,
        condition: '专注 25 分钟',
        dailyLimit: 2,
        icon: 'timer',
        color: '#FFB74D'
      },
      {
        id: ID.deletedHabit,
        childId: ID.main,
        title: '已删习惯',
        points: 9,
        condition: '不应出现',
        dailyLimit: 1,
        icon: 'star',
        color: '#000000',
        status: 'deleted',
        deletedAt: new Date()
      },
      {
        id: `dbtest-${RUN}-read-habit-other`,
        childId: ID.other,
        title: '另一个孩子的习惯',
        points: 2,
        condition: '不应串门',
        dailyLimit: 1,
        icon: 'star',
        color: '#000000'
      }
    ]
  })
  await prisma.wish.createMany({
    data: [
      {
        id: ID.wishOpen,
        childId: ID.main,
        title: '去游乐园',
        cost: 100,
        emoji: '🎡',
        coverStyle: 'A',
        redeemed: false
      },
      {
        id: ID.wishRedeemed,
        childId: ID.main,
        title: '看一场电影',
        cost: 50,
        emoji: '🎬',
        coverStyle: 'B',
        redeemed: true,
        redeemedAt: new Date('2026-09-01T00:00:00.000Z')
      },
      {
        id: ID.deletedWish,
        childId: ID.main,
        title: '已删心愿',
        cost: 1,
        emoji: '❌',
        coverStyle: 'C',
        // ★ 软删只让它从「心愿列表」消失；它**确实兑换过**，累计次数不该因删配置而回退。
        redeemed: true,
        status: 'deleted',
        deletedAt: new Date()
      },
      {
        id: ID.otherWish,
        childId: ID.other,
        title: '另一个孩子的心愿',
        cost: 10,
        emoji: '🎁',
        coverStyle: 'D',
        redeemed: true
      }
    ]
  })


  // ── 流水：被冲正的表扬 ＋ 冲正行 ＋ 正常表扬 ＋ 兑换 ＋ 调整 ────────────────
  // `reversedAt` 只能在 INSERT 时给出：I5 禁止应用角色 UPDATE 账本。
  await prisma.pointRecord.create({
    data: {
      id: ID.recReversed,
      childId: ID.main,
      titleSnapshot: '番茄钟写作业',
      pointsDelta: 1,
      category: 'praise',
      source: 'child_self',
      operatorUserId: ID.kid,
      operatorRole: 'child',
      balanceAfter: 1,
      createdAt: T.reversed,
      reversedAt: T.correction
    }
  })
  await prisma.pointRecord.create({
    data: {
      id: ID.recCorrection,
      childId: ID.main,
      titleSnapshot: '撤销：番茄钟写作业',
      pointsDelta: -1,
      category: 'adjust',
      source: 'correction',
      note: '番茄钟写作业',
      balanceAfter: 0,
      reversesRecordId: ID.recReversed,
      createdAt: T.correction
    }
  })
  await prisma.pointRecord.create({
    data: {
      id: ID.recPraise,
      childId: ID.main,
      habitId: ID.habit,
      titleSnapshot: '完成作业',
      pointsDelta: 3,
      category: 'praise',
      source: 'guardian',
      operatorUserId: ID.dad,
      operatorRole: 'guardian',
      balanceAfter: 3,
      createdAt: T.praise
    }
  })
  await prisma.pointRecord.create({
    data: {
      id: ID.recExchange,
      childId: ID.main,
      wishId: ID.wishRedeemed,
      titleSnapshot: '看一场电影',
      pointsDelta: -50,
      category: 'exchange',
      source: 'approval',
      operatorUserId: ID.dad,
      operatorRole: 'guardian',
      balanceAfter: -47,
      createdAt: T.exchange
    }
  })
  await prisma.pointRecord.create({
    data: {
      id: ID.recAdjust,
      childId: ID.main,
      titleSnapshot: '临时调整',
      pointsDelta: -5,
      category: 'adjust',
      source: 'guardian',
      operatorUserId: ID.dad,
      operatorRole: 'guardian',
      note: '协商后扣回',
      balanceAfter: 30,
      createdAt: T.adjust
    }
  })
  await prisma.pointRecord.create({
    data: {
      id: ID.recOther,
      childId: ID.other,
      titleSnapshot: '另一个孩子的流水',
      pointsDelta: 7,
      category: 'praise',
      source: 'guardian',
      operatorUserId: ID.dad,
      operatorRole: 'guardian',
      balanceAfter: 7,
      createdAt: new Date('2026-10-06T00:00:00.000Z')
    }
  })
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()
  seeded = true

  // ★ 不传 `hasDatabase`：本文件要验的正是生产那条路（由 DATABASE_URL 推断）。
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()
})


// ══ 组 A：装配 —— 下面的 200 必须来自 Prisma 适配器，而不是 501/替身 ═════════
describe('组 A：真 AppModule 里 `READ_REPOSITORY` 绑的是 Prisma 适配器', () => {
  it('DI 取到的端口是真适配器（否则 501 会让所有 200 断言无从谈起）', () => {
    const port = app.get<object>(READ_REPOSITORY)
    assert.ok(
      port instanceof PrismaReadRepository,
      `只读端口是 ${port.constructor.name} —— 装配没接上，生产会以「每请求 501」的样子活着`
    )
  })
})

// ══ 组 B：GET /home —— 真库里的软删 / 冲正 / 跨孩子 ═════════════════════════
describe('组 B：GET /home —— 快照只含 active，计数按历史口径', () => {
  it('guardian 读到孩子、规则、习惯、心愿（软删项一律不出现）', async () => {
    const res = await get('/home', H.dad)
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)

    assert.deepEqual(res.body.child, {
      id: ID.main,
      name: `只读套件主孩子 ${RUN}`,
      pointsBalance: 30
    })

    const habits = res.body.habits as { id: string; ruleId: string | null; points: number }[]
    assert.deepEqual(
      habits.map((habit) => habit.id),
      [ID.habit],
      '软删习惯混进了首页 —— 回收站不是「今天的习惯」'
    )
    assert.equal(habits[0].ruleId, ID.rewardRule)
    assert.equal(habits[0].points, 1)

    const rules = res.body.rules as { id: string; points: number; direction: string }[]
    assert.deepEqual(
      rules.map((rule) => rule.id).sort(),
      [ID.penaltyRule, ID.rewardRule].sort(),
      '软删规则混进了首页'
    )
    assert.equal(rules.find((rule) => rule.id === ID.rewardRule)?.points, 3)
    assert.equal(
      rules.find((rule) => rule.id === ID.penaltyRule)?.points,
      -5,
      '扣分规则原样下发成正数 —— A1 又在服务端复活了'
    )

    const wishes = res.body.wishes as { id: string; coverStyle: string }[]
    assert.deepEqual(
      wishes.map((wish) => wish.id).sort(),
      [ID.wishOpen, ID.wishRedeemed].sort(),
      '软删心愿混进了首页'
    )
    assert.equal(wishes.find((wish) => wish.id === ID.wishRedeemed)?.coverStyle, 'B')
  })

  it('★ 计数：冲正后的表扬不计数（1 而非 2）；累计兑换含已软删但那笔确实兑换过（2）', async () => {
    const res = await get('/home', H.dad)
    assert.equal(
      res.body.goodHabitCount,
      1,
      '被冲正的表扬仍被计数 —— 撤销打卡后战绩没有回落（与客户端 checkedCountToday 直接矛盾）'
    )
    assert.equal(
      res.body.rewardCount,
      2,
      '兑换累计口径不对：软删只影响可兑换列表，不应抹掉已经发生过的兑换'
    )
  })

  it('child 也能读同一份快照（矩阵 view_child_points = ALLOW），且不下发展示串', async () => {
    const res = await get('/home', H.kid)
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.body).sort(), [
      'child',
      'goodHabitCount',
      'habits',
      'rewardCount',
      'rules',
      'wishes'
    ])
  })

  it('另一个孩子读到的是**自己的**习惯/心愿/计数（不串门）', async () => {
    const res = await get('/home', H.other)
    assert.equal(res.status, 200)
    assert.equal((res.body.child as { pointsBalance: number }).pointsBalance, 999)
    const habits = res.body.habits as { id: string }[]
    assert.deepEqual(habits.map((habit) => habit.id), [`dbtest-${RUN}-read-habit-other`])
    const wishes = res.body.wishes as { id: string }[]
    assert.deepEqual(wishes.map((wish) => wish.id), [ID.otherWish])
    assert.equal(res.body.goodHabitCount, 1)
    assert.equal(res.body.rewardCount, 1, '主孩子的两条兑换串到了另一个孩子头上')
  })
})


// ══ 组 C：GET /records —— 真账本顺序 / 筛选 / 分页 / 归属 ═════════════════════
describe('组 C：GET /records —— 账本只增不删，分页与筛选来自真 SQL', () => {
  it('全部记录按 (createdAt desc, id desc)：调整 → 兑换 → 表扬 → 冲正 → 原表扬', async () => {
    const res = await get('/records', H.dad)
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    const records = res.body.records as Record<string, unknown>[]
    assert.deepEqual(records.map((record) => record.id), [
      ID.recAdjust,
      ID.recExchange,
      ID.recPraise,
      ID.recCorrection,
      ID.recReversed
    ])
    assert.equal(res.body.limit, 50)
    assert.equal(res.body.hasMore, false)
  })

  it('字段映射：titleSnapshot → title、ISO 时间、冲正双向关系都在', async () => {
    const res = await get('/records', H.dad)
    const records = res.body.records as Record<string, unknown>[]
    const adjust = records.find((record) => record.id === ID.recAdjust)!
    assert.equal(adjust.title, '临时调整')
    assert.equal(adjust.points, -5)
    assert.equal(adjust.category, 'adjust')
    assert.equal(adjust.source, 'guardian')
    assert.equal(adjust.operatorRole, 'guardian')
    assert.equal(adjust.note, '协商后扣回')
    assert.equal(adjust.createdAt, T.adjust.toISOString())

    const reversed = records.find((record) => record.id === ID.recReversed)!
    assert.equal(reversed.reversedAt, T.correction.toISOString())
    const correction = records.find((record) => record.id === ID.recCorrection)!
    assert.equal(correction.reversesRecordId, ID.recReversed)
    assert.equal(correction.source, 'correction')

    const exchange = records.find((record) => record.id === ID.recExchange)!
    assert.equal(exchange.points, -50)
    assert.equal(exchange.wishId, ID.wishRedeemed)
    assert.equal(exchange.habitId, null)
  })

  it('★ 记录页是账本：被冲正的表扬**仍然在列表里**（只是统计不算它）', async () => {
    const res = await get('/records?category=praise', H.dad)
    assert.equal(res.status, 200)
    const records = res.body.records as { id: string }[]
    assert.deepEqual(
      records.map((record) => record.id),
      [ID.recPraise, ID.recReversed],
      '筛选把冲正历史擦掉了 —— 账本 append-only 的承诺在读端失效'
    )
  })

  it('limit=2 ⇒ 返回 2 条 + hasMore=true；limit=5 ⇒ 全 5 条 + hasMore=false', async () => {
    const first = await get('/records?limit=2', H.dad)
    assert.equal(first.status, 200)
    assert.equal((first.body.records as unknown[]).length, 2)
    assert.equal(first.body.limit, 2)
    assert.equal(first.body.hasMore, true, '多取一条的判据没生效 —— 恰好满页被当成了还有下一页')

    const all = await get('/records?limit=5', H.dad)
    assert.equal((all.body.records as unknown[]).length, 5)
    assert.equal(all.body.hasMore, false)
  })

  it('另一个孩子只读到自己的那一条（childId 来自会话，不来自 query）', async () => {
    const res = await get('/records', H.other)
    assert.equal(res.status, 200)
    const records = res.body.records as { id: string }[]
    assert.deepEqual(records.map((record) => record.id), [ID.recOther])

    const cross = await get(`/records?childId=${ID.other}`, H.dad)
    assert.equal(cross.status, 400, '未知查询键没有 400 —— 形状不是封闭集合')
  })

  it('非法入参 ⇒ 400（未知分类 / limit 越界 / 未知键）', async () => {
    for (const path of [
      '/records?category=nope',
      '/records?limit=0',
      '/records?limit=201',
      '/records?limit=abc',
      '/records?unknown=1'
    ]) {
      const res = await get(path, H.dad)
      assert.equal(res.status, 400, `${path} 应当 400，实际 ${res.status}`)
    }
  })
})

// ══ 组 D：真库上的三道屏障（401/403/404 必须分得开）══════════════════════════
describe('组 D：身份 → 屏障一 → 只读端口 —— 拒绝发生在查数据之前', () => {
  it('缺身份头 ⇒ 401 UNAUTHENTICATED', async () => {
    const none = await get('/home', {})
    assert.equal(none.status, 401)
    assert.equal(none.body.code, 'UNAUTHENTICATED')

    const deviceOnly = await get('/home', H.deviceOnly)
    assert.equal(deviceOnly.status, 401)
    assert.equal(deviceOnly.body.code, 'UNAUTHENTICATED')
  })

  it('未登记设备 ⇒ 401 SESSION_NOT_FOUND（不是 501）', async () => {
    const res = await get('/home', H.unknown)
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'SESSION_NOT_FOUND')
  })

  it('有会话但没有成员位 ⇒ 403 MEMBER_NOT_FOUND', async () => {
    const res = await get('/records', H.noMember)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'MEMBER_NOT_FOUND')
  })

  it('拿主孩子的会话去读另一个孩子 ⇒ 401（会话是 (device, child) 的，不是“任意孩子通行证”）', async () => {
    const res = await get('/home', H.crossChild)
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'SESSION_NOT_FOUND')
  })

  it('★ 孩子已软删但成员位仍在 ⇒ 404 CHILD_NOT_FOUND（不是空首页）', async () => {
    const res = await get('/home', H.gone)
    assert.equal(res.status, 404, `实际 ${res.status}：${JSON.stringify(res.body)}（headers=${JSON.stringify(H.gone)}）`)
    assert.equal(res.body.code, 'CHILD_NOT_FOUND')

    const records = await get('/records', H.gone)
    assert.equal(records.status, 404)
    assert.equal(records.body.code, 'CHILD_NOT_FOUND')
  })
})

after(async () => {
  // 数据**故意不删**（账本 DELETE 被 REVOKE，见文件头）；这里只收连接与监听端口。
  if (app !== undefined) await app.close()
  if (seeded) await prisma.$disconnect()
})


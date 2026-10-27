/**
 * notifications-db.dbtest.ts —— 站内通知的**真库 × 真 HTTP** 套件（W5-L，2026-10-23）
 *
 * ── 它与另外两份用例的分工（缺哪份都算没验完）────────────────────────────────
 *   · `test/notifications-http.test.ts` —— 真 HTTP，但端口是**替身**：
 *       证明三道屏障、入参封闭、映射、404 语义；证明不了 SQL 在 Postgres 上读出了什么。
 *   · `test/notifications-wiring.test.ts` —— 证明适配器「把哪些键交给 Prisma」
 *       （`where` 里有没有 `recipientUserId`、`take` 是不是 `limit + 1`）。
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `fetch`，
 *       断言最终的 JSON 与「夹具里刻意制造的收件人交叉、同毫秒、软删孩子」是否一致。
 *
 * ── 夹具刻意制造的六种「会读错」的情形 ──────────────────────────────────────
 *   ① **别人的通知**（同一孩子、另一个家长）不得出现在我的列表里；
 *   ② **另一个孩子的通知**（我还是成员）不得串到我这个孩子的列表里；
 *   ③ **同一毫秒的三条**（批量落库的真实形状）：游标只带时间会把剩下两条整页漏掉
 *      ⇒ 键集游标必须是 `(createdAt, id)` 双条件，翻页不重不漏；
 *   ④ **软删的孩子**：`status=deleted` ⇒ 404 `CHILD_NOT_FOUND`，
 *      不是「你没有新消息」的空页；
 *   ⑤ **标记已读的幂等**：再点一次回**原来的** `readAt`，库里的值也不许变；
 *   ⑥ **不是我的 id = 不存在**：别人的 / 不存在的 / 跨孩子的 id 都是同一个
 *      404 `NOTIFICATION_NOT_FOUND`（区分两者等于给出探测口）。
 *
 * ── ★ 数据不清理（与 identity / ledger / read 套件同一纪律）──────────────────
 *   每次运行用全新 `dbtest-<run>` 前缀，跑完「那些行还在」本身就是证据。
 *   通知行随 `Child` 级联删除（`onDelete: Cascade`），但本套件**不删**孩子。
 *
 * ── 入口 ──────────────────────────────────────────────────────────────────
 *   `npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AppModule } from '../src/app.module'
import { applyGlobalPipes } from '../src/app.setup'
import {
  NOTIFICATIONS_REPOSITORY,
  type NotificationsPort
} from '../src/notifications/notifications.repository'
import { PrismaNotificationsRepository } from '../src/notifications/notifications.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'
import { grantConsentFor } from './support/consent-fixture'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-n-dad`,
  kid: `dbtest-${RUN}-n-kid`,
  mom: `dbtest-${RUN}-n-mom`,
  stranger: `dbtest-${RUN}-n-stranger`,
  main: `dbtest-${RUN}-n-main`,
  other: `dbtest-${RUN}-n-other`,
  gone: `dbtest-${RUN}-n-gone`,
  devDad: `dbtest-${RUN}-n-dev-dad`,
  devKid: `dbtest-${RUN}-n-dev-kid`,
  devMom: `dbtest-${RUN}-n-dev-mom`,
  devOther: `dbtest-${RUN}-n-dev-other`,
  devGone: `dbtest-${RUN}-n-dev-gone`,
  devNoMember: `dbtest-${RUN}-n-dev-no-member`,
  // 主孩子、发给爸爸的五条 —— 顺序断言就靠它们。
  top: `dbtest-${RUN}-n-top`,
  sameC: `dbtest-${RUN}-n-same-c`,
  sameB: `dbtest-${RUN}-n-same-b`,
  sameA: `dbtest-${RUN}-n-same-a`,
  old: `dbtest-${RUN}-n-old`,
  // 孩子自己的 / 另一个家长的 / 另一个孩子的 / 已删孩子的。
  kidOwn: `dbtest-${RUN}-n-kid-own`,
  momOwn: `dbtest-${RUN}-n-mom-own`,
  otherOwn: `dbtest-${RUN}-n-other-own`,
  goneOwn: `dbtest-${RUN}-n-gone-own`
} as const

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.main },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.main },
  mom: { 'x-kp-device-id': ID.devMom, 'x-kp-child-id': ID.main },
  otherChild: { 'x-kp-device-id': ID.devOther, 'x-kp-child-id': ID.other },
  goneChild: { 'x-kp-device-id': ID.devGone, 'x-kp-child-id': ID.gone },
  noMember: { 'x-kp-device-id': ID.devNoMember, 'x-kp-child-id': ID.main }
} as const

/**
 * 时间戳：整秒，避免 `timestamp(3)` 截断把「同毫秒」写成两个值。
 * `same*` 三条**共用** `T.same` —— 这就是批量落库时的真实形状。
 */
const T = {
  old: new Date('2026-10-01T01:00:00.000Z'),
  same: new Date('2026-10-02T01:00:00.000Z'),
  top: new Date('2026-10-03T01:00:00.000Z'),
  alreadyRead: new Date('2026-10-01T02:00:00.000Z')
}

let prisma: PrismaService
let app: INestApplication
let url = ''
let seeded = false

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function request(
  method: 'GET' | 'PATCH',
  path: string,
  headers: Record<string, string>
): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, { method, headers })
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

/** 带 JSON body 的 POST（W5-M：真 HTTP 提交审批，看家长是否真的收到）。 */
async function postJson(
  path: string,
  headers: Record<string, string>,
  body: unknown
): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
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

const get = (path: string, headers: Record<string, string>): Promise<HttpResult> =>
  request('GET', path, headers)
const patch = (path: string, headers: Record<string, string>): Promise<HttpResult> =>
  request('PATCH', path, headers)

/** 列表项的窄类型：只取断言要用的字段。 */
interface Item {
  id: string
  type: string
  title: string
  body: string
  payload: unknown
  readAt: string | null
  createdAt: string
}

function itemsOf(body: Record<string, unknown>): Item[] {
  const items = body.items
  assert.ok(Array.isArray(items), `回包缺少 items 数组：${JSON.stringify(body)}`)
  return items as Item[]
}

function idsOf(body: Record<string, unknown>): string[] {
  return itemsOf(body).map((item) => item.id)
}

/** 业务错误码：`{ code, message }`（全局过滤后的统一形状）。 */
function codeOf(body: Record<string, unknown>): unknown {
  return body.code
}

async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: `通知 DB 套件 爸爸 ${RUN}` },
      { id: ID.kid, displayName: `通知 DB 套件 孩子 ${RUN}` },
      { id: ID.mom, displayName: `通知 DB 套件 妈妈 ${RUN}` },
      { id: ID.stranger, displayName: `通知 DB 套件 路人 ${RUN}` }
    ]
  })
  await prisma.child.createMany({
    data: [
      { id: ID.main, name: `通知套件主孩子 ${RUN}`, pointsBalance: 0 },
      { id: ID.other, name: `通知套件另一个孩子 ${RUN}`, pointsBalance: 0 },
      {
        id: ID.gone,
        name: `通知套件已删孩子 ${RUN}`,
        status: 'deleted',
        deletedAt: new Date()
      }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.main, userId: ID.dad, role: 'guardian', status: 'active' },
      { childId: ID.main, userId: ID.kid, role: 'child', status: 'active' },
      { childId: ID.main, userId: ID.mom, role: 'guardian', status: 'active' },
      { childId: ID.other, userId: ID.dad, role: 'guardian', status: 'active' },
      { childId: ID.gone, userId: ID.dad, role: 'guardian', status: 'active' }
      // ID.stranger 刻意**没有**成员位：屏障一必须给出 403。
    ]
  })
  // ★ W7-A 起写端点都过 ConsentGuard：组 E（新申请待确认）要真的提交申请 ⇒ main 需授权。
  await grantConsentFor(prisma, [[ID.main, ID.dad]])
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
        deviceId: ID.devMom,
        childId: ID.main,
        userId: ID.mom,
        activeRole: 'guardian',
        expiresAt: future
      },
      {
        deviceId: ID.devOther,
        childId: ID.other,
        userId: ID.dad,
        activeRole: 'guardian',
        expiresAt: future
      },
      {
        deviceId: ID.devGone,
        childId: ID.gone,
        userId: ID.dad,
        activeRole: 'guardian',
        expiresAt: future
      },
      {
        deviceId: ID.devNoMember,
        childId: ID.main,
        userId: ID.stranger,
        activeRole: 'viewer',
        expiresAt: future
      }
    ]
  })

  /** 直接造一行通知（绕过 service）：夹具要能构造「同毫秒」「已读」「别人的」。 */
  const seedNotification = async (input: {
    id: string
    childId: string
    recipientUserId: string
    title: string
    createdAt: Date
    readAt?: Date
  }): Promise<void> => {
    await prisma.notification.create({
      data: {
        id: input.id,
        childId: input.childId,
        recipientUserId: input.recipientUserId,
        type: 'approval.approved',
        title: input.title,
        body: `${input.title} 的正文`,
        payload: { approvalId: `dbtest-${RUN}-approval` },
        createdAt: input.createdAt,
        ...(input.readAt === undefined ? {} : { readAt: input.readAt })
      }
    })
  }

  // ① 爸爸的五条：T.top（最新）→ T.same 三条（同毫秒，id 降序 c>b>a）→ T.old（最早，已读）。
  await seedNotification({
    id: ID.top,
    childId: ID.main,
    recipientUserId: ID.dad,
    title: '最新一条',
    createdAt: T.top
  })
  await seedNotification({
    id: ID.sameC,
    childId: ID.main,
    recipientUserId: ID.dad,
    title: '同毫秒 C',
    createdAt: T.same
  })
  await seedNotification({
    id: ID.sameB,
    childId: ID.main,
    recipientUserId: ID.dad,
    title: '同毫秒 B',
    createdAt: T.same
  })
  await seedNotification({
    id: ID.sameA,
    childId: ID.main,
    recipientUserId: ID.dad,
    title: '同毫秒 A',
    createdAt: T.same
  })
  await seedNotification({
    id: ID.old,
    childId: ID.main,
    recipientUserId: ID.dad,
    title: '很早的一条',
    createdAt: T.old,
    readAt: T.alreadyRead
  })

  // ② 孩子 / 另一个家长 / 另一个孩子 / 已删孩子各一条。
  await seedNotification({
    id: ID.kidOwn,
    childId: ID.main,
    recipientUserId: ID.kid,
    title: '给孩子的',
    createdAt: T.same
  })
  await seedNotification({
    id: ID.momOwn,
    childId: ID.main,
    recipientUserId: ID.mom,
    title: '给妈妈的',
    createdAt: T.top
  })
  await seedNotification({
    id: ID.otherOwn,
    childId: ID.other,
    recipientUserId: ID.dad,
    title: '另一个孩子的',
    createdAt: T.top
  })
  await seedNotification({
    id: ID.goneOwn,
    childId: ID.gone,
    recipientUserId: ID.dad,
    title: '已删孩子的',
    createdAt: T.top
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

after(async () => {
  if (app !== undefined) await app.close()
  // 通知行不删（见文件头）；只断开连接。
  if (seeded) await prisma.$disconnect()
})

// ══ 组 A：装配 —— 下面的 200 必须来自 Prisma 适配器 ══════════════════════════
describe('组 A：真 AppModule 里 `NOTIFICATIONS_REPOSITORY` 绑的是 Prisma 适配器', () => {
  it('DI 取到的端口是真适配器（否则 501 会让所有 200 断言无从谈起）', () => {
    const port = app.get<object>(NOTIFICATIONS_REPOSITORY)
    assert.ok(
      port instanceof PrismaNotificationsRepository,
      `通知端口是 ${port.constructor.name} —— 装配没接上，生产会以「每请求 501」的样子活着`
    )
  })
})

// ══ 组 B：GET /notifications —— 收件人 / 孩子 / 同毫秒游标 ═══════════════════
describe('组 B：GET /notifications —— 只回发给我的，键集游标不丢同毫秒的行', () => {
  it('guardian 的五条：时间降序、同毫秒按 id 降序、unreadCount 只数自己的未读', async () => {
    const res = await get('/notifications?limit=10', H.dad)
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)

    assert.deepEqual(idsOf(res.body), [ID.top, ID.sameC, ID.sameB, ID.sameA, ID.old])
    assert.equal(res.body.hasMore, false, '仅 5 条却声称还有下一页')
    assert.equal(res.body.nextCursor, null, '最后一页不该给游标')
    // 五条里只有 `old` 已读 ⇒ 未读 4（别人的、别的孩子的都不计入）。
    assert.equal(res.body.unreadCount, 4)

    const [top, , , , old] = itemsOf(res.body)
    assert.equal(top?.readAt, null, '`top` 应该是未读')
    assert.equal(old?.readAt, T.alreadyRead.toISOString(), '已读行的时间被改写了')
    assert.equal(top?.createdAt, T.top.toISOString())
    // 收件人标识**不下发**：客户端已经知道自己是谁，下发只会诱导前端自己算权限。
    assert.equal('recipientUserId' in (top ?? {}), false)
    assert.equal('recipientRole' in (top ?? {}), false)
    assert.deepEqual(top?.payload, { approvalId: `dbtest-${RUN}-approval` })
  })

  it('同一个孩子、另一个家长：只看到给自己的那条（收件人是查询键的一半）', async () => {
    const res = await get('/notifications', H.mom)
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.deepEqual(idsOf(res.body), [ID.momOwn])
    assert.equal(res.body.unreadCount, 1)
    assert.equal(res.body.hasMore, false)
  })

  it('孩子视角：能读到自己的那一条（不是空列表）', async () => {
    const res = await get('/notifications', H.kid)
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.deepEqual(idsOf(res.body), [ID.kidOwn])
    assert.equal(res.body.unreadCount, 1)
  })

  it('同一个家长、另一个孩子：不会串到主孩子的列表里', async () => {
    const res = await get('/notifications', H.otherChild)
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.deepEqual(idsOf(res.body), [ID.otherOwn])
    assert.equal(res.body.unreadCount, 1)
  })

  it('limit=1 逐页走完：5 条一行不漏、一行不重（游标是 (createdAt, id) 双条件）', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const query: string =
        cursor === null
          ? '/notifications?limit=1'
          : `/notifications?limit=1&cursor=${encodeURIComponent(cursor)}`
      const res = await get(query, H.dad)
      assert.equal(res.status, 200, `第 ${pages + 1} 页实际 ${res.status}：${JSON.stringify(res.body)}`)
      const ids = idsOf(res.body)
      assert.equal(ids.length, 1, `第 ${pages + 1} 页应恰好 1 条，实际 ${JSON.stringify(ids)}`)
      // ★ 未读数与列表同一次查询：翻页不会让它变（红点不能跟着页走）。
      assert.equal(res.body.unreadCount, 4, `第 ${pages + 1} 页的 unreadCount 与事实不符`)
      seen.push(...ids)
      pages += 1
      cursor = typeof res.body.nextCursor === 'string' ? res.body.nextCursor : null
      if (cursor === null) break
      assert.equal(res.body.hasMore, true, '给了游标却说没有下一页')
      assert.ok(pages < 10, '翻页没有终止 —— 游标没前进')
    }

    assert.equal(pages, 5, `5 条通知应正好 5 页，实际 ${pages} 页`)
    assert.deepEqual(seen, [ID.top, ID.sameC, ID.sameB, ID.sameA, ID.old])
    assert.equal(new Set(seen).size, 5, '有行被重复返回')
  })

  it('limit 越界 / 游标是垃圾：400，不静默退回第一页', async () => {
    for (const query of ['/notifications?limit=0', '/notifications?limit=101', '/notifications?limit=abc']) {
      const res = await get(query, H.dad)
      assert.equal(res.status, 400, `${query} 实际 ${res.status}：${JSON.stringify(res.body)}`)
    }

    const bad = await get('/notifications?cursor=not-a-cursor', H.dad)
    assert.equal(bad.status, 400, `实际 ${bad.status}：${JSON.stringify(bad.body)}`)
    assert.equal(codeOf(bad.body), 'INVALID_NOTIFICATION_CURSOR')
  })

  it('没有成员位 ⇒ 403，且回包里没有半条通知', async () => {
    const res = await get('/notifications', H.noMember)
    assert.equal(res.status, 403, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal('items' in res.body, false, '被拒绝的请求不该带数据')
  })

  it('孩子已软删（成员位还在）⇒ 404 CHILD_NOT_FOUND，不是「你没有新消息」', async () => {
    const res = await get('/notifications', H.goneChild)
    assert.equal(res.status, 404, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(codeOf(res.body), 'CHILD_NOT_FOUND')
    assert.equal('items' in res.body, false, '软删的孩子不能被读成空页')
  })
})

// ══ 组 C：PATCH /notifications/:id/read —— 幂等、归属、方法 ═════════════════
describe('组 C：PATCH /notifications/:id/read —— 幂等，别人的 id 与不存在同码', () => {
  it('第一次标记：200 + 新 readAt；库里的值跟着变，红点同步减一', async () => {
    const res = await patch(`/notifications/${ID.top}/read`, H.dad)
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(res.body.id, ID.top)
    const readAt = res.body.readAt
    assert.equal(typeof readAt, 'string', `readAt 应是 ISO 串，实际 ${JSON.stringify(readAt)}`)

    const stored = await prisma.notification.findUnique({
      where: { id: ID.top },
      select: { readAt: true }
    })
    assert.equal(stored?.readAt?.toISOString(), readAt, '回包的 readAt 与库里那一行不一致')

    const list = await get('/notifications?limit=10', H.dad)
    assert.equal(list.status, 200)
    assert.equal(list.body.unreadCount, 3, '标记已读后红点没有减一')
    assert.equal(itemsOf(list.body)[0]?.readAt, readAt)
  })

  it('再点一次：回**原来的** readAt，库里不写第二次（幂等不是「刷新时间」）', async () => {
    const first = await patch(`/notifications/${ID.sameA}/read`, H.dad)
    assert.equal(first.status, 200, `实际 ${first.status}：${JSON.stringify(first.body)}`)

    // 隔开一点，确保「重写一次」会得到明显不同的时间戳。
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await patch(`/notifications/${ID.sameA}/read`, H.dad)
    assert.equal(second.status, 200, `实际 ${second.status}：${JSON.stringify(second.body)}`)
    assert.equal(second.body.readAt, first.body.readAt, '重复标记覆盖了第一次的时间')

    const stored = await prisma.notification.findUnique({
      where: { id: ID.sameA },
      select: { readAt: true }
    })
    assert.equal(stored?.readAt?.toISOString(), first.body.readAt)
  })

  it('早就读过的那条：回种子里的时间，不覆盖成现在', async () => {
    const res = await patch(`/notifications/${ID.old}/read`, H.dad)
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(res.body.readAt, T.alreadyRead.toISOString())
  })

  it('别人的 / 孩子的 / 跨孩子的 / 不存在的 id：全是同一个 404 NOTIFICATION_NOT_FOUND', async () => {
    const cases: Array<{ label: string; id: string; headers: Record<string, string> }> = [
      { label: '同一孩子、发给妈妈', id: ID.momOwn, headers: H.dad },
      { label: '同一孩子、发给孩子', id: ID.kidOwn, headers: H.dad },
      { label: '爸爸的 id 但换到另一个孩子', id: ID.top, headers: H.otherChild },
      { label: '根本不存在的 id', id: `dbtest-${RUN}-n-missing`, headers: H.dad }
    ]

    for (const item of cases) {
      const res = await patch(`/notifications/${item.id}/read`, item.headers)
      assert.equal(res.status, 404, `${item.label} 实际 ${res.status}：${JSON.stringify(res.body)}`)
      assert.equal(codeOf(res.body), 'NOTIFICATION_NOT_FOUND', `${item.label} 的错误码不一致 —— 等于给出了「这个 id 存在」的探测口`)
    }

    // ★ 关键：这四次「越权尝试」一条都**没有**真的写进库。
    const untouched = await prisma.notification.findMany({
      where: { id: { in: [ID.momOwn, ID.kidOwn] } },
      select: { id: true, readAt: true }
    })
    assert.equal(untouched.length, 2)
    for (const row of untouched) {
      assert.equal(row.readAt, null, `${row.id} 被越权标记成了已读`)
    }
  })

  it('标已读是 PATCH，不是 POST：POST 同路径 404，且不改任何行', async () => {
    const before = await prisma.notification.findUnique({
      where: { id: ID.sameB },
      select: { readAt: true }
    })
    assert.equal(before?.readAt, null)

    const res = await fetch(`${url}/notifications/${ID.sameB}/read`, {
      method: 'POST',
      headers: H.dad
    })
    assert.equal(res.status, 404, `POST 竟然命中了标记已读：${res.status}`)

    const afterRow = await prisma.notification.findUnique({
      where: { id: ID.sameB },
      select: { readAt: true }
    })
    assert.equal(afterRow?.readAt, null, 'POST 竟然把这一行标成了已读')
  })
})

// ══ 组 D：append —— 审批结论真落库，payload 原样可读 ════════════════════════
describe('组 D：append —— 站内通知真写进 `Notification` 表', () => {
  it('带 payload：列落对、readAt 为空、列表里立刻能读到（未读 +1）', async () => {
    const port = app.get<NotificationsPort>(NOTIFICATIONS_REPOSITORY)
    await port.append({
      childId: ID.main,
      recipientUserId: ID.dad,
      type: 'approval.rejected',
      title: '兑换申请被拒绝',
      body: '家长没有同意这次兑换。',
      payload: { approvalId: `dbtest-${RUN}-appended`, status: 'rejected' }
    })

    const row = await prisma.notification.findFirst({
      where: {
        childId: ID.main,
        recipientUserId: ID.dad,
        type: 'approval.rejected',
        title: '兑换申请被拒绝'
      },
      orderBy: { createdAt: 'desc' }
    })
    assert.ok(row !== null, 'append 没有真的写进库')
    assert.equal(row.readAt, null, '新通知不该是已读')
    assert.deepEqual(row.payload, {
      approvalId: `dbtest-${RUN}-appended`,
      status: 'rejected'
    })

    const list = await get('/notifications?limit=1', H.dad)
    assert.equal(list.status, 200, `实际 ${list.status}：${JSON.stringify(list.body)}`)
    assert.equal(itemsOf(list.body)[0]?.id, row.id, '刚写的那条不在列表最前面')
    assert.equal(list.body.unreadCount, 3, `未读数应比上一组 +1，实际 ${JSON.stringify(list.body.unreadCount)}`)
  })

  it('不带 payload：库里是 null（不是 `{}`，也不是字符串 "undefined"）', async () => {
    const port = app.get<NotificationsPort>(NOTIFICATIONS_REPOSITORY)
    await port.append({
      childId: ID.main,
      recipientUserId: ID.kid,
      type: 'family.notice',
      title: '家里有新消息',
      body: '打开看看。'
    })

    const row = await prisma.notification.findFirst({
      where: { childId: ID.main, recipientUserId: ID.kid, type: 'family.notice' },
      orderBy: { createdAt: 'desc' }
    })
    assert.ok(row !== null, 'append 没有真的写进库')
    assert.equal(row.payload, null)
  })
})

// ══ 组 E：W5-M 提交即通知家长（真库 × 真 HTTP）════════════════════════════════
// ★ 本组要证明的是一条**跨模块**事实：审批 service 落库之后，通知层按**成员位**
//   解析出家长，并真的往 `Notification` 表写了每人一条。单元测试能证明
//   「给了家长列表就会写」，只有真库能证明「家长列表是从 ChildMember 查出来的」。
describe('组 E：新申请待确认 —— 真的发给这个孩子的家长（W5-M）', () => {
  /** 当前未读数：用列表端点现读，避免把前面组的计数硬编码进来。 */
  async function unreadOf(headers: Record<string, string>): Promise<number> {
    const res = await get('/notifications?limit=1', headers)
    assert.equal(res.status, 200, `读未读数失败：${JSON.stringify(res.body)}`)
    return Number(res.body.unreadCount)
  }

  it('端口口径：只回 active guardian（不含 child，也不含别的孩子）', async () => {
    const port = app.get<NotificationsPort>(NOTIFICATIONS_REPOSITORY)

    const main = await port.listActiveGuardianUserIds(ID.main)
    assert.deepEqual([...main].sort(), [ID.dad, ID.mom], '家长集合不对 —— 孩子 / 路人被算进来了？')

    const other = await port.listActiveGuardianUserIds(ID.other)
    assert.deepEqual(other, [ID.dad], '跨孩子串了家长（爸爸在两个孩子都是 guardian）')
  })

  it('孩子提交 ⇒ 爸爸 / 妈妈各一条 approval.submitted，孩子自己一条都没有', async () => {
    const beforeDad = await unreadOf(H.dad)
    const beforeMom = await unreadOf(H.mom)
    const beforeKid = await unreadOf(H.kid)

    const created = await postJson('/approvals', H.kid, {
      action: 'request_points_bonus',
      amount: 10,
      reason: '帮忙洗碗'
    })
    assert.equal(created.status, 202, `孩子提交没成功：${JSON.stringify(created.body)}`)
    const approvalId = String(created.body.id)
    assert.ok(approvalId.length > 0)

    const rows = await prisma.notification.findMany({
      where: { childId: ID.main, type: 'approval.submitted' },
      orderBy: { recipientUserId: 'asc' }
    })
    assert.deepEqual(
      rows.map((row) => row.recipientUserId),
      [ID.dad, ID.mom],
      '不是每位家长各一条 —— 少写等于有人永远看不到新申请'
    )
    for (const row of rows) {
      assert.equal(row.readAt, null, '新通知不该是已读')
      assert.equal(row.childId, ID.main)
      assert.deepEqual(row.payload, {
        approvalId,
        action: 'request_points_bonus',
        submittedByUserId: ID.kid
      }, 'payload 多了金额 / 理由，或 approvalId 对不上')
      assert.match(row.body, /收件箱/)
    }
    assert.equal(
      rows.filter((row) => row.recipientUserId === ID.kid).length,
      0,
      '申请人收到了「待你确认」—— 纯噪音'
    )

    assert.equal(await unreadOf(H.dad), beforeDad + 1, '爸爸的红点没 +1')
    assert.equal(await unreadOf(H.mom), beforeMom + 1, '妈妈的红点没 +1')
    assert.equal(await unreadOf(H.kid), beforeKid, '孩子的未读数变了 —— 申请人也被通知了')
  })

  it('家长自己提交 ⇒ 只发给另一位家长，提交人的红点不动', async () => {
    const beforeDad = await unreadOf(H.dad)
    const beforeMom = await unreadOf(H.mom)

    const created = await postJson('/approvals', H.dad, {
      action: 'request_points_bonus',
      amount: 5,
      reason: '周末整理书架'
    })
    assert.equal(created.status, 202, `家长提交没成功：${JSON.stringify(created.body)}`)
    const approvalId = String(created.body.id)

    const all = await prisma.notification.findMany({
      where: { childId: ID.main, type: 'approval.submitted' },
      orderBy: { recipientUserId: 'asc' }
    })
    const rows = all.filter(
      (row) => (row.payload as { approvalId?: unknown } | null)?.approvalId === approvalId
    )
    assert.deepEqual(
      rows.map((row) => row.recipientUserId),
      [ID.mom],
      '要么发给了提交人自己，要么漏掉了另一位家长'
    )
    assert.equal(await unreadOf(H.dad), beforeDad, '提交人的红点 +1 了 —— 自己提醒自己')
    assert.equal(await unreadOf(H.mom), beforeMom + 1, '另一位家长没有收到待确认')
  })
})



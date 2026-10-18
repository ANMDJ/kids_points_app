/**
 * read-http.test.ts —— 只读端点（`GET /home` / `GET /records`）的 **HTTP 集成测试**
 * （W4-A，2026-10-18；真起 Nest ＋ 真发请求）
 *
 * ── 为什么必须走 HTTP ────────────────────────────────────────────────────────
 *   本文件要证明的不是「service 能返回一个对象」，而是：
 *     ① 三个 Guard **真的挂在路由上**（缺身份 ⇒ 401，非成员 ⇒ 403）；
 *     ② `childId` 真的来自**会话**，而不是 query（客户端无法读别人家数据）；
 *     ③ 无库装配时**不会**返回空首页/空流水（501 是唯一诚实的答复）。
 *   这三点在「直接 new Service(fakePort)」的测试里全都看不见。
 *
 * ── 世界钉死 ────────────────────────────────────────────────────────────────
 *   恒用 `ReadModule.register({ hasDatabase: false })`：身份 / 成员位 / 只读端口
 *   三条都注入替身。若按环境推断，组 A 的 501 断言就不再是在测本模块。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'
import { ReadModule } from '../src/read/read.module'
import {
  READ_REPOSITORY,
  type HomeSnapshotRow,
  type ListRecordsInput,
  type ReadPort,
  type RecordPageRow
} from '../src/read/read.repository'

const CHILD_ID = 'child-1'
const DEV_DAD = 'dev-dad'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'
const DEV_STRANGER = 'dev-stranger'

function identity(deviceId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': CHILD_ID }
}

const GUARDIAN = identity(DEV_DAD)
const CHILD = identity(DEV_KID)
const VIEWER = identity(DEV_GUEST)

function makeSessionFake(): DeviceSessionPort {
  const future = (): Date => new Date(Date.now() + 5 * 60 * 1000)
  const rows: SessionLookupRow[] = [
    { deviceId: DEV_DAD, childId: CHILD_ID, userId: 'u-dad', activeRole: 'guardian', expiresAt: future() },
    { deviceId: DEV_KID, childId: CHILD_ID, userId: 'u-kid', activeRole: 'child', expiresAt: future() },
    { deviceId: DEV_GUEST, childId: CHILD_ID, userId: 'u-guest', activeRole: 'viewer', expiresAt: future() }
  ]
  return {
    async findSession(deviceId, childId) {
      return rows.find((row) => row.deviceId === deviceId && row.childId === childId) ?? null
    }
  }
}

/** `u-guest` 刻意没有成员位：屏障一必须在他身上给出 403（§9.21）。 */
function makeMembershipFake(): MembershipPort {
  const rows: MembershipLookupRow[] = [
    { childId: CHILD_ID, userId: 'u-dad', role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: 'u-kid', role: 'child', status: 'active', restrictions: {} }
  ]
  return {
    async findMembership(childId, userId) {
      return rows.find((row) => row.childId === childId && row.userId === userId) ?? null
    }
  }
}

function makeHome(): HomeSnapshotRow {
  return {
    child: { id: CHILD_ID, name: '小满', pointsBalance: 124 },
    goodHabitCount: 324,
    rewardCount: 4,
    habits: [
      {
        id: 'h-1',
        title: '番茄钟写作业',
        points: 1,
        condition: '专注 25 分钟',
        dailyLimit: 2,
        icon: 'timer',
        color: '#FFB74D',
        ruleId: 'r-1'
      }
    ],
    rules: [
      {
        id: 'r-1',
        title: '完成作业',
        condition: '当天作业全部完成',
        dailyLimit: 2,
        points: 3,
        direction: 'reward',
        icon: 'book',
        color: '#81C784',
        currentVersion: 2
      },
      {
        id: 'r-2',
        title: '超时未完成',
        condition: '约定时间内未完成',
        dailyLimit: 1,
        points: 5,
        direction: 'penalty',
        icon: 'clock',
        color: '#E57373',
        currentVersion: 1
      }
    ],
    wishes: [
      {
        id: 'w-1',
        title: '去游乐园',
        cost: 100,
        emoji: '🎡',
        coverStyle: 'A',
        redeemed: false
      }
    ]
  }
}

function makePage(hasMore = true): RecordPageRow {
  return {
    hasMore,
    rows: [
      {
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
        createdAt: new Date('2026-10-18T01:02:03.000Z')
      },
      {
        id: 'rec-2',
        titleSnapshot: '撤销：番茄钟写作业',
        pointsDelta: -1,
        category: 'adjust',
        source: 'correction',
        operatorRole: null,
        note: '番茄钟写作业',
        habitId: 'h-1',
        ruleId: null,
        ruleVersion: null,
        wishId: null,
        reversesRecordId: 'rec-0',
        reversedAt: null,
        balanceAfter: 123,
        createdAt: new Date('2026-10-18T02:03:04.000Z')
      }
    ]
  }
}

function makeReadFake(): ReadPort & { homeCalls: string[]; recordCalls: ListRecordsInput[] } {
  const homeCalls: string[] = []
  const recordCalls: ListRecordsInput[] = []
  return {
    homeCalls,
    recordCalls,
    async loadHome(childId) {
      homeCalls.push(childId)
      return childId === CHILD_ID ? makeHome() : null
    },
    async listRecords(input) {
      recordCalls.push(input)
      return makePage()
    }
  }
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function get(
  baseUrl: string,
  path: string,
  headers: Record<string, string>
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, { headers })
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

async function startApp(repository?: ReadPort): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [ReadModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (repository !== undefined) {
    builder.overrideProvider(READ_REPOSITORY).useValue(repository)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app) // 与 main.ts 同一函数（不自己拼一份）
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 「查询未实现」必须 501，不得返回空数据 ═════════════════
describe('组 A：默认装配（只读端口未注入）⇒ 501，绝不冒充空数据', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('GET /home ⇒ 501 READ_MODEL_NOT_IMPLEMENTED（不是 200 + 0 分）', async () => {
    const res = await get(url, '/home', GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'READ_MODEL_NOT_IMPLEMENTED')
  })

  it('GET /records ⇒ 501（不是 200 + 空数组）', async () => {
    const res = await get(url, '/records', GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'READ_MODEL_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：三道屏障真的挂在路由上 ═════════════════════════════════════════════
describe('组 B：身份 → 屏障一 → 屏障二 —— 缺任何一道都不给数据', () => {
  let app!: INestApplication
  let url = ''
  let port: ReturnType<typeof makeReadFake>

  before(async () => {
    port = makeReadFake()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.homeCalls.length = 0
    port.recordCalls.length = 0
  })

  it('缺 x-kp-device-id / x-kp-child-id ⇒ 401 UNAUTHENTICATED，端口零调用', async () => {
    const noDevice = await get(url, '/home', { 'x-kp-child-id': CHILD_ID })
    assert.equal(noDevice.status, 401)
    assert.equal(noDevice.body.code, 'UNAUTHENTICATED')

    const noChild = await get(url, '/home', { 'x-kp-device-id': DEV_DAD })
    assert.equal(noChild.status, 401)
    assert.equal(noChild.body.code, 'UNAUTHENTICATED')

    assert.equal(port.homeCalls.length, 0, '身份没过却调用了只读端口 —— 权限成了可选')
  })

  it('没有会话 ⇒ 401 SESSION_NOT_FOUND，端口零调用', async () => {
    const res = await get(url, '/home', identity(DEV_STRANGER))
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'SESSION_NOT_FOUND')
    assert.equal(port.homeCalls.length, 0)
  })

  it('有会话但不是成员 ⇒ 403 MEMBER_NOT_FOUND，端口零调用（§9.21）', async () => {
    const res = await get(url, '/home', VIEWER)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'MEMBER_NOT_FOUND')
    assert.equal(port.homeCalls.length, 0)
  })
})


// ══ 组 C：GET /home 的成功形状 ═══════════════════════════════════════════════
describe('组 C：GET /home —— 结构字段、带符号分值、childId 来自会话', () => {
  let app!: INestApplication
  let url = ''
  let port: ReturnType<typeof makeReadFake>

  before(async () => {
    port = makeReadFake()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.homeCalls.length = 0
  })

  for (const [role, headers] of [
    ['guardian', GUARDIAN],
    ['child', CHILD]
  ] as const) {
    it(`${role} 有权读（矩阵 view_child_points = ALLOW）`, async () => {
      const res = await get(url, '/home', headers)
      assert.equal(res.status, 200)
      const child = res.body.child as { id: string; name: string; pointsBalance: number }
      assert.deepEqual(child, { id: CHILD_ID, name: '小满', pointsBalance: 124 })
      assert.equal(res.body.goodHabitCount, 324)
      assert.equal(res.body.rewardCount, 4)
      assert.deepEqual(port.homeCalls, [CHILD_ID])
    })
  }

  it('规则分值带符号：penalty 5 ⇒ -5；reward 3 ⇒ 3（库里恒为正，03 A1）', async () => {
    const res = await get(url, '/home', GUARDIAN)
    const rules = res.body.rules as { points: number; direction: string }[]
    assert.equal(rules[0].points, 3)
    assert.equal(rules[0].direction, 'reward')
    assert.equal(rules[1].points, -5)
    assert.equal(rules[1].direction, 'penalty')
  })

  it('不下发展示串 —— 派生只在客户端一处（03 E17 / E19）', async () => {
    const res = await get(url, '/home', GUARDIAN)
    assert.deepEqual(Object.keys(res.body).sort(), [
      'child',
      'goodHabitCount',
      'habits',
      'rewardCount',
      'rules',
      'wishes'
    ])
    const habit = (res.body.habits as Record<string, unknown>[])[0]
    assert.deepEqual(Object.keys(habit).sort(), [
      'color',
      'condition',
      'dailyLimit',
      'icon',
      'id',
      'points',
      'ruleId',
      'title'
    ])
  })

  it('孩子行不存在 ⇒ 404 CHILD_NOT_FOUND（不是空快照）', async () => {
    const ghost: ReadPort = {
      async loadHome() {
        return null
      },
      async listRecords() {
        return { rows: [], hasMore: false }
      }
    }
    const other = await startApp(ghost)
    try {
      const res = await get(other.url, '/home', GUARDIAN)
      assert.equal(res.status, 404)
      assert.equal(res.body.code, 'CHILD_NOT_FOUND')
    } finally {
      await other.app.close()
    }
  })
})

// ══ 组 D：GET /records —— 筛选 / 分页 / 入参封闭 ═════════════════════════════
describe('组 D：GET /records —— 分类、limit、hasMore、拒绝非法入参', () => {
  let app!: INestApplication
  let url = ''
  let port: ReturnType<typeof makeReadFake>

  before(async () => {
    port = makeReadFake()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.recordCalls.length = 0
  })

  it('不传 limit ⇒ 50；category 为 undefined（全部）', async () => {
    const res = await get(url, '/records', GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(port.recordCalls, [{ childId: CHILD_ID, category: undefined, limit: 50 }])
    assert.equal(res.body.limit, 50)
    assert.equal(res.body.hasMore, true)
  })

  it('category=praise&limit=2 ⇒ 原样交给端口', async () => {
    const res = await get(url, '/records?category=praise&limit=2', CHILD)
    assert.equal(res.status, 200)
    assert.deepEqual(port.recordCalls, [{ childId: CHILD_ID, category: 'praise', limit: 2 }])
    assert.equal(res.body.limit, 2)
  })

  it('流水字段映射：titleSnapshot → title、createdAt → ISO、枚举保持库内拼写', async () => {
    const res = await get(url, '/records', GUARDIAN)
    const records = res.body.records as Record<string, unknown>[]
    assert.equal(records[0].title, '番茄钟写作业')
    assert.equal(records[0].points, 1)
    assert.equal(records[0].category, 'praise')
    assert.equal(records[0].source, 'child_self')
    assert.equal(records[0].operatorRole, 'child')
    assert.equal(records[0].createdAt, '2026-10-18T01:02:03.000Z')
    assert.equal(records[0].reversedAt, null)
    assert.equal(records[1].source, 'correction')
    assert.equal(records[1].reversesRecordId, 'rec-0')
  })

  it('非法入参 ⇒ 400（未知分类 / limit 越界 / 未知键），且不查库', async () => {
    for (const path of [
      '/records?category=nope',
      '/records?limit=0',
      '/records?limit=201',
      '/records?limit=abc',
      '/records?unknown=1'
    ]) {
      const res = await get(url, path, GUARDIAN)
      assert.equal(res.status, 400, `${path} 应当 400，实际 ${res.status}`)
    }
    assert.equal(port.recordCalls.length, 0, '入参没过却在查库 —— 形状校验没生效')
  })

  it('hasMore=true ⇒ 下发 nextCursor；原样回传 ⇒ 端口收到 before（本页最后一行的键）', async () => {
    const first = await get(url, '/records?limit=2', GUARDIAN)
    assert.equal(first.status, 200)
    assert.equal(first.body.hasMore, true)
    assert.equal(typeof first.body.nextCursor, 'string', 'hasMore=true 却没有下一页游标')

    port.recordCalls.length = 0
    const second = await get(
      url,
      `/records?limit=2&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
      GUARDIAN
    )
    assert.equal(second.status, 200, `实际 ${second.status}：${JSON.stringify(second.body)}`)
    assert.deepEqual(port.recordCalls, [
      {
        childId: CHILD_ID,
        category: undefined,
        limit: 2,
        before: {
          // makePage 的最后一行是 rec-2（02:03:04）—— 游标必须钉在它上面
          createdAt: new Date('2026-10-18T02:03:04.000Z'),
          id: 'rec-2'
        }
      }
    ])
  })

  it('非法 cursor ⇒ 400 INVALID_RECORD_CURSOR，且不查库（不静默退回第一页）', async () => {
    const res = await get(url, '/records?cursor=not-a-cursor', GUARDIAN)
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'INVALID_RECORD_CURSOR')
    assert.equal(port.recordCalls.length, 0, '游标没解析却在查库 —— 会把错误游标当成第一页')
  })

  it('hasMore=false ⇒ nextCursor=null（客户端据此停止“加载更多”）', async () => {
    const done: ReadPort = {
      async loadHome() {
        return null
      },
      async listRecords() {
        return { rows: [], hasMore: false }
      }
    }
    const other = await startApp(done)
    try {
      const res = await get(other.url, '/records', GUARDIAN)
      assert.equal(res.status, 200)
      assert.equal(res.body.hasMore, false)
      assert.equal(res.body.nextCursor, null)
    } finally {
      await other.app.close()
    }
  })
})


/**
 * habits-http.test.ts —— 打卡 / 撤销的 **HTTP 集成测试**（W4-D，2026-10-19）
 *
 * 真起 Nest、真发请求；持久化端口与幂等端口都是替身（世界固定为 `hasDatabase: false`）。
 * 要证明的是**路由上的事实**，不是 service 能不能返回对象：
 *   ① 三个 Guard 真的挂在控制器上（缺身份 401、无成员 403、child 不能撤销 403）；
 *   ② `childId` 真的来自会话 —— 请求体里多传 `childId` 必须 400，而不是被静默忽略；
 *   ③ 幂等只在**带 key** 时生效（不带 key 两次 = 两笔，这是产品语义）；
 *   ④ 无库装配时两个端点都 501（绝不假装打卡成功）。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import {
  ConflictException,
  NotFoundException,
  type INestApplication
} from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import { HabitsModule } from '../src/habits/habits.module'
import {
  HABITS_REPOSITORY,
  type CheckInInput,
  type DeleteHabitInput,
  type HabitsPort,
  type ReverseRecordInput
} from '../src/habits/habits.repository'
import {
  IDEMPOTENCY_REPOSITORY,
  type BeginIdempotencyInput,
  type BeginIdempotencyResult,
  type CompleteIdempotencyInput,
  type IdempotencyPort
} from '../src/idempotency/idempotency.repository'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'
import type { RecordRow } from '../src/read/read.repository'

const CHILD_ID = 'child-1'
const HABIT_ID = 'habit-1'
const RECORD_ID = 'rec-1'
const CORRECTION_ID = 'rec-correction'

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

/** `u-guest` 刻意没有成员位：屏障一必须给出 403。 */
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

function checkInRow(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: RECORD_ID,
    titleSnapshot: '番茄钟写作业',
    pointsDelta: 1,
    category: 'praise',
    source: 'child_self',
    operatorRole: 'child',
    note: '',
    habitId: HABIT_ID,
    ruleId: null,
    ruleVersion: null,
    wishId: null,
    reversesRecordId: null,
    reversedAt: null,
    balanceAfter: 125,
    createdAt: new Date('2026-10-19T01:02:03.000Z'),
    ...overrides
  }
}

type PortFake = HabitsPort & {
  checkIns: CheckInInput[]
  reverses: ReverseRecordInput[]
  deletes: DeleteHabitInput[]
  checkInError: Error | null
}

function makePort(): PortFake {
  const port: PortFake = {
    checkIns: [],
    reverses: [],
    deletes: [],
    checkInError: null,
    async deleteHabit(input) {
      port.deletes.push(input)
      return input.habitId
    },
    async checkIn(input) {
      port.checkIns.push(input)
      if (port.checkInError !== null) throw port.checkInError
      return checkInRow({ source: input.source, operatorRole: input.operatorRole })
    },
    async reverse(input) {
      port.reverses.push(input)
      return checkInRow({
        id: CORRECTION_ID,
        titleSnapshot: '撤销：番茄钟写作业',
        pointsDelta: -1,
        category: 'adjust',
        source: 'correction',
        operatorRole: input.operatorRole,
        note: input.note ?? '番茄钟写作业',
        reversesRecordId: RECORD_ID,
        balanceAfter: 124
      })
    }
  }
  return port
}


/** 内存幂等：键 = `${childId}:${key}`，与库层唯一约束同形。 */
function makeIdempotencyFake(): IdempotencyPort & { begins: BeginIdempotencyInput[] } {
  const records = new Map<
    string,
    { requestHash: string; statusCode: number | null; body: Record<string, unknown> | null }
  >()
  const begins: BeginIdempotencyInput[] = []
  return {
    begins,
    async begin(input): Promise<BeginIdempotencyResult> {
      begins.push(input)
      const id = `${input.childId}:${input.key}`
      const existing = records.get(id)
      if (existing === undefined) {
        records.set(id, { requestHash: input.requestHash, statusCode: null, body: null })
        return { kind: 'started' }
      }
      if (existing.requestHash !== input.requestHash) {
        return { kind: 'conflict', reason: 'HASH_MISMATCH' }
      }
      if (existing.statusCode === null || existing.body === null) {
        return { kind: 'conflict', reason: 'IN_PROGRESS' }
      }
      return { kind: 'replay', statusCode: existing.statusCode, body: existing.body }
    },
    async complete(input: CompleteIdempotencyInput): Promise<void> {
      const id = `${input.childId}:${input.key}`
      const existing = records.get(id)
      if (existing === undefined) throw new Error(`complete 了不存在的幂等记录 ${id}`)
      existing.statusCode = input.statusCode
      existing.body = input.body
    },
    async abort(input): Promise<void> {
      records.delete(`${input.childId}:${input.key}`)
    }
  }
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function post(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  body: unknown = {}
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  return readResult(res)
}

/** `DELETE` 没有请求体 —— 与 `post` 分开，避免每次调用都要写一个多余的 `{}`。 */
async function del(
  baseUrl: string,
  path: string,
  headers: Record<string, string>
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE', headers })
  return readResult(res)
}

async function readResult(res: Response): Promise<HttpResult> {
  const text = await res.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed }
}

async function startApp(
  options: { port?: HabitsPort; idempotency?: IdempotencyPort } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [HabitsModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (options.idempotency !== undefined) {
    builder.overrideProvider(IDEMPOTENCY_REPOSITORY).useValue(options.idempotency)
  }

  if (options.port !== undefined) {
    builder.overrideProvider(HABITS_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 501，绝不假装打卡成功 ═══════════════════════════════════
describe('组 A：默认装配（习惯端口未注入）⇒ 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('POST /records/check-in ⇒ 501 HABITS_PERSISTENCE_NOT_IMPLEMENTED', async () => {
    const res = await post(url, '/records/check-in', GUARDIAN, { habitId: HABIT_ID })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'HABITS_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('POST /records/:id/reverse ⇒ 501（不会返回一个假的负数记录）', async () => {
    const res = await post(url, `/records/${RECORD_ID}/reverse`, GUARDIAN, {})
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'HABITS_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('带 Idempotency-Key ⇒ 先被幂等端口 501 拦下（无库不假装保护已生效）', async () => {
    const res = await post(
      url,
      '/records/check-in',
      { ...GUARDIAN, 'idempotency-key': 'k-1' },
      { habitId: HABIT_ID }
    )
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'IDEMPOTENCY_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：三道屏障 + 入参封闭 ═════════════════════════════════════════════════
describe('组 B：身份 → 成员 → 矩阵；请求体不能指定孩子/金额', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = makePort()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.checkIns.length = 0
    port.reverses.length = 0
    port.checkInError = null
  })

  it('缺身份头 ⇒ 401 UNAUTHENTICATED，端口零调用', async () => {
    const res = await post(url, '/records/check-in', {}, { habitId: HABIT_ID })
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'UNAUTHENTICATED')
    assert.equal(port.checkIns.length, 0)
  })

  it('会话不存在 ⇒ 401 SESSION_NOT_FOUND，端口零调用', async () => {
    const res = await post(url, '/records/check-in', identity(DEV_STRANGER), { habitId: HABIT_ID })
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'SESSION_NOT_FOUND')
    assert.equal(port.checkIns.length, 0)
  })

  it('viewer 没有成员位 ⇒ 403，端口零调用（屏障一）', async () => {
    const res = await post(url, '/records/check-in', VIEWER, { habitId: HABIT_ID })
    assert.equal(res.status, 403)
    assert.equal(port.checkIns.length, 0)
  })

  it('child 撤销打卡 ⇒ 403（矩阵 undo_check_in = DENY），端口零调用', async () => {
    const res = await post(url, `/records/${RECORD_ID}/reverse`, CHILD, {})
    assert.equal(res.status, 403)
    assert.equal(port.reverses.length, 0)
  })

  it('多传 childId ⇒ 400（不是静默忽略后给请求体里的孩子加分）', async () => {
    const res = await post(url, '/records/check-in', GUARDIAN, {
      habitId: HABIT_ID,
      childId: 'someone-elses-child'
    })
    assert.equal(res.status, 400)
    assert.equal(port.checkIns.length, 0)
  })

  it('多传 points ⇒ 400（分值只能来自库里的习惯）', async () => {
    const res = await post(url, '/records/check-in', GUARDIAN, { habitId: HABIT_ID, points: 999 })
    assert.equal(res.status, 400)
    assert.equal(port.checkIns.length, 0)
  })

  it('缺 habitId / 空 habitId ⇒ 400', async () => {
    const missing = await post(url, '/records/check-in', CHILD, {})
    assert.equal(missing.status, 400)

    const empty = await post(url, '/records/check-in', CHILD, { habitId: '' })
    assert.equal(empty.status, 400)
    assert.equal(port.checkIns.length, 0)
  })

  it('撤销请求体多传金额 ⇒ 400（金额由原记录决定）', async () => {
    const res = await post(url, `/records/${RECORD_ID}/reverse`, GUARDIAN, { points: 100 })
    assert.equal(res.status, 400)
    assert.equal(port.reverses.length, 0)
  })
})


// ══ 组 C：成功路径 + 响应契约 ═════════════════════════════════════════════════
describe('组 C：打卡 / 撤销 201，响应与 GET /records 同构', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake
  let idempotency: ReturnType<typeof makeIdempotencyFake>

  before(async () => {
    port = makePort()
    idempotency = makeIdempotencyFake()
    ;({ app, url } = await startApp({ port, idempotency }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.checkIns.length = 0
    port.reverses.length = 0
    port.checkInError = null
    idempotency.begins.length = 0
  })

  it('孩子打卡：childId 来自会话，source=child_self；201 + {record, executedRecordId}', async () => {
    const res = await post(url, '/records/check-in', CHILD, { habitId: HABIT_ID })

    assert.equal(res.status, 201)
    assert.deepEqual(Object.keys(res.body).sort(), ['executedRecordId', 'record'])
    assert.equal(res.body.executedRecordId, RECORD_ID)

    const record = res.body.record as Record<string, unknown>
    assert.deepEqual(Object.keys(record).sort(), [
      'balanceAfter',
      'category',
      'createdAt',
      'habitId',
      'id',
      'note',
      'operatorRole',
      'points',
      'reversedAt',
      'reversesRecordId',
      'ruleId',
      'ruleVersion',
      'source',
      'title',
      'wishId'
    ])
    assert.equal(record.points, 1)
    assert.equal(record.title, '番茄钟写作业')
    assert.equal(record.createdAt, '2026-10-19T01:02:03.000Z')

    assert.equal(port.checkIns.length, 1)
    assert.equal(port.checkIns[0].childId, CHILD_ID)
    assert.equal(port.checkIns[0].habitId, HABIT_ID)
    assert.equal(port.checkIns[0].operatorUserId, 'u-kid')
    assert.equal(port.checkIns[0].source, 'child_self')
    assert.equal(idempotency.begins.length, 0, '没带 key 却进了幂等层')
  })

  it('家长打卡：source=guardian', async () => {
    const res = await post(url, '/records/check-in', GUARDIAN, { habitId: HABIT_ID })
    assert.equal(res.status, 201)
    assert.equal(port.checkIns[0].source, 'guardian')
  })

  it('家长撤销：201，响应是新的冲正记录（原记录 id 走路径）', async () => {
    const res = await post(url, `/records/${RECORD_ID}/reverse`, GUARDIAN, { note: '点错了' })

    assert.equal(res.status, 201)
    const record = res.body.record as Record<string, unknown>
    assert.equal(res.body.executedRecordId, CORRECTION_ID)
    assert.equal(record.id, CORRECTION_ID)
    assert.equal(record.source, 'correction')
    assert.equal(record.category, 'adjust')
    assert.equal(record.points, -1)
    assert.equal(record.reversesRecordId, RECORD_ID)

    assert.equal(port.reverses.length, 1)
    assert.equal(port.reverses[0].childId, CHILD_ID)
    assert.equal(port.reverses[0].recordId, RECORD_ID)
    assert.equal(port.reverses[0].note, '点错了')
  })

  it('不带 key 连点两次 ⇒ 两笔（显式产品语义，不是“自动去重”）', async () => {
    const first = await post(url, '/records/check-in', CHILD, { habitId: HABIT_ID })
    const second = await post(url, '/records/check-in', CHILD, { habitId: HABIT_ID })
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.equal(port.checkIns.length, 2)
  })

  it('带同一个 key 重放 ⇒ 只执行一次，第二次原样返回首次响应', async () => {
    const headers = { ...CHILD, 'idempotency-key': 'checkin-1' }
    const first = await post(url, '/records/check-in', headers, { habitId: HABIT_ID })
    const second = await post(url, '/records/check-in', headers, { habitId: HABIT_ID })

    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.deepEqual(second.body, first.body)
    assert.equal(port.checkIns.length, 1, '重放却再次执行了业务')
    assert.equal(idempotency.begins.length, 2)
    assert.equal(port.checkIns[0].idempotencyKey, 'checkin-1')
  })

  it('同一个 key 换个请求体 ⇒ 409 IDEMPOTENCY_KEY_REUSED，且不执行第二次', async () => {
    const headers = { ...CHILD, 'idempotency-key': 'checkin-2' }
    await post(url, '/records/check-in', headers, { habitId: HABIT_ID })
    const res = await post(url, '/records/check-in', headers, { habitId: 'another-habit' })

    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(port.checkIns.length, 1)
  })

  it('业务 409 时同一 key 可重试（失败不缓存）', async () => {
    port.checkInError = new ConflictException({
      code: 'HABIT_DAILY_LIMIT_REACHED',
      message: '今天已经完成 1 次'
    })
    const headers = { ...CHILD, 'idempotency-key': 'checkin-3' }
    const failed = await post(url, '/records/check-in', headers, { habitId: HABIT_ID })
    assert.equal(failed.status, 409)
    assert.equal(failed.body.code, 'HABIT_DAILY_LIMIT_REACHED')

    port.checkInError = null
    const retried = await post(url, '/records/check-in', headers, { habitId: HABIT_ID })
    assert.equal(retried.status, 201)
    assert.equal(port.checkIns.length, 2)
  })
})

// ══ 组 D：端口的 4xx 原样穿过 HTTP（错误码是契约的一部分）════════════════════
describe('组 D：HABIT_NOT_FOUND / 上限 / 非打卡记录 —— 状态码与 code 不变形', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = makePort()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.checkInError = null
  })

  it('端口 404 HABIT_NOT_FOUND ⇒ HTTP 404 + 同一个 code', async () => {
    port.checkInError = new NotFoundException({
      code: 'HABIT_NOT_FOUND',
      message: '习惯不存在'
    })
    const res = await post(url, '/records/check-in', CHILD, { habitId: 'ghost' })
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'HABIT_NOT_FOUND')
  })

  it('端口 409 HABIT_DAILY_LIMIT_REACHED ⇒ 409（不是 500）', async () => {
    port.checkInError = new ConflictException({
      code: 'HABIT_DAILY_LIMIT_REACHED',
      message: '上限已到'
    })
    const res = await post(url, '/records/check-in', CHILD, { habitId: HABIT_ID })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'HABIT_DAILY_LIMIT_REACHED')
  })
})

// ══ 组 E：DELETE /habits/:id —— 软删进回收站（W5-F，2026-10-21）════════════════
describe('组 E：DELETE /habits/:id（软删 → 回收站）', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = makePort()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.deletes.length = 0
  })

  it('缺身份头 ⇒ 401，端口零调用（回收站不是后门）', async () => {
    const res = await del(url, `/habits/${HABIT_ID}`, {})
    assert.equal(res.status, 401)
    assert.equal(port.deletes.length, 0)
  })

  it('孩子删除习惯 ⇒ 403（矩阵 delete_habit child DENY），端口零调用', async () => {
    const res = await del(url, `/habits/${HABIT_ID}`, CHILD)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.deletes.length, 0)
  })

  it('家长删除 ⇒ 200 {habitId}，且 childId 来自会话而不是路径/请求体', async () => {
    const res = await del(url, `/habits/${HABIT_ID}`, GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { habitId: HABIT_ID })
    assert.equal(port.deletes.length, 1)
    // ★ `operatorRole` 来自会话（家长），不是请求体里能写的东西。
    assert.deepEqual(port.deletes[0], {
      childId: CHILD_ID,
      habitId: HABIT_ID,
      operatorUserId: 'u-dad',
      operatorRole: 'guardian'
    })
  })

  it('重复删除 ⇒ 仍然 200（库层幂等；不会因为"已经删过"变成 404）', async () => {
    const first = await del(url, `/habits/${HABIT_ID}`, GUARDIAN)
    const second = await del(url, `/habits/${HABIT_ID}`, GUARDIAN)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.deepEqual(second.body, { habitId: HABIT_ID })
    assert.equal(port.deletes.length, 2, '两次请求都应到达端口（幂等由库层短路，不写第二条审计）')
  })

  it('带 Idempotency-Key 重放 ⇒ 只有第一次到达端口', async () => {
    const replayPort = makePort()
    const replayApp = await startApp({ port: replayPort, idempotency: makeIdempotencyFake() })
    try {
      const headers = { ...GUARDIAN, 'idempotency-key': 'habit-delete-1' }
      const first = await del(replayApp.url, `/habits/${HABIT_ID}`, headers)
      const second = await del(replayApp.url, `/habits/${HABIT_ID}`, headers)
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      assert.deepEqual(second.body, first.body)
      assert.equal(replayPort.deletes.length, 1, '重放又删了一次 —— 幂等层没生效')
    } finally {
      await replayApp.app.close()
    }
  })
})


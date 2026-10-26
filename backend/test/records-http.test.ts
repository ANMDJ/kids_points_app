/**
 * records-http.test.ts —— 「记一笔」（`POST /records/adjust`）的 **HTTP 集成测试**
 * （W5-B，2026-10-20）
 *
 * 真起 Nest、真发请求；持久化端口与幂等端口都是替身（世界固定为 `hasDatabase: false`）。
 * 要证明的是**路由上的事实**，不是 service 能不能返回对象：
 *   ① 三道屏障真的挂在控制器上（缺身份 401、无成员 403、**孩子 403**）；
 *   ② `childId` / `source` / `balanceAfter` 都不能由请求体指定（集合封闭 ⇒ 400）；
 *   ③ 分值边界（0 / ±1000）、空白标题、超长附注都在 400 被拦，端口零调用；
 *   ④ 幂等只在**带 key** 时生效（不带 key 两次 = 两笔，这是产品语义）；
 *   ⑤ 无库装配时 501（绝不假装"分已经记上了"）。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { ConflictException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
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
import {
  RECORDS_REPOSITORY,
  type AdjustRecordInput,
  type RecordsPort
} from '../src/records/records.repository'
import { RecordsModule } from '../src/records/records.module'
import { RecordsService } from '../src/records/records.service'

// ★ W7-A：同意闸门（第四道屏障）—— 见 test/support/consent-fake.ts
import { CONSENT_REPOSITORY } from '../src/consent/consent.repository'
import { makeGrantedConsentFake } from './support/consent-fake'

const CHILD_ID = 'child-1'
const RECORD_ID = 'rec-adjust-1'

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

/** 与 `toRecordDto()` 期望的行同构；默认是一条 +5 的手动加分。 */
function adjustRow(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: RECORD_ID,
    titleSnapshot: '主动帮妈妈洗碗',
    pointsDelta: 5,
    category: 'adjust',
    source: 'guardian',
    operatorRole: 'guardian',
    note: '',
    habitId: null,
    ruleId: null,
    ruleVersion: null,
    wishId: null,
    reversesRecordId: null,
    reversedAt: null,
    balanceAfter: 129,
    createdAt: new Date('2026-10-20T01:02:03.000Z'),
    ...overrides
  }
}

type PortFake = RecordsPort & {
  adjusts: AdjustRecordInput[]
  adjustError: Error | null
}

function makePort(): PortFake {
  const port: PortFake = {
    adjusts: [],
    adjustError: null,
    async adjust(input) {
      port.adjusts.push(input)
      if (port.adjustError !== null) throw port.adjustError
      return adjustRow({
        titleSnapshot: input.title,
        pointsDelta: input.points,
        note: input.note ?? '',
        source: input.source,
        operatorRole: input.operatorRole,
        balanceAfter: 124 + input.points
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
  options: { port?: RecordsPort; idempotency?: IdempotencyPort } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [RecordsModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())
    // ★ W7-A：第四道屏障（同意闸门）。这些用例测的是本文件自己的关口，
    //   同意状态作为背景条件恒为 granted —— 撤回/重授予的行为见 consent-http.test.ts。
    .overrideProvider(CONSENT_REPOSITORY)
    .useValue(makeGrantedConsentFake())

  if (options.idempotency !== undefined) {
    builder.overrideProvider(IDEMPOTENCY_REPOSITORY).useValue(options.idempotency)
  }
  if (options.port !== undefined) {
    builder.overrideProvider(RECORDS_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}


// ══ 组 A：无库装配 —— 501，绝不假装"分已经记上了" ════════════════════════════
describe('组 A：默认装配（记一笔端口未注入）⇒ 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('POST /records/adjust ⇒ 501 RECORDS_PERSISTENCE_NOT_IMPLEMENTED', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, { title: '洗碗', points: 5 })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'RECORDS_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('带 Idempotency-Key ⇒ 先被幂等端口 501 拦下（无库不假装保护已生效）', async () => {
    const res = await post(
      url,
      '/records/adjust',
      { ...GUARDIAN, 'idempotency-key': 'k-1' },
      { title: '洗碗', points: 5 }
    )
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'IDEMPOTENCY_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：三道屏障 + 入参封闭 ═════════════════════════════════════════════════
describe('组 B：身份 → 成员 → 矩阵；请求体不能指定孩子/来源/余额', () => {
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
    port.adjusts.length = 0
    port.adjustError = null
  })

  it('缺身份头 ⇒ 401 UNAUTHENTICATED，端口零调用', async () => {
    const res = await post(url, '/records/adjust', {}, { title: '洗碗', points: 5 })
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'UNAUTHENTICATED')
    assert.equal(port.adjusts.length, 0)
  })

  it('会话不存在 ⇒ 401 SESSION_NOT_FOUND，端口零调用', async () => {
    const res = await post(url, '/records/adjust', identity(DEV_STRANGER), {
      title: '洗碗',
      points: 5
    })
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'SESSION_NOT_FOUND')
    assert.equal(port.adjusts.length, 0)
  })

  it('viewer 没有成员位 ⇒ 403，端口零调用（屏障一）', async () => {
    const res = await post(url, '/records/adjust', VIEWER, { title: '洗碗', points: 5 })
    assert.equal(res.status, 403)
    assert.equal(port.adjusts.length, 0)
  })

  it('★ child 记一笔 ⇒ 403（矩阵 adjust_points = DENY），端口零调用', async () => {
    const res = await post(url, '/records/adjust', CHILD, { title: '我自己加分', points: 5 })
    assert.equal(res.status, 403)
    assert.equal(port.adjusts.length, 0)
  })

  it('多传 childId ⇒ 400（不是静默忽略后给请求体里的孩子加分）', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, {
      title: '洗碗',
      points: 5,
      childId: 'someone-elses-child'
    })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })

  it('多传 source ⇒ 400（来源只能由会话角色派生）', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, {
      title: '洗碗',
      points: 5,
      source: 'child_self'
    })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })

  it('多传 balanceAfter ⇒ 400（余额由账本内核算，客户端说了不算）', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, {
      title: '洗碗',
      points: 5,
      balanceAfter: 9999
    })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })
})


// ══ 组 C：字段级判据（400）—— 一条都不能漏到内核 ═════════════════════════════
describe('组 C：分值 / 标题 / 附注的边界', () => {
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
    port.adjusts.length = 0
  })

  it('points = 0 ⇒ 400（0 没有语义：流水无法解释）', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, { title: '洗碗', points: 0 })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })

  it('points = 1000 ⇒ 400（与两端 PointsStepper 的 max=999 同口径）', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, { title: '洗碗', points: 1000 })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })

  it('points = -1000 ⇒ 400', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, { title: '洗碗', points: -1000 })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })

  it('points 为小数 ⇒ 400', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, { title: '洗碗', points: 1.5 })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })

  it('标题只有空白 ⇒ 400（而不是让内核 500 MISSING_TITLE_SNAPSHOT）', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, { title: '   ', points: 5 })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })

  it('标题超过 120 字 ⇒ 400', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, {
      title: '好'.repeat(121),
      points: 5
    })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })

  it('附注超过 200 字 ⇒ 400', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, {
      title: '洗碗',
      points: 5,
      note: '嗯'.repeat(201)
    })
    assert.equal(res.status, 400)
    assert.equal(port.adjusts.length, 0)
  })
})


// ══ 组 D：成功路径 + 业务拒绝 + 幂等 ═════════════════════════════════════════
describe('组 D：201 回包 / 409 透传 / 幂等三态', () => {
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
    port.adjusts.length = 0
    port.adjustError = null
  })

  it('201：record 与 GET /records 的行同构，executedRecordId = record.id', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, {
      title: '  主动帮妈妈洗碗  ',
      points: 5,
      note: '  今天特别主动  '
    })
    assert.equal(res.status, 201)
    const record = res.body.record as Record<string, unknown>
    assert.equal(record.id, RECORD_ID)
    assert.equal(record.category, 'adjust')
    assert.equal(record.points, 5)
    assert.equal(record.balanceAfter, 129)
    assert.equal(record.source, 'guardian')
    assert.equal(record.operatorRole, 'guardian')
    // 标题 / 附注落库前 trim 过：不留首尾空白
    assert.equal(record.title, '主动帮妈妈洗碗')
    assert.equal(record.note, '今天特别主动')
    assert.equal(res.body.executedRecordId, RECORD_ID)

    // 端口拿到的是**会话**结论，不是请求体
    assert.equal(port.adjusts.length, 1)
    const input = port.adjusts[0]
    assert.equal(input.childId, CHILD_ID)
    assert.equal(input.operatorUserId, 'u-dad')
    assert.equal(input.operatorRole, 'guardian')
    assert.equal(input.source, 'guardian')
    assert.equal(input.points, 5)
    assert.equal(input.idempotencyKey, undefined)
  })

  it('负分原样落库（-7 就是扣 7 分，不取反、不取绝对值）', async () => {
    const res = await post(url, '/records/adjust', GUARDIAN, { title: '顶嘴', points: -7 })
    assert.equal(res.status, 201)
    const record = res.body.record as Record<string, unknown>
    assert.equal(record.points, -7)
    assert.equal(port.adjusts[0].points, -7)
  })

  it('409 INSUFFICIENT_POINTS 原样透传（余额不会被扣成负数）', async () => {
    port.adjustError = new ConflictException({
      code: 'INSUFFICIENT_POINTS',
      message: '余额不足'
    })
    const res = await post(url, '/records/adjust', GUARDIAN, { title: '扣光', points: -999 })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'INSUFFICIENT_POINTS')
  })

  it('同一 Idempotency-Key 重放 ⇒ 回到首次响应，端口只被调用一次', async () => {
    const headers = { ...GUARDIAN, 'idempotency-key': 'adjust-1' }
    const body = { title: '洗碗', points: 5 }

    const first = await post(url, '/records/adjust', headers, body)
    assert.equal(first.status, 201)
    const callsAfterFirst = port.adjusts.length
    assert.equal(port.adjusts[0].idempotencyKey, 'adjust-1')
    assert.equal(idempotency.begins[0].actionType, 'adjust_points')

    const second = await post(url, '/records/adjust', headers, body)
    assert.equal(second.status, 201)
    assert.deepEqual(second.body, first.body)
    assert.equal(port.adjusts.length, callsAfterFirst, '重放不得再调用业务端口')
  })

  it('同一 key 换成不同请求体 ⇒ 409（不会把上一笔结果冒充这一次）', async () => {
    const headers = { ...GUARDIAN, 'idempotency-key': 'adjust-2' }
    const first = await post(url, '/records/adjust', headers, { title: '洗碗', points: 5 })
    assert.equal(first.status, 201)

    const second = await post(url, '/records/adjust', headers, { title: '洗碗', points: 6 })
    assert.equal(second.status, 409)
  })
})

// ══ 组 E：绕过 HTTP 直接调用 service —— 权限断言不能只在 Guard 里 ═════════════
describe('组 E：service 直调（无 Guard 场景）仍然拒绝孩子记分', () => {
  it('child ⇒ 403 ACTION_NOT_ALLOWED，端口零调用', async () => {
    const port = makePort()
    const service = new RecordsService(port)
    await assert.rejects(
      () =>
        service.adjust(
          CHILD_ID,
          { title: '我自己加分', points: 5 },
          { userId: 'u-kid', role: 'child' }
        ),
      (err: unknown) => {
        const http = err as { getStatus?: () => number; getResponse?: () => unknown }
        assert.equal(http.getStatus?.(), 403)
        const body = http.getResponse?.() as { code?: string }
        assert.equal(body.code, 'ACTION_NOT_ALLOWED')
        return true
      }
    )
    assert.equal(port.adjusts.length, 0)
  })
})


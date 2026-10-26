/**
 * wishes-http.test.ts —— 心愿写入口的 **HTTP 集成测试**（W5-B，2026-10-20）
 *
 * 真起 Nest、真发请求；持久化与幂等端口都是替身（世界固定 `hasDatabase: false`）。
 * 要证明的是**路由上的事实**：
 *   ① 三个 Guard 真的挂在控制器上（缺身份 401 / child、viewer 403）；
 *   ② 孩子 `add_wish` **不会静默成功** —— 矩阵 REQUIRE_APPROVAL ⇒ `403 APPROVAL_REQUIRED`，
 *      且端口**一次都没被调用**（「没有落库」必须与「界面上加了」区分开）；
 *   ③ `childId` / `coverStyle` / `redeemed` 来自会话与库层，请求体多传 ⇒ 400；
 *   ④ 校验与规范化在 service 唯一一处（标题 trim、全空白拒、emoji 缺省 `🎁`）；
 *   ⑤ 两条端点都支持 `Idempotency-Key`；无库装配时一律 501。
 *
 * ★ 这里**不**证明「配色真的按空档落库」「审计真的写了」——那需要真 Postgres，
 *   属于 `wishes-prisma` 集成用例的范围；替身只能证明控制器把正确的输入交给了端口。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { NotFoundException, type INestApplication } from '@nestjs/common'
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
import type { WishRow } from '../src/read/read.repository'
import { WishesModule } from '../src/wishes/wishes.module'
import {
  WISHES_REPOSITORY,
  type CreateWishInput,
  type DeleteWishInput,
  type WishesPort
} from '../src/wishes/wishes.repository'

// ★ W7-A：同意闸门（第四道屏障）—— 见 test/support/consent-fake.ts
import { CONSENT_REPOSITORY } from '../src/consent/consent.repository'
import { makeGrantedConsentFake } from './support/consent-fake'

const CHILD_ID = 'child-1'
const WISH_ID = 'wish-1'
const DEV_DAD = 'dev-dad'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'

function identity(deviceId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': CHILD_ID }
}

const GUARDIAN = identity(DEV_DAD)
const CHILD = identity(DEV_KID)
const VIEWER = identity(DEV_GUEST)

function makeSessionFake(): DeviceSessionPort {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
  const rows: SessionLookupRow[] = [
    { deviceId: DEV_DAD, childId: CHILD_ID, userId: 'u-dad', activeRole: 'guardian', expiresAt },
    { deviceId: DEV_KID, childId: CHILD_ID, userId: 'u-kid', activeRole: 'child', expiresAt },
    { deviceId: DEV_GUEST, childId: CHILD_ID, userId: 'u-guest', activeRole: 'viewer', expiresAt }
  ]
  return {
    async findSession(deviceId, childId) {
      return rows.find((row) => row.deviceId === deviceId && row.childId === childId) ?? null
    }
  }
}

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


function wishRow(overrides: Partial<WishRow> = {}): WishRow {
  return {
    id: WISH_ID,
    title: '去游乐园',
    cost: 120,
    emoji: '🎡',
    // 端口返回 B：证明控制器**不**自己算配色，而是原样下发库层的决定（03 E16）。
    coverStyle: 'B',
    redeemed: false,
    ...overrides
  }
}

const VALID_CREATE = { title: '  去游乐园  ', cost: 120, emoji: '🎡' }

type PortFake = WishesPort & {
  creates: CreateWishInput[]
  deletes: DeleteWishInput[]
  createError: Error | null
  deleteError: Error | null
}

function makePort(): PortFake {
  const port: PortFake = {
    creates: [],
    deletes: [],
    createError: null,
    deleteError: null,
    async createWish(input) {
      port.creates.push(input)
      if (port.createError !== null) throw port.createError
      return wishRow({ title: input.title, cost: input.cost, emoji: input.emoji })
    },
    async deleteWish(input) {
      port.deletes.push(input)
      if (port.deleteError !== null) throw port.deleteError
      return input.wishId
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

async function request(
  baseUrl: string,
  method: 'POST' | 'DELETE',
  path: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
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
  options: { port?: WishesPort; idempotency?: IdempotencyPort } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [WishesModule.register({ hasDatabase: false })]
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
    builder.overrideProvider(WISHES_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 501，绝不假装心愿已保存 ═══════════════════════════════════
describe('组 A：默认装配（心愿端口未注入）⇒ 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('POST /wishes ⇒ 501 WISHES_PERSISTENCE_NOT_IMPLEMENTED', async () => {
    const res = await request(url, 'POST', '/wishes', GUARDIAN, VALID_CREATE)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'WISHES_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('DELETE /wishes/:id ⇒ 501（不会假装进了回收站）', async () => {
    const res = await request(url, 'DELETE', `/wishes/${WISH_ID}`, GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'WISHES_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('带 Idempotency-Key ⇒ 先被幂等端口 501 拦下（无库不假装保护已生效）', async () => {
    const res = await request(
      url,
      'POST',
      '/wishes',
      { ...GUARDIAN, 'idempotency-key': 'wish-create-1' },
      VALID_CREATE
    )
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'IDEMPOTENCY_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：三道屏障 —— 身份 / 成员 / 权限（顺序不能反）══════════════════════════
describe('组 B：身份与权限', () => {
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
    port.creates.length = 0
    port.deletes.length = 0
  })

  it('缺设备头 ⇒ 401（身份解析没跑，根本到不了控制器）', async () => {
    const res = await request(url, 'POST', '/wishes', {}, VALID_CREATE)
    assert.equal(res.status, 401)
    assert.equal(port.creates.length, 0)
  })

  it('孩子新增心愿 ⇒ 403 APPROVAL_REQUIRED，且端口一次都没被调用', async () => {
    // 矩阵 `add_wish`.child = REQUIRE_APPROVAL：端点没声明「会把请求转成审批」，
    // 所以 Guard 必须拒绝 —— 若这里放行，孩子就绕过了家长确认（02 §3）。
    const res = await request(url, 'POST', '/wishes', CHILD, VALID_CREATE)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'APPROVAL_REQUIRED')
    assert.equal(port.creates.length, 0, '孩子的心愿被直接落库了 —— 审批屏障失效')
  })

  it('孩子删除心愿 ⇒ 403 FORBIDDEN（矩阵 delete_wish child DENY）', async () => {
    const res = await request(url, 'DELETE', `/wishes/${WISH_ID}`, CHILD)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.deletes.length, 0)
  })

  it('viewer ⇒ 403（矩阵只认 guardian / child，viewer 一律 DENY）', async () => {
    const res = await request(url, 'POST', '/wishes', VIEWER, VALID_CREATE)
    assert.equal(res.status, 403)
    assert.equal(port.creates.length, 0)
  })

  it('家长新增心愿 ⇒ 201，且操作人 / 孩子都来自会话', async () => {
    const res = await request(url, 'POST', '/wishes', GUARDIAN, VALID_CREATE)
    assert.equal(res.status, 201)
    assert.equal(port.creates.length, 1)
    assert.equal(port.creates[0].childId, CHILD_ID)
    assert.equal(port.creates[0].operatorUserId, 'u-dad')
    assert.equal(port.creates[0].operatorRole, 'guardian')
  })

  it('家长删除心愿 ⇒ 200 { wishId }（软删，幂等由仓储兑现）', async () => {
    const res = await request(url, 'DELETE', `/wishes/${WISH_ID}`, GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { wishId: WISH_ID })
    assert.equal(port.deletes.length, 1)
    assert.equal(port.deletes[0].wishId, WISH_ID)
    assert.equal(port.deletes[0].operatorUserId, 'u-dad')
  })
})


// ══ 组 C：请求形状 —— 集合封闭 + 规范化 + 回包同构 ═════════════════════════════
describe('组 C：请求形状与规范化', () => {
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
    port.creates.length = 0
  })

  it('请求体带 childId ⇒ 400（孩子只能来自会话）', async () => {
    const res = await request(url, 'POST', '/wishes', GUARDIAN, {
      ...VALID_CREATE,
      childId: 'child-2'
    })
    assert.equal(res.status, 400)
    assert.equal(port.creates.length, 0)
  })

  it('请求体带 coverStyle ⇒ 400（配色由服务端算，客户端说了不算 —— 03 E16）', async () => {
    const res = await request(url, 'POST', '/wishes', GUARDIAN, {
      ...VALID_CREATE,
      coverStyle: 'C'
    })
    assert.equal(res.status, 400)
    assert.equal(port.creates.length, 0)
  })

  it('请求体带 redeemed ⇒ 400（兑换是审批的事，不是新增的参数）', async () => {
    const res = await request(url, 'POST', '/wishes', GUARDIAN, {
      ...VALID_CREATE,
      redeemed: true
    })
    assert.equal(res.status, 400)
    assert.equal(port.creates.length, 0)
  })

  it('cost=0 / 1.5 / 100001 ⇒ 400（必须是 1..100000 的整数）', async () => {
    for (const cost of [0, 1.5, 100_001]) {
      const res = await request(url, 'POST', '/wishes', GUARDIAN, { ...VALID_CREATE, cost })
      assert.equal(res.status, 400, `cost=${cost} 竟然被接受`)
    }
    assert.equal(port.creates.length, 0)
  })

  it('标题全空白 ⇒ 400 WISH_TITLE_REQUIRED（MinLength 拦不住空格）', async () => {
    const res = await request(url, 'POST', '/wishes', GUARDIAN, {
      ...VALID_CREATE,
      title: '   '
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'WISH_TITLE_REQUIRED')
    assert.equal(port.creates.length, 0)
  })

  it('标题 trim；emoji 缺省 ⇒ 🎁', async () => {
    const res = await request(url, 'POST', '/wishes', GUARDIAN, {
      title: '  去游乐园  ',
      cost: 120
    })
    assert.equal(res.status, 201)
    assert.equal(port.creates[0].title, '去游乐园')
    assert.equal(port.creates[0].emoji, '🎁')
  })

  it('回包与 GET /home 的 wishes[] 同构：端口给的 coverStyle 原样下发', async () => {
    const res = await request(url, 'POST', '/wishes', GUARDIAN, VALID_CREATE)
    assert.equal(res.status, 201)
    assert.deepEqual(res.body, {
      id: WISH_ID,
      title: '去游乐园',
      cost: 120,
      emoji: '🎡',
      coverStyle: 'B',
      redeemed: false
    })
  })

  it('端口抛 404 ⇒ 原样透传（跨孩子 / 已删除不伪装成 200）', async () => {
    port.deleteError = new NotFoundException({
      code: 'WISH_NOT_FOUND',
      message: '不存在'
    })
    const res = await request(url, 'DELETE', '/wishes/wish-other', GUARDIAN)
    port.deleteError = null
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'WISH_NOT_FOUND')
  })
})


// ══ 组 D：幂等 —— 双击「保存心愿」不该建出两个心愿 ═════════════════════════════
describe('组 D：Idempotency-Key', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = makePort()
    ;({ app, url } = await startApp({ port, idempotency: makeIdempotencyFake() }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.creates.length = 0
    port.deletes.length = 0
  })

  it('同一个键重复 POST ⇒ 端口只被调一次，第二次重放同一份 201 回包', async () => {
    const headers = { ...GUARDIAN, 'idempotency-key': 'wish-create-1' }
    const first = await request(url, 'POST', '/wishes', headers, VALID_CREATE)
    const second = await request(url, 'POST', '/wishes', headers, VALID_CREATE)
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.deepEqual(second.body, first.body)
    assert.equal(port.creates.length, 1, '重放也调用了端口 —— 会建出第二个心愿')
  })

  it('幂等哈希按 (POST, /wishes, body) 计算 —— 换内容同键 ⇒ 409（不静默覆盖）', async () => {
    const headers = { ...GUARDIAN, 'idempotency-key': 'wish-create-2' }
    await request(url, 'POST', '/wishes', headers, VALID_CREATE)
    const conflict = await request(url, 'POST', '/wishes', headers, {
      ...VALID_CREATE,
      cost: 999
    })
    assert.equal(conflict.status, 409)
  })

  it('DELETE 同键重放 ⇒ 端口只被调一次，回包仍是 200 { wishId }', async () => {
    const headers = { ...GUARDIAN, 'idempotency-key': 'wish-delete-1' }
    const first = await request(url, 'DELETE', `/wishes/${WISH_ID}`, headers)
    const second = await request(url, 'DELETE', `/wishes/${WISH_ID}`, headers)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.deepEqual(second.body, { wishId: WISH_ID })
    assert.equal(port.deletes.length, 1)
  })
})


/**
 * device-tokens-http.test.ts —— `POST /device-tokens` / `POST /device-tokens/revoke`
 * 的 **HTTP 集成测试**（W6-A，2026-10-24）
 *
 * 真起 Nest、真发请求；会话 / 成员位 / token 端口都是替身（世界固定 `hasDatabase: false`）。
 * 要证明的是**路由上的事实**：
 *   ① 无库装配时两条路由都 501 —— 不假装登记成功，也不返回空列表；
 *   ② 两条路由都走三道屏障：缺身份 401、viewer 无成员位 403、且**端口零调用**；
 *   ③ ★ 孩子也能登记（`manage_device_tokens` 两侧 ALLOW）—— 孩子的设备收不到推送
 *      才是缺陷；
 *   ④ 响应里**没有 `token`**（它是可直接用来推送的凭据）；
 *   ⑤ 归属冲突 409 / 不是我的 404，机器码可断言；
 *   ⑥ 请求体集合封闭：多传 `userId` / `childId` / `active` ⇒ 400 且端口零调用；
 *   ⑦ `token` 不在 URL 里：`/device-tokens/<token>` 根本没有这条路由。
 *
 * ★ 这里**不**证明唯一约束与 LRU 淘汰 —— 那需要真 Postgres：
 *   `test-db/device-tokens-db.dbtest.ts`。替身只能证明路由**问对了问题**。
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
import { DeviceTokensHttpModule } from '../src/device-tokens/device-tokens-http.module'
import {
  DEVICE_TOKENS_REPOSITORY,
  type DeviceTokensPort
} from '../src/device-tokens/device-tokens.repository'
import type {
  ActivePushToken,
  RegisterDeviceTokenInput,
  RegisterDeviceTokenResult,
  RevokeDeviceTokenResult
} from '../src/device-tokens/device-tokens.types'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import {
  MEMBERSHIP_REPOSITORY,
  type MembershipPort
} from '../src/membership/membership.repository'

const CHILD_ID = 'child-1'
const DEV_DAD = 'dev-dad'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'

const TOKEN = 'ios-token-abcdef'

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

/** `u-guest` 刻意没有成员位（屏障一必须拦住 viewer）。 */
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

const LAST_SEEN_AT = new Date('2026-10-24T02:00:00.000Z')
const CREATED_AT = new Date('2026-10-20T01:00:00.000Z')

/** 端口替身：记下每次调用的入参，并允许注入要回的结果。 */
class PortFake implements DeviceTokensPort {
  readonly registers: RegisterDeviceTokenInput[] = []
  readonly revokes: { userId: string; token: string }[] = []

  registerResult: RegisterDeviceTokenResult | null = null
  revokeResult: RevokeDeviceTokenResult | null = null

  reset(): void {
    this.registers.length = 0
    this.revokes.length = 0
    this.registerResult = {
      kind: 'ok',
      created: true,
      row: {
        id: 'tok-1',
        platform: 'ios',
        active: true,
        lastSeenAt: LAST_SEEN_AT,
        createdAt: CREATED_AT,
        revokedAt: null
      }
    }
    this.revokeResult = {
      kind: 'ok',
      row: {
        id: 'tok-1',
        platform: 'ios',
        active: false,
        lastSeenAt: LAST_SEEN_AT,
        createdAt: CREATED_AT,
        revokedAt: LAST_SEEN_AT
      }
    }
  }

  async register(input: RegisterDeviceTokenInput): Promise<RegisterDeviceTokenResult> {
    this.registers.push(input)
    if (this.registerResult === null) throw new Error('测试没设置 registerResult')
    return this.registerResult
  }

  async revoke(input: { userId: string; token: string }): Promise<RevokeDeviceTokenResult> {
    this.revokes.push(input)
    if (this.revokeResult === null) throw new Error('测试没设置 revokeResult')
    return this.revokeResult
  }

  async listActiveForUser(_userId: string): Promise<ActivePushToken[]> {
    throw new Error('HTTP 路径不应该读 token 列表')
  }

  async deactivateTokens(_tokens: string[]): Promise<number> {
    throw new Error('HTTP 路径不应该改 token 状态')
  }
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  payload?: unknown
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headers,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
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
  options: { port?: PortFake } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [DeviceTokensHttpModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (options.port !== undefined) {
    builder.overrideProvider(DEVICE_TOKENS_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 两条路由全 501 ═════════════════════════════════════════
describe('组 A：默认装配（token 端口未注入）⇒ 两条路由全 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('POST /device-tokens ⇒ 501（不假装登记成功）', async () => {
    const res = await request(url, 'POST', '/device-tokens', GUARDIAN, {
      platform: 'ios',
      token: TOKEN
    })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'DEVICE_TOKENS_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('POST /device-tokens/revoke ⇒ 501（不假装注销成功）', async () => {
    const res = await request(url, 'POST', '/device-tokens/revoke', GUARDIAN, { token: TOKEN })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'DEVICE_TOKENS_PERSISTENCE_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：成功路径、响应形状、冲突码 ═════════════════════════════════════════
describe('组 B：登记 / 注销的成功路径', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = new PortFake()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.reset()
  })

  it('家长登记 ⇒ 200；userId / childId 都来自会话，响应里没有 token', async () => {
    const res = await request(url, 'POST', '/device-tokens', GUARDIAN, {
      platform: 'ios',
      token: TOKEN
    })

    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      id: 'tok-1',
      platform: 'ios',
      active: true,
      lastSeenAt: '2026-10-24T02:00:00.000Z',
      createdAt: '2026-10-20T01:00:00.000Z',
      revokedAt: null
    })
    assert.equal('token' in res.body, false, '响应里回显了 token')
    assert.equal(port.registers[0].userId, 'u-dad')
    assert.equal(port.registers[0].childId, CHILD_ID)
  })

  it('★ 孩子也能登记（矩阵 child ALLOW）—— 孩子的设备收不到推送才是缺陷', async () => {
    const res = await request(url, 'POST', '/device-tokens', CHILD, {
      platform: 'weapp',
      token: 'weapp-token-xyz'
    })
    assert.equal(res.status, 200)
    assert.equal(port.registers[0].userId, 'u-kid')
    assert.equal(port.registers[0].platform, 'weapp')
  })

  it('重复上报同一 token ⇒ 仍 200、同一 id（构造幂等，不返回 201 假话）', async () => {
    const first = await request(url, 'POST', '/device-tokens', GUARDIAN, {
      platform: 'ios',
      token: TOKEN
    })
    const second = await request(url, 'POST', '/device-tokens', GUARDIAN, {
      platform: 'ios',
      token: TOKEN
    })

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(second.body.id, first.body.id)
    assert.equal(port.registers.length, 2, '第二次上报被路由拦掉了 —— 刷新 lastSeenAt 就不会发生')
    // 本阶段**不下发** `created`（客户端不需要区分新登记 / 只是刷新）。
    assert.equal('created' in second.body, false)
  })

  it('token 属于别的账号 ⇒ 409 DEVICE_TOKEN_OWNED_BY_OTHER（不让后一次注册悄悄接管）', async () => {
    port.registerResult = { kind: 'owned_by_other' }
    const res = await request(url, 'POST', '/device-tokens', CHILD, {
      platform: 'ios',
      token: TOKEN
    })

    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'DEVICE_TOKEN_OWNED_BY_OTHER')
    assert.equal('token' in res.body, false, '冲突响应里带回了 token')
  })

  it('注销 ⇒ 200 + active:false；userId 来自会话，且不需要 childId', async () => {
    const res = await request(url, 'POST', '/device-tokens/revoke', CHILD, { token: TOKEN })

    assert.equal(res.status, 200)
    assert.equal(res.body.active, false)
    assert.equal(res.body.revokedAt, '2026-10-24T02:00:00.000Z')
    assert.deepEqual(port.revokes, [{ userId: 'u-kid', token: TOKEN }])
  })

  it('注销不是我的 ⇒ 404 DEVICE_TOKEN_NOT_FOUND（不是我的 = 不存在，不给探测口）', async () => {
    port.revokeResult = { kind: 'not_found' }
    const res = await request(url, 'POST', '/device-tokens/revoke', CHILD, { token: TOKEN })

    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'DEVICE_TOKEN_NOT_FOUND')
  })
})

// ══ 组 C：请求体封闭（校验先于端口，零调用）══════════════════════════════════
describe('组 C：请求体集合封闭', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = new PortFake()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.reset()
  })

  it('缺 token ⇒ 400，端口零调用', async () => {
    const res = await request(url, 'POST', '/device-tokens', GUARDIAN, { platform: 'ios' })
    assert.equal(res.status, 400)
    assert.equal(port.registers.length, 0)
  })

  it('token 太短（< 8）⇒ 400（必是伪造 / 传错）', async () => {
    const res = await request(url, 'POST', '/device-tokens', GUARDIAN, {
      platform: 'ios',
      token: 'short'
    })
    assert.equal(res.status, 400)
    assert.equal(port.registers.length, 0)
  })

  it('token 含空白字符 ⇒ 400（不替客户端 trim 后再存 —— 那会把两种值混成一个）', async () => {
    const res = await request(url, 'POST', '/device-tokens', GUARDIAN, {
      platform: 'ios',
      token: 'ios token abcdef'
    })
    assert.equal(res.status, 400)
    assert.equal(port.registers.length, 0)
  })

  it('platform 不在 weapp / ios / android ⇒ 400（枚举写错不该等到写库才 500）', async () => {
    const res = await request(url, 'POST', '/device-tokens', GUARDIAN, {
      platform: 'windows',
      token: TOKEN
    })
    assert.equal(res.status, 400)
    assert.equal(port.registers.length, 0)
  })

  it('多传 userId ⇒ 400（客户端不许声明自己是谁）', async () => {
    const res = await request(url, 'POST', '/device-tokens', GUARDIAN, {
      platform: 'ios',
      token: TOKEN,
      userId: 'u-someone-else'
    })
    assert.equal(res.status, 400)
    assert.equal(port.registers.length, 0)
  })

  it('多传 childId / active ⇒ 400（同一条封闭规则）', async () => {
    for (const extra of [{ childId: 'child-2' }, { active: false }, { id: 'tok-9' }]) {
      const res = await request(url, 'POST', '/device-tokens', GUARDIAN, {
        platform: 'ios',
        token: TOKEN,
        ...extra
      })
      assert.equal(res.status, 400, `多传 ${Object.keys(extra)[0]} 被接受了`)
      assert.equal(port.registers.length, 0)
    }
  })

  it('注销缺 token ⇒ 400', async () => {
    const res = await request(url, 'POST', '/device-tokens/revoke', GUARDIAN, {})
    assert.equal(res.status, 400)
    assert.equal(port.revokes.length, 0)
  })

  it('token 不在 URL 里：GET /device-tokens/<token> ⇒ 404（根本没有这条路由）', async () => {
    // 若哪天有人「顺手」加了 `DELETE /device-tokens/:token`，token 就会进 access log。
    const res = await request(url, 'GET', `/device-tokens/${TOKEN}`, GUARDIAN)
    assert.equal(res.status, 404)
  })
})

// ══ 组 D：三道屏障 ═══════════════════════════════════════════════════════════
describe('组 D：三道屏障（端口零调用）', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = new PortFake()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.reset()
  })

  it('缺身份头 ⇒ 401（登记）', async () => {
    const res = await request(url, 'POST', '/device-tokens', {}, { platform: 'ios', token: TOKEN })
    assert.equal(res.status, 401)
    assert.equal(port.registers.length, 0)
  })

  it('viewer 没有成员位 ⇒ 403 MEMBER_NOT_FOUND（登记）', async () => {
    const res = await request(url, 'POST', '/device-tokens', VIEWER, {
      platform: 'ios',
      token: TOKEN
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'MEMBER_NOT_FOUND')
    assert.equal(port.registers.length, 0)
  })

  it('缺身份头 ⇒ 401（注销）', async () => {
    const res = await request(url, 'POST', '/device-tokens/revoke', {}, { token: TOKEN })
    assert.equal(res.status, 401)
    assert.equal(port.revokes.length, 0)
  })

  it('viewer 没有成员位 ⇒ 403（注销，屏障一同样先跑）', async () => {
    const res = await request(url, 'POST', '/device-tokens/revoke', VIEWER, { token: TOKEN })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'MEMBER_NOT_FOUND')
    assert.equal(port.revokes.length, 0)
  })
})


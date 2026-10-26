/**
 * invites-http.test.ts —— 邀请码四条路由的 **HTTP 集成测试**（W5-G，2026-10-22）
 *
 * 真起 Nest、真发请求；会话 / 成员 / 邀请码三个端口都是替身
 * （世界固定 `hasDatabase: false`）。要证明的是**路由上的事实**：
 *   ① 无库装配时四条路由全 501 —— 不返回空列表冒充「还没有邀请码」，
 *      也不假装加入成功；
 *   ② 管理侧（生成 / 列表 / 吊销）真的走三道屏障：缺身份 401、viewer 无成员位 403、
 *      孩子（`invite_member` child DENY）403 **且端口零调用**；
 *   ③ `POST /invites/accept` **只**有身份屏障 —— 被邀请人按定义还不是成员，
 *      「先有成员位」会让这条路由对真正的被邀请人永远 403。这里钉住这个
 *      **刻意的不对称**，免得将来有人「顺手补上屏障一」把它变成死路；
 *   ④ `childId` 来自会话（请求体多传 `childId` ⇒ 400，不是被静默忽略）；
 *   ⑤ 码在**服务层**被规范化（`abcd-2345` ⇒ `ABCD2345`），形状不合法 ⇒ 400
 *      `INVITE_CODE_MALFORMED`（端口零调用），而端口抛的 409 / 404 原样透出；
 *   ⑥ 次数与有效期由服务端算：客户端只能给 `maxUses` / `expiresInDays`。
 *
 * ★ 这里**不**证明「并发下不超发」「占位失败会回滚名额」—— 那需要真 Postgres
 *   （`test-db/invites-db.dbtest.ts` 组 C）。替身端口只能证明路由**问对了问题**。
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
import {
  INVITES_REPOSITORY,
  type AcceptInviteInput,
  type AcceptedInviteRow,
  type CreateInviteInput,
  type InvitesPort,
  type RevokeInviteInput
} from '../src/invites/invites.repository'
import type {
  InviteRevokeResponse,
  InviteRow
} from '../src/invites/invites.types'
import { InvitesModule } from '../src/invites/invites.module'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import {
  MEMBERSHIP_REPOSITORY,
  type MembershipPort
} from '../src/membership/membership.repository'

// ★ W7-A：同意闸门（第四道屏障）—— 见 test/support/consent-fake.ts
import { CONSENT_REPOSITORY } from '../src/consent/consent.repository'
import { makeGrantedConsentFake } from './support/consent-fake'

const CHILD_ID = 'child-1'
const INVITE_ID = 'invite-1'

const DEV_DAD = 'dev-dad'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'

function identity(deviceId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': CHILD_ID }
}

const GUARDIAN = identity(DEV_DAD)
const CHILD = identity(DEV_KID)
const VIEWER = identity(DEV_GUEST)

/** 一个形状合法的码（字符都在 31 字符表里）。 */
const VALID_CODE = 'ABCD2345'

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

/** 固定时刻的端口行：ISO 断言才有确定值（`Date` 序列化相同 ≠ 契约要求显式转换）。 */
const CREATED_AT = new Date('2026-10-22T01:00:00.000Z')
const EXPIRES_AT = new Date('2026-10-29T01:00:00.000Z')

/** 邀请码端口替身：记录**每次调用收到的入参**，并允许注入要抛的错。 */
class PortFake implements InvitesPort {
  readonly creates: CreateInviteInput[] = []
  readonly lists: string[] = []
  readonly revokes: RevokeInviteInput[] = []
  readonly accepts: AcceptInviteInput[] = []

  createError: Error | null = null
  listError: Error | null = null
  revokeError: Error | null = null
  acceptError: Error | null = null

  reset(): void {
    this.creates.length = 0
    this.lists.length = 0
    this.revokes.length = 0
    this.accepts.length = 0
    this.createError = null
    this.listError = null
    this.revokeError = null
    this.acceptError = null
  }

  async createInvite(input: CreateInviteInput): Promise<InviteRow> {
    this.creates.push(input)
    if (this.createError !== null) throw this.createError
    return {
      id: INVITE_ID,
      childId: input.childId,
      code: VALID_CODE,
      role: input.role,
      maxUses: input.maxUses,
      usedCount: 0,
      // 回显服务层算出来的绝对时刻：断言「天 → 毫秒」换算真的发生在服务层。
      expiresAt: input.expiresAt,
      revoked: false,
      createdAt: CREATED_AT
    }
  }

  async listInvites(childId: string): Promise<InviteRow[]> {
    this.lists.push(childId)
    if (this.listError !== null) throw this.listError
    return [
      {
        id: INVITE_ID,
        childId,
        code: VALID_CODE,
        role: 'guardian',
        maxUses: 3,
        usedCount: 1,
        expiresAt: EXPIRES_AT,
        revoked: false,
        createdAt: CREATED_AT
      }
    ]
  }

  async revokeInvite(input: RevokeInviteInput): Promise<InviteRevokeResponse> {
    this.revokes.push(input)
    if (this.revokeError !== null) throw this.revokeError
    return { id: input.inviteId, revoked: true }
  }

  async acceptInvite(input: AcceptInviteInput): Promise<AcceptedInviteRow> {
    this.accepts.push(input)
    if (this.acceptError !== null) throw this.acceptError
    // 回显会话到期时刻：线格式必须是 ISO 串（服务层负责转换）。
    return { childId: CHILD_ID, role: 'guardian', sessionExpiresAt: input.sessionExpiresAt }
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
    imports: [InvitesModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())
    // ★ W7-A：第四道屏障（同意闸门）。这些用例测的是本文件自己的关口，
    //   同意状态作为背景条件恒为 granted —— 撤回/重授予的行为见 consent-http.test.ts。
    .overrideProvider(CONSENT_REPOSITORY)
    .useValue(makeGrantedConsentFake())

  if (options.port !== undefined) {
    builder.overrideProvider(INVITES_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

const NEW_INVITE = { role: 'guardian', maxUses: 3, expiresInDays: 7 }

// ══ 组 A：无库装配 —— 四条路由全 501（不假装成功）════════════════════════════
describe('组 A：默认装配（邀请码端口未注入）⇒ 四条路由全 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('POST /invites ⇒ 501（不返回一个"看起来能用"的码）', async () => {
    const res = await request(url, 'POST', '/invites', GUARDIAN, NEW_INVITE)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'INVITES_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('GET /invites ⇒ 501（空列表会被误读成"这个孩子还没有邀请码"）', async () => {
    const res = await request(url, 'GET', '/invites', GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'INVITES_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('POST /invites/:id/revoke ⇒ 501', async () => {
    const res = await request(url, 'POST', `/invites/${INVITE_ID}/revoke`, GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'INVITES_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('POST /invites/accept ⇒ 501（成员位与会话都没落库，绝不回 200）', async () => {
    const res = await request(url, 'POST', '/invites/accept', GUARDIAN, { code: VALID_CODE })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'INVITES_PERSISTENCE_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：屏障 —— 管理侧三道，加入侧只有身份 ══════════════════════════════════
describe('组 B：管理侧三道屏障 / 加入侧只有身份屏障', () => {
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

  it('缺身份头 ⇒ 401，端口零调用', async () => {
    const res = await request(url, 'GET', '/invites', {})
    assert.equal(res.status, 401)
    assert.equal(port.lists.length, 0)
  })

  it('viewer 没有成员位 ⇒ 403（屏障一），端口零调用', async () => {
    const res = await request(url, 'GET', '/invites', VIEWER)
    assert.equal(res.status, 403)
    assert.equal(port.lists.length, 0)
  })

  it('孩子生成邀请码 ⇒ 403 FORBIDDEN，端口零调用（invite_member child DENY）', async () => {
    const res = await request(url, 'POST', '/invites', CHILD, NEW_INVITE)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.creates.length, 0)
  })

  it('孩子列出邀请码 ⇒ 403 FORBIDDEN，端口零调用（看得见码 = 能拿去加入）', async () => {
    const res = await request(url, 'GET', '/invites', CHILD)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.lists.length, 0)
  })

  it('孩子吊销邀请码 ⇒ 403 FORBIDDEN，端口零调用', async () => {
    const res = await request(url, 'POST', `/invites/${INVITE_ID}/revoke`, CHILD)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.revokes.length, 0)
  })

  it('★ 孩子设备用码加入 ⇒ 200（加入侧刻意不查成员位，见 controller 头注释）', async () => {
    const res = await request(url, 'POST', '/invites/accept', CHILD, { code: VALID_CODE })
    assert.equal(res.status, 200)
    assert.equal(port.accepts.length, 1)
  })

  it('加入侧仍要求身份：缺身份头 ⇒ 401，端口零调用', async () => {
    const res = await request(url, 'POST', '/invites/accept', {}, { code: VALID_CODE })
    assert.equal(res.status, 401)
    assert.equal(port.accepts.length, 0)
  })
})
// ══ 组 C：成功路径 + 线格式 ════════════════════════════════════════════════════
describe('组 C：家长路径与响应形状', () => {
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

  it('POST /invites ⇒ 201 `InviteCodeDto`，时间是 ISO 串', async () => {
    const startedAt = Date.now()
    const res = await request(url, 'POST', '/invites', GUARDIAN, NEW_INVITE)
    assert.equal(res.status, 201)
    assert.equal(res.body.id, INVITE_ID)
    assert.equal(res.body.code, VALID_CODE)
    assert.equal(res.body.role, 'guardian')
    assert.equal(res.body.maxUses, 3)
    assert.equal(res.body.usedCount, 0)
    assert.equal(res.body.revoked, false)
    // ★ 线格式必须是字符串：Date 序列化结果相同，但契约要求显式 toISOString。
    assert.equal(res.body.createdAt, CREATED_AT.toISOString())
    assert.equal(typeof res.body.expiresAt, 'string')

    // 端口收到的是**绝对时刻** ≈ now + 7 天：客户端只说「多久」，服务端算「哪一刻」。
    const input = port.creates[0]
    assert.equal(port.creates.length, 1)
    assert.equal(input.childId, CHILD_ID)
    assert.equal(input.maxUses, 3)
    assert.equal(input.role, 'guardian')
    assert.equal(input.operatorUserId, 'u-dad')
    assert.equal(input.operatorRole, 'guardian')
    const days = (input.expiresAt.getTime() - startedAt) / 86_400_000
    assert.ok(days > 6.99 && days < 7.01, `有效期应是 ~7 天，实际 ${days} 天`)
  })

  it('请求体多传 childId ⇒ 400（孩子只能来自会话，集合封闭）', async () => {
    const res = await request(url, 'POST', '/invites', GUARDIAN, {
      ...NEW_INVITE,
      childId: 'other-child'
    })
    assert.equal(res.status, 400)
    assert.equal(port.creates.length, 0)
  })

  it('GET /invites ⇒ 200 `{items:[...]}`，孩子 id 来自会话', async () => {
    const res = await request(url, 'GET', '/invites?childId=other-child', GUARDIAN)
    assert.equal(res.status, 200)
    const items = res.body.items as Array<Record<string, unknown>>
    assert.equal(items.length, 1)
    assert.equal(items[0].id, INVITE_ID)
    assert.equal(items[0].usedCount, 1)
    assert.equal(items[0].expiresAt, EXPIRES_AT.toISOString())
    // 服务端只下发事实，不下发结论（没有 expired / status）。
    assert.equal(items[0].expired, undefined)
    // ★ 查询串里的 childId 不起作用：端口收到的仍是会话里的孩子。
    assert.deepEqual(port.lists, [CHILD_ID])
  })

  it('POST /invites/:id/revoke ⇒ 200 `{id, revoked:true}`，端口收到家长身份', async () => {
    const res = await request(url, 'POST', `/invites/${INVITE_ID}/revoke`, GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { id: INVITE_ID, revoked: true })
    assert.deepEqual(port.revokes[0], {
      childId: CHILD_ID,
      inviteId: INVITE_ID,
      operatorUserId: 'u-dad',
      operatorRole: 'guardian'
    })
  })

  it('POST /invites/accept ⇒ 200 `{childId, role, sessionExpiresAt}`', async () => {
    const res = await request(url, 'POST', '/invites/accept', GUARDIAN, { code: VALID_CODE })
    assert.equal(res.status, 200)
    assert.equal(res.body.childId, CHILD_ID)
    assert.equal(res.body.role, 'guardian')

    const input = port.accepts[0]
    assert.equal(port.accepts.length, 1)
    assert.equal(input.code, VALID_CODE)
    // 被邀请人来自**会话**，不是请求体：请求体只有 code。
    assert.equal(input.userId, 'u-dad')
    assert.equal(input.deviceId, DEV_DAD)
    assert.equal(res.body.sessionExpiresAt, input.sessionExpiresAt.toISOString())

    // INVITE_SESSION_TTL_MS = 30 天（PIN 落地前**刻意**不按 §7 的 5 分钟，见 invite-code.ts）。
    const days = (input.sessionExpiresAt.getTime() - Date.now()) / 86_400_000
    assert.ok(days > 29.9 && days < 30.01, `会话 TTL 应是 ~30 天，实际 ${days} 天`)
  })

  it('码在服务层被规范化：`abcd-2345` / `abcd 2345` ⇒ `ABCD2345`', async () => {
    const hyphen = await request(url, 'POST', '/invites/accept', GUARDIAN, { code: 'abcd-2345' })
    assert.equal(hyphen.status, 200)
    assert.equal(port.accepts[0].code, 'ABCD2345')

    const spaced = await request(url, 'POST', '/invites/accept', GUARDIAN, { code: '  abcd 2345 ' })
    assert.equal(spaced.status, 200)
    assert.equal(port.accepts[1].code, 'ABCD2345')
  })
})

// ══ 组 D：校验（400）与端口错误透出（404 / 409）═══════════════════════════════
describe('组 D：形状 400 / 业务 409 —— 两类失败不许互相伪装', () => {
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

  it('role=viewer ⇒ 400（reviewer 在矩阵里没有列，发出去是一张死路票）', async () => {
    const res = await request(url, 'POST', '/invites', GUARDIAN, {
      ...NEW_INVITE,
      role: 'viewer'
    })
    assert.equal(res.status, 400)
    assert.equal(port.creates.length, 0)
  })

  it('maxUses 越界（0 / 11 / 1.5）⇒ 400', async () => {
    for (const maxUses of [0, 11, 1.5]) {
      const res = await request(url, 'POST', '/invites', GUARDIAN, { ...NEW_INVITE, maxUses })
      assert.equal(res.status, 400, `maxUses=${maxUses} 应该被拒`)
    }
    assert.equal(port.creates.length, 0)
  })

  it('expiresInDays 越界（0 / 31）⇒ 400（凭据不该无限期有效）', async () => {
    for (const expiresInDays of [0, 31]) {
      const res = await request(url, 'POST', '/invites', GUARDIAN, {
        ...NEW_INVITE,
        expiresInDays
      })
      assert.equal(res.status, 400, `expiresInDays=${expiresInDays} 应该被拒`)
    }
    assert.equal(port.creates.length, 0)
  })

  it('缺 code ⇒ 400，端口零调用', async () => {
    const res = await request(url, 'POST', '/invites/accept', GUARDIAN, {})
    assert.equal(res.status, 400)
    assert.equal(port.accepts.length, 0)
  })

  it('★ 形状不合法 ⇒ 400 INVITE_CODE_MALFORMED（不是 409：抄漏一位 ≠ 码失效）', async () => {
    for (const code of ['ABC', 'ABCD0EFG', 'ABCD23456']) {
      const res = await request(url, 'POST', '/invites/accept', GUARDIAN, { code })
      assert.equal(res.status, 400, `code=${code} 应该被判为形状不合法`)
      assert.equal(res.body.code, 'INVITE_CODE_MALFORMED')
    }
    // `ABCD0EFG` 含 `0`：字母表里没有它，猜成 `O` 会把「输错了」变成「码无效但看起来对」。
    assert.equal(port.accepts.length, 0)
  })

  it('端口 409 INVITE_CODE_UNAVAILABLE ⇒ HTTP 409 + 同一个 code', async () => {
    port.acceptError = new ConflictException({
      code: 'INVITE_CODE_UNAVAILABLE',
      message: '不存在 / 已过期 / 已用完 / 已吊销'
    })
    const res = await request(url, 'POST', '/invites/accept', GUARDIAN, { code: VALID_CODE })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'INVITE_CODE_UNAVAILABLE')
  })

  it('端口 409 ALREADY_MEMBER ⇒ HTTP 409（不消耗名额，不是 500）', async () => {
    port.acceptError = new ConflictException({ code: 'ALREADY_MEMBER', message: '已经是成员' })
    const res = await request(url, 'POST', '/invites/accept', GUARDIAN, { code: VALID_CODE })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'ALREADY_MEMBER')
  })

  it('端口 409 DEVICE_SESSION_CONFLICT ⇒ HTTP 409（共享平板上已有别人的会话）', async () => {
    port.acceptError = new ConflictException({
      code: 'DEVICE_SESSION_CONFLICT',
      message: '这台设备已有其他账号的会话'
    })
    const res = await request(url, 'POST', '/invites/accept', GUARDIAN, { code: VALID_CODE })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'DEVICE_SESSION_CONFLICT')
  })

  it('端口 404 INVITE_NOT_FOUND（吊销）⇒ HTTP 404 + 同一个 code', async () => {
    port.revokeError = new NotFoundException({
      code: 'INVITE_NOT_FOUND',
      message: '这个邀请码不存在或不属于当前孩子'
    })
    const res = await request(url, 'POST', `/invites/${INVITE_ID}/revoke`, GUARDIAN)
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'INVITE_NOT_FOUND')
  })

  it('端口 404 CHILD_NOT_FOUND（生成）⇒ HTTP 404（孩子刚被删了）', async () => {
    port.createError = new NotFoundException({
      code: 'CHILD_NOT_FOUND',
      message: '孩子不存在或已删除'
    })
    const res = await request(url, 'POST', '/invites', GUARDIAN, NEW_INVITE)
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'CHILD_NOT_FOUND')
  })
})



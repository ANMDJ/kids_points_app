/**
 * register-public-invite-http.test.ts —— 用**网站发放的注册码**注册
 *                                      （W12，2026-11-02；真起 Nest ＋ 真发 HTTP）
 *
 * ── 它与 `invite-register-http.test.ts` 的分工 ──────────────────────────────
 *   那个文件覆盖「家庭邀请码 ⇒ 加入已有家庭」；本文件覆盖
 *   「网站注册码 ⇒ 建一个**零个孩子**的账号」（`membership: null`），
 *   以及同一个端点如何区分两种码。
 *
 * ── 七件事（每一件都能失败）───────────────────────────────────────────────
 *   ① 网站码 + 匹配手机号 ⇒ 200，`membership` 为 null，token 真的过守卫；
 *   ② 网站码 + 匹配邮箱（同一个码也可以）⇒ 200；
 *   ③ 网站码 + 不匹配的标识 ⇒ 409 `INVITE_CODE_UNAVAILABLE`，且**零写入**；
 *   ④ 网站码已用过 ⇒ 409，且**不会掉回家庭邀请码路径**；
 *   ⑤ 查不到的码 ⇒ 仍走家庭邀请码路径（既有行为逐字不变）；
 *   ⑥ 码形状错 ⇒ 400 `INVITE_CODE_MALFORMED`，两条路都没被调用；
 *   ⑦ 缺设备头 / 多余字段 ⇒ 400。
 *
 * ── ⚠️ 诚实标注 ────────────────────────────────────────────────────────────
 *   两个仓储都是内存替身。真 Prisma 的「占码失败 ⇒ 0 个 User（整笔回滚）」
 *   由 `test-db/` 负责；本轮**没有**跑活库。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { ConflictException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import type { AuthSessionRow } from '../src/identity/auth-session.gate'
import {
  AUTH_SESSION_REPOSITORY,
  type AuthSessionPort,
  type CreateAuthSessionInput
} from '../src/identity/auth-session.repository'
import { IdentityModule } from '../src/identity/identity.module'
import {
  IDENTITY_REPOSITORY,
  type IdentityPort
} from '../src/identity/identity.repository'
import {
  INVITE_REGISTRATION_REPOSITORY,
  type InviteRegistrationPort,
  type RegisteredInviteRow,
  type RegisterWithInviteInput
} from '../src/identity/invite-registration.repository'
import { LoginRateLimiter } from '../src/identity/login-rate-limiter'
import {
  PUBLIC_REGISTRATION_REPOSITORY,
  type PublicRegistrationPort,
  type RegisteredPublicRow,
  type RegisterWithPublicInviteInput
} from '../src/identity/public-registration.repository'
import { WECHAT_CODE2SESSION } from '../src/identity/wechat/wechat-code2session.port'
import {
  REGISTRATION_INVITE_REPOSITORY,
  type RegistrationInvitePort
} from '../src/registration-invites/registration-invite.repository'
import type {
  CreateRegistrationInviteInput,
  CreateRegistrationInviteResult,
  RegistrationInviteLookup,
  RegistrationInviteQuotaSnapshot
} from '../src/registration-invites/registration-invite.types'
import { makeWechatFake } from './support/wechat-fake'

interface HttpResult {
  status: number
  body: Record<string, unknown>
  text: string
}

async function send(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  let payload: string | undefined
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(init.body)
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(payload === undefined ? {} : { body: payload })
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  if (text !== '') {
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      body = { _raw: text }
    }
  }
  return { status: res.status, body, text }
}

// ── 内存替身一：认证会话（与 `invite-register-http.test.ts` 同形）────────────
function makeSessionsFake(): AuthSessionPort & { rows: Map<string, AuthSessionRow> } {
  const rows = new Map<string, AuthSessionRow>()
  return {
    rows,
    async findByTokenHash(tokenHash) {
      return rows.get(tokenHash) ?? null
    },
    async create(input: CreateAuthSessionInput) {
      const now = new Date()
      rows.set(input.tokenHash, {
        id: `as-${rows.size + 1}`,
        userId: input.userId,
        tokenHash: input.tokenHash,
        method: input.method,
        deviceId: input.deviceId,
        issuedAt: now,
        lastSeenAt: now,
        expiresAt: input.expiresAt,
        revokedAt: null
      })
    },
    async touch() {},
    async revoke() {
      return false
    },
    async revokeOthers() {
      return 0
    }
  }
}

// ── 内存替身二：身份读路径 ──────────────────────────────────────────────────
class IdentityStub implements IdentityPort {
  readonly users = new Map<string, { userId: string; displayName: string | null }>()

  async readUser(userId: string) {
    return this.users.get(userId) ?? null
  }

  async listChildren() {
    return []
  }

  async loginWithOpenId(): Promise<never> {
    throw new Error('register-public-invite 不使用 loginWithOpenId')
  }

  async readAccountByIdentifier(): Promise<never> {
    throw new Error('register-public-invite 不使用 readAccountByIdentifier')
  }

  async readAccount(): Promise<never> {
    throw new Error('register-public-invite 不使用 readAccount')
  }

  async issueSession(): Promise<never> {
    throw new Error('register-public-invite 不使用 issueSession（注册走自己的事务）')
  }

  async writeAccount(): Promise<never> {
    throw new Error('register-public-invite 不使用 writeAccount')
  }

  async bootstrapChild(): Promise<never> {
    throw new Error('register-public-invite 不使用 bootstrapChild')
  }

  async ensureChildSession(): Promise<never> {
    throw new Error('register-public-invite 不使用 ensureChildSession')
  }
}

// ── 内存替身三：网站码的**只读路由** ──────────────────────────────────────────
interface LookupFake extends RegistrationInvitePort {
  codes: Map<string, RegistrationInviteLookup>
  seed(code: string, row?: Partial<RegistrationInviteLookup>): void
}

function makeLookupFake(): LookupFake {
  const fake: LookupFake = {
    codes: new Map(),
    seed(code, row = {}) {
      fake.codes.set(code, {
        phone: row.phone ?? '13800138000',
        email: row.email ?? 'dad@example.com',
        expiresAt: row.expiresAt ?? new Date(Date.now() + 7 * 86400000),
        usedAt: row.usedAt ?? null,
        revoked: row.revoked ?? false
      })
    },
    async findByCode(code) {
      return fake.codes.get(code) ?? null
    },
    async createInvite(_input: CreateRegistrationInviteInput): Promise<CreateRegistrationInviteResult> {
      throw new Error('register-public-invite 不使用 createInvite')
    },
    async readQuota(_input: {
      day: string
      dailyLimit: number
    }): Promise<RegistrationInviteQuotaSnapshot> {
      throw new Error('register-public-invite 不使用 readQuota')
    }
  }
  return fake
}

// ── 内存替身四：网站码的**写入** ──────────────────────────────────────────────
interface PublicFake extends PublicRegistrationPort {
  calls: RegisterWithPublicInviteInput[]
  /** 这些码在写入时被视为「已用过」⇒ 409。 */
  unusable: Set<string>
}

function makePublicFake(
  sessions: ReturnType<typeof makeSessionsFake>,
  identity: IdentityStub
): PublicFake {
  const fake: PublicFake = {
    calls: [],
    unusable: new Set(),

    async registerWithInvite(input): Promise<RegisteredPublicRow> {
      fake.calls.push(input)
      if (fake.unusable.has(input.code)) {
        throw new ConflictException({ code: 'INVITE_CODE_UNAVAILABLE' })
      }
      const userId = `u-web-${fake.calls.length}`
      identity.users.set(userId, { userId, displayName: input.displayName })
      await sessions.create({
        userId,
        tokenHash: input.tokenHash,
        method: 'password',
        deviceId: input.deviceId,
        expiresAt: input.authExpiresAt
      })
      return { userId, displayName: input.displayName }
    }
  }
  return fake
}

// ── 内存替身五：家庭邀请码（既有路径，用来证明「没被误走」）────────────────────
interface FamilyFake extends InviteRegistrationPort {
  calls: RegisterWithInviteInput[]
}

function makeFamilyFake(): FamilyFake {
  const fake: FamilyFake = {
    calls: [],
    async registerWithInvite(input): Promise<RegisteredInviteRow> {
      fake.calls.push(input)
      return {
        userId: `u-family-${fake.calls.length}`,
        displayName: input.displayName,
        childId: 'child-family',
        role: 'guardian'
      }
    }
  }
  return fake
}

// ── 装配 ─────────────────────────────────────────────────────────────────────
interface Harness {
  app: INestApplication
  url: string
  sessions: ReturnType<typeof makeSessionsFake>
  identity: IdentityStub
  lookup: LookupFake
  publicRegistration: PublicFake
  family: FamilyFake
}

async function startApp(): Promise<Harness> {
  const sessions = makeSessionsFake()
  const identity = new IdentityStub()
  const lookup = makeLookupFake()
  const publicRegistration = makePublicFake(sessions, identity)
  const family = makeFamilyFake()

  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule.register({ hasDatabase: false, wechatConfigured: true })]
  })
    .overrideProvider(AUTH_SESSION_REPOSITORY)
    .useValue(sessions)
    .overrideProvider(IDENTITY_REPOSITORY)
    .useValue(identity)
    .overrideProvider(INVITE_REGISTRATION_REPOSITORY)
    .useValue(family)
    .overrideProvider(REGISTRATION_INVITE_REPOSITORY)
    .useValue(lookup)
    .overrideProvider(PUBLIC_REGISTRATION_REPOSITORY)
    .useValue(publicRegistration)
    .overrideProvider(WECHAT_CODE2SESSION)
    .useValue(makeWechatFake())
    .compile()

  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  const url = await app.getUrl()
  return {
    app,
    url: url.replace('[::1]', '127.0.0.1'),
    sessions,
    identity,
    lookup,
    publicRegistration,
    family
  }
}

describe('网站注册码（POST /auth/register-invite 的第二条路）', () => {
  let harness!: Harness

  before(async () => {
    harness = await startApp()
  })

  after(async () => {
    await harness.app.close()
  })

  beforeEach(() => {
    harness.app.get(LoginRateLimiter).reset()
    harness.sessions.rows.clear()
    harness.identity.users.clear()
    harness.lookup.codes.clear()
    harness.publicRegistration.calls.length = 0
    harness.publicRegistration.unusable.clear()
    harness.family.calls.length = 0
  })

  const body = (code: string, identifier = '13800138000') => ({
    inviteCode: code,
    identifier,
    password: 'jiazhang2026',
    displayName: '妈妈'
  })

  it('★ 网站码 + 匹配手机号 ⇒ 200，membership 为 null，token 真的过守卫', async () => {
    harness.lookup.seed('WEB23456')

    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-web' },
      body: body('web-2345-6')
    })

    assert.equal(res.status, 200, res.text)
    assert.equal(res.body.membership, null)
    assert.match(res.body.token as string, /^kps_/)
    assert.deepEqual(res.body.user, { id: 'u-web-1', displayName: '妈妈' })

    // ★ 闭环：token 必须真的被 `AuthGuard` 认（否则「注册成功」是假的）
    const session = await send(harness.url, '/auth/session', {
      headers: { authorization: `Bearer ${res.body.token as string}` }
    })
    assert.equal(session.status, 200, session.text)
    assert.equal((session.body.user as { id: string }).id, 'u-web-1')

    // 端口拿到规范化标识 + 哈希后的密码；家庭路径一次都没被调用
    const call = harness.publicRegistration.calls[0]
    assert.equal(call?.code, 'WEB23456')
    assert.equal(call?.identifierType, 'phone')
    assert.equal(call?.identifierValue, '13800138000')
    assert.match(call?.passwordHash ?? '', /^scrypt-pw\$/)
    assert.equal(call?.deviceId, 'dev-web')
    assert.equal(harness.family.calls.length, 0)
  })

  it('同一个网站码也可以用码上的**邮箱**注册（绑定的两个标识都认）', async () => {
    harness.lookup.seed('WEB23456')
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-web' },
      body: body('WEB23456', ' Dad@Example.COM ')
    })
    assert.equal(res.status, 200, res.text)
    assert.equal(res.body.membership, null)
    assert.equal(harness.publicRegistration.calls[0]?.identifierType, 'email')
    assert.equal(harness.publicRegistration.calls[0]?.identifierValue, 'dad@example.com')
  })

  it('★ 网站码 + 不匹配的标识 ⇒ 409，且两条路都**零写入**', async () => {
    harness.lookup.seed('WEB23456') // 绑 13800138000 / dad@example.com
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-web' },
      body: body('WEB23456', '13900139000')
    })

    assert.equal(res.status, 409, res.text)
    assert.equal(res.body.code, 'INVITE_CODE_UNAVAILABLE')
    assert.equal(harness.publicRegistration.calls.length, 0)
    assert.equal(harness.family.calls.length, 0)
  })

  it('★ 网站码已用过 ⇒ 409，且**不会掉回**家庭邀请码路径', async () => {
    harness.lookup.seed('USED2345', { usedAt: new Date() })
    harness.publicRegistration.unusable.add('USED2345')

    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-web' },
      body: body('USED2345')
    })

    assert.equal(res.status, 409, res.text)
    assert.equal(res.body.code, 'INVITE_CODE_UNAVAILABLE')
    // 路由已经判定它是网站码 ⇒ 家庭路径不能被调用（否则错误来自另一张表）
    assert.equal(harness.family.calls.length, 0)
  })

  it('查不到的码 ⇒ 仍走家庭邀请码路径（既有行为逐字不变）', async () => {
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-family' },
      body: body('MAMA2345')
    })

    assert.equal(res.status, 200, res.text)
    assert.deepEqual(res.body.membership, { childId: 'child-family', role: 'guardian' })
    assert.equal(harness.family.calls.length, 1)
    assert.equal(harness.publicRegistration.calls.length, 0)
  })

  it('码形状错 ⇒ 400 MALFORMED，两次查码都没发生', async () => {
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-web' },
      body: body('WEB2345') // 7 位
    })
    assert.equal(res.status, 400, res.text)
    assert.equal(res.body.code, 'INVITE_CODE_MALFORMED')
    assert.equal(harness.publicRegistration.calls.length, 0)
    assert.equal(harness.family.calls.length, 0)
  })

  it('缺 x-kp-device-id ⇒ 400（否则 token 永远过不了业务守卫）', async () => {
    harness.lookup.seed('WEB23456')
    const res = await send(harness.url, '/auth/register-invite', {
      body: body('WEB23456')
    })
    assert.equal(res.status, 400, res.text)
    assert.equal(res.body.code, 'DEVICE_ID_REQUIRED')
    assert.equal(harness.publicRegistration.calls.length, 0)
  })

  it('请求体多一个 role ⇒ 400（角色不能自选）', async () => {
    harness.lookup.seed('WEB23456')
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-web' },
      body: { ...body('WEB23456'), role: 'guardian' }
    })
    assert.equal(res.status, 400, res.text)
    assert.equal(harness.publicRegistration.calls.length, 0)
  })
})


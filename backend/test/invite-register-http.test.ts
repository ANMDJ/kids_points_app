/**
 * invite-register-http.test.ts —— **邀请码注册**的集成测试
 *                            （W11-A，2026-11-02；真起 Nest ＋ 真发 HTTP）
 *
 * ── 这一步在补哪个洞 ───────────────────────────────────────────────────────
 *   `42` §5.1 拒绝开放注册，`42` §9 第 1 条写明前置条件是「邀请码并入家庭」。
 *   没有这条路由时，一位**新家长**在 App 里没有任何入口：登录页只能登录
 *   「已经在小程序里建过号」的人。本文件钉住新入口的每一条拒绝理由。
 *
 * ── 七件事（每一件都能失败）───────────────────────────────────────────────
 *   ① 成功路径：200 + token 真的过 `AuthGuard` + `membership` 指向邀请码里的孩子；
 *   ② 邀请码**规范化**（`mama-2345` / `+86 138-0013-8000`）在服务端只有一份；
 *   ③ 密码是**哈希**后才进端口（端口拿不到明文）；
 *   ④ 码形状错 ⇒ 400、码不可用 ⇒ 409（形状不消耗任何写入）；
 *   ⑤ 弱密码 / 标识形状错 ⇒ 400；已被占用 ⇒ 409（不是"格式不对"）；
 *   ⑥ 缺 `x-kp-device-id` ⇒ 400（否则发出去的 token 永远过不了业务守卫）；
 *   ⑦ 请求体里多一个 `role` ⇒ **400**（角色只能来自邀请码，不能自选）。
 *
 * ── ⚠️ 诚实标注 ────────────────────────────────────────────────────────────
 *   本文件用**内存替身**，只证明接线 / 状态码 / 不泄漏。真 Prisma 的
 *   「失败后 0 个 User（整笔回滚）」「P2002 ⇒ 409」由 `test-db/` 套件负责；
 *   本轮**没有**跑活库（见 `45` §7）。
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
  INVITE_REGISTRATION_REPOSITORY,
  type InviteRegistrationPort,
  type RegisteredInviteRow,
  type RegisterWithInviteInput
} from '../src/identity/invite-registration.repository'
import {
  IDENTITY_REPOSITORY,
  type IdentityPort
} from '../src/identity/identity.repository'
import { LOGIN_RATE_LIMIT_PER_DEVICE, LoginRateLimiter } from '../src/identity/login-rate-limiter'
import { WECHAT_CODE2SESSION } from '../src/identity/wechat/wechat-code2session.port'
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

// ── 内存替身一：认证会话 ─────────────────────────────────────────────────────
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


// ── 内存替身二：身份读路径（本文件只用到 readUser）────────────────────────────
class IdentityStub implements IdentityPort {
  readonly users = new Map<string, { userId: string; displayName: string | null }>()

  async readUser(userId: string) {
    return this.users.get(userId) ?? null
  }

  async listChildren() {
    return []
  }

  async loginWithOpenId(): Promise<never> {
    throw new Error('invite-register-http 不使用 loginWithOpenId')
  }

  async readAccountByIdentifier(): Promise<never> {
    throw new Error('invite-register-http 不使用 readAccountByIdentifier')
  }

  async readAccount(): Promise<never> {
    throw new Error('invite-register-http 不使用 readAccount')
  }

  async issueSession(): Promise<never> {
    throw new Error('invite-register-http 不使用 issueSession（注册走自己的事务）')
  }

  async writeAccount(): Promise<never> {
    throw new Error('invite-register-http 不使用 writeAccount')
  }

  async bootstrapChild(): Promise<never> {
    throw new Error('invite-register-http 不使用 bootstrapChild')
  }

  async ensureChildSession(): Promise<never> {
    throw new Error('invite-register-http 不使用 ensureChildSession')
  }
}

// ── 内存替身三：邀请注册写路径 ────────────────────────────────────────────────
interface CodeRow {
  childId: string
  role: 'child' | 'guardian'
  maxUses: number
  usedCount: number
  revoked: boolean
  expiresAt: Date
}

interface RegistrationFake extends InviteRegistrationPort {
  codes: Map<string, CodeRow>
  /** 每次调用的入参 —— 证明「哈希后才进端口」「角色不来自请求体」。 */
  calls: RegisterWithInviteInput[]
  taken: Set<string>
  seedCode(code: string, row?: Partial<CodeRow>): void
}

function makeRegistrationFake(
  sessions: ReturnType<typeof makeSessionsFake>,
  identity: IdentityStub
): RegistrationFake {
  const fake: RegistrationFake = {
    codes: new Map<string, CodeRow>(),
    calls: [],
    taken: new Set<string>(),

    seedCode(code, row = {}) {
      fake.codes.set(code, {
        childId: row.childId ?? 'child-demo',
        role: row.role ?? 'guardian',
        maxUses: row.maxUses ?? 3,
        usedCount: row.usedCount ?? 0,
        revoked: row.revoked ?? false,
        expiresAt: row.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      })
    },

    async registerWithInvite(input): Promise<RegisteredInviteRow> {
      fake.calls.push(input)

      const row = fake.codes.get(input.code)
      const usable =
        row !== undefined &&
        !row.revoked &&
        row.usedCount < row.maxUses &&
        row.expiresAt.getTime() > Date.now()
      if (!usable) {
        // 与真适配器同一条口径：四种情况同一个 409，且**不消耗**名额。
        throw new ConflictException({ code: 'INVITE_CODE_UNAVAILABLE' })
      }

      if (fake.taken.has(input.identifierValue)) {
        throw new ConflictException({
          code: 'IDENTIFIER_TAKEN',
          field: input.identifierType
        })
      }

      row.usedCount += 1
      const userId = `u-new-${fake.calls.length}`
      identity.users.set(userId, { userId, displayName: input.displayName })

      await sessions.create({
        userId,
        tokenHash: input.tokenHash,
        method: 'password',
        deviceId: input.deviceId,
        expiresAt: input.authExpiresAt
      })

      return {
        userId,
        displayName: input.displayName,
        childId: row.childId,
        role: row.role
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
  registration: RegistrationFake
}

async function startApp(): Promise<Harness> {
  const sessions = makeSessionsFake()
  const identity = new IdentityStub()
  const registration = makeRegistrationFake(sessions, identity)

  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule.register({ hasDatabase: false, wechatConfigured: true })]
  })
    .overrideProvider(AUTH_SESSION_REPOSITORY)
    .useValue(sessions)
    .overrideProvider(IDENTITY_REPOSITORY)
    .useValue(identity)
    .overrideProvider(INVITE_REGISTRATION_REPOSITORY)
    .useValue(registration)
    .overrideProvider(WECHAT_CODE2SESSION)
    .useValue(makeWechatFake())
    .compile()

  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app) // 与 main.ts 同一函数：`@Public()` 与白名单都靠它
  await app.listen(0, '127.0.0.1')
  const url = await app.getUrl()
  return { app, url: url.replace('[::1]', '127.0.0.1'), sessions, identity, registration }
}

describe('邀请码注册（POST /auth/register-invite）', () => {
  let harness!: Harness

  before(async () => {
    harness = await startApp()
  })

  after(async () => {
    await harness.app.close()
  })

  beforeEach(() => {
    // 进程内单例 + 同一批内存替身会跨用例累积 ⇒ 每条用例从**空世界**开始。
    harness.app.get(LoginRateLimiter).reset()
    harness.sessions.rows.clear()
    harness.identity.users.clear()
    harness.registration.codes.clear()
    harness.registration.calls.length = 0
    harness.registration.taken.clear()
  })

  const validBody = (code: string) => ({
    inviteCode: code,
    identifier: '13800138000',
    password: 'jiazhang2026',
    displayName: '妈妈'
  })

  // ═══════════════ A. 成功路径 ═══════════════
  it('★ 注册成功：200 + token 真的过守卫 + membership 指向码里的孩子', async () => {
    harness.registration.seedCode('MAMA2345', { childId: 'child-demo', role: 'guardian' })

    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-new' },
      body: validBody('mama-2345') // 小写 + 连字符：规范化在服务端
    })

    assert.equal(res.status, 200, res.text)
    const token = res.body.token as string
    assert.match(token, /^kps_[A-Za-z0-9_-]{43}$/)
    assert.deepEqual(res.body.membership, { childId: 'child-demo', role: 'guardian' })
    assert.deepEqual(res.body.user, { id: 'u-new-1', displayName: '妈妈' })

    // ★ 闭环：token 必须真的被 `AuthGuard` 认（否则"注册成功"是假的）
    const session = await send(harness.url, '/auth/session', {
      headers: { authorization: `Bearer ${token}` }
    })
    assert.equal(session.status, 200, session.text)
    assert.equal((session.body.user as { id: string }).id, 'u-new-1')
  })

  it('★ 密码哈希后才进端口；标识被规范化成手机号；显示名去掉首尾空格', async () => {
    harness.registration.seedCode('MAMA2345')
    await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-new' },
      body: {
        inviteCode: ' MAMA-2345 ',
        identifier: ' +86 138-0013-8000 ',
        password: 'jiazhang2026',
        displayName: '  妈妈  '
      }
    })

    const call = harness.registration.calls[0]
    assert.equal(call?.code, 'MAMA2345')
    assert.equal(call?.identifierType, 'phone')
    assert.equal(call?.identifierValue, '13800138000')
    assert.equal(call?.displayName, '妈妈')
    assert.equal(call?.deviceId, 'dev-new')
    // 端口永远拿不到明文密码（`scrypt-pw$` 前缀见 common/password-hash.ts）
    assert.match(call?.passwordHash ?? '', /^scrypt-pw\$/)
    assert.notEqual(call?.passwordHash, 'jiazhang2026')
  })

  it('角色来自邀请码（child 码 ⇒ child），不是请求体能改的', async () => {
    harness.registration.seedCode('CHKD2345', { role: 'child' })
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-kid' },
      body: validBody('CHKD2345')
    })
    assert.equal(res.status, 200, res.text)
    assert.deepEqual(res.body.membership, { childId: 'child-demo', role: 'child' })
  })

  // ═══════════════ B. 邀请码的两种失败 ═══════════════
  it('★ 码形状非法（DEMO2345 含 O）⇒ 400，且一次写入都没有', async () => {
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-new' },
      body: validBody('DEMO2345')
    })

    assert.equal(res.status, 400, res.text)
    assert.equal(res.body.code, 'INVITE_CODE_MALFORMED')
    assert.equal(harness.registration.calls.length, 0)
  })

  it('★ 码不存在 / 已吊销 / 已用完 / 已过期 ⇒ **同一个** 409', async () => {
    harness.registration.seedCode('REVK2345', { revoked: true })
    harness.registration.seedCode('USED2345', { maxUses: 1, usedCount: 1 })
    harness.registration.seedCode('XPRD2345', { expiresAt: new Date(Date.now() - 1000) })

    for (const code of ['ZZZZ2345', 'REVK2345', 'USED2345', 'XPRD2345']) {
      const res = await send(harness.url, '/auth/register-invite', {
        headers: { 'x-kp-device-id': 'dev-new' },
        body: validBody(code)
      })
      assert.equal(res.status, 409, `${code}: ${res.text}`)
      assert.equal(res.body.code, 'INVITE_CODE_UNAVAILABLE')
    }
  })


  // ═══════════════ C. 账号侧的形状与冲突 ═══════════════
  it('弱密码 ⇒ 400 WEAK_PASSWORD（在花 scrypt 之前）', async () => {
    harness.registration.seedCode('MAMA2345')
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-new' },
      body: { ...validBody('MAMA2345'), password: '12345678' }
    })

    assert.equal(res.status, 400, res.text)
    assert.equal(res.body.code, 'WEAK_PASSWORD')
    assert.equal(harness.registration.calls.length, 0)
  })

  it('标识形状错 ⇒ 400 INVALID_IDENTIFIER', async () => {
    harness.registration.seedCode('MAMA2345')
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-new' },
      body: { ...validBody('MAMA2345'), identifier: 'not-an-account' }
    })

    assert.equal(res.status, 400, res.text)
    assert.equal(res.body.code, 'INVALID_IDENTIFIER')
  })

  it('★ 手机号已被占用 ⇒ 409 IDENTIFIER_TAKEN（不是 400「格式不对」）', async () => {
    harness.registration.seedCode('MAMA2345')
    harness.registration.taken.add('13800138000')

    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-new' },
      body: validBody('MAMA2345')
    })

    assert.equal(res.status, 409, res.text)
    assert.equal(res.body.code, 'IDENTIFIER_TAKEN')
    assert.equal(res.body.field, 'phone')
  })

  // ═══════════════ D. 装配 / 越权面的几条硬约束 ═══════════════
  it('缺 x-kp-device-id ⇒ 400 DEVICE_ID_REQUIRED（不发必然 401 的 token）', async () => {
    harness.registration.seedCode('MAMA2345')
    const res = await send(harness.url, '/auth/register-invite', {
      body: validBody('MAMA2345')
    })

    assert.equal(res.status, 400, res.text)
    assert.equal(res.body.code, 'DEVICE_ID_REQUIRED')
  })

  it('★ 请求体多一个 role ⇒ 400（全局 whitelist + forbidNonWhitelisted）', async () => {
    harness.registration.seedCode('MAMA2345')
    const res = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-new' },
      body: { ...validBody('MAMA2345'), role: 'guardian' }
    })

    assert.equal(res.status, 400, res.text)
    assert.equal(harness.registration.calls.length, 0)
  })

  it('★ 与登录共用限流：同一设备连续第 11 次 ⇒ 429 LOGIN_RATE_LIMITED', async () => {
    harness.registration.seedCode('MAMA2345')
    for (let i = 0; i < LOGIN_RATE_LIMIT_PER_DEVICE; i += 1) {
      const res = await send(harness.url, '/auth/register-invite', {
        headers: { 'x-kp-device-id': 'dev-flood' },
        body: { ...validBody('MAMA2345'), password: 'weak' }
      })
      // 前 10 次是 400（弱密码），第 11 次应该连业务判断都进不去。
      assert.equal(res.status, 400, res.text)
    }

    const limited = await send(harness.url, '/auth/register-invite', {
      headers: { 'x-kp-device-id': 'dev-flood' },
      body: validBody('MAMA2345')
    })
    assert.equal(limited.status, 429, limited.text)
    assert.equal(limited.body.code, 'LOGIN_RATE_LIMITED')
  })
})


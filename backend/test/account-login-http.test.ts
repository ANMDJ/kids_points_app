/**
 * account-login-http.test.ts —— App **手机号/邮箱 + 密码**登录的集成测试
 *                              （W9-D，2026-10-30；真起 Nest ＋ 真发 HTTP）
 *
 * ── 这一步在修什么 ─────────────────────────────────────────────────────────
 *   W9-A/W9-B 让小程序能用微信登录，但 Flutter 没有微信 SDK（要 1–2 周审核 +
 *   300 元/年），于是整个 App 只能靠 `--dart-define` 的编译期常量身份 ——
 *   生产环境必然 401。W9-D 给出**第二条身份锚点**：手机号/邮箱 + 密码。
 *
 * ── 本文件钉的五件事（每一件都能失败）───────────────────────────────────────
 *   ① 登录成功签发的 token **真的被守卫认**（否则"登录成功"是假的）；
 *   ② 失败一律同一个 401 —— 账号不存在 / 没设密码 / 密码错**不可区分**
 *      （否则这就是一个手机号枚举接口）；
 *   ③ 规范化在**两条路**上一致：绑定 `138 0013 8000` 之后，用
 *      `+86 13800138000` 也能登录（不一致 = 同一个人绑出三个账号）；
 *   ④ 改密码要带旧密码，且成功后**踢掉其它会话、保留当前这条**；
 *   ⑤ 绑定冲突是 **409** 而不是 400/500（400 会让用户反复改写法）。
 *
 * ── ⚠️ 诚实标注 ────────────────────────────────────────────────────────────
 *   · 仓库是**内存替身**（验接线 / 状态码 / 不泄漏）；真 Prisma 的 `P2002` ⇒ 409、
 *     `UPDATE … WHERE status='active' RETURNING` 的原子性在
 *     `test-db/account-login-db.dbtest.ts`；
 *   · **不测**"scrypt 不可暴力破解"（那由 N=16384 + 限流共同给，属数学性质）；
 *   · **不测**时序（`burnPasswordHashCost` 只为对齐，用测试去卡毫秒会变成
 *     一个随机红的用例）；这里只证明它在"账号不存在"分支上**被调用过**。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { ConflictException, ForbiddenException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import { hashPassword } from '../src/common/password-hash'
import {
  authSessionExpiresAt,
  hashToken,
  issueToken,
  type AuthSessionRow
} from '../src/identity/auth-session.gate'
import {
  AUTH_SESSION_REPOSITORY,
  type AuthSessionPort,
  type CreateAuthSessionInput
} from '../src/identity/auth-session.repository'
import { IdentityModule } from '../src/identity/identity.module'
import {
  IDENTITY_REPOSITORY,
  type AccountRow,
  type AccountViewRow,
  type BootstrapChildInput,
  type BootstrapChildResult,
  type ChildMembershipRow,
  type EnsureChildSessionInput,
  type EnsureChildSessionResult,
  type IdentityPort,
  type IssueSessionInput,
  type LoginUserRow,
  type LoginWithOpenIdInput,
  type WriteAccountInput
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
interface SessionsFake extends AuthSessionPort {
  /** key = tokenHash。 */
  rows: Map<string, AuthSessionRow>
  /** 造一条已存在的会话，返回**明文** token（只用于拼 Bearer 头）。 */
  put(userId: string, method?: string): string
}

function makeSessionsFake(): SessionsFake {
  const fake: SessionsFake = {
    rows: new Map<string, AuthSessionRow>(),
    put(userId, method = 'wechat_mp') {
      const token = issueToken()
      const tokenHash = hashToken(token)
      const now = new Date()
      const row: AuthSessionRow = {
        id: `as-${fake.rows.size + 1}`,
        userId,
        tokenHash,
        method,
        deviceId: null,
        issuedAt: now,
        lastSeenAt: now,
        expiresAt: authSessionExpiresAt(now),
        revokedAt: null
      }
      fake.rows.set(tokenHash, row)
      return token
    },
    async findByTokenHash(tokenHash) {
      return fake.rows.get(tokenHash) ?? null
    },
    async create(input: CreateAuthSessionInput) {
      const now = new Date()
      fake.rows.set(input.tokenHash, {
        id: `as-created-${fake.rows.size + 1}`,
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
    async touch(tokenHash, now) {
      const row = fake.rows.get(tokenHash)
      if (row !== undefined) row.lastSeenAt = now
    },
    async revoke(tokenHash) {
      const row = fake.rows.get(tokenHash)
      if (row === undefined || row.revokedAt !== null) return false
      row.revokedAt = new Date()
      return true
    },
    async revokeOthers(userId, keepTokenHash, now) {
      let count = 0
      for (const row of fake.rows.values()) {
        if (row.userId !== userId) continue
        if (row.revokedAt !== null) continue
        if (keepTokenHash !== null && row.tokenHash === keepTokenHash) continue
        row.revokedAt = now
        count += 1
      }
      return count
    }
  }
  return fake
}

// ── 内存替身二：身份写路径（含账号行）─────────────────────────────────────────
interface IdentityFake extends IdentityPort {
  users: Map<string, LoginUserRow>
  accounts: Map<string, AccountRow>
  children: Map<string, ChildMembershipRow[]>
  /** 每次 `issueSession` 的入参（证明"不建 User、只签会话"）。 */
  issued: IssueSessionInput[]
  /** 造一个已有账号（密码走真 `hashPassword`，不是假串）。 */
  seed(input: {
    userId: string
    phone?: string
    email?: string
    password?: string
    status?: string
  }): Promise<AccountRow>
  /** 给某个用户一个成员位（`membership` 断言用）。 */
  grantChild(userId: string, childId: string, role?: string): void
}

function makeIdentityFake(sessions: SessionsFake): IdentityFake {
  const fake: IdentityFake = {
    users: new Map<string, LoginUserRow>(),
    accounts: new Map<string, AccountRow>(),
    children: new Map<string, ChildMembershipRow[]>(),
    issued: [],

    async seed(input) {
      const account: AccountRow = {
        userId: input.userId,
        displayName: '家长',
        status: input.status ?? 'active',
        phone: input.phone ?? null,
        email: input.email ?? null,
        passwordHash: input.password === undefined ? null : await hashPassword(input.password)
      }
      fake.accounts.set(input.userId, account)
      fake.users.set(input.userId, { userId: input.userId, displayName: account.displayName })
      return account
    },

    grantChild(userId, childId, role = 'guardian') {
      const list = fake.children.get(userId) ?? []
      list.push({ childId, name: '小朋友', role })
      fake.children.set(userId, list)
    },

    async loginWithOpenId(input: LoginWithOpenIdInput): Promise<LoginUserRow> {
      const userId = `u-${input.openId}`
      const user: LoginUserRow = { userId, displayName: '家长' }
      fake.users.set(userId, user)
      await sessions.create({
        userId,
        tokenHash: input.tokenHash,
        method: input.method,
        deviceId: input.deviceId,
        expiresAt: input.expiresAt
      })
      return user
    },

    async readUser(userId) {
      return fake.users.get(userId) ?? null
    },

    async listChildren(userId) {
      return fake.children.get(userId) ?? []
    },

    async bootstrapChild(input: BootstrapChildInput): Promise<BootstrapChildResult> {
      return { childId: 'child-new', role: 'guardian', parentModeUntil: input.parentModeUntil }
    },

    async ensureChildSession(input: EnsureChildSessionInput): Promise<EnsureChildSessionResult> {
      return { role: 'guardian', sessionExpiresAt: input.sessionExpiresAt }
    },

    async readAccountByIdentifier(type, value) {
      for (const row of fake.accounts.values()) {
        if (type === 'phone' && row.phone === value) return row
        if (type === 'email' && row.email === value) return row
      }
      return null
    },

    async readAccount(userId) {
      return fake.accounts.get(userId) ?? null
    },

    async issueSession(input: IssueSessionInput): Promise<LoginUserRow> {
      fake.issued.push(input)
      const user = fake.users.get(input.userId)
      const account = fake.accounts.get(input.userId)
      if (user === undefined || account === undefined || account.status !== 'active') {
        // 与真适配器的 `UPDATE … WHERE status='active' RETURNING` 0 行同口径。
        throw new ForbiddenException({ code: 'USER_NOT_ACTIVE' })
      }
      await sessions.create({
        userId: user.userId,
        tokenHash: input.tokenHash,
        method: input.method,
        deviceId: input.deviceId,
        expiresAt: input.expiresAt
      })
      return user
    },

    async writeAccount(input: WriteAccountInput): Promise<AccountViewRow> {
      const row = fake.accounts.get(input.userId)
      if (row === undefined) throw new ForbiddenException({ code: 'USER_NOT_ACTIVE' })

      // ★ 真库靠唯一索引；替身必须**同样拒绝**，否则"409 IDENTIFIER_TAKEN"
      //   这条用例在本文件里永远是绿的（那是假绿）。
      for (const other of fake.accounts.values()) {
        if (other.userId === input.userId) continue
        if (input.phone !== undefined && other.phone === input.phone) {
          throw new ConflictException({
            code: 'IDENTIFIER_TAKEN',
            field: 'phone',
            message: '这个手机号已经被另一个账号绑定了。'
          })
        }
        if (input.email !== undefined && other.email === input.email) {
          throw new ConflictException({
            code: 'IDENTIFIER_TAKEN',
            field: 'email',
            message: '这个邮箱已经被另一个账号绑定了。'
          })
        }
      }

      if (input.phone !== undefined) row.phone = input.phone
      if (input.email !== undefined) row.email = input.email
      if (input.passwordHash !== undefined) row.passwordHash = input.passwordHash
      return { phone: row.phone, email: row.email, hasPassword: row.passwordHash !== null }
    }
  }
  return fake
}

// ── 装配 ─────────────────────────────────────────────────────────────────────
interface Harness {
  app: INestApplication
  url: string
  sessions: SessionsFake
  identity: IdentityFake
}

/**
 * 起一个**只有身份层**的真服务。
 *
 * ★ `hasDatabase: false` + 三个 provider 全 override：本文件测接线，
 *   而"有库装配是否真写库 / `P2002` 是否真翻 409"由
 *   `test-db/account-login-db.dbtest.ts` 证。
 */
async function startApp(): Promise<Harness> {
  const sessions = makeSessionsFake()
  const identity = makeIdentityFake(sessions)
  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule.register({ hasDatabase: false, wechatConfigured: true })]
  })
    .overrideProvider(AUTH_SESSION_REPOSITORY)
    .useValue(sessions)
    .overrideProvider(IDENTITY_REPOSITORY)
    .useValue(identity)
    .overrideProvider(WECHAT_CODE2SESSION)
    .useValue(makeWechatFake())
    .compile()

  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app) // 与 main.ts 同一函数：`@Public()` 与白名单都靠它
  await app.listen(0, '127.0.0.1')
  const url = await app.getUrl()
  return { app, url: url.replace('[::1]', '127.0.0.1'), sessions, identity }
}

describe('App 账号登录（手机号/邮箱 + 密码）', () => {
  let harness!: Harness

  before(async () => {
    harness = await startApp()
  })

  after(async () => {
    await harness.app.close()
  })

  beforeEach(() => {
    // 进程内单例 + 同一批内存替身会跨用例累积 —— 每条用例都必须从**空世界**开始，
    // 否则「sessions.rows.size === 0」这类断言测到的是上一条用例留下的东西。
    harness.app.get(LoginRateLimiter).reset()
    harness.sessions.rows.clear()
    harness.identity.users.clear()
    harness.identity.accounts.clear()
    harness.identity.children.clear()
    harness.identity.issued.length = 0
  })

  // ═══════════════ A. 成功路径 ═══════════════
  describe('A. 登录成功', () => {
    it('★ 手机号写法不同也能登进**同一个**账号，签发的 token 真的被守卫认', async () => {
      await harness.identity.seed({
        userId: 'u-dad',
        phone: '13800138000',
        password: 'jiazhang2026'
      })
      harness.identity.grantChild('u-dad', 'child-1')

      const res = await send(harness.url, '/auth/login-account', {
        body: { identifier: ' +86 138-0013-8000 ', password: 'jiazhang2026' }
      })

      assert.equal(res.status, 200, res.text)
      const token = res.body.token as string
      assert.match(token, /^kps_[A-Za-z0-9_-]{43}$/)
      assert.deepEqual(res.body.membership, { childId: 'child-1', role: 'guardian' })

      // ★ 闭环：token 不是"看起来像"就行，必须真的过 `AuthGuard`
      const session = await send(harness.url, '/auth/session', {
        headers: { authorization: `Bearer ${token}` }
      })
      assert.equal(session.status, 200, session.text)
      assert.equal((session.body.user as { id: string }).id, 'u-dad')
    })

    it('邮箱大小写不敏感；落库的 method 是 password', async () => {
      await harness.identity.seed({
        userId: 'u-mom',
        email: 'mom@example.com',
        password: 'jiazhang2026'
      })

      const res = await send(harness.url, '/auth/login-account', {
        body: { identifier: 'Mom@Example.COM', password: 'jiazhang2026' }
      })

      assert.equal(res.status, 200, res.text)
      assert.equal(harness.identity.issued.at(-1)?.method, 'password')
    })

    it('★ 不建 User：同一账号登两次 ⇒ 两条会话、零个新账号', async () => {
      await harness.identity.seed({
        userId: 'u-dad',
        phone: '13800138000',
        password: 'jiazhang2026'
      })

      for (let i = 0; i < 2; i += 1) {
        const res = await send(harness.url, '/auth/login-account', {
          body: { identifier: '13800138000', password: 'jiazhang2026' }
        })
        assert.equal(res.status, 200, res.text)
      }

      assert.equal(harness.identity.accounts.size, 1)
      assert.equal(harness.sessions.rows.size, 2)
    })
  })

  // ═══════════════ B. 失败同形 ═══════════════
  describe('B. 失败一律 401 且**不可区分**（否则是手机号枚举接口）', () => {
    it('★ 密码错 / 账号不存在 / 从未设密码：三者响应体逐字相同', async () => {
      await harness.identity.seed({
        userId: 'u-dad',
        phone: '13800138000',
        password: 'jiazhang2026'
      })
      await harness.identity.seed({ userId: 'u-no-pw', phone: '13900139000' })

      const wrong = await send(harness.url, '/auth/login-account', {
        body: { identifier: '13800138000', password: 'jiazhang2027' }
      })
      const missing = await send(harness.url, '/auth/login-account', {
        body: { identifier: '13700137000', password: 'jiazhang2026' }
      })
      const noPassword = await send(harness.url, '/auth/login-account', {
        body: { identifier: '13900139000', password: 'jiazhang2026' }
      })

      for (const res of [wrong, missing, noPassword]) {
        assert.equal(res.status, 401, res.text)
        assert.equal(res.body.code, 'ACCOUNT_INVALID_CREDENTIALS')
      }
      // ★ 逐字相同 —— 连 message 的一个字都不能差
      assert.equal(wrong.text, missing.text)
      assert.equal(wrong.text, noPassword.text)
    })

    it('失败不签发任何会话（`issueSession` 一次都没被调用）', async () => {
      await harness.identity.seed({
        userId: 'u-dad',
        phone: '13800138000',
        password: 'jiazhang2026'
      })

      await send(harness.url, '/auth/login-account', {
        body: { identifier: '13800138000', password: 'wrong-one-2026' }
      })

      assert.equal(harness.identity.issued.length, 0)
      assert.equal(harness.sessions.rows.size, 0)
    })

    it('★ 账号被停用 ⇒ 403（密码是对的，问题不在凭据）', async () => {
      await harness.identity.seed({
        userId: 'u-off',
        phone: '13800138000',
        password: 'jiazhang2026',
        status: 'suspended'
      })

      const res = await send(harness.url, '/auth/login-account', {
        body: { identifier: '13800138000', password: 'jiazhang2026' }
      })

      assert.equal(res.status, 403, res.text)
      assert.equal(res.body.code, 'USER_NOT_ACTIVE')
    })
  })

  // ═══════════════ C. 形状错 ═══════════════
  describe('C. 形状错 ⇒ 400，且不碰库', () => {
    it('标识不是手机号也不是邮箱 ⇒ 400 INVALID_IDENTIFIER + 具体原因', async () => {
      const res = await send(harness.url, '/auth/login-account', {
        body: { identifier: '12345', password: 'jiazhang2026' }
      })

      assert.equal(res.status, 400, res.text)
      assert.equal(res.body.code, 'INVALID_IDENTIFIER')
      assert.equal(res.body.reason, 'PHONE_FORMAT')
      assert.equal(harness.sessions.rows.size, 0)
    })

    it('空标识 / 超长密码 ⇒ 400（DTO 层就拦下，不进 service）', async () => {
      const empty = await send(harness.url, '/auth/login-account', {
        body: { identifier: '', password: 'jiazhang2026' }
      })
      assert.equal(empty.status, 400)

      const long = await send(harness.url, '/auth/login-account', {
        body: { identifier: '13800138000', password: 'a'.repeat(65) }
      })
      assert.equal(long.status, 400)
    })

    it('多余字段 ⇒ 400（集合封闭：`{ identifier, password, userId }` 不许通过）', async () => {
      const res = await send(harness.url, '/auth/login-account', {
        body: { identifier: '13800138000', password: 'jiazhang2026', userId: 'u-dad' }
      })
      assert.equal(res.status, 400, res.text)
    })
  })

  // ═══════════════ D. 绑定（PUT /auth/account）═══════════════
  describe('D. 绑定手机号/邮箱 + 设密码', () => {
    it('没有 Bearer ⇒ 401（匿名可写 = 账号接管）', async () => {
      const res = await send(harness.url, '/auth/account', {
        method: 'PUT',
        body: { phone: '13800138000', password: 'jiazhang2026' }
      })
      assert.equal(res.status, 401, res.text)
    })

    it('★ 绑定 + 设密码 ⇒ 200，且**规范化后**落库（绑完立刻能登）', async () => {
      await harness.identity.seed({ userId: 'u-new' })
      const token = harness.sessions.put('u-new')

      const res = await send(harness.url, '/auth/account', {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: { phone: '+86 138-0013-8000', password: 'jiazhang2026' }
      })

      assert.equal(res.status, 200, res.text)
      assert.deepEqual(res.body, { phone: '13800138000', email: null, hasPassword: true })

      // ★ 闭环：返回的是这个号，就一定能用它登进去（写/读同一处规范化）
      const login = await send(harness.url, '/auth/login-account', {
        body: { identifier: '138 0013 8000', password: 'jiazhang2026' }
      })
      assert.equal(login.status, 200, login.text)
    })

    it('★ 手机号已被别人绑定 ⇒ 409 IDENTIFIER_TAKEN（不是 400）', async () => {
      await harness.identity.seed({
        userId: 'u-other',
        phone: '13800138000',
        password: 'jiazhang2026'
      })
      await harness.identity.seed({ userId: 'u-new' })
      const token = harness.sessions.put('u-new')

      const res = await send(harness.url, '/auth/account', {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: { phone: '138 0013 8000' }
      })

      assert.equal(res.status, 409, res.text)
      assert.equal(res.body.code, 'IDENTIFIER_TAKEN')
      assert.equal(res.body.field, 'phone')
    })

    it('空 body ⇒ 400 ACCOUNT_NOTHING_TO_UPDATE（不静默 200）', async () => {
      await harness.identity.seed({ userId: 'u-new' })
      const token = harness.sessions.put('u-new')

      const res = await send(harness.url, '/auth/account', {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: {}
      })

      assert.equal(res.status, 400, res.text)
      assert.equal(res.body.code, 'ACCOUNT_NOTHING_TO_UPDATE')
    })

    it('弱密码 ⇒ 400 WEAK_PASSWORD + 具体原因（含"与手机号相同"）', async () => {
      await harness.identity.seed({ userId: 'u-new' })
      const token = harness.sessions.put('u-new')
      const headers = { authorization: `Bearer ${token}` }

      const tooShort = await send(harness.url, '/auth/account', {
        method: 'PUT',
        headers,
        body: { password: 'a1b2c3' }
      })
      assert.equal(tooShort.status, 400, tooShort.text)
      assert.equal(tooShort.body.reason, 'TOO_SHORT')

      const sameAsPhone = await send(harness.url, '/auth/account', {
        method: 'PUT',
        headers,
        body: { phone: '13800138000', password: '13800138000' }
      })
      assert.equal(sameAsPhone.status, 400, sameAsPhone.text)
      assert.equal(sameAsPhone.body.reason, 'SAME_AS_IDENTIFIER')
    })
  })

  // ═══════════════ E. 改密码 ═══════════════
  describe('D2. 读绑定状态（GET /auth/account）', () => {
    it('没有 Bearer ⇒ 401（否则成了「按手机号探测是否注册」的接口）', async () => {
      const res = await send(harness.url, '/auth/account')
      assert.equal(res.status, 401, res.text)
    })

    it('★ 全新账号 ⇒ 200 且三字段是「还没绑」，不是 404 / 403', async () => {
      await harness.identity.seed({ userId: 'u-new' })
      const token = harness.sessions.put('u-new')

      const res = await send(harness.url, '/auth/account', {
        headers: { authorization: `Bearer ${token}` }
      })

      assert.equal(res.status, 200, res.text)
      // ★ 这三个字段同时为空是**合法**的：说明这个账号还没绑 App 登录。
      //   小程序那一屏据此显示「还没有 App 登录账号」而不是空白表单。
      assert.deepEqual(res.body, { phone: null, email: null, hasPassword: false })
    })

    it('★ 绑过之后读到的是**规范化**后的值（与登录时用的是同一份）', async () => {
      await harness.identity.seed({
        userId: 'u-dad',
        phone: '13800138000',
        password: 'jiazhang2026'
      })
      const token = harness.sessions.put('u-dad')

      const res = await send(harness.url, '/auth/account', {
        headers: { authorization: `Bearer ${token}` }
      })

      assert.equal(res.status, 200, res.text)
      assert.deepEqual(res.body, { phone: '13800138000', email: null, hasPassword: true })
    })

    it('只绑邮箱、没有密码 ⇒ hasPassword:false（决定界面写「设置」还是「修改」）', async () => {
      await harness.identity.seed({ userId: 'u-mail', email: 'dad@example.com' })
      const token = harness.sessions.put('u-mail')

      const res = await send(harness.url, '/auth/account', {
        headers: { authorization: `Bearer ${token}` }
      })

      assert.equal(res.status, 200, res.text)
      assert.deepEqual(res.body, { phone: null, email: 'dad@example.com', hasPassword: false })
    })

    it('★ 只读到**自己**那一行，且响应里没有任何哈希', async () => {
      await harness.identity.seed({
        userId: 'u-a',
        phone: '13800138000',
        password: 'jiazhang2026'
      })
      await harness.identity.seed({
        userId: 'u-b',
        phone: '13900139000',
        password: 'jiazhang2026'
      })
      const token = harness.sessions.put('u-a')

      const res = await send(harness.url, '/auth/account', {
        headers: { authorization: `Bearer ${token}` }
      })

      assert.equal(res.body.phone, '13800138000')
      // 集合封闭：多一个字段就意味着有人往 `AccountView` 里塞了别的东西。
      assert.deepEqual(Object.keys(res.body).sort(), ['email', 'hasPassword', 'phone'])
      assert.equal(res.text.includes('scrypt'), false)
    })

    it('账号被停用 ⇒ 403（不是 200 空值，也不是 404）', async () => {
      await harness.identity.seed({ userId: 'u-off', status: 'disabled' })
      const token = harness.sessions.put('u-off')

      const res = await send(harness.url, '/auth/account', {
        headers: { authorization: `Bearer ${token}` }
      })

      assert.equal(res.status, 403, res.text)
      assert.equal(res.body.code, 'USER_NOT_ACTIVE')
    })
  })

  describe('E. 改密码', () => {
    it('已设过密码但没带 currentPassword ⇒ 400 CURRENT_PASSWORD_REQUIRED', async () => {
      await harness.identity.seed({
        userId: 'u-dad',
        phone: '13800138000',
        password: 'jiazhang2026'
      })
      const token = harness.sessions.put('u-dad')

      const res = await send(harness.url, '/auth/account', {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: { password: 'xinde2026mima' }
      })

      assert.equal(res.status, 400, res.text)
      assert.equal(res.body.code, 'CURRENT_PASSWORD_REQUIRED')
    })

    it('currentPassword 错 ⇒ 403 CURRENT_PASSWORD_INVALID（不是 401：他不是要重登）', async () => {
      await harness.identity.seed({
        userId: 'u-dad',
        phone: '13800138000',
        password: 'jiazhang2026'
      })
      const token = harness.sessions.put('u-dad')

      const res = await send(harness.url, '/auth/account', {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}` },
        body: { password: 'xinde2026mima', currentPassword: 'wrong-one-2026' }
      })

      assert.equal(res.status, 403, res.text)
      assert.equal(res.body.code, 'CURRENT_PASSWORD_INVALID')
    })

    it('★ 改密成功 ⇒ 踢掉其它会话、保留当前这条；新密码立刻生效', async () => {
      await harness.identity.seed({
        userId: 'u-dad',
        phone: '13800138000',
        password: 'jiazhang2026'
      })
      const current = harness.sessions.put('u-dad')
      const other = harness.sessions.put('u-dad')

      const res = await send(harness.url, '/auth/account', {
        method: 'PUT',
        headers: { authorization: `Bearer ${current}` },
        body: { password: 'xinde2026mima', currentPassword: 'jiazhang2026' }
      })
      assert.equal(res.status, 200, res.text)

      const stillMine = await send(harness.url, '/auth/session', {
        headers: { authorization: `Bearer ${current}` }
      })
      assert.equal(stillMine.status, 200, '改密码把自己的这条会话也踢掉了')

      const kicked = await send(harness.url, '/auth/session', {
        headers: { authorization: `Bearer ${other}` }
      })
      assert.equal(kicked.status, 401)
      assert.equal(kicked.body.code, 'TOKEN_INVALID')

      const oldPassword = await send(harness.url, '/auth/login-account', {
        body: { identifier: '13800138000', password: 'jiazhang2026' }
      })
      assert.equal(oldPassword.status, 401)

      const newPassword = await send(harness.url, '/auth/login-account', {
        body: { identifier: '13800138000', password: 'xinde2026mima' }
      })
      assert.equal(newPassword.status, 200, newPassword.text)
    })
  })

  // ═══════════════ F. 限流 ═══════════════
  describe('F. 限流（与微信登录共用额度）', () => {
    it('同一设备超过额度 ⇒ 429 LOGIN_RATE_LIMITED', async () => {
      await harness.identity.seed({
        userId: 'u-dad',
        phone: '13800138000',
        password: 'jiazhang2026'
      })

      let last: HttpResult | undefined
      for (let i = 0; i <= LOGIN_RATE_LIMIT_PER_DEVICE; i += 1) {
        last = await send(harness.url, '/auth/login-account', {
          headers: { 'x-kp-device-id': 'dev-limit' },
          body: { identifier: '13800138000', password: 'wrong-one-2026' }
        })
      }

      assert.equal(last?.status, 429, last?.text)
      assert.equal(last?.body.code, 'LOGIN_RATE_LIMITED')
    })
  })
})

/**
 * identity-http.test.ts —— **登录 / 认证会话**的集成测试（W9-A，2026-10-29）
 *                            （真起 Nest ＋ 真发 HTTP 请求）
 *
 * ── 这一步在修什么 ─────────────────────────────────────────────────────────
 *   W1-C 之后"角色与身份由服务端会话行给出"，但**设备凭据仍不可验证**：
 *   `x-kp-device-id` 谁都能报，于是"知道别人的 deviceId"＝"以那个家长的身份操作"。
 *   W9-A 把凭据换成 `AuthSession` 里的**不透明 token**（`kps_<43 位 base64url>`），
 *   设备头降级成**选择器**。本文件测的就是这条链路的**接线**与**错误码的形状**。
 *
 * ── 为什么必须走 HTTP（而不是只测纯函数）───────────────────────────────────
 *   判定内核已经在 `test/auth-session-gate.test.ts` 里穷举过；
 *   这里只钉"接线"这一层 —— 而这层恰好是最容易静默出错的地方：
 *     · `APP_GUARD` 有没有注册、`@Public()` 有没有被读到（`Reflector` 拿错 handler）；
 *     · `@UseGuards(AuthGuard)` 与全局守卫**同时**存在时会不会把身份丢掉；
 *     · 微信的五类结局有没有被翻成**五个不同的**状态码（最容易做错的是
 *       `40125` 报成 401，那会让所有人朝"用户登录失败"排查）；
 *     · 401 `TOKEN_INVALID` / 401 `TOKEN_EXPIRED` / 500 `SESSION_SHAPE_INVALID`
 *       三者有没有真的分开（合成一个码，家长换手机就会看到登录页）。
 *
 * ── ⚠️ 诚实标注 ────────────────────────────────────────────────────────────
 *   ① 本文件的仓库是**内存替身**（验接线 / 状态码 / 不泄漏）；真 Prisma 的两半证据
 *      在别处：`test-db/auth-session-db.dbtest.ts`（并发登录 ⇒ 只有一个 User）；
 *   ② **限流是进程内的**（`LoginRateLimiter` 的注释写清了取舍）：多实例部署时
 *      每个实例各有 10/min，本文件只证"单实例内生效"；
 *   ③ 本文件**不**测"微信真的回了 40029" —— 那是网络契约，靠
 *      `wechat-code2session.http.ts` 的分类表 + `wechat-errors.ts` 的单测。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import { PARENT_MODE_TTL_MS } from '../src/auth/parent-mode.policy'
import {
  AUTH_SESSION_TTL_MS,
  authSessionExpiresAt,
  hashToken,
  issueToken,
  type AuthSessionRow
} from '../src/identity/auth-session.gate'
import {
  AUTH_SESSION_REPOSITORY,
  type AuthSessionPort
} from '../src/identity/auth-session.repository'
import { CHILD_SESSION_TTL_MS } from '../src/identity/identity.prisma.repository'
import {
  IDENTITY_REPOSITORY,
  type BootstrapChildInput,
  type ChildMembershipRow,
  type EnsureChildSessionInput,
  type IdentityPort,
  type LoginUserRow,
  type LoginWithOpenIdInput
} from '../src/identity/identity.repository'
import { IdentityModule } from '../src/identity/identity.module'
import { LoginRateLimiter, LOGIN_RATE_LIMIT_PER_DEVICE } from '../src/identity/login-rate-limiter'
import { WECHAT_CODE2SESSION } from '../src/identity/wechat/wechat-code2session.port'
import { makeWechatFake, type WechatFake } from './support/wechat-fake'

interface HttpResult {
  status: number
  body: Record<string, unknown>
  text: string
}

/**
 * 发一个请求。
 *
 * ★ 头名统一小写：`fetch` 会原样送出，而 Nest 的 `req.headers` 恒小写。
 *   用例里若写 `X-Kp-Device-Id`，"头名大小写对不对"就会混进每一条断言里。
 */
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
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body, text }
}

// ── 内存替身一：认证会话（AuthSessionPort）────────────────────────────────────
interface AuthSessionFake extends AuthSessionPort {
  /** key = tokenHash（与真表一致：唯一键也是它）。 */
  rows: Map<string, AuthSessionRow>
  /** 收到的查询键（用来证明"形状不对时不该查库"这类断言）。 */
  queries: string[]
  touches: string[]
  revokes: Array<{ tokenHash: string; reason: string }>
  puts: AuthSessionRow[]
  /** 造一行会话（`overrides` 可把 `method` 写坏、把 `expiresAt` 设成过去）。 */
  put(overrides?: Partial<AuthSessionRow> & { token?: string }): AuthSessionRow
  /**
   * ★ 模拟**适配器写歪**：忽略入参、返回第一行。
   *   内核的 `TOKEN_HASH_MISMATCH` 就是为这一族病留的 —— 组 C 用它证明那条守卫不是装饰。
   */
  ignoreTokenHash(on: boolean): void
}

function makeAuthSessionFake(onRow?: (row: AuthSessionRow) => void): AuthSessionFake {
  let ignoring = false
  const fake: AuthSessionFake = {
    rows: new Map<string, AuthSessionRow>(),
    queries: [],
    touches: [],
    revokes: [],
    puts: [],
    put(overrides = {}) {
      const token = overrides.token ?? issueToken()
      const tokenHash = overrides.tokenHash ?? hashToken(token)
      const now = new Date()
      const row: AuthSessionRow = {
        id: overrides.id ?? `as-${fake.puts.length + 1}`,
        userId: overrides.userId ?? 'u-dad',
        tokenHash,
        method: overrides.method ?? 'wechat_mp',
        deviceId: overrides.deviceId ?? null,
        issuedAt: overrides.issuedAt ?? now,
        lastSeenAt: overrides.lastSeenAt ?? now,
        expiresAt: overrides.expiresAt ?? authSessionExpiresAt(now),
        revokedAt: overrides.revokedAt ?? null
      }
      fake.rows.set(row.tokenHash, row)
      fake.puts.push(row)
      // `token` 只用于让用例能拼出 Authorization 头（真表里**没有**这一列）。
      Object.defineProperty(row, 'token', { value: token, enumerable: false })
      onRow?.(row)
      return row
    },
    ignoreTokenHash(on) {
      ignoring = on
    },
    async findByTokenHash(tokenHash) {
      this.queries.push(tokenHash)
      if (ignoring) return [...this.rows.values()][0] ?? null
      return this.rows.get(tokenHash) ?? null
    },
    async create(input) {
      const now = new Date()
      const row: AuthSessionRow = {
        id: `as-created-${this.rows.size + 1}`,
        userId: input.userId,
        tokenHash: input.tokenHash,
        method: input.method,
        deviceId: input.deviceId,
        issuedAt: now,
        lastSeenAt: now,
        expiresAt: input.expiresAt,
        revokedAt: null
      }
      this.rows.set(row.tokenHash, row)
      onRow?.(row)
    },
    async touch(tokenHash, now) {
      this.touches.push(tokenHash)
      const row = this.rows.get(tokenHash)
      // ★ 只动 `lastSeenAt`：动 `expiresAt` 就是滑动窗口（`40` §4.3 禁止）。
      if (row !== undefined) row.lastSeenAt = now
    },
    async revoke(tokenHash) {
      this.revokes.push({ tokenHash, reason: 'test' })
      const row = this.rows.get(tokenHash)
      if (row === undefined || row.revokedAt !== null) return false
      row.revokedAt = new Date()
      return true
    }
  }
  return fake
}

/** 取出替身造行时记下的明文 token（只用于拼请求头）。 */
function tokenOf(row: AuthSessionRow): string {
  const value = (row as unknown as { token?: string }).token
  assert.equal(typeof value, 'string', '替身没有记下明文 token —— 用例无法构造请求头')
  return value as string
}

/** 拼 `Authorization` 头。 */
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

// ── 内存替身二：身份写路径（IdentityPort）────────────────────────────────────
interface IdentityFake extends IdentityPort {
  logins: LoginWithOpenIdInput[]
  bootstraps: BootstrapChildInput[]
  childSessions: EnsureChildSessionInput[]
  users: Map<string, LoginUserRow>
  children: Map<string, ChildMembershipRow[]>
  /** 让 `ensureChildSession` 回一个**非法**角色（验 500 `MEMBER_ROLE_INVALID`）。 */
  roleOverride: string | null
}

function makeIdentityFake(sessions: AuthSessionFake): IdentityFake {
  return {
    logins: [],
    bootstraps: [],
    childSessions: [],
    users: new Map<string, LoginUserRow>(),
    children: new Map<string, ChildMembershipRow[]>(),
    roleOverride: null,
    async loginWithOpenId(input) {
      this.logins.push(input)
      const userId = `u-${input.openId}`
      const user: LoginUserRow = { userId, displayName: '家长' }
      this.users.set(userId, user)
      // ★ 真适配器把 `User` upsert 与 `AuthSession` 写在**同一事务**里
      //   （`identity.prisma.repository.ts`）；替身也必须让两件事一起发生，
      //   否则"登录成功但会话没落库"这种错误在本文件里根本看不见。
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
      return this.users.get(userId) ?? null
    },
    async listChildren(userId) {
      return this.children.get(userId) ?? []
    },
    async bootstrapChild(input) {
      this.bootstraps.push(input)
      return { childId: 'child-new', role: 'guardian' as const, parentModeUntil: input.parentModeUntil }
    },
    async ensureChildSession(input) {
      this.childSessions.push(input)
      return {
        role: this.roleOverride ?? 'guardian',
        sessionExpiresAt: input.sessionExpiresAt
      }
    }
  }
}

// ── 装配 ─────────────────────────────────────────────────────────────────────
interface Harness {
  app: INestApplication
  url: string
  sessions: AuthSessionFake
  identity: IdentityFake
  wechat: WechatFake
}

/**
 * 起一个**只有身份层**的真服务。
 *
 * ★ `hasDatabase: false` 是刻意的：本文件测的是接线与状态码，替身已经足够；
 *   而"有库装配是否真写库"由 `test-db/auth-session-db.dbtest.ts` 证（那里才有真事务）。
 *   用 `false` 还有一个好处：**它证明了无库装配下那些 501 不会被本文件掩盖** ——
 *   三条 provider 全被 override，所以这里连 `NotImplemented*` 都不会被实例化。
 * ★ `wechatConfigured: true` + override `WECHAT_CODE2SESSION`：走"配了凭据"的分支，
 *   但真实现（`HttpWechatCode2Session`）被替身换掉 ⇒ 不会碰外网。
 */
async function startApp(): Promise<Harness> {
  // ★ 两个替身互相需要：`put()` 造出来的会话行必须对应一个"存在的用户"
  //   （否则 `/auth/session` 会走 403 `USER_NOT_ACTIVE`，测到的就不是本意的事）。
  let userHost: IdentityFake | undefined
  const sessions = makeAuthSessionFake((row) => {
    userHost?.users.set(row.userId, { userId: row.userId, displayName: '家长' })
  })
  const identity = makeIdentityFake(sessions)
  userHost = identity
  const wechat = makeWechatFake()
  const moduleRef = await Test.createTestingModule({
    imports: [IdentityModule.register({ hasDatabase: false, wechatConfigured: true })]
  })
    .overrideProvider(AUTH_SESSION_REPOSITORY)
    .useValue(sessions)
    .overrideProvider(IDENTITY_REPOSITORY)
    .useValue(identity)
    .overrideProvider(WECHAT_CODE2SESSION)
    .useValue(wechat)
    .compile()

  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app) // ★ 与 main.ts 同一函数：测的是**真装配**（`@Public()` / 白名单都靠它）
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl(), sessions, identity, wechat }
}

/** 临时改环境变量（`AUTH_DEVICE_ID_FALLBACK` / `NODE_ENV`），跑完必定还原。 */
async function withEnv(
  patch: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ── 组 A：身份来自 **token**，不是设备头 ──────────────────────────────────────
describe('组 A：`GET /auth/session` 的身份只来自 Bearer token（40 §9.1）', () => {
  let app!: INestApplication
  let url = ''
  let sessions!: AuthSessionFake
  let identity!: IdentityFake

  before(async () => {
    ;({ app, url, sessions, identity } = await startApp())
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    sessions.rows.clear()
    sessions.puts.length = 0
    sessions.touches.length = 0
    sessions.queries.length = 0
    identity.children.clear()
  })

  it('★ 没有 Authorization ⇒ 401 UNAUTHENTICATED（**不是** TOKEN_INVALID）', async () => {
    // ★ 两者必须分开：`UNAUTHENTICATED` = 根本没登过（引导登录页）；
    //   `TOKEN_INVALID` = 掉登了（清 token）。合成一个码，客户端无法区分
    //   "第一次打开小程序" 与 "服务器把我会话弄丢了"，只能一律弹登录。
    const r = await send(url, '/auth/session')
    assert.equal(r.status, 401)
    assert.equal(
      r.body.code,
      'UNAUTHENTICATED',
      '无 token 被报成了别的码 —— 客户端会把它当成"掉登"，而它其实是"还没登"'
    )
  })

  it('★ 双读期旁路被关掉时，缺口也必须是 401 UNAUTHENTICATED（由 AuthGuard 直接拒）', async () => {
    await withEnv({ AUTH_DEVICE_ID_FALLBACK: '0' }, async () => {
      const r = await send(url, '/auth/session', { headers: { 'x-kp-device-id': 'dev-dad' } })
      assert.equal(r.status, 401, '`x-kp-device-id` 单独出现就放行了 —— 那就是提权后门')
      assert.equal(r.body.code, 'UNAUTHENTICATED')
    })
  })

  it('合法 token ⇒ 200，且身份取自会话行（`userId` 来自库里，不是客户端）', async () => {
    const row = sessions.put({ userId: 'u-dad' })
    identity.children.set('u-dad', [{ childId: 'child-1', name: '小明', role: 'guardian' }])

    const r = await send(url, '/auth/session', {
      headers: { ...bearer(tokenOf(row)), 'x-kp-device-id': 'dev-other-device' }
    })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.user, { id: 'u-dad', displayName: '家长' })
    assert.deepEqual(r.body.children, [{ childId: 'child-1', name: '小明', role: 'guardian' }])
    // 7 天**绝对**到期：本请求不能改变它（§4.3 不滑动）。
    assert.equal(r.body.expiresAt, row.expiresAt instanceof Date ? row.expiresAt.toISOString() : row.expiresAt)
  })

  it('每次请求都会（异步）刷 `lastSeenAt`，但**不动** `expiresAt`', async () => {
    const row = sessions.put({ userId: 'u-dad' })
    const before = row.expiresAt
    await send(url, '/auth/session', { headers: bearer(tokenOf(row)) })
    // `void … .catch()` 是异步的 —— 给事件循环一拍（不 sleep 一个固定毫秒）。
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(sessions.touches, [row.tokenHash], '`lastSeenAt` 没有被刷新')
    assert.equal(row.expiresAt, before, '`expiresAt` 被改了 —— 那就是滑动窗口（§4.3 禁止）')
  })

  it('有会话行但用户已停用 ⇒ 403 USER_NOT_ACTIVE（不是 401：重登也发不出凭据）', async () => {
    const row = sessions.put({ userId: 'u-gone' })
    identity.users.delete('u-gone') // 停用：会话行还在，用户已不可用
    const r = await send(url, '/auth/session', { headers: bearer(tokenOf(row)) })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'USER_NOT_ACTIVE')
  })
})

// ── 组 B：四个拒绝码必须**可分** ───────────────────────────────────────────────
describe('组 B：401 与 500 的边界（`40` §9.3 的表逐行）', () => {
  let app!: INestApplication
  let url = ''
  let sessions!: AuthSessionFake

  before(async () => {
    ;({ app, url, sessions } = await startApp())
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    sessions.rows.clear()
    sessions.puts.length = 0
    sessions.queries.length = 0
    sessions.ignoreTokenHash(false)
  })

  it('★ 已到期 ⇒ 401 TOKEN_EXPIRED（客户端可静默重登一次）', async () => {
    const row = sessions.put({ expiresAt: new Date(Date.now() - 1_000) })
    const r = await send(url, '/auth/session', { headers: bearer(tokenOf(row)) })
    assert.equal(r.status, 401)
    // ★ 与 `TOKEN_INVALID` 必须分开：`TOKEN_EXPIRED` 的客户端动作是
    //   "静默重新 wx.login() 后重放原请求**一次**"；`TOKEN_INVALID` 是"清 token"。
    //   合成一个码，家长在 7 天后的第一次点击会被弹到登录页（体验断层）。
    assert.equal(r.body.code, 'TOKEN_EXPIRED')
  })

  it('已撤销（登出过）⇒ 401 TOKEN_INVALID', async () => {
    const row = sessions.put({ revokedAt: new Date() })
    const r = await send(url, '/auth/session', { headers: bearer(tokenOf(row)) })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'TOKEN_INVALID')
  })

  it('库里没有这个 token ⇒ 401 TOKEN_INVALID', async () => {
    const r = await send(url, '/auth/session', { headers: bearer(issueToken()) })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'TOKEN_INVALID')
  })

  it('token 形状不对（不是 `kps_` 前缀）⇒ 401 TOKEN_INVALID，且**不查库**', async () => {
    sessions.queries.length = 0
    const r = await send(url, '/auth/session', { headers: bearer('abc.def.ghi') })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'TOKEN_INVALID')
    // 形状错就不该落库：省一次查询，而且"把 64 位垃圾当哈希去查"只是噪音。
    assert.deepEqual(sessions.queries, [], '形状不合法的 token 被拿去查库了')
  })

  it('重复的 Authorization 头 ⇒ 401 TOKEN_INVALID（不猜哪个有效）', async () => {
    const row = sessions.put({})
    const r = await fetch(`${url}/auth/session`, {
      headers: [
        ['authorization', `Bearer ${tokenOf(row)}`],
        ['authorization', `Bearer ${issueToken()}`]
      ]
    })
    assert.equal(r.status, 401)
    assert.equal(((await r.json()) as Record<string, unknown>).code, 'TOKEN_INVALID')
  })

  it('★ `method` 不在白名单 ⇒ **500** SESSION_SHAPE_INVALID（不是 401）', async () => {
    const row = sessions.put({ method: 'sms' })
    const r = await send(url, '/auth/session', { headers: bearer(tokenOf(row)) })
    assert.equal(r.status, 500, '数据坏被报成了 401 —— 用户会反复重登，而病在数据')
    assert.equal(r.body.code, 'SESSION_SHAPE_INVALID')
    assert.equal(r.body.detail, 'INVALID_AUTH_METHOD')
  })

  it('★ 适配器没按 tokenHash 查（返回了别人的行）⇒ **500** SESSION_SHAPE_INVALID', async () => {
    // 若这里回 200，那就是"任意一个有效 token 都能换到别人的身份"。
    sessions.put({ userId: 'u-victim' })
    sessions.ignoreTokenHash(true)
    const r = await send(url, '/auth/session', { headers: bearer(issueToken()) })
    assert.equal(r.status, 500)
    assert.equal(r.body.code, 'SESSION_SHAPE_INVALID')
    assert.equal(r.body.detail, 'TOKEN_HASH_MISMATCH')
  })
})

// ── 组 C：`POST /auth/login` ───────────────────────────────────────────────────
describe('组 C：`POST /auth/login`（`40` §8.1 / §11.2）', () => {
  let harness!: Harness

  before(async () => {
    harness = await startApp()
  })
  after(async () => {
    await harness.app.close()
  })
  beforeEach(() => {
    harness.sessions.rows.clear()
    harness.sessions.puts.length = 0
    harness.identity.logins.length = 0
    harness.identity.children.clear()
    harness.wechat.reset()
  })

  it('★ 它是 `@Public()` 的：关掉双读期旁路、不带任何凭据 ⇒ 仍然 200', async () => {
    // 这一条钉的是 `@Public()` 装饰器真的被 `Reflector` 读到了。
    // 去掉 `@Public()`，本用例会变成 401 —— 而"登录接口要求登录"是自举死锁
    // （客户端永远拿不到第一个 token），却**不会**让任何其它用例变红。
    await withEnv({ AUTH_DEVICE_ID_FALLBACK: '0' }, async () => {
      const r = await send(harness.url, '/auth/login', { body: { code: 'js-code-public' } })
      assert.equal(r.status, 200, '登录接口不再是匿名可达 —— 客户端拿不到第一个 token')
    })
  })

  it('200 的形状：token 只在响应里出现一次，库里只有 sha256', async () => {
    const before = Date.now()
    const r = await send(harness.url, '/auth/login', {
      body: { code: 'js-code-1' },
      headers: { 'x-kp-device-id': 'dev-dad' }
    })
    assert.equal(r.status, 200)

    const token = r.body.token as string
    assert.match(token, /^kps_[A-Za-z0-9_-]{43}$/, 'token 形状不是 kps_<43 位 base64url>')

    const login = harness.identity.logins[0]
    assert.ok(login !== undefined)
    // ★ 落库的是哈希：`AuthSession.tokenHash`。明文只存在于响应体（§11.2）。
    assert.equal(login.tokenHash, hashToken(token))
    assert.notEqual(login.tokenHash, token, '明文 token 进了仓库 —— 库一旦泄露就是全员掉号')
    assert.equal(login.method, 'wechat_mp')
    assert.equal(login.deviceId, 'dev-dad', '设备标识应当只作为审计字段传下去')

    // 会话真的写进去了（不是只在回包里成立）。
    assert.deepEqual([...harness.sessions.rows.keys()], [hashToken(token)])
    assert.deepEqual(r.body.user, { id: 'u-o-default-openid', displayName: '家长' })

    // 7 天**绝对**到期（容差 5 秒：用例可能跨秒）。
    const expiresAt = Date.parse(r.body.expiresAt as string)
    assert.ok(Math.abs(expiresAt - (before + AUTH_SESSION_TTL_MS)) < 5_000, '有效期不是 7 天')
  })

  it('membership：有成员位 ⇒ 首个孩子；没有 ⇒ `null`（客户端据此决定要不要走 bootstrap）', async () => {
    const none = await send(harness.url, '/auth/login', {
      body: { code: 'c-1' },
      headers: { 'x-kp-device-id': 'dev-1' }
    })
    assert.equal(harness.wechat.codes.at(-1), 'c-1')
    // 新用户（`u-o-default-openid`）没有任何成员位。
    assert.equal(none.body.membership, null)

    harness.wechat.enqueue({ kind: 'OK', openId: '爸爸' })
    harness.identity.children.set('u-爸爸', [{ childId: 'child-9', name: '小明', role: 'guardian' }])
    const some = await send(harness.url, '/auth/login', {
      body: { code: 'c-2' },
      headers: { 'x-kp-device-id': 'dev-2' }
    })
    assert.deepEqual(some.body.membership, { childId: 'child-9', role: 'guardian' })
  })

  it('每次登录都签发**新** token（会话固定防护，§11.3）', async () => {
    const a = await send(harness.url, '/auth/login', { body: { code: 'x1' } })
    const b = await send(harness.url, '/auth/login', { body: { code: 'x2' } })
    assert.notEqual(a.body.token, b.body.token, '同一个 openId 两次登录拿到同一个 token')
    assert.equal(harness.sessions.rows.size, 2, '第二条会话没有落库 ⇒ 只支持单设备登录')
  })

  it('微信五类结局 ⇒ 五个**不同**的状态码（401 / 429 / 500 / 503 / 502）', async () => {
    const cases: Array<{
      outcome: Parameters<WechatFake['enqueue']>[0]
      status: number
      code: string
      why: string
    }> = [
      {
        outcome: { kind: 'CODE_INVALID', errcode: 40029 },
        status: 401,
        code: 'WECHAT_CODE_INVALID',
        why: 'code 过期/已用过：客户端重新 wx.login() 再试一次即可'
      },
      {
        outcome: { kind: 'RATE_LIMITED', errcode: 45011 },
        status: 429,
        code: 'LOGIN_RATE_LIMITED',
        why: '微信侧限流：必须退避，**不要**自动重试'
      },
      {
        outcome: { kind: 'CREDENTIAL_INVALID', errcode: 40125 },
        status: 500,
        code: 'WECHAT_CREDENTIAL_INVALID',
        why: '★ 我们的 AppSecret 错了：报 401 会让所有人朝"用户登录失败"排查'
      },
      {
        outcome: { kind: 'NOT_CONFIGURED', missing: ['WECHAT_MP_SECRET'] },
        status: 503,
        code: 'WECHAT_NOT_CONFIGURED',
        why: '部署没配凭据：501 会被读成"接口不存在"（永久）'
      },
      {
        outcome: { kind: 'UNAVAILABLE', detail: 'timeout' },
        status: 502,
        code: 'WECHAT_UNAVAILABLE',
        why: '外网故障：502 可以退避重试，500 会被当成我们的 bug'
      }
    ]

    for (const item of cases) {
      harness.wechat.enqueue(item.outcome)
      const r = await send(harness.url, '/auth/login', { body: { code: 'js' } })
      assert.equal(r.status, item.status, `${item.outcome.kind} 的状态码不对 —— ${item.why}`)
      assert.equal(r.body.code, item.code, `${item.outcome.kind} 的错误码不是 ${item.code}`)
    }

    // 一次都没有签发成功 ⇒ 一行会话都不该存在。
    assert.equal(harness.sessions.rows.size, 0, '失败路径写了会话行')
    assert.equal(harness.identity.logins.length, 0, '失败路径调用了 loginWithOpenId')
  })

  it('请求体不合法（缺 code）⇒ 400，且**不碰**微信', async () => {
    const r = await send(harness.url, '/auth/login', { body: {} })
    assert.equal(r.status, 400)
    assert.deepEqual(harness.wechat.codes, [], 'DTO 校验失败后仍然去打了微信')
  })
})

// ── 组 D：登录限流（`40` §11.1）───────────────────────────────────────────────
describe('组 D：`POST /auth/login` 的限流（10 次/分钟/设备）', () => {
  let harness!: Harness

  before(async () => {
    harness = await startApp()
  })
  after(async () => {
    await harness.app.close()
  })
  beforeEach(() => {
    // ★ 限流器是**进程内单例**：不清空的话，组 D 的额度会被别的 describe 吃掉
    //   （本文件里的其它组都用"每次一个不同 deviceId"避开同一份额度）。
    harness.app.get(LoginRateLimiter).reset()
    harness.sessions.rows.clear()
    harness.wechat.reset()
  })

  it(`同一设备第 ${LOGIN_RATE_LIMIT_PER_DEVICE + 1} 次 ⇒ 429，且**不再**打微信`, async () => {
    const headers = { 'x-kp-device-id': 'dev-hammer' }
    for (let i = 0; i < LOGIN_RATE_LIMIT_PER_DEVICE; i += 1) {
      const ok = await send(harness.url, '/auth/login', { body: { code: `c${i}` }, headers })
      assert.equal(ok.status, 200, `第 ${i + 1} 次被拦了 —— 额度少于文档写的 10 次`)
    }
    const callsBefore = harness.wechat.codes.length

    const blocked = await send(harness.url, '/auth/login', { body: { code: 'c-last' }, headers })
    assert.equal(blocked.status, 429)
    assert.equal(blocked.body.code, 'LOGIN_RATE_LIMITED')
    assert.equal(blocked.body.scope, 'device')
    assert.ok(Number(blocked.body.retryAfterSeconds) >= 1)

    // ★ 限流在**碰外网之前**：否则攻击者仍能用我们当探测器（每次一次微信调用）。
    assert.equal(harness.wechat.codes.length, callsBefore, '被限流的请求仍然去打了微信')
  })

  it('换一台设备 ⇒ 重新有额度（限额按设备，不是全局）', async () => {
    const r = await send(harness.url, '/auth/login', {
      body: { code: 'c-fresh' },
      headers: { 'x-kp-device-id': 'dev-fresh' }
    })
    assert.equal(r.status, 200)
  })
})

// ── 组 E：`POST /auth/logout` ─────────────────────────────────────────────────
describe('组 E：`POST /auth/logout` 只撤销**这一条**会话（幂等、204）', () => {
  let harness!: Harness

  before(async () => {
    harness = await startApp()
  })
  after(async () => {
    await harness.app.close()
  })
  beforeEach(() => {
    harness.sessions.rows.clear()
    harness.sessions.revokes.length = 0
  })

  it('没有凭据 ⇒ 401 UNAUTHENTICATED', async () => {
    const r = await send(harness.url, '/auth/logout', { body: {} })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'UNAUTHENTICATED')
  })

  it('★ 200/204 空体：撤销成功（没有可说的内容）', async () => {
    const row = harness.sessions.put({ userId: 'u-dad' })
    const r = await send(harness.url, '/auth/logout', {
      method: 'POST',
      headers: bearer(tokenOf(row))
    })
    assert.equal(r.status, 204)
    assert.equal(r.text, '', '204 不该有响应体')
    assert.deepEqual(
      harness.sessions.revokes.map((item) => item.tokenHash),
      [row.tokenHash]
    )
  })

  it('★ 只撤销这一条：同一用户的另一台设备仍可用', async () => {
    const phone = harness.sessions.put({ userId: 'u-dad' })
    const tablet = harness.sessions.put({ userId: 'u-dad' })

    await send(harness.url, '/auth/logout', { method: 'POST', headers: bearer(tokenOf(phone)) })

    const gone = await send(harness.url, '/auth/session', { headers: bearer(tokenOf(phone)) })
    assert.equal(gone.status, 401)
    assert.equal(gone.body.code, 'TOKEN_INVALID', '登出后这把 token 还能用')

    const alive = await send(harness.url, '/auth/session', { headers: bearer(tokenOf(tablet)) })
    assert.equal(alive.status, 200, '登出一台设备把另一台也踢了 —— 同账号多设备不可用')
  })

  it('已撤销的 token 再登出 ⇒ 401 TOKEN_INVALID（不会 500，也不会连坐）', async () => {
    const row = harness.sessions.put({ revokedAt: new Date() })
    const r = await send(harness.url, '/auth/logout', { method: 'POST', headers: bearer(tokenOf(row)) })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'TOKEN_INVALID')
  })
})

// ── 组 F：`POST /children`（新用户 bootstrap，`40` §7）────────────────────────
describe('组 F：`POST /children` 的同意闸门（缺同意 ⇒ 一行数据都不建）', () => {
  let harness!: Harness

  before(async () => {
    harness = await startApp()
  })
  after(async () => {
    await harness.app.close()
  })
  beforeEach(() => {
    harness.sessions.rows.clear()
    harness.identity.bootstraps.length = 0
  })

  /** 一个已登录家长的请求头。 */
  function asParent(): Record<string, string> {
    const row = harness.sessions.put({ userId: 'u-dad' })
    return { ...bearer(tokenOf(row)), 'x-kp-device-id': 'dev-dad' }
  }

  it('★ 缺 `consent` ⇒ 400 CONSENT_NOT_ACCEPTED，且**没有**调用建库', async () => {
    const r = await send(harness.url, '/children', { body: {}, headers: asParent() })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'CONSENT_NOT_ACCEPTED')
    assert.deepEqual(harness.identity.bootstraps, [], '"没反对"被当成了"同意"')
  })

  it('★ `consent.accepted=false` ⇒ 400（字面 true 才算同意）', async () => {
    const r = await send(harness.url, '/children', {
      body: { consent: { accepted: false } },
      headers: asParent()
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'CONSENT_NOT_ACCEPTED')
    assert.deepEqual(harness.identity.bootstraps, [])
  })

  it('有同意但缺设备头 ⇒ 400 DEVICE_ID_REQUIRED（DeviceSession 的行键）', async () => {
    const row = harness.sessions.put({ userId: 'u-dad' })
    const r = await send(harness.url, '/children', {
      body: { consent: { accepted: true } },
      headers: bearer(tokenOf(row))
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DEVICE_ID_REQUIRED')
    assert.deepEqual(harness.identity.bootstraps, [])
  })

  it('★ 请求体里塞儿童信息 ⇒ 400（白名单拒绝：这些字段只能走 `PATCH /child`）', async () => {
    const r = await send(harness.url, '/children', {
      body: { consent: { accepted: true }, name: '小明', birthday: '2020-01-01' },
      headers: asParent()
    })
    assert.equal(r.status, 400)
    assert.deepEqual(harness.identity.bootstraps, [], '未知字段被静默吞掉了')
  })

  it('正常 ⇒ 200：childId + 5 分钟家长窗口 + `modeSource=bootstrap`', async () => {
    const before = Date.now()
    const r = await send(harness.url, '/children', {
      body: { consent: { accepted: true }, relation: 'mother' },
      headers: { ...asParent(), 'user-agent': 'test-agent', 'x-forwarded-for': '203.0.113.7' }
    })
    assert.equal(r.status, 200)
    assert.deepEqual(
      { childId: r.body.childId, role: r.body.role, modeSource: r.body.modeSource },
      { childId: 'child-new', role: 'guardian', modeSource: 'bootstrap' }
    )
    const until = Date.parse(r.body.parentModeUntil as string)
    assert.ok(Math.abs(until - (before + PARENT_MODE_TTL_MS)) < 5_000, '家长窗口不是 5 分钟')

    const call = harness.identity.bootstraps[0]
    assert.ok(call !== undefined)
    assert.equal(call.userId, 'u-dad', '建孩子用的 userId 不是 token 里的那个')
    assert.equal(call.deviceId, 'dev-dad')
    assert.equal(call.relation, 'mother')
    assert.ok(call.consentVersion.length > 0, '同意版本为空 —— 留痕无法自证')
    // ★ IP / UA 只以 HMAC 形式落库（`hash-pii.ts`）；没配盐 ⇒ `null`，绝不留原文。
    if (call.ipHash !== null) {
      assert.match(call.ipHash, /^[0-9a-f]{64}$/)
      assert.notEqual(call.ipHash, '203.0.113.7')
    }
    if (call.userAgentHash !== null) assert.match(call.userAgentHash, /^[0-9a-f]{64}$/)
  })

  it('没登录（关掉双读期旁路）⇒ 401 UNAUTHENTICATED', async () => {
    await withEnv({ AUTH_DEVICE_ID_FALLBACK: '0' }, async () => {
      const r = await send(harness.url, '/children', {
        body: { consent: { accepted: true } },
        headers: { 'x-kp-device-id': 'dev-dad' }
      })
      assert.equal(r.status, 401)
      assert.equal(r.body.code, 'UNAUTHENTICATED')
    })
  })
})

// ── 组 G：`POST /auth/child-session`（补 DeviceSession 行，`40` §8.4）─────────
describe('组 G：`POST /auth/child-session` 只补行，不改变权限', () => {
  let harness!: Harness

  before(async () => {
    harness = await startApp()
  })
  after(async () => {
    await harness.app.close()
  })
  beforeEach(() => {
    harness.sessions.rows.clear()
    harness.identity.childSessions.length = 0
    harness.identity.roleOverride = null
  })

  it('缺设备头 ⇒ 400 DEVICE_ID_REQUIRED，且没有写行', async () => {
    const row = harness.sessions.put({ userId: 'u-dad' })
    const r = await send(harness.url, '/auth/child-session', {
      body: { childId: 'child-1' },
      headers: bearer(tokenOf(row))
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'DEVICE_ID_REQUIRED')
    assert.deepEqual(harness.identity.childSessions, [])
  })

  it('正常 ⇒ 200：角色取自成员位，TTL 是 30 天（`40` §8.4 的 upsert）', async () => {
    const before = Date.now()
    const row = harness.sessions.put({ userId: 'u-dad' })
    const r = await send(harness.url, '/auth/child-session', {
      body: { childId: ' child-1 ' },
      headers: { ...bearer(tokenOf(row)), 'x-kp-device-id': 'dev-dad' }
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.childId, 'child-1', 'childId 没有 trim')
    assert.equal(r.body.role, 'guardian')

    const call = harness.identity.childSessions[0]
    assert.ok(call !== undefined)
    assert.equal(call.userId, 'u-dad')
    assert.equal(call.deviceId, 'dev-dad')
    const expires = call.sessionExpiresAt.getTime()
    assert.ok(Math.abs(expires - (before + CHILD_SESSION_TTL_MS)) < 5_000, '会话 TTL 不是 30 天')
  })

  it('★ 成员位角色非法 ⇒ 500 MEMBER_ROLE_INVALID（不是 403）', async () => {
    harness.identity.roleOverride = 'owner'
    const row = harness.sessions.put({ userId: 'u-dad' })
    const r = await send(harness.url, '/auth/child-session', {
      body: { childId: 'child-1' },
      headers: { ...bearer(tokenOf(row)), 'x-kp-device-id': 'dev-dad' }
    })
    assert.equal(r.status, 500, '数据坏被报成了"你没权限" —— 用户会去要邀请码')
    assert.equal(r.body.code, 'MEMBER_ROLE_INVALID')
  })

  it('没登录 ⇒ 401 UNAUTHENTICATED（不能靠设备头补行）', async () => {
    await withEnv({ AUTH_DEVICE_ID_FALLBACK: '0' }, async () => {
      const r = await send(harness.url, '/auth/child-session', {
        body: { childId: 'child-1' },
        headers: { 'x-kp-device-id': 'dev-dad' }
      })
      assert.equal(r.status, 401)
      assert.equal(r.body.code, 'UNAUTHENTICATED')
      assert.deepEqual(harness.identity.childSessions, [])
    })
  })
})

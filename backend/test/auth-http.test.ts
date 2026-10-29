/**
 * auth-http.test.ts —— 家长模式 / 家长 PIN 的 **HTTP 集成测试**（W8-C，2026-10-27）
 *
 * 真起 Nest、真发请求；身份 / 成员 / 家长模式三个端口都是内存替身。
 * 要钉住的是**路由上的事实**（`docs/design/02` §7、§9.18）：
 *   ① 三道屏障的顺序与归属：缺身份头 401 / 无会话 401 / `manage_parent_pin` 对孩子 403
 *      （矩阵）且**端口零调用**；
 *   ② `GET` 不说谎：`activeRole` / `parentMode` / `pinConfigured` / `remainingAttempts`
 *      全部照库里那行翻，**不在内存里拼**；
 *   ③ `POST` 用 PIN 换 5 分钟：`expiresAt ≈ now+5min`、`remainingSeconds=300`；
 *      成功后 `GET` 立刻是 `guardian`（写真的写进了端口，不是只改了回包）；
 *   ④ 失败的三档语义**互不混用**：
 *        格式错 ⇒ 400 且**不计次**（手滑不是猜测）；
 *        值不对 ⇒ 403 `PARENT_PIN_INVALID` + `remainingAttempts` 递减；
 *        达阈值 / 锁定期 ⇒ 429 `PARENT_PIN_LOCKED` + `retryAfterSeconds`，
 *        且锁定期内**一次 scrypt 都不跑**（`recordPinFailure` 零调用）；
 *   ⑤ `DELETE` 不需要 PIN、幂等、把 `expiresAt` 写回现在（降级永远允许）；
 *   ⑥ `POST /auth/parent-pin`：首次设置免 `currentPin`；已有 PIN 必须带且验对
 *      （缺 ⇒ 400 / 错 ⇒ 403 + 计次）；孩子的成员位 403 `PARENT_PIN_REQUIRES_GUARDIAN`；
 *   ⑦ 无库装配四条路由**全部 501** —— 绝不返回「已切到家长模式」的假状态。
 *
 * ★ 这里**不**证明「行锁 / 事务 / 审计行 / pinHash 真的落了库」—— 那要真 Postgres。
 *   替身只证明「控制器把正确的输入交给了端口，并把端口的结果如实翻成 HTTP」。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import { AuthModule } from '../src/auth/auth.module'
import { AUTH_REPOSITORY } from '../src/auth/auth.repository'
import { hashPin } from '../src/common/pin-hash'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import {
  MEMBERSHIP_REPOSITORY,
  type MembershipPort
} from '../src/membership/membership.repository'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import {
  FAKE_CHILD_ID,
  FAKE_DAD_ID,
  FAKE_KID_ID,
  makeAuthFake,
  type AuthFake
} from './support/auth-fake'

const CHILD_ID = FAKE_CHILD_ID
const DEV_DAD = 'dev-dad'
const DEV_DAD_PARENT = 'dev-dad-parent'
const DEV_MOM = 'dev-mom'
const DEV_MOM_PARENT = 'dev-mom-parent'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'
const MOM_ID = 'u-mom'
const PIN = '1234'

function identity(deviceId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': CHILD_ID }
}

const GUARDIAN = identity(DEV_DAD)
/** 同一部手机，但会话 `activeRole` 已经是 `guardian`（家长模式内）—— `manage_parent_pin` 只在这里可用。 */
const GUARDIAN_PARENT = identity(DEV_DAD_PARENT)
const MOM = identity(DEV_MOM)
const MOM_PARENT = identity(DEV_MOM_PARENT)
const CHILD = identity(DEV_KID)
const VIEWER = identity(DEV_GUEST)

/**
 * 会话行的 `activeRole` 默认 **`child`** —— 这是真实形态：家长的微信登录着，
 * 但手机在孩子手里，所以设备默认不是家长模式。`u-dad` 的家长身份在**成员位**上
 * （`ChildMember.role`），提权靠 PIN 把这一行改成 `guardian`。
 *
 * ★ 另有两台"已经在家长模式里"的设备（`*-parent`）：`manage_parent_pin` 在矩阵里
 *   对孩子是 DENY，所以**设 / 改 PIN 只能在 `activeRole=guardian` 的会话上做**。
 *   这不是漏洞而是顺序：PIN 最初是在家长登录 / 引导时设置的（那时会话是 guardian），
 *   之后 TTL 到期回落到 child，想再改 PIN 得先用 PIN 重新进家长模式。
 */
function makeSessionFake(): DeviceSessionPort {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
  const rows: SessionLookupRow[] = [
    { deviceId: DEV_DAD, childId: CHILD_ID, userId: FAKE_DAD_ID, activeRole: 'child', expiresAt },
    {
      deviceId: DEV_DAD_PARENT,
      childId: CHILD_ID,
      userId: FAKE_DAD_ID,
      activeRole: 'guardian',
      expiresAt
    },
    { deviceId: DEV_MOM, childId: CHILD_ID, userId: MOM_ID, activeRole: 'child', expiresAt },
    {
      deviceId: DEV_MOM_PARENT,
      childId: CHILD_ID,
      userId: MOM_ID,
      activeRole: 'guardian',
      expiresAt
    },
    { deviceId: DEV_KID, childId: CHILD_ID, userId: FAKE_KID_ID, activeRole: 'child', expiresAt }
    // DEV_GUEST 故意没有会话行：身份这一关就该挡住。
  ]
  return {
    async findSession(deviceId, childId) {
      return rows.find((row) => row.deviceId === deviceId && row.childId === childId) ?? null
    }
  }
}

function makeMembershipFake(): MembershipPort {
  const rows: MembershipLookupRow[] = [
    { childId: CHILD_ID, userId: FAKE_DAD_ID, role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: MOM_ID, role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: FAKE_KID_ID, role: 'child', status: 'active', restrictions: {} }
  ]
  return {
    async findMembership(childId, userId) {
      return rows.find((row) => row.childId === childId && row.userId === userId) ?? null
    }
  }
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function request(
  baseUrl: string,
  method: 'GET' | 'POST' | 'DELETE',
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

/** 每个 describe 自己建 app（替身状态互不污染）。 */
async function startApp(
  auth?: AuthFake
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [AuthModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (auth !== undefined) {
    builder.overrideProvider(AUTH_REPOSITORY).useValue(auth)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

/**
 * 把 `u-dad` 的成员位拨回"有 PIN、没锁、孩子模式"，并清空调用记录。
 *
 * ★ 每个 `it` 前重置 **状态**（而不是重建 app）：app 编译一次就够，
 *   而"上一次用例把爸爸锁了"这类串味会让后面的用例读到别人的失败计数。
 */
function resetDad(auth: AuthFake, patch: Partial<AuthFake['members'][string]> = {}): void {
  Object.assign(auth.members[FAKE_DAD_ID], {
    memberRole: 'guardian',
    pinHash: PIN_HASH,
    pinFailedCount: 0,
    pinLockedUntil: null,
    activeRole: 'child',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    ...patch
  })
  auth.calls.length = 0
}

let PIN_HASH = ''

// ══ 组 A：无库装配 —— 四条路由全部 501，绝不假装「已切换」══════════════════════════
describe('组 A：默认装配（家长模式端口未注入）⇒ 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('GET /auth/parent-mode ⇒ 501 PARENT_MODE_NOT_IMPLEMENTED', async () => {
    const res = await request(url, 'GET', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'PARENT_MODE_NOT_IMPLEMENTED')
  })

  it('POST /auth/parent-mode ⇒ 501（不是 200 + 「已切到家长模式」）', async () => {
    const res = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'PARENT_MODE_NOT_IMPLEMENTED')
  })

  it('DELETE /auth/parent-mode ⇒ 501', async () => {
    const res = await request(url, 'DELETE', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'PARENT_MODE_NOT_IMPLEMENTED')
  })

  it('POST /auth/parent-pin ⇒ 501（否则界面会以为 PIN 设好了）', async () => {
    // 用"已在家长模式"的设备：`manage_parent_pin` 对孩子是 DENY，先过矩阵才轮得到 501。
    const res = await request(url, 'POST', '/auth/parent-pin', GUARDIAN_PARENT, { pin: PIN })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'PARENT_MODE_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：三道屏障 + GET 不说谎 ══════════════════════════════════════════════════
describe('组 B：身份 / 成员 / 矩阵与 GET 的语义', () => {
  let app!: INestApplication
  let url = ''
  let auth: AuthFake

  before(async () => {
    PIN_HASH = await hashPin(PIN)
    auth = makeAuthFake({
      [FAKE_DAD_ID]: { memberRole: 'guardian', pinHash: PIN_HASH },
      [MOM_ID]: { memberRole: 'guardian', pinHash: null },
      [FAKE_KID_ID]: { memberRole: 'child', pinHash: null }
    })
    ;({ app, url } = await startApp(auth))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    resetDad(auth)
    Object.assign(auth.members[MOM_ID], { pinHash: null, pinFailedCount: 0, pinLockedUntil: null })
  })

  it('缺设备头 ⇒ 401，端口零调用（身份解析没跑）', async () => {
    const res = await request(url, 'GET', '/auth/parent-mode', { 'x-kp-child-id': CHILD_ID })
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'UNAUTHENTICATED')
    assert.equal(auth.calls.length, 0)
  })

  it('缺孩子头 ⇒ 401（"在哪个孩子上"这半个身份不能缺）', async () => {
    const res = await request(url, 'GET', '/auth/parent-mode', { 'x-kp-device-id': DEV_DAD })
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'UNAUTHENTICATED')
    assert.equal(auth.calls.length, 0)
  })

  it('没有会话行 ⇒ 401 SESSION_NOT_FOUND，端口零调用', async () => {
    const res = await request(url, 'GET', '/auth/parent-mode', VIEWER)
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'SESSION_NOT_FOUND')
    assert.equal(auth.calls.length, 0)
  })

  it('GET：孩子模式 + 已设 PIN ⇒ parentMode=false / remainingSeconds=0 / pinConfigured=true', async () => {
    const res = await request(url, 'GET', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.activeRole, 'child')
    assert.equal(res.body.parentMode, false)
    assert.equal(res.body.modeSource, null)
    assert.equal(res.body.parentModeExpiresAt, null)
    assert.equal(res.body.remainingSeconds, 0)
    assert.equal(res.body.pinConfigured, true)
    assert.equal(res.body.remainingAttempts, 5)
    assert.equal(res.body.lockedUntil, null)
  })

  it('GET：没有 PIN 的家长 ⇒ pinConfigured=false（界面该显示「先设置」）', async () => {
    const res = await request(url, 'GET', '/auth/parent-mode', MOM)
    assert.equal(res.status, 200)
    assert.equal(res.body.pinConfigured, false)
  })

  it('GET：回包里**没有** pinHash / 明文这类字段（秘密不出现在 HTTP 上）', async () => {
    const res = await request(url, 'GET', '/auth/parent-mode', GUARDIAN)
    assert.deepEqual(Object.keys(res.body).sort(), [
      'activeRole',
      'lockedUntil',
      'modeSource',
      'parentMode',
      'parentModeExpiresAt',
      'pinConfigured',
      'remainingAttempts',
      'remainingSeconds'
    ])
  })

  it('GET：会话里的家长角色已过期 ⇒ 回落 child（TTL 是服务端说了算）', async () => {
    resetDad(auth, { activeRole: 'guardian', expiresAt: new Date(Date.now() - 1000) })
    const res = await request(url, 'GET', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.activeRole, 'child')
    assert.equal(res.body.parentMode, false)
    assert.equal(res.body.modeSource, null)
    assert.equal(res.body.remainingSeconds, 0)
  })

  it('★ 登录会话自带 guardian（30 天）⇒ modeSource=session，不是"5 分钟后收回"', async () => {
    // 邀请码加入的家长设备就是这一行：activeRole 一上来就是 guardian，TTL 是设备登录的 30 天。
    // 只报 remainingSeconds 而不报来源，客户端会把它当坏数据（≤300 的硬校验）或显示 43200:00。
    resetDad(auth, { activeRole: 'guardian', expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) })
    const res = await request(url, 'GET', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.parentMode, true)
    assert.equal(res.body.modeSource, 'session')
    assert.ok(Number(res.body.remainingSeconds) > 300, `remainingSeconds=${String(res.body.remainingSeconds)}`)
  })
})


// ══ 组 C：POST —— 用 PIN 换 5 分钟 ═══════════════════════════════════════════════
describe('组 C：POST /auth/parent-mode（成功与三类失败）', () => {
  let app!: INestApplication
  let url = ''
  let auth: AuthFake

  before(async () => {
    auth = makeAuthFake({
      [FAKE_DAD_ID]: { memberRole: 'guardian', pinHash: PIN_HASH },
      [MOM_ID]: { memberRole: 'guardian', pinHash: null },
      [FAKE_KID_ID]: { memberRole: 'child', pinHash: null }
    })
    ;({ app, url } = await startApp(auth))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    resetDad(auth)
    Object.assign(auth.members[MOM_ID], { pinHash: null })
  })

  it('PIN 正确 ⇒ 200 + parentMode=true + remainingSeconds=300', async () => {
    const before = Date.now()
    const res = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 200)
    assert.equal(res.body.activeRole, 'guardian')
    assert.equal(res.body.parentMode, true)
    assert.equal(res.body.modeSource, 'pin')
    assert.equal(res.body.remainingSeconds, 300)
    assert.equal(res.body.pinConfigured, true)
    assert.equal(res.body.remainingAttempts, 5)

    // TTL 的绝对时刻：允许 5 秒抖动（哈希本身要跑 scrypt），但必须**接近** now+5min。
    const expiresAt = Date.parse(String(res.body.parentModeExpiresAt))
    assert.ok(Number.isFinite(expiresAt), `parentModeExpiresAt 不是时间串：${String(res.body.parentModeExpiresAt)}`)
    assert.ok(
      Math.abs(expiresAt - before - 5 * 60 * 1000) < 5000,
      `expiresAt 偏离 now+5min 太多：${expiresAt - before}`
    )

    // 一次成功只写一次会话行；**没有**失败记录。
    assert.deepEqual(
      auth.calls.map((call) => call.method),
      ['readModeState', 'enterParentMode']
    )
    const enter = auth.calls[1]?.input as { operator: { userId: string; role: string }; expiresAt: Date }
    assert.deepEqual(enter.operator, { userId: FAKE_DAD_ID, role: 'child' })
    assert.equal(enter.expiresAt.toISOString(), new Date(expiresAt).toISOString())
  })

  it('紧接着 GET ⇒ 也是 guardian（写进了端口状态，不是只改了回包）', async () => {
    await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: PIN })
    const res = await request(url, 'GET', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.parentMode, true)
    assert.ok(Number(res.body.remainingSeconds) > 290)
  })

  it('PIN 值不对 ⇒ 403 PARENT_PIN_INVALID + remainingAttempts=4 + 记了一次', async () => {
    const res = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: '0000' })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'PARENT_PIN_INVALID')
    assert.equal(res.body.remainingAttempts, 4)
    assert.equal(res.body.lockedUntil, null)
    assert.deepEqual(
      auth.calls.map((call) => call.method),
      ['readModeState', 'recordPinFailure']
    )
    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 1)
  })

  it('PIN 格式非法（3 位 / 带字母）⇒ 400 且**不计次**（手滑不是猜测）', async () => {
    const short = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: '123' })
    assert.equal(short.status, 400)
    assert.equal(short.body.code, 'PARENT_PIN_FORMAT_INVALID')

    const letters = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: '12a4' })
    assert.equal(letters.status, 400)
    assert.equal(letters.body.code, 'PARENT_PIN_FORMAT_INVALID')

    assert.equal(auth.calls.some((call) => call.method === 'recordPinFailure'), false)
    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 0)
  })

  it('缺 pin / 未知键 ⇒ 400（集合封闭：DTO + 全局管道）', async () => {
    const missing = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, {})
    assert.equal(missing.status, 400)

    const extra = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, {
      pin: PIN,
      childId: 'other'
    })
    assert.equal(extra.status, 400)
  })

  it('孩子的成员位 ⇒ 403 PARENT_MODE_REQUIRES_GUARDIAN（矩阵 ALLOW，但成员位没有钥匙）', async () => {
    // 矩阵里 `switch_role_mode` 对孩子是 ALLOW —— 孩子**可以按下**「家长模式」按钮，
    // 好把手机递给家长。但提权要的是"成员位上的 PIN"，孩子的成员位上没有。
    const res = await request(url, 'POST', '/auth/parent-mode', CHILD, { pin: PIN })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'PARENT_MODE_REQUIRES_GUARDIAN')
    assert.equal(auth.calls.some((call) => call.method === 'enterParentMode'), false)
  })

  it('家长但还没设过 PIN ⇒ 409 PARENT_PIN_NOT_SET（身份没问题，"没钥匙"是状态问题）', async () => {
    const res = await request(url, 'POST', '/auth/parent-mode', MOM, { pin: PIN })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'PARENT_PIN_NOT_SET')
    assert.equal(auth.calls.some((call) => call.method === 'enterParentMode'), false)
  })
})


// ══ 组 D：锁定 —— 连错 5 次锁 15 分钟 ════════════════════════════════════════════
describe('组 D：锁定（§9.18）', () => {
  let app!: INestApplication
  let url = ''
  let auth: AuthFake

  before(async () => {
    auth = makeAuthFake({ [FAKE_DAD_ID]: { memberRole: 'guardian', pinHash: PIN_HASH } })
    ;({ app, url } = await startApp(auth))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    resetDad(auth)
  })

  it('第 5 次错 ⇒ 429 PARENT_PIN_LOCKED + retryAfterSeconds=900 + remainingAttempts=0', async () => {
    resetDad(auth, { pinFailedCount: 4 })
    const res = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: '0000' })
    assert.equal(res.status, 429)
    assert.equal(res.body.code, 'PARENT_PIN_LOCKED')
    assert.equal(res.body.retryAfterSeconds, 900)
    assert.equal(res.body.remainingAttempts, 0)
    const lockedUntil = Date.parse(String(res.body.lockedUntil))
    assert.ok(
      Math.abs(lockedUntil - Date.now() - 15 * 60 * 1000) < 5000,
      'lockedUntil 不是 now+15min'
    )
    // 达阈值时计数**清零**（解锁后从 0 重新数，见 policy 用例）。
    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 0)
  })

  it('锁定期内再试（哪怕 PIN 是对的）⇒ 429，且**不跑 scrypt、不记次**', async () => {
    resetDad(auth, { pinLockedUntil: new Date(Date.now() + 10 * 60 * 1000) })
    const res = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 429)
    assert.equal(res.body.code, 'PARENT_PIN_LOCKED')
    assert.ok(Number(res.body.retryAfterSeconds) > 500)
    assert.deepEqual(
      auth.calls.map((call) => call.method),
      ['readModeState']
    )
    assert.equal(auth.members[FAKE_DAD_ID]?.activeRole, 'child')
  })

  it('锁定已到期 ⇒ 正常校验（PIN 对就能进）', async () => {
    resetDad(auth, { pinLockedUntil: new Date(Date.now() - 1000) })
    const res = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 200)
    assert.equal(res.body.parentMode, true)
  })

  it('GET 在锁定期内 ⇒ 200，lockedUntil 如实暴露、remainingAttempts=0', async () => {
    const lockedUntil = new Date(Date.now() + 10 * 60 * 1000)
    resetDad(auth, { pinLockedUntil: lockedUntil, pinFailedCount: 3 })
    const res = await request(url, 'GET', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.lockedUntil, lockedUntil.toISOString())
    assert.equal(res.body.remainingAttempts, 0)
  })

  it('锁定期内**改 PIN** 也不行（否则"忘了 PIN"就等于绕过锁定）', async () => {
    resetDad(auth, { pinLockedUntil: new Date(Date.now() + 10 * 60 * 1000) })
    // 改 PIN 必须在家长模式的会话上（矩阵 `manage_parent_pin`），所以这里用 `*-parent` 设备：
    // 否则会先撞上 403 FORBIDDEN，测不到"锁定"这一层。
    const res = await request(url, 'POST', '/auth/parent-pin', GUARDIAN_PARENT, {
      pin: '9999',
      currentPin: PIN
    })
    assert.equal(res.status, 429)
    assert.equal(res.body.code, 'PARENT_PIN_LOCKED')
    assert.equal(auth.calls.some((call) => call.method === 'setParentPin'), false)
  })
})


// ══ 组 E：DELETE —— 降级永远允许 ═════════════════════════════════════════════════
describe('组 E：DELETE /auth/parent-mode（不需要 PIN）', () => {
  let app!: INestApplication
  let url = ''
  let auth: AuthFake

  before(async () => {
    auth = makeAuthFake({
      [FAKE_DAD_ID]: { memberRole: 'guardian', pinHash: PIN_HASH },
      [FAKE_KID_ID]: { memberRole: 'child', pinHash: null }
    })
    ;({ app, url } = await startApp(auth))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    resetDad(auth)
  })

  it('从家长模式退出 ⇒ 200 parentMode=false / remainingSeconds=0，且**没验 PIN**', async () => {
    resetDad(auth, { activeRole: 'guardian' })
    const res = await request(url, 'DELETE', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.activeRole, 'child')
    assert.equal(res.body.parentMode, false)
    assert.equal(res.body.modeSource, null)
    assert.equal(res.body.parentModeExpiresAt, null)
    assert.equal(res.body.remainingSeconds, 0)
    assert.deepEqual(
      auth.calls.map((call) => call.method),
      ['readModeState', 'exitParentMode']
    )
    // `expiresAt` 必须被写回"现在"，不是留着一个未来的时间戳。
    const member = auth.members[FAKE_DAD_ID]
    assert.ok(member !== undefined)
    assert.ok(member.expiresAt.getTime() <= Date.now() + 1000)
  })

  it('已经是 child 再退一次 ⇒ 200（幂等，不是 409）', async () => {
    const first = await request(url, 'DELETE', '/auth/parent-mode', GUARDIAN)
    assert.equal(first.status, 200)
    const second = await request(url, 'DELETE', '/auth/parent-mode', GUARDIAN)
    assert.equal(second.status, 200)
    assert.equal(second.body.parentMode, false)
  })

  it('锁定期间也能退出（降级不受锁定影响：越严越好）', async () => {
    resetDad(auth, {
      activeRole: 'guardian',
      pinLockedUntil: new Date(Date.now() + 10 * 60 * 1000)
    })
    const res = await request(url, 'DELETE', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.parentMode, false)
  })

  it('孩子的会话也能调（矩阵 ALLOW，实际是 no-op 降级）', async () => {
    const res = await request(url, 'DELETE', '/auth/parent-mode', CHILD)
    assert.equal(res.status, 200)
    assert.equal(res.body.parentMode, false)
  })
})


// ══ 组 F：POST /auth/parent-pin —— 首次设置 / 修改 ═══════════════════════════════
describe('组 F：POST /auth/parent-pin', () => {
  let app!: INestApplication
  let url = ''
  let auth: AuthFake

  before(async () => {
    auth = makeAuthFake({
      [FAKE_DAD_ID]: { memberRole: 'guardian', pinHash: PIN_HASH },
      [MOM_ID]: { memberRole: 'guardian', pinHash: null },
      [FAKE_KID_ID]: { memberRole: 'child', pinHash: null }
    })
    ;({ app, url } = await startApp(auth))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    resetDad(auth)
    Object.assign(auth.members[MOM_ID], {
      pinHash: null,
      pinFailedCount: 0,
      pinLockedUntil: null,
      activeRole: 'child'
    })
  })

  it('首次设置（家长、还没 PIN）⇒ 200 pinConfigured=true / changed=false', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin', MOM_PARENT, { pin: '5678' })
    assert.equal(res.status, 200)
    assert.equal(res.body.pinConfigured, true)
    assert.equal(res.body.changed, false)
    assert.equal(res.body.remainingAttempts, 5)
    assert.ok(typeof res.body.pinSetAt === 'string' && res.body.pinSetAt.length > 0)
    // 端口拿到的是**哈希**，不是明文。
    const call = auth.calls.find((item) => item.method === 'setParentPin')
    const input = call?.input as { pinHash: string; hadPinBefore: boolean }
    assert.equal(input.hadPinBefore, false)
    assert.ok(input.pinHash.startsWith('scrypt$'), 'pinHash 不是自描述 scrypt 串')
    assert.equal(input.pinHash.includes('5678'), false)
  })

  it('设完之后就能用这个新 PIN 进家长模式（哈希真的被用上了）', async () => {
    await request(url, 'POST', '/auth/parent-pin', MOM_PARENT, { pin: '5678' })
    // 换到"孩子手里"的那台设备上提权 —— 正是 PIN 存在的理由。
    const res = await request(url, 'POST', '/auth/parent-mode', MOM, { pin: '5678' })
    assert.equal(res.status, 200)
    assert.equal(res.body.parentMode, true)
  })

  it('★ 孩子模式的会话改 PIN ⇒ 403 FORBIDDEN（矩阵门：PIN 只能在家长模式里改）', async () => {
    // 这不是"矩阵漏了一行"：PIN 是提权钥匙，**用孩子模式的会话改它**就等于
    // "谁拿着手机谁就能重设钥匙"。首次设置发生在家长登录 / 引导时（那时会话是
    // guardian）；之后想改，得先用 PIN 进家长模式。
    const res = await request(url, 'POST', '/auth/parent-pin', GUARDIAN, { pin: '9999' })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(auth.calls.length, 0)
  })

  it('已有 PIN 但缺 currentPin ⇒ 400 PARENT_PIN_CURRENT_REQUIRED，且**没写库**', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin', GUARDIAN_PARENT, { pin: '9999' })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'PARENT_PIN_CURRENT_REQUIRED')
    assert.equal(auth.calls.some((call) => call.method === 'setParentPin'), false)
  })

  it('currentPin 不对 ⇒ 403 PARENT_PIN_INVALID + 计次，且**没写库**', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin', GUARDIAN_PARENT, {
      pin: '9999',
      currentPin: '0000'
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'PARENT_PIN_INVALID')
    assert.equal(res.body.remainingAttempts, 4)
    assert.equal(auth.calls.some((call) => call.method === 'setParentPin'), false)
    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 1)
  })

  it('currentPin 对 ⇒ 200 changed=true；旧 PIN 立刻失效、新 PIN 可用', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin', GUARDIAN_PARENT, {
      pin: '9876',
      currentPin: PIN
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.changed, true)
    assert.equal(res.body.pinConfigured, true)

    const oldPin = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: PIN })
    assert.equal(oldPin.status, 403)
    assert.equal(oldPin.body.code, 'PARENT_PIN_INVALID')

    const newPin = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: '9876' })
    assert.equal(newPin.status, 200)
    assert.equal(newPin.body.parentMode, true)
  })

  it('新 PIN 格式非法 ⇒ 400，**没写库、也没计次**', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin', GUARDIAN_PARENT, {
      pin: '12',
      currentPin: PIN
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'PARENT_PIN_FORMAT_INVALID')
    assert.equal(auth.calls.some((call) => call.method === 'setParentPin'), false)
    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 0)
  })

  it('当前 PIN 格式非法 ⇒ 400，**不计次**（手滑不是猜）', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin', GUARDIAN_PARENT, {
      pin: '9876',
      currentPin: 'abc'
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'PARENT_PIN_FORMAT_INVALID')
    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 0)
  })

  it('孩子的成员位 ⇒ 403 FORBIDDEN（矩阵：manage_parent_pin 对孩子 DENY），端口零调用', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin', CHILD, { pin: '5678' })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(auth.calls.length, 0)
  })

  it('没有会话 ⇒ 401（身份先于一切）', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin', VIEWER, { pin: '5678' })
    assert.equal(res.status, 401)
    assert.equal(auth.calls.length, 0)
  })
})


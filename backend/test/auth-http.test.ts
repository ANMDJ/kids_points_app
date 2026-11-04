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
import { hashPin, verifyPin } from '../src/common/pin-hash'
import { hashPassword, verifyPassword } from '../src/common/password-hash'
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
/**
 * 「另一个家长」—— 只给组 I（重置 PIN 的限流用例）用。
 *
 * ★ 必须有一条**干净**的账号：`AuthService` 的限流器是进程级 Map，
 *   同一个 userId 在前面用例里消费过的额度会带到后面（组 I 的 mom 就吃过 1 次）。
 *   用新账号才能确定性断言「第 1–5 次 403、第 6 次 429」。
 */
const DEV_AUNT = 'dev-aunt'
const AUNT_ID = 'u-aunt'
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
/** 组 I 专用：一个干净账号（限流额度没被别的用例吃过）。 */
const AUNT = identity(DEV_AUNT)

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
    { deviceId: DEV_KID, childId: CHILD_ID, userId: FAKE_KID_ID, activeRole: 'child', expiresAt },
    { deviceId: DEV_AUNT, childId: CHILD_ID, userId: AUNT_ID, activeRole: 'child', expiresAt }
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
    { childId: CHILD_ID, userId: FAKE_KID_ID, role: 'child', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: AUNT_ID, role: 'guardian', status: 'active', restrictions: {} }
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
    // W14：孩子模式是**每台设备**的状态；不清掉会让下一条用例读到上一条的窗口。
    kidModeUntil: null,
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

  it('POST /auth/kid-mode ⇒ 501（W14：绝不回一个"孩子模式已开启"的假状态）', async () => {
    const res = await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 15 })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'PARENT_MODE_NOT_IMPLEMENTED')
  })

  it('DELETE /auth/kid-mode ⇒ 501（收回也要真写库，不能只改回包）', async () => {
    const res = await request(url, 'DELETE', '/auth/kid-mode', GUARDIAN, { pin: PIN })
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
      'kidMode',
      'kidModeExpired',
      'kidModeRemainingSeconds',
      'kidModeUntil',
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

// ══ 组 G：孩子模式（W14，2026-11-03）════════════════════════════════════════════
/**
 * 要钉住的是**A 方案**的五条事实（`docs/design/51-kid-mode-window.md`）：
 *   ① 只有**已经在家长模式**的家长能开；孩子开不了（403 `KID_MODE_REQUIRES_PARENT_MODE`）；
 *   ② 时长 1–30 分钟：31 / 0 / 缺字段在**管道层**就 400，端口零调用；
 *   ③ 开了之后 `GET` 立刻是 `child` + `kidMode:true` + 倒计时（不是只改回包）；
 *   ④ **到期不自动回家长模式**：`kidModeExpired:true`，家长专属动作仍被矩阵挡住；
 *      必须 `DELETE` + 正确 PIN 才回到 guardian；
 *   ⑤ 收回的失败语义与"进入家长模式"逐字一致：400 不计次 / 403 计次 / 429 锁定。
 */
describe('组 G：孩子模式（W14）', () => {
  let app!: INestApplication
  let url = ''
  let auth: AuthFake

  const DAY_MS = 24 * 60 * 60 * 1000

  /** 家长设备以登录会话自带 guardian（邀请码 / 密码登录后的真实形态）。 */
  function sessionBackedGuardian(): void {
    resetDad(auth, { activeRole: 'guardian', expiresAt: new Date(Date.now() + 30 * DAY_MS) })
  }

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
    Object.assign(auth.members[MOM_ID], {
      pinHash: null,
      pinFailedCount: 0,
      pinLockedUntil: null,
      activeRole: 'child',
      kidModeUntil: null
    })
  })

  it('★ 家长模式 + 已设 PIN ⇒ 200：角色降级为 child、倒计时 ≈ 15 分钟', async () => {
    sessionBackedGuardian()
    const res = await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 15 })

    assert.equal(res.status, 200)
    assert.equal(res.body.activeRole, 'child')
    assert.equal(res.body.parentMode, false)
    assert.equal(res.body.kidMode, true)
    assert.equal(res.body.kidModeExpired, false)
    assert.ok(
      Number(res.body.kidModeRemainingSeconds) >= 895 &&
        Number(res.body.kidModeRemainingSeconds) <= 900,
      `kidModeRemainingSeconds=${String(res.body.kidModeRemainingSeconds)}`
    )
    assert.ok(typeof res.body.kidModeUntil === 'string')

    // 端口收到的必须是**算好的绝对时刻** + 原始分钟数（审计用）。
    const call = auth.calls.find((item) => item.method === 'enterKidMode')
    const input = call?.input as { kidModeUntil: Date; durationMinutes: number }
    assert.equal(input.durationMinutes, 15)
    assert.ok(Math.abs(input.kidModeUntil.getTime() - (Date.now() + 15 * 60_000)) < 5_000)

    // 库里那一列真的被写了（不是只改了回包）。
    const member = auth.members[FAKE_DAD_ID]
    assert.ok(member?.kidModeUntil instanceof Date)

    // `activeRole` / `expiresAt` **没被动** —— 收回时才能回到原来的 30 天窗口。
    assert.equal(member?.activeRole, 'guardian')
    assert.ok((member?.expiresAt.getTime() ?? 0) > Date.now() + 29 * DAY_MS)
  })

  it('孩子模式的 GET 立刻是 child + kidMode=true（身份内核真的读了这一列）', async () => {
    sessionBackedGuardian()
    await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 15 })

    const res = await request(url, 'GET', '/auth/parent-mode', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.activeRole, 'child')
    assert.equal(res.body.parentMode, false)
    assert.equal(res.body.kidMode, true)
    assert.equal(res.body.kidModeExpired, false)
    assert.equal(res.body.modeSource, null)
    assert.equal(res.body.remainingSeconds, 0)
  })

  it('31 / 0 / 缺字段 ⇒ 400，端口零调用（上限由 DTO 先挡，服务端再夹）', async () => {
    sessionBackedGuardian()
    for (const body of [{ durationMinutes: 31 }, { durationMinutes: 0 }, {}]) {
      const res = await request(url, 'POST', '/auth/kid-mode', GUARDIAN, body)
      assert.equal(res.status, 400, JSON.stringify(body))
    }
    assert.equal(auth.calls.length, 0)
  })

  it('孩子的成员位 ⇒ 403 KID_MODE_REQUIRES_GUARDIAN（PIN 属于成员）', async () => {
    const res = await request(url, 'POST', '/auth/kid-mode', CHILD, { durationMinutes: 15 })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'KID_MODE_REQUIRES_GUARDIAN')
    assert.equal(auth.calls.some((call) => call.method === 'enterKidMode'), false)
  })

  it('家长成员位但当前不在家长模式 ⇒ 403 KID_MODE_REQUIRES_PARENT_MODE', async () => {
    // 孩子模式下"给自己延长时间"必须走不通 —— 否则这道门等于不存在。
    resetDad(auth, { activeRole: 'child' })
    const res = await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 15 })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'KID_MODE_REQUIRES_PARENT_MODE')
    assert.equal(auth.calls.some((call) => call.method === 'enterKidMode'), false)
  })

  it('没有设 PIN ⇒ 409 KID_MODE_REQUIRES_PIN（否则到点后没人能收回）', async () => {
    Object.assign(auth.members[MOM_ID], { activeRole: 'guardian', pinHash: null })
    const res = await request(url, 'POST', '/auth/kid-mode', MOM_PARENT, { durationMinutes: 15 })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'KID_MODE_REQUIRES_PIN')
    assert.equal(auth.calls.some((call) => call.method === 'enterKidMode'), false)
  })

  it('已经开着再开一次 ⇒ 409 KID_MODE_ALREADY_ACTIVE（不静默续期）', async () => {
    sessionBackedGuardian()
    await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 10 })
    const before = auth.members[FAKE_DAD_ID]?.kidModeUntil?.getTime()

    const res = await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 30 })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'KID_MODE_ALREADY_ACTIVE')
    assert.equal(auth.members[FAKE_DAD_ID]?.kidModeUntil?.getTime(), before)
  })

  it('孩子模式期间用 PIN 直接进家长模式 ⇒ 409 KID_MODE_ACTIVE（指明走收回端点）', async () => {
    sessionBackedGuardian()
    await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 10 })
    auth.calls.length = 0

    const res = await request(url, 'POST', '/auth/parent-mode', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'KID_MODE_ACTIVE')
    assert.equal(auth.calls.some((call) => call.method === 'enterParentMode'), false)
  })
  it('★ 到期不自动回家长模式：kidModeExpired=true，家长专属动作仍被挡住', async () => {
    // 把窗口拨到过去 = "时间到了，但家长还没收"。
    sessionBackedGuardian()
    auth.members[FAKE_DAD_ID]!.kidModeUntil = new Date(Date.now() - 1_000)

    const read = await request(url, 'GET', '/auth/parent-mode', GUARDIAN)
    assert.equal(read.status, 200)
    assert.equal(read.body.activeRole, 'child')
    assert.equal(read.body.parentMode, false)
    assert.equal(read.body.kidMode, false)
    assert.equal(read.body.kidModeExpired, true)
    assert.equal(read.body.kidModeRemainingSeconds, 0)

    // `manage_parent_pin` 只对 guardian ALLOW ⇒ 403 说明角色**没有**回到 guardian。
    const blocked = await request(url, 'POST', '/auth/parent-pin', GUARDIAN, { pin: '9999' })
    assert.equal(blocked.status, 403)
    assert.equal(blocked.body.code, 'FORBIDDEN')
  })

  it('★ 正确 PIN 收回 ⇒ 回到原来的 30 天家长会话（不是 5 分钟）', async () => {
    sessionBackedGuardian()
    await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 10 })

    const res = await request(url, 'DELETE', '/auth/kid-mode', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 200)
    assert.equal(res.body.kidMode, false)
    assert.equal(res.body.kidModeExpired, false)
    assert.equal(res.body.kidModeUntil, null)
    assert.equal(res.body.parentMode, true)
    assert.equal(res.body.modeSource, 'session')
    assert.ok(Number(res.body.remainingSeconds) > 300)

    const member = auth.members[FAKE_DAD_ID]
    assert.equal(member?.kidModeUntil, null)
    assert.equal(member?.activeRole, 'guardian')
  })

  it('收回时 PIN 不对 ⇒ 403 计次，且**不**清掉孩子模式', async () => {
    sessionBackedGuardian()
    await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 10 })
    auth.calls.length = 0

    const res = await request(url, 'DELETE', '/auth/kid-mode', GUARDIAN, { pin: '0000' })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'PARENT_PIN_INVALID')
    assert.equal(res.body.remainingAttempts, 4)
    assert.equal(auth.calls.some((call) => call.method === 'exitKidMode'), false)
    assert.ok(auth.members[FAKE_DAD_ID]?.kidModeUntil instanceof Date)
    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 1)
  })

  it('收回时 PIN 格式错 ⇒ 400 且**不计次**（手滑不是猜）', async () => {
    sessionBackedGuardian()
    await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 10 })

    const res = await request(url, 'DELETE', '/auth/kid-mode', GUARDIAN, { pin: 'abc' })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'PARENT_PIN_FORMAT_INVALID')
    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 0)
  })

  it('锁定期间收回 ⇒ 429，且一次 scrypt 都不跑（recordPinFailure 零调用）', async () => {
    sessionBackedGuardian()
    await request(url, 'POST', '/auth/kid-mode', GUARDIAN, { durationMinutes: 10 })
    auth.members[FAKE_DAD_ID]!.pinLockedUntil = new Date(Date.now() + 10 * 60_000)
    auth.calls.length = 0

    const res = await request(url, 'DELETE', '/auth/kid-mode', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 429)
    assert.equal(res.body.code, 'PARENT_PIN_LOCKED')
    assert.ok(Number(res.body.retryAfterSeconds) > 0)
    assert.equal(auth.calls.some((call) => call.method === 'recordPinFailure'), false)
  })

  it('已经收回再收一次 ⇒ 200（幂等降级，但仍要验 PIN）', async () => {
    sessionBackedGuardian()
    const first = await request(url, 'DELETE', '/auth/kid-mode', GUARDIAN, { pin: PIN })
    assert.equal(first.status, 200)
    auth.calls.length = 0

    const second = await request(url, 'DELETE', '/auth/kid-mode', GUARDIAN, { pin: PIN })
    assert.equal(second.status, 200)
    assert.equal(second.body.kidMode, false)
    assert.ok(auth.calls.some((call) => call.method === 'exitKidMode'))
  })


})

// ══ 组 H：POST /auth/parent-pin/verify（2026-11-04，App 本机 PIN 锁）══════════════
/**
 * 要钉住的是**五条**事实（`docs/design/52-app-pin-lock.md` §3）：
 *   ① 只回答「对不对」：成功后**不改**会话行（`activeRole` / `expiresAt` 原样），
 *      也不清零 `pinFailedCount` —— 所以它不会把 30 天家长会话压成 5 分钟；
 *   ② 值不对 ⇒ 403 + `remainingAttempts` 递减，并**真的记了一次**（成员级计次）；
 *   ③ 格式错 ⇒ 400 且不计次（与 `POST /auth/parent-mode` 逐字一致）；
 *   ④ 没设过 PIN ⇒ 409 `PARENT_PIN_NOT_SET`；锁定期 ⇒ 429 且 scrypt 零调用；
 *   ⑤ 权限走 `switch_role_mode`：**孩子模式的会话也能验**（锁屏不该被 403 卡死）。
 */
describe('组 H：POST /auth/parent-pin/verify（只校验，不改角色）', () => {
  let app!: INestApplication
  let url = ''
  let auth: AuthFake

  const DAY_MS = 24 * 60 * 60 * 1000

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
    Object.assign(auth.members[MOM_ID], {
      pinHash: null,
      pinFailedCount: 0,
      pinLockedUntil: null,
      activeRole: 'child'
    })
  })

  it('PIN 正确 ⇒ 200 { valid:true }；角色 / TTL / 计数**都不动**', async () => {
    // 以家长身份登录的设备（30 天会话）—— 正是「解锁不该压缩它」的那台。
    const expiresAt = new Date(Date.now() + 30 * DAY_MS)
    resetDad(auth, { activeRole: 'guardian', expiresAt })

    const res = await request(url, 'POST', '/auth/parent-pin/verify', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 200)
    assert.equal(res.body.valid, true)
    assert.equal(res.body.remainingAttempts, 5)

    // 只读了一次成员位 + 跑了一次 scrypt；**没有**任何写调用。
    assert.deepEqual(
      auth.calls.map((call) => call.method),
      ['readModeState']
    )
    assert.equal(auth.members[FAKE_DAD_ID]?.activeRole, 'guardian')
    assert.equal(auth.members[FAKE_DAD_ID]?.expiresAt.toISOString(), expiresAt.toISOString())
  })

  it('PIN 不对 ⇒ 403 PARENT_PIN_INVALID + 计次（成员级）', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin/verify', GUARDIAN, { pin: '0000' })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'PARENT_PIN_INVALID')
    assert.equal(res.body.remainingAttempts, 4)
    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 1)
  })

  it('格式错（3 位 / 带字母）⇒ 400 且**不计次**', async () => {
    const short = await request(url, 'POST', '/auth/parent-pin/verify', GUARDIAN, { pin: '123' })
    assert.equal(short.status, 400)
    assert.equal(short.body.code, 'PARENT_PIN_FORMAT_INVALID')

    const letters = await request(url, 'POST', '/auth/parent-pin/verify', GUARDIAN, { pin: '12a4' })
    assert.equal(letters.status, 400)
    assert.equal(letters.body.code, 'PARENT_PIN_FORMAT_INVALID')

    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 0)
  })

  it('还没设过 PIN ⇒ 409 PARENT_PIN_NOT_SET（不是 401）', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin/verify', MOM, { pin: PIN })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'PARENT_PIN_NOT_SET')
  })

  it('锁定期间 ⇒ 429 且一次 scrypt 都不跑', async () => {
    auth.members[FAKE_DAD_ID]!.pinLockedUntil = new Date(Date.now() + 10 * 60_000)
    auth.calls.length = 0

    const res = await request(url, 'POST', '/auth/parent-pin/verify', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 429)
    assert.equal(res.body.code, 'PARENT_PIN_LOCKED')
    assert.ok(Number(res.body.retryAfterSeconds) > 0)
    assert.equal(auth.calls.some((call) => call.method === 'recordPinFailure'), false)
  })

  it('孩子模式的会话也能验（锁屏不能被 403 卡死），但**不提权**', async () => {
    // 孩子模式下 `activeRole` 是 child、且 kidModeUntil 还在窗口内。
    resetDad(auth, { kidModeUntil: new Date(Date.now() + 10 * 60_000) })

    const res = await request(url, 'POST', '/auth/parent-pin/verify', GUARDIAN, { pin: PIN })
    assert.equal(res.status, 200)
    assert.equal(res.body.valid, true)
    assert.equal(auth.members[FAKE_DAD_ID]?.activeRole, 'child')
    assert.notEqual(auth.members[FAKE_DAD_ID]?.kidModeUntil, null)
  })
})
// ══ 组 I：POST /auth/parent-pin/reset（P1-7：忘记 PIN 的唯一旁路）════════════════
describe('组 I：POST /auth/parent-pin/reset（凭账号密码重设 PIN）', () => {
  let app!: INestApplication
  let url = ''
  let auth: AuthFake
  const NEW_PIN = '2468'
  const PASSWORD = 'jiazhang2026'

  before(async () => {
    PIN_HASH = await hashPin(PIN)
    const passwordHash = await hashPassword(PASSWORD)
    auth = makeAuthFake(
      {
        [FAKE_DAD_ID]: { memberRole: 'guardian', pinHash: PIN_HASH },
        // 妈妈：成员位是家长，但账号**没设过密码**（微信登录直接建出来的那种）。
        [MOM_ID]: { memberRole: 'guardian', pinHash: null },
        [FAKE_KID_ID]: { memberRole: 'child', pinHash: null },
        // 组 I 的限流用例要一条干净账号（成员位是家长、从没设过 PIN）。
        [AUNT_ID]: { memberRole: 'guardian', pinHash: null }
      },
      {
        [FAKE_DAD_ID]: passwordHash,
        [MOM_ID]: null,
        [FAKE_KID_ID]: await hashPassword(PASSWORD),
        [AUNT_ID]: passwordHash
      }
    )
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
      activeRole: 'child',
      kidModeUntil: null
    })
  })

  it('密码正确 ⇒ 200，新 PIN 立刻生效（旧 PIN 失效）、计数清零', async () => {
    // 先制造"错了 3 次"的现场：重置必须把计数一起清掉，否则下次一错就锁。
    auth.members[FAKE_DAD_ID]!.pinFailedCount = 3

    const res = await request(url, 'POST', '/auth/parent-pin/reset', GUARDIAN, {
      password: PASSWORD,
      pin: NEW_PIN
    })

    assert.equal(res.status, 200)
    assert.equal(res.body.pinConfigured, true)
    assert.equal(res.body.changed, true)
    assert.equal(res.body.clearedFailures, 3)
    assert.equal(res.body.wasLocked, false)
    assert.equal(res.body.remainingAttempts, 5)

    // 端口收到的**是哈希**（明文不进端口）；旧 PIN 已失效，新 PIN 可用。
    const resetCall = auth.calls.find((call) => call.method === 'resetParentPin')
    assert.ok(resetCall !== undefined)
    const pinHash = (resetCall.input as { pinHash: string }).pinHash
    assert.equal(pinHash.includes(NEW_PIN), false, '端口不许收明文')
    assert.equal(await verifyPin(NEW_PIN, pinHash), true)
    assert.equal(await verifyPin(PIN, pinHash), false)

    assert.equal(auth.members[FAKE_DAD_ID]?.pinFailedCount, 0)
    assert.equal(auth.members[FAKE_DAD_ID]?.pinLockedUntil, null)
  })

  it('密码不对 ⇒ 403 CURRENT_PASSWORD_INVALID，且**一次写都没有**（旧 PIN 仍有效）', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin/reset', GUARDIAN, {
      password: 'wrong-password',
      pin: NEW_PIN
    })

    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'CURRENT_PASSWORD_INVALID')
    assert.equal(auth.calls.some((call) => call.method === 'resetParentPin'), false)
    const stored = auth.members[FAKE_DAD_ID]?.pinHash ?? ''
    assert.equal(await verifyPassword(PASSWORD, auth.accountPasswords[FAKE_DAD_ID] ?? null), true)
    assert.equal(await verifyPin(PIN, stored), true, '失败的重置不能改变旧 PIN')
  })

  it('账号没设过密码 ⇒ 403 ACCOUNT_PASSWORD_NOT_SET（不假装成功）', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin/reset', MOM, {
      password: PASSWORD,
      pin: NEW_PIN
    })

    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'ACCOUNT_PASSWORD_NOT_SET')
    assert.equal(auth.calls.some((call) => call.method === 'resetParentPin'), false)
  })

  it('新 PIN 格式错 ⇒ 400 且**不读密码 / 不占限流额度**', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin/reset', GUARDIAN, {
      password: PASSWORD,
      pin: '12a4'
    })

    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'PARENT_PIN_FORMAT_INVALID')
    assert.deepEqual(
      auth.calls.map((call) => call.method),
      []
    )
  })

  it('成员位是孩子 ⇒ 403 PARENT_PIN_REQUIRES_GUARDIAN（密码对也不行）', async () => {
    const res = await request(url, 'POST', '/auth/parent-pin/reset', CHILD, {
      password: PASSWORD,
      pin: NEW_PIN
    })

    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'PARENT_PIN_REQUIRES_GUARDIAN')
    assert.equal(auth.calls.some((call) => call.method === 'resetParentPin'), false)
  })

  it('孩子模式进行中的设备也能重置（锁在 child 正是要救的那台）⇒ 200 且会话不动', async () => {
    const until = new Date(Date.now() + 10 * 60_000)
    resetDad(auth, { kidModeUntil: until })

    const res = await request(url, 'POST', '/auth/parent-pin/reset', GUARDIAN, {
      password: PASSWORD,
      pin: NEW_PIN
    })

    assert.equal(res.status, 200)
    // 重置只换钥匙：**不提权**、不清孩子模式窗口。
    assert.equal(auth.members[FAKE_DAD_ID]?.activeRole, 'child')
    assert.equal(auth.members[FAKE_DAD_ID]?.kidModeUntil?.toISOString(), until.toISOString())
  })

  it('连续试错密码 ⇒ 第 6 次 429 PIN_RESET_RATE_LIMITED（按 userId 限流）', async () => {
    // 用**干净账号**（AUNT）确定性断言额度：前 5 次 403，第 6 次 429。
    // 不能用 mom：她在这个组的前面用例里已经消费过额度（限流器是进程级 Map）。
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request(url, 'POST', '/auth/parent-pin/reset', AUNT, {
        password: 'wrong-password',
        pin: NEW_PIN
      })
      assert.equal(res.status, 403, `第 ${attempt} 次应是 403（还没到上限）`)
    }

    const limited = await request(url, 'POST', '/auth/parent-pin/reset', AUNT, {
      password: 'wrong-password',
      pin: NEW_PIN
    })
    assert.equal(limited.status, 429)
    assert.equal(limited.body.code, 'PIN_RESET_RATE_LIMITED')
    assert.ok(Number(limited.body.retryAfterSeconds) > 0)

    // ★ 被限流时**不再跑 scrypt**、也不再写库：额度用尽后不能继续当密码探针。
    assert.equal(auth.calls.some((call) => call.method === 'resetParentPin'), false)
  })
})




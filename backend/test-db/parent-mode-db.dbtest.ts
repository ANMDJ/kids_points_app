/**
 * parent-mode-db.dbtest.ts —— 家长模式 **真库 × 真 HTTP** 套件（W8-C，2026-10-27）
 *
 * ── 它与另外三份用例的分工 ─────────────────────────────────────────────────
 *   · `test/parent-mode-policy.test.ts` —— 纯规则（TTL / 失败计数 / 锁定 / PIN 格式）；
 *   · `test/auth-http.test.ts`        —— 真 HTTP、端口是替身（闸门 / 400 / 403 / 429）；
 *   · `test/permission-matrix.test.ts` —— 矩阵与 contracts JSON 的规模对账；
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `fetch`：
 *       PIN 落库 → 失败计数 → 进入家长模式 → 会话行抬升 → 锁定 → 退出。
 *
 * ── 五条只有真库能回答的问题 ────────────────────────────────────────────────
 *   ① `ActionType` 枚举里真的有 `manage_parent_pin` 吗（迁移**真的**应用了）？
 *      —— 不是读 schema 文件，而是让审计行**真的插进去**再读回来；
 *   ② PIN 存的是可验回的哈希吗（`verifyPin` 验得回、库里不含明文）？
 *   ③ 进入家长模式是否**真的**把 `DeviceSession.expiresAt` 抬到 `now + 5 分钟`
 *      （而不是只回了 `parentMode:true`）？退出是否又把它压到 `now`？
 *   ④ 失败计数是**成员级**的库值吗：输错一次 `pinFailedCount` 真的 +1、
 *      成功进入后真的清零、5 次后 `pinLockedUntil` 真的写进库里？
 *   ⑤ 被锁定时**读**端点是否仍可用（锁只拦「进」，不拦「看」）？
 *
 * ── ★ 数据不清理 ────────────────────────────────────────────────────────────
 *   审计是追加式证据（且账本 / 审计表的 DELETE 在真库上被 REVOKE）。
 *   每次运行用全新 `dbtest-<run>` 前缀，于是「从零开始」成立，也不删任何既有行。
 *
 * 入口：`npm run test:db`（缺 `DATABASE_URL` 直接红；`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AppModule } from '../src/app.module'
import { applyGlobalPipes } from '../src/app.setup'
import { PrismaAuthRepository } from '../src/auth/auth.prisma.repository'
import { AUTH_REPOSITORY, type AuthPort } from '../src/auth/auth.repository'
import { PIN_LOCK_MS, PIN_MAX_FAILURES } from '../src/auth/parent-mode.policy'
import { verifyPin } from '../src/common/pin-hash'
import { PrismaService } from '../src/prisma/prisma.service'
import { grantConsentFor } from './support/consent-fixture'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-pm-dad`,
  kid: `dbtest-${RUN}-pm-kid`,
  main: `dbtest-${RUN}-pm-main`,
  devDad: `dbtest-${RUN}-pm-dev-dad`,
  devKid: `dbtest-${RUN}-pm-dev-kid`
} as const

const PIN = '4321'
const NEW_PIN = '998877'

function identity(deviceId: string, childId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': childId }
}

const H = {
  dad: identity(ID.devDad, ID.main),
  kid: identity(ID.devKid, ID.main)
} as const

let prisma: PrismaService
let app: INestApplication
let url = ''

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, {
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

/** 夹具写成功了吗 —— 没写成功就不该去「复核」，否则 `after` 会用假错误盖住真错误。 */
let seeded = false

/** 夹具：一个孩子（dad=guardian、kid=child）+ 两台设备会话，且**还没设过 PIN**。 */
async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)
  await prisma.child.create({ data: { id: ID.main, name: `家长模式 DB 套件 ${RUN}` } })
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: '家长模式 DB 套件家长' },
      { id: ID.kid, displayName: '家长模式 DB 套件孩子' }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.main, userId: ID.dad, role: 'guardian' },
      { childId: ID.main, userId: ID.kid, role: 'child' }
    ]
  })
  // `switch_role_mode` / `manage_parent_pin` 都是同意豁免动作，但夹具仍然授权：
  // 要证明的是「家长模式本身的行为」，不是再验一遍同意闸门（那是 onboarding 套件的活）。
  await grantConsentFor(prisma, [[ID.main, ID.dad]])
  await prisma.deviceSession.createMany({
    data: [
      {
        deviceId: ID.devDad,
        childId: ID.main,
        userId: ID.dad,
        activeRole: 'guardian',
        expiresAt: future
      },
      {
        deviceId: ID.devKid,
        childId: ID.main,
        userId: ID.kid,
        activeRole: 'child',
        expiresAt: future
      }
    ]
  })

  // 独立复核：夹具**真的**进了库，且 PIN 确实是「没设过」。
  const member = await prisma.childMember.findFirstOrThrow({
    where: { childId: ID.main, userId: ID.dad },
    select: { pinHash: true, pinSetAt: true, pinFailedCount: true, pinLockedUntil: true }
  })
  assert.deepEqual(member, {
    pinHash: null,
    pinSetAt: null,
    pinFailedCount: 0,
    pinLockedUntil: null
  })
  assert.equal(await prisma.deviceSession.count({ where: { childId: ID.main } }), 2)
}

/**
 * ★ 数据**不清理**（与 `identity` / `ledger` / `read` / `onboarding` 套件同一纪律）
 *
 *   审计行是追加式证据，且真库上审计 / 账本表的 `DELETE` 已被 REVOKE ⇒「删干净」
 *   这个承诺在这里不可能兑现。承诺换成另一种：每次运行用全新 `dbtest-<RUN>` 前缀
 *   ⇒「从零开始」成立，并**不删任何既有行**。`after` 做的是复核，不是清理。
 */
async function verifyRetained(): Promise<void> {
  const audits = await prisma.auditLog.findMany({
    where: { childId: ID.main },
    select: { action: true, targetType: true, before: true, after: true }
  })

  // ① 本轮**真的**写进了 `manage_parent_pin`：这就是「迁移已应用」的库级证据
  //    （枚举没有这个值时，上面 SetParentPin 的审计插入会 500，用例先红）。
  const pinAudits = audits.filter((row) => row.action === 'manage_parent_pin')
  assert.ok(pinAudits.length >= 2, `manage_parent_pin 审计应 ≥2 条，实际 ${pinAudits.length}`)
  assert.equal(pinAudits.every((row) => row.targetType === 'ChildMember'), true)

  // ② 切换审计：成功 1 次（via=parent_pin）+ 失败若干次（outcome=pin_rejected / pin_locked）
  const switchAudits = audits.filter((row) => row.action === 'switch_role_mode')
  assert.equal(
    switchAudits.some(
      (row) => (row.after as Record<string, unknown> | null)?.via === 'parent_pin'
    ),
    true,
    '本轮没有「用 PIN 通过」的切换审计 —— 组 F 本该先红'
  )
  assert.equal(
    switchAudits.some(
      (row) => (row.after as Record<string, unknown> | null)?.outcome === 'pin_rejected'
    ),
    true,
    '本轮没有「PIN 不对」的切换审计 —— 组 E 本该先红'
  )

  // ③ 审计里**绝不能**出现 PIN 本身 / 哈希（长度本身也是信息）
  const serialized = JSON.stringify(audits)
  for (const secret of [PIN, NEW_PIN]) {
    assert.equal(serialized.includes(secret), false, `审计里出现了明文 PIN ${secret}`)
  }
  assert.equal(serialized.includes('scrypt$'), false, '审计里出现了 scrypt 哈希')
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()
  seeded = true

  // ★ 刻意**不传** `hasDatabase`：要验的正是生产那条路（由 DATABASE_URL 推断）。
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()
})

after(async () => {
  // 三步各自独立：`before` 中途炸掉时 app / seeded 可能是空的，
  // 无条件 close 只会抛出「盖住真因」的错误。
  if (app !== undefined) await app.close()
  if (seeded) await verifyRetained()
  if (prisma !== undefined) await prisma.$disconnect()
})

// ══ 组 A：装配 —— 下面所有落库断言的**前提** ════════════════════════════════
describe('组 A：真 AppModule 的装配（否则 200/403 可能是在跟替身说话）', () => {
  it('认证端口是 Prisma 适配器（环境推断生效）', () => {
    assert.ok(
      app.get<AuthPort>(AUTH_REPOSITORY) instanceof PrismaAuthRepository,
      '认证端口不是 Prisma 适配器 —— 下面的落库断言就只可能来自替身'
    )
  })
})

// ══ 组 B：还没设过 PIN 的读 / 进 ═════════════════════════════════════════════
describe('组 B：「还没设 PIN」是一个状态，不是权限问题', () => {
  it('GET /auth/parent-mode ⇒ 200，会话自带 guardian（modeSource:session）、pinConfigured:false、5 次机会', async () => {
    const res = await call('GET', '/auth/parent-mode', H.dad)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.activeRole, 'guardian')
    // ★ 夹具里 dad 的设备是「邀请码加入的家长设备」形态：会话本来就是 guardian
    //   （30 天登录会话）。服务端按会话派生 `parentMode`，所以这里**就是**家长模式；
    //   「还没设 PIN」是另一个维度，不是「不在家长模式」。
    assert.equal(res.body.parentMode, true)
    assert.equal(res.body.modeSource, 'session')
    assert.equal(res.body.pinConfigured, false)
    assert.equal(res.body.remainingAttempts, PIN_MAX_FAILURES)
    assert.equal(res.body.lockedUntil, null)
    // 剩余时间来自会话行（1 小时），**远超** PIN 的 5 分钟 —— 这正是客户端必须
    // 按 `modeSource` 区分文案的理由（只按秒数显示会得到「3600:00 后自动收回」）。
    const left = res.body.remainingSeconds as number
    assert.ok(left > 300, `登录会话的剩余秒数应 >300，实际 ${left}`)
    const expiresAt = Date.parse(String(res.body.parentModeExpiresAt))
    assert.ok(
      Number.isFinite(expiresAt),
      `parentModeExpiresAt 不是时间串：${String(res.body.parentModeExpiresAt)}`
    )
  })

  it('POST /auth/parent-mode ⇒ 409 PARENT_PIN_NOT_SET（不是 401/403）', async () => {
    const res = await call('POST', '/auth/parent-mode', H.dad, { pin: PIN })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.equal(res.body.code, 'PARENT_PIN_NOT_SET')
  })

  it('★ 409 之后会话行**没有**被改动（没进家长模式，也没抬 TTL）', async () => {
    const session = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { activeRole: true, expiresAt: true }
    })
    assert.equal(session.activeRole, 'guardian', '会话本来的角色没被动过')
    assert.ok(session.expiresAt.getTime() > Date.now() + 30 * 60_000, 'TTL 没有被改短')
  })
})

// ══ 组 C：设 PIN —— 哈希落库 + `manage_parent_pin` 审计（枚举的库级证据）═══════
describe('组 C：首次设置 PIN（迁移是否真的应用，全看这一段）', () => {
  it('POST /auth/parent-pin ⇒ 200，changed:false、pinConfigured:true', async () => {
    const res = await call('POST', '/auth/parent-pin', H.dad, { pin: PIN })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.pinConfigured, true)
    assert.equal(res.body.changed, false, '首次设置不是「修改」')
    assert.equal(res.body.remainingAttempts, PIN_MAX_FAILURES)
    assert.equal(typeof res.body.pinSetAt, 'string')
  })

  it('★ 库里是**可验回的哈希**，不是明文、也不是 PIN 本身', async () => {
    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinHash: true, pinSetAt: true, pinFailedCount: true, pinLockedUntil: true }
    })
    assert.ok(member.pinHash !== null)
    assert.notEqual(member.pinHash, PIN)
    assert.equal(member.pinHash.includes(PIN), false, '哈希里不该出现明文 PIN')
    assert.equal(await verifyPin(PIN, member.pinHash), true)
    assert.equal(await verifyPin(NEW_PIN, member.pinHash), false)
    assert.ok(member.pinSetAt !== null)
    assert.equal(member.pinFailedCount, 0)
    assert.equal(member.pinLockedUntil, null)
  })

  it('★ 审计动作 `manage_parent_pin` 真的插得进库（ActionType 枚举不含它就会 500）', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { childId: ID.main, action: 'manage_parent_pin' },
      select: { targetType: true, before: true, after: true }
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].targetType, 'ChildMember')
    assert.deepEqual(rows[0].before, { pinSet: false })
    assert.deepEqual(rows[0].after, { pinSet: true, changed: false })
  })

  it('孩子设备 POST /auth/parent-pin ⇒ 403（`manage_parent_pin` 对 child 是 DENY）', async () => {
    const before = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinHash: true }
    })
    const res = await call('POST', '/auth/parent-pin', H.kid, { pin: '1111' })
    assert.equal(res.status, 403, JSON.stringify(res.body))
    assert.equal(res.body.code, 'FORBIDDEN')

    const after = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinHash: true }
    })
    assert.equal(after.pinHash, before.pinHash, '403 之后 PIN 不能被动过')
  })
})

// ══ 组 D：失败计数是**成员级**的库值 ═════════════════════════════════════════
describe('组 D：PIN 不对 ⇒ 403 + 计数真的 +1（库里有行，不是只在回包里）', () => {
  it('POST /auth/parent-mode {pin: 0000} ⇒ 403 PARENT_PIN_INVALID，剩余 4 次', async () => {
    const res = await call('POST', '/auth/parent-mode', H.dad, { pin: '0000' })
    assert.equal(res.status, 403, JSON.stringify(res.body))
    assert.equal(res.body.code, 'PARENT_PIN_INVALID')
    assert.equal(res.body.remainingAttempts, PIN_MAX_FAILURES - 1)
  })

  it('★ `pinFailedCount` 落库为 1，且会话仍是 guardian（失败不能提权）', async () => {
    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinFailedCount: true, pinLockedUntil: true }
    })
    assert.equal(member.pinFailedCount, 1)
    assert.equal(member.pinLockedUntil, null)

    const session = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { activeRole: true }
    })
    assert.equal(session.activeRole, 'guardian', '会话角色没被失败请求改过')
  })

  it('失败也留审计，但**只记**计数，不记 PIN', async () => {
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { childId: ID.main, action: 'switch_role_mode' },
      orderBy: { createdAt: 'desc' },
      select: { after: true, deviceId: true }
    })
    assert.deepEqual(row.after, {
      outcome: 'pin_rejected',
      pinFailedCount: 1,
      pinLockedUntil: null
    })
    assert.equal(row.deviceId, ID.devDad, '切换审计必须带 deviceId（02 §7）')
  })
})

// ══ 组 E：进家长模式 —— 会话行**真的**被抬升 ════════════════════════════════
describe('组 E：PIN 对了 ⇒ 会话行抬到 now+5min（不是只回一个 parentMode:true）', () => {
  it('POST /auth/parent-mode {pin: 正确} ⇒ 200，parentMode:true、剩余约 300 秒', async () => {
    const res = await call('POST', '/auth/parent-mode', H.dad, { pin: PIN })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.activeRole, 'guardian')
    assert.equal(res.body.parentMode, true)
    // 5 分钟以内的剩余时间 ⇒ 来源是 PIN；登录会话（30 天）会报 session。
    assert.equal(res.body.modeSource, 'pin')
    assert.equal(res.body.pinConfigured, true)
    assert.equal(res.body.lockedUntil, null)
    assert.equal(res.body.remainingAttempts, PIN_MAX_FAILURES, '成功进入要把失败计数清零')
    const left = res.body.remainingSeconds as number
    assert.ok(left > 0 && left <= 300, `remainingSeconds 应在 (0,300]，实际 ${left}`)
  })

  it('★ `DeviceSession` 落库：guardian + expiresAt ≈ now + 5 分钟（±15s）', async () => {
    const session = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { activeRole: true, expiresAt: true }
    })
    assert.equal(session.activeRole, 'guardian')
    const delta = session.expiresAt.getTime() - Date.now()
    assert.ok(
      delta > 300_000 - 15_000 && delta <= 300_000,
      `expiresAt 应落在 now+285s..now+300s，实际 +${Math.round(delta / 1000)}s`
    )
  })

  it('★ 成功进入把成员上的失败计数清零（否则「错 4 次」会一直挂着）', async () => {
    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinFailedCount: true, pinLockedUntil: true }
    })
    assert.equal(member.pinFailedCount, 0)
    assert.equal(member.pinLockedUntil, null)
  })

  it('审计：switch_role_mode / DeviceSession / via=parent_pin，带 deviceId', async () => {
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { childId: ID.main, action: 'switch_role_mode' },
      orderBy: { createdAt: 'desc' },
      select: { targetType: true, targetId: true, deviceId: true, after: true },
    })
    assert.equal(row.targetType, 'DeviceSession')
    assert.equal(row.targetId, `${ID.devDad}:${ID.main}`)
    assert.equal(row.deviceId, ID.devDad)
    assert.equal((row.after as Record<string, unknown>).via, 'parent_pin')
  })
})

// ══ 组 F：家长模式中的读 ═════════════════════════════════════════════════════
describe('组 F：进来之后再读，看的是**同一行会话上的绝对时刻**', () => {
  it('GET /auth/parent-mode ⇒ parentMode:true，parentModeExpiresAt 与会话行一致', async () => {
    const res = await call('GET', '/auth/parent-mode', H.dad)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.parentMode, true)
    const session = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { expiresAt: true }
    })
    assert.equal(res.body.parentModeExpiresAt, session.expiresAt.toISOString())
    assert.ok((res.body.remainingSeconds as number) > 0)
  })

  it('同一台设备上孩子会话**不受影响**（切换是按 (deviceId, childId) 的）', async () => {
    const res = await call('GET', '/auth/parent-mode', H.kid)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.parentMode, false, '孩子设备不该因为家长进模式而提权')
  })
})

// ══ 组 G：改 PIN —— 必须握着旧的（422/403/200 三态）═════════════════════════
describe('组 G：修改 PIN 的三条分支', () => {
  it('不带 currentPin ⇒ 400 PARENT_PIN_CURRENT_REQUIRED（不计次）', async () => {
    const res = await call('POST', '/auth/parent-pin', H.dad, { pin: NEW_PIN })
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.equal(res.body.code, 'PARENT_PIN_CURRENT_REQUIRED')
    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinFailedCount: true }
    })
    assert.equal(member.pinFailedCount, 0, '请求不完整不该记成一次「输错」')
  })

  it('currentPin 不对 ⇒ 403 PARENT_PIN_INVALID，计数 +1', async () => {
    const res = await call('POST', '/auth/parent-pin', H.dad, {
      pin: NEW_PIN,
      currentPin: '0000'
    })
    assert.equal(res.status, 403, JSON.stringify(res.body))
    assert.equal(res.body.code, 'PARENT_PIN_INVALID')
    assert.equal(res.body.remainingAttempts, PIN_MAX_FAILURES - 1)

    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinFailedCount: true }
    })
    assert.equal(member.pinFailedCount, 1)
  })

  it('currentPin 正确 ⇒ 200 changed:true，旧 PIN 立刻失效', async () => {
    const res = await call('POST', '/auth/parent-pin', H.dad, {
      pin: NEW_PIN,
      currentPin: PIN
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.changed, true)
    assert.equal(res.body.pinConfigured, true)
    assert.equal(res.body.remainingAttempts, PIN_MAX_FAILURES, '改 PIN 也要清掉失败计数')
  })

  it('★ 库里换成了新 PIN 的哈希：旧 PIN 验不回，新 PIN 验得回', async () => {
    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinHash: true, pinFailedCount: true, pinLockedUntil: true }
    })
    assert.ok(member.pinHash !== null)
    assert.equal(await verifyPin(PIN, member.pinHash), false, '旧 PIN 必须失效')
    assert.equal(await verifyPin(NEW_PIN, member.pinHash), true, '新 PIN 必须生效')
    assert.equal(member.pinFailedCount, 0)
    assert.equal(member.pinLockedUntil, null)
  })

  it('审计多了第二条 manage_parent_pin，且这条 changed:true', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { childId: ID.main, action: 'manage_parent_pin' },
      orderBy: { createdAt: 'asc' },
      select: { before: true, after: true }
    })
    assert.equal(rows.length, 2)
    assert.deepEqual(rows[1].before, { pinSet: true })
    assert.deepEqual(rows[1].after, { pinSet: true, changed: true })
  })
})

// ══ 组 H：连错 5 次 ⇒ 成员级锁定（15 分钟）══════════════════════════════════
describe('组 H：锁定是**成员级**的，写进 `pinLockedUntil`', () => {
  it('连续输错：前 4 次 403，第 5 次 429 PARENT_PIN_LOCKED', async () => {
    // 不写死次数：从当前计数推到 `PIN_MAX_FAILURES`，最后一次必须是 429。
    const start = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinFailedCount: true }
    })
    const remaining = PIN_MAX_FAILURES - start.pinFailedCount

    for (let i = 1; i <= remaining; i += 1) {
      const res = await call('POST', '/auth/parent-mode', H.dad, { pin: '0000' })
      const last = i === remaining
      assert.equal(
        res.status,
        last ? 429 : 403,
        `第 ${i}/${remaining} 次：${JSON.stringify(res.body)}`
      )
      assert.equal(res.body.code, last ? 'PARENT_PIN_LOCKED' : 'PARENT_PIN_INVALID')
      if (last) {
        const retryAfter = res.body.retryAfterSeconds as number
        assert.ok(retryAfter > 0 && retryAfter <= PIN_LOCK_MS / 1000, `retryAfter=${retryAfter}`)
      }
    }
  })

  it('★ 库里 `pinFailedCount` 归零、`pinLockedUntil` 落在 now+14min..now+15min', async () => {
    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinFailedCount: true, pinLockedUntil: true }
    })
    // ★ 达阈值即清零（parent-mode.policy.ts#nextPinFailureState 的口径）：
    //   保留 5 会让「解锁后再错一次」立刻又锁 15 分钟，形同永久锁死。
    assert.equal(member.pinFailedCount, 0)
    assert.ok(member.pinLockedUntil !== null)
    const delta = member.pinLockedUntil.getTime() - Date.now()
    assert.ok(
      delta > PIN_LOCK_MS - 60_000 && delta <= PIN_LOCK_MS,
      `锁定应约 15 分钟，实际 +${Math.round(delta / 1000)}s`
    )
  })

  it('锁定只拦「进」不拦「看」：GET 仍 200，且报 lockedUntil / 0 次机会', async () => {
    const res = await call('GET', '/auth/parent-mode', H.dad)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(typeof res.body.lockedUntil, 'string')
    assert.equal(res.body.remainingAttempts, 0)
  })

  it('锁定期间再输对 PIN 也进不去（429 而不是 200）', async () => {
    const res = await call('POST', '/auth/parent-mode', H.dad, { pin: NEW_PIN })
    assert.equal(res.status, 429, JSON.stringify(res.body))
    assert.equal(res.body.code, 'PARENT_PIN_LOCKED')
    const session = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { activeRole: true }
    })
    assert.equal(session.activeRole, 'guardian', '锁定不该把已有的 guardian 会话踢下去')
  })
})

// ══ 组 I：退出 —— 会话过期 ⇒ 回落 child，且可重入（幂等）═══════════════════════
describe('组 I：DELETE /auth/parent-mode 把 TTL 压到 now', () => {
  it('DELETE ⇒ 200，parentMode:false / remainingSeconds:0', async () => {
    const res = await call('DELETE', '/auth/parent-mode', H.dad)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.parentMode, false)
    assert.equal(res.body.parentModeExpiresAt, null)
    assert.equal(res.body.remainingSeconds, 0)
  })

  it('★ 会话行 activeRole=child 且 expiresAt <= now（TTL 到期就是降级，不是 401）', async () => {
    const session = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { activeRole: true, expiresAt: true }
    })
    assert.equal(session.activeRole, 'child')
    assert.ok(session.expiresAt.getTime() <= Date.now() + 1000)
  })

  it('审计落了一条 via=explicit_exit', async () => {
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { childId: ID.main, action: 'switch_role_mode' },
      orderBy: { createdAt: 'desc' },
      select: { after: true, deviceId: true }
    })
    assert.equal((row.after as Record<string, unknown>).via, 'explicit_exit')
    assert.equal(row.deviceId, ID.devDad)
  })

  it('再 DELETE 一次仍 200（已退出不是错误）', async () => {
    const res = await call('DELETE', '/auth/parent-mode', H.dad)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.parentMode, false)
  })
})

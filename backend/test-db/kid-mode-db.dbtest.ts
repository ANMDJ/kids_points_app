/**
 * kid-mode-db.dbtest.ts —— 孩子模式 **真库 × 真 HTTP** 套件（W14，2026-11-03）
 *
 * ── 与另外三份用例的分工 ───────────────────────────────────────────────────
 *   · `test/kid-mode-policy.test.ts`      —— 纯规则（1–30 / 三态 / 剩余秒数）；
 *   · `test/session-gate.test.ts` 组 F   —— 身份内核的降级优先级（含 viewer 不提权）；
 *   · `test/auth-http.test.ts` 组 G      —— 真 HTTP、端口是替身（403/409/400/429）；
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `fetch`。
 *
 * ── 只有真库能回答的五条 ───────────────────────────────────────────────────
 *   ① 迁移真的应用了吗：`DeviceSession.kidModeUntil` 这一列能写能读；
 *   ② 开孩子模式**不改** `activeRole` / `expiresAt`（收回后要回到原来的 30 天）；
 *   ③ 窗口内 guardian 专属动作**真的**被矩阵挡住（actor 角色来自服务端）；
 *   ④ **到期不自动回家长模式**：把时间戳拨到过去后，角色仍是 child，
 *      且 `POST /auth/parent-mode` 被 409 挡住（只能走 `DELETE /auth/kid-mode`）；
 *   ⑤ 审计里有两类证据（`via=guardian_handoff` / `via=pin_release`），且**不含 PIN**。
 *
 * ── 数据不清理（与其它 db 套件同一条纪律）────────────────────────────────────
 *   审计是追加式证据；每次运行用全新 `dbtest-<run>` 前缀，不删任何既有行。
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
import { PrismaService } from '../src/prisma/prisma.service'
import { grantConsentFor } from './support/consent-fixture'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-km-dad`,
  mom: `dbtest-${RUN}-km-mom`,
  kid: `dbtest-${RUN}-km-kid`,
  main: `dbtest-${RUN}-km-main`,
  devDad: `dbtest-${RUN}-km-dev-dad`,
  devMom: `dbtest-${RUN}-km-dev-mom`,
  devKid: `dbtest-${RUN}-km-dev-kid`
} as const

const PIN = '4321'

function identity(deviceId: string, childId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': childId }
}

const H = {
  dad: identity(ID.devDad, ID.main),
  mom: identity(ID.devMom, ID.main),
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

let seeded = false

/** 夹具：一个孩子（dad/mom=guardian、kid=child）+ 三台设备会话。 */
async function seed(): Promise<void> {
  const month = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await prisma.child.create({ data: { id: ID.main, name: `孩子模式 DB 套件 ${RUN}` } })
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: '孩子模式 DB 套件家长' },
      { id: ID.mom, displayName: '孩子模式 DB 套件另一位家长' },
      { id: ID.kid, displayName: '孩子模式 DB 套件孩子' }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.main, userId: ID.dad, role: 'guardian' },
      { childId: ID.main, userId: ID.mom, role: 'guardian' },
      { childId: ID.main, userId: ID.kid, role: 'child' }
    ]
  })
  await grantConsentFor(prisma, [[ID.main, ID.dad]])
  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.main, userId: ID.dad, activeRole: 'guardian', expiresAt: month },
      { deviceId: ID.devMom, childId: ID.main, userId: ID.mom, activeRole: 'guardian', expiresAt: month },
      { deviceId: ID.devKid, childId: ID.main, userId: ID.kid, activeRole: 'child', expiresAt: month }
    ]
  })

  // 独立复核：三台设备都在，且 kidModeUntil 全是 NULL（新列对存量行的默认值）。
  const rows = await prisma.deviceSession.findMany({
    where: { childId: ID.main },
    select: { kidModeUntil: true }
  })
  assert.equal(rows.length, 3)
  assert.equal(rows.every((row) => row.kidModeUntil === null), true)
}

/** `after` 的复核：审计里必须有两类证据，且**不含 PIN**。 */
async function verifyRetained(): Promise<void> {
  const audits = await prisma.auditLog.findMany({
    where: { childId: ID.main, action: 'switch_role_mode' },
    select: { before: true, after: true, targetType: true }
  })

  const vias = new Set(
    audits.map((row) => (row.after as Record<string, unknown> | null)?.via)
  )
  assert.equal(vias.has('guardian_handoff'), true, '没有「开孩子模式」的审计（via=guardian_handoff）')
  assert.equal(vias.has('pin_release'), true, '没有「用 PIN 收回」的审计（via=pin_release）')
  assert.equal(audits.every((row) => row.targetType === 'DeviceSession'), true)

  const handoff = audits.find(
    (row) => (row.after as Record<string, unknown> | null)?.via === 'guardian_handoff'
  )
  assert.equal(
    (handoff?.after as Record<string, unknown> | null)?.durationMinutes,
    15,
    '审计里没记下原始分钟数（事后无法回答"这次给了多久"）'
  )

  const serialized = JSON.stringify(audits)
  assert.equal(serialized.includes(PIN), false, '审计里出现了明文 PIN')
  assert.equal(serialized.includes('scrypt$'), false, '审计里出现了 PIN 哈希')
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()
  seeded = true

  // ★ 刻意不传 `hasDatabase`：验的是生产那条路（由 DATABASE_URL 推断）。
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()

  // 设 PIN 必须在「还是 guardian」时做（`manage_parent_pin` 对孩子 DENY）。
  const pin = await call('POST', '/auth/parent-pin', H.dad, { pin: PIN })
  assert.equal(pin.status, 200, JSON.stringify(pin.body))
})

after(async () => {
  if (app !== undefined) await app.close()
  if (seeded) await verifyRetained()
  if (prisma !== undefined) await prisma.$disconnect()
})

describe('组 A：装配与迁移', () => {
  it('认证端口是 Prisma 适配器（否则下面的落库断言只可能来自替身）', () => {
    assert.ok(app.get<AuthPort>(AUTH_REPOSITORY) instanceof PrismaAuthRepository)
  })
})

describe('组 B：开孩子模式 —— 真写列、不动 activeRole/expiresAt', () => {
  it('31 分钟 ⇒ 400（DTO 的 @Max 在管道层就挡，端口不会收到）', async () => {
    const res = await call('POST', '/auth/kid-mode', H.dad, { durationMinutes: 31 })
    assert.equal(res.status, 400, JSON.stringify(res.body))
  })

  it('15 分钟 ⇒ 200：角色降级、kidModeUntil 落库、原 30 天窗口不变', async () => {
    const before = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { activeRole: true, expiresAt: true }
    })

    const res = await call('POST', '/auth/kid-mode', H.dad, { durationMinutes: 15 })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.activeRole, 'child')
    assert.equal(res.body.parentMode, false)
    assert.equal(res.body.kidMode, true)
    assert.equal(res.body.kidModeExpired, false)
    assert.ok(Number(res.body.kidModeRemainingSeconds) >= 895)

    const row = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { activeRole: true, expiresAt: true, kidModeUntil: true }
    })
    assert.equal(row.activeRole, before.activeRole, '开孩子模式不该改 activeRole')
    assert.equal(
      row.expiresAt.getTime(),
      before.expiresAt.getTime(),
      '开孩子模式不该改 expiresAt（收回后要回到原来的 30 天）'
    )
    assert.ok(row.kidModeUntil !== null)
    const delta = row.kidModeUntil.getTime() - Date.now()
    assert.ok(delta > 14 * 60_000 && delta <= 15 * 60_000, `kidModeUntil 偏差过大：${delta}`)
  })

  it('窗口内 guardian 专属动作被矩阵挡住（actor 角色来自服务端，不是客户端）', async () => {
    const res = await call('POST', '/auth/parent-pin', H.dad, { pin: '9999' })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
  })

  it('GET 说真话：kidMode=true / parentMode=false / 倒计时 > 0', async () => {
    const res = await call('GET', '/auth/parent-mode', H.dad)
    assert.equal(res.status, 200)
    assert.equal(res.body.activeRole, 'child')
    assert.equal(res.body.kidMode, true)
    assert.equal(res.body.kidModeExpired, false)
    assert.ok(Number(res.body.kidModeRemainingSeconds) > 0)
  })
})


describe('组 C：收回 —— 必须 PIN，且回到原来的窗口', () => {
  it('PIN 不对 ⇒ 403 计次，且**不**清掉孩子模式（释放只能由对的人做）', async () => {
    const res = await call('DELETE', '/auth/kid-mode', H.dad, { pin: '0000' })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'PARENT_PIN_INVALID')
    assert.equal(res.body.remainingAttempts, 4)

    const row = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { kidModeUntil: true }
    })
    assert.ok(row.kidModeUntil !== null, 'PIN 错却把孩子模式清掉了')
    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinFailedCount: true }
    })
    assert.equal(member.pinFailedCount, 1)
  })

  it('PIN 对 ⇒ 200：kidModeUntil 清空、回到 session 家长权限（不是 5 分钟）', async () => {
    const res = await call('DELETE', '/auth/kid-mode', H.dad, { pin: PIN })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.kidMode, false)
    assert.equal(res.body.kidModeExpired, false)
    assert.equal(res.body.kidModeUntil, null)
    assert.equal(res.body.parentMode, true)
    assert.equal(res.body.modeSource, 'session')
    assert.ok(Number(res.body.remainingSeconds) > 300, '收回后被压成 5 分钟窗口了')

    const row = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { kidModeUntil: true, activeRole: true }
    })
    assert.equal(row.kidModeUntil, null)
    assert.equal(row.activeRole, 'guardian')
  })
})

describe('组 D：到期 —— 不自动回家长模式（A 方案）', () => {
  it('已开着再开一次 ⇒ 409 KID_MODE_ALREADY_ACTIVE（不静默续期）', async () => {
    const first = await call('POST', '/auth/kid-mode', H.dad, { durationMinutes: 5 })
    assert.equal(first.status, 200, JSON.stringify(first.body))

    const second = await call('POST', '/auth/kid-mode', H.dad, { durationMinutes: 30 })
    assert.equal(second.status, 409)
    assert.equal(second.body.code, 'KID_MODE_ALREADY_ACTIVE')

    const row = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      select: { kidModeUntil: true }
    })
    const remaining = (row.kidModeUntil?.getTime() ?? 0) - Date.now()
    assert.ok(remaining <= 5 * 60_000, `第二次调用把时间推后了：${remaining}`)
  })

  it('★ 时间到点后角色仍是 child，用 PIN 直接进家长模式被 409 挡住', async () => {
    // 直接把窗口拨到过去 —— 等价于"孩子等到了点"。
    await prisma.deviceSession.update({
      where: { deviceId_childId: { deviceId: ID.devDad, childId: ID.main } },
      data: { kidModeUntil: new Date(Date.now() - 1_000) }
    })

    const read = await call('GET', '/auth/parent-mode', H.dad)
    assert.equal(read.status, 200)
    assert.equal(read.body.activeRole, 'child')
    assert.equal(read.body.parentMode, false)
    assert.equal(read.body.kidMode, false)
    assert.equal(read.body.kidModeExpired, true)
    assert.equal(read.body.kidModeRemainingSeconds, 0)

    const blocked = await call('POST', '/auth/parent-mode', H.dad, { pin: PIN })
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.code, 'KID_MODE_ACTIVE')

    // 家长的专属动作仍然进不去（actor 是 child）。
    const forbidden = await call('POST', '/auth/parent-pin', H.dad, { pin: '9999' })
    assert.equal(forbidden.status, 403)
  })

  it('到期后用 PIN 收回 ⇒ 回到 guardian（这是唯一出口）', async () => {
    const res = await call('DELETE', '/auth/kid-mode', H.dad, { pin: PIN })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.kidModeExpired, false)
    assert.equal(res.body.parentMode, true)
  })
})

describe('组 E：谁能开 —— 成员位与 PIN 是两道独立的门', () => {
  it('孩子设备 ⇒ 403 KID_MODE_REQUIRES_GUARDIAN', async () => {
    const res = await call('POST', '/auth/kid-mode', H.kid, { durationMinutes: 15 })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'KID_MODE_REQUIRES_GUARDIAN')
  })

  it('家长成员位但没设 PIN ⇒ 409 KID_MODE_REQUIRES_PIN（否则到点收不回来）', async () => {
    const res = await call('POST', '/auth/kid-mode', H.mom, { durationMinutes: 15 })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'KID_MODE_REQUIRES_PIN')

    const row = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId: ID.devMom, childId: ID.main } },
      select: { kidModeUntil: true }
    })
    assert.equal(row.kidModeUntil, null, '409 之后不该留下任何写入')
  })
})


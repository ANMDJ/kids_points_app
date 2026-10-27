/**
 * deletion-http.test.ts —— 家庭数据删除（`/family-deletion`）的 **HTTP 集成测试**
 * （W7-D，2026-10-27；真起 Nest ＋ 真发请求）
 *
 * ── 它要证明的四件事 ────────────────────────────────────────────────────────
 *   ① 三个 Guard **真的挂在路由上**（缺身份 401、非成员 403、孩子 403）；
 *   ② `childId` / `userId` 真的来自**会话**，客户端无法指定「删谁家」；
 *   ③ 无库装配 ⇒ **501**，绝不回 200「已删除」（那会让家长以为数据没了）；
 *   ④ 二次确认是真的：缺字段 / `false` / 多余字段都不会走到端口。
 *
 * ★ 本文件**不**证明「撤回同意后仍可用」的结构 —— 那条由
 *   `deletion-wiring.test.ts` 对着守卫元数据钉住（守卫列表里没有 `ConsentGuard`）。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import { DELETION_REPOSITORY } from '../src/deletion/deletion.repository'
import { DeletionModule } from '../src/deletion/deletion.module'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'
import { makeDeletionFake, type DeletionFake } from './support/deletion-fake'

const CHILD_ID = 'child-1'
const DEV_DAD = 'dev-dad'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'
const DEV_STRANGER = 'dev-stranger'

const GUARDIAN = { 'x-kp-device-id': DEV_DAD, 'x-kp-child-id': CHILD_ID }
const CHILD = { 'x-kp-device-id': DEV_KID, 'x-kp-child-id': CHILD_ID }
const VIEWER = { 'x-kp-device-id': DEV_GUEST, 'x-kp-child-id': CHILD_ID }

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

/** `u-guest` 刻意没有成员位：屏障一必须在他身上给出 403（§9.21）。 */
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

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function call(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

async function startApp(repository?: DeletionFake): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [DeletionModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (repository !== undefined) {
    builder.overrideProvider(DELETION_REPOSITORY).useValue(repository)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app) // 与 main.ts 同一函数（不自己拼一份）
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 「没接库」必须是 501 ═══════════════════════════════════
describe('组 A：默认装配（删除端口未注入）⇒ 501，绝不回「已删除」', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('GET /family-deletion ⇒ 501 FAMILY_DELETION_NOT_IMPLEMENTED', async () => {
    const res = await call(url, '/family-deletion', { headers: GUARDIAN })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'FAMILY_DELETION_NOT_IMPLEMENTED')
  })

  it('POST /family-deletion ⇒ 501（不是 200 + 一个假状态）', async () => {
    const res = await call(url, '/family-deletion', {
      method: 'POST',
      body: { confirmed: true },
      headers: GUARDIAN
    })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'FAMILY_DELETION_NOT_IMPLEMENTED')
  })

  it('POST /family-deletion/cancel ⇒ 501（撤销也不能假装成功）', async () => {
    const res = await call(url, '/family-deletion/cancel', { method: 'POST', headers: GUARDIAN })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'FAMILY_DELETION_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：三道屏障 ═══════════════════════════════════════════════════════════
describe('组 B：身份 → 屏障一 → 屏障二 —— 缺任何一道都不给删除', () => {
  let app!: INestApplication
  let url = ''
  let port: DeletionFake

  before(async () => {
    port = makeDeletionFake()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
  })

  it('缺 x-kp-device-id / x-kp-child-id ⇒ 401 UNAUTHENTICATED，端口零调用', async () => {
    const noDevice = await call(url, '/family-deletion', { headers: { 'x-kp-child-id': CHILD_ID } })
    assert.equal(noDevice.status, 401)
    assert.equal(noDevice.body.code, 'UNAUTHENTICATED')

    const noChild = await call(url, '/family-deletion', { headers: { 'x-kp-device-id': DEV_DAD } })
    assert.equal(noChild.status, 401)
    assert.equal(noChild.body.code, 'UNAUTHENTICATED')

    assert.equal(port.calls.length, 0, '身份没过却已经碰了删除端口 —— 权限成了可选')
  })

  it('没有会话 ⇒ 401 SESSION_NOT_FOUND', async () => {
    const res = await call(url, '/family-deletion', {
      headers: { 'x-kp-device-id': DEV_STRANGER, 'x-kp-child-id': CHILD_ID }
    })
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'SESSION_NOT_FOUND')
    assert.equal(port.calls.length, 0)
  })

  it('有会话但不是成员 ⇒ 403 MEMBER_NOT_FOUND（§9.21），端口零调用', async () => {
    const res = await call(url, '/family-deletion', { headers: VIEWER })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'MEMBER_NOT_FOUND')
    assert.equal(port.calls.length, 0)
  })

  it('★ 孩子本人 ⇒ 403 FORBIDDEN（矩阵 view/manage_family_deletion.child = DENY）', async () => {
    const read = await call(url, '/family-deletion', { headers: CHILD })
    assert.equal(read.status, 403)
    assert.equal(read.body.code, 'FORBIDDEN')

    const write = await call(url, '/family-deletion', {
      method: 'POST',
      body: { confirmed: true },
      headers: CHILD
    })
    assert.equal(write.status, 403)
    assert.equal(write.body.code, 'FORBIDDEN')

    const cancel = await call(url, '/family-deletion/cancel', {
      method: 'POST',
      headers: CHILD
    })
    assert.equal(cancel.status, 403)

    assert.equal(port.calls.length, 0, '孩子被拒了却已进入业务层 —— 拒绝发生在读/写之后')
  })
})

// ══ 组 C：二次确认 ═══════════════════════════════════════════════════════════
describe('组 C：二次确认 —— 缺字段 / false / 多余字段都不许走到端口', () => {
  let app!: INestApplication
  let url = ''
  let port: DeletionFake

  before(async () => {
    port = makeDeletionFake()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
  })

  it('空 body ⇒ 400（管道层拒绝），端口零调用', async () => {
    const res = await call(url, '/family-deletion', { method: 'POST', body: {}, headers: GUARDIAN })
    assert.equal(res.status, 400)
    assert.equal(port.calls.length, 0)
  })

  it('confirmed: false ⇒ 400 FAMILY_DELETION_NOT_CONFIRMED', async () => {
    const res = await call(url, '/family-deletion', {
      method: 'POST',
      body: { confirmed: false },
      headers: GUARDIAN
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'FAMILY_DELETION_NOT_CONFIRMED')
    assert.equal(port.calls.length, 0)
  })

  it('confirmed: "true"（字符串）⇒ 400 —— 宽松解析会把旧 body 变成一次删除', async () => {
    const res = await call(url, '/family-deletion', {
      method: 'POST',
      body: { confirmed: 'true' },
      headers: GUARDIAN
    })
    assert.equal(res.status, 400)
    assert.equal(port.calls.length, 0)
  })

  it('多余字段（childId / days / userId）⇒ 400 —— 请求体集合封闭', async () => {
    for (const extra of [{ childId: 'child-2' }, { days: 0 }, { userId: 'u-other' }]) {
      const res = await call(url, '/family-deletion', {
        method: 'POST',
        body: { confirmed: true, ...extra },
        headers: GUARDIAN
      })
      assert.equal(res.status, 400, `${JSON.stringify(extra)} 竟然被接受`)
    }
    assert.equal(port.calls.length, 0)
  })
})
// ══ 组 D：成功形状 ═══════════════════════════════════════════════════════════
describe('组 D：guardian 200 —— childId / userId 来自会话，状态原样回放', () => {
  let app!: INestApplication
  let url = ''
  let port: DeletionFake

  before(async () => {
    port = makeDeletionFake('pending')
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
  })

  it('GET ⇒ 200，端口收到会话里的 childId', async () => {
    const res = await call(url, '/family-deletion', { headers: GUARDIAN })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'pending')
    assert.equal(res.body.daysRemaining, 7)
    assert.deepEqual(port.calls, [{ op: 'read', childId: CHILD_ID }])
  })

  it('POST { confirmed: true } ⇒ 200，输入带会话里的 childId + userId + 时钟', async () => {
    const res = await call(url, '/family-deletion', {
      method: 'POST',
      body: { confirmed: true },
      headers: GUARDIAN
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'pending')

    const first = port.calls[0]
    assert.equal(first?.op, 'request')
    if (first?.op !== 'request') return
    assert.equal(first.input.childId, CHILD_ID)
    assert.deepEqual(first.input.operator, { userId: 'u-dad', role: 'guardian' })
    assert.ok(first.input.now instanceof Date)
  })

  it('POST /family-deletion/cancel ⇒ 200 cancelled，输入同样来自会话', async () => {
    const res = await call(url, '/family-deletion/cancel', { method: 'POST', headers: GUARDIAN })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'cancelled')
    assert.equal(res.body.canCancel, false)

    const first = port.calls[0]
    assert.equal(first?.op, 'cancel')
    if (first?.op !== 'cancel') return
    assert.equal(first.input.childId, CHILD_ID)
    assert.equal(first.input.operator.userId, 'u-dad')
  })
})


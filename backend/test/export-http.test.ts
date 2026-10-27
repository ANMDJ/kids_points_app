/**
 * export-http.test.ts —— 家庭数据导出（`GET /export`）的 **HTTP 集成测试**
 * （W7-C，2026-10-27；真起 Nest ＋ 真发请求）
 *
 * ── 为什么必须走 HTTP ────────────────────────────────────────────────────────
 *   本文件要证明的不是「service 能拼出一个对象」，而是：
 *     ① 三个 Guard **真的挂在路由上**（缺身份 401、非成员 403、孩子 403）；
 *     ② `childId` 真的来自**会话**，端口收到的就是会话里的那个 ——
 *        客户端无法指定「导谁家」；
 *     ③ 无库装配 ⇒ **501**，绝不返回一份空文件（空文件会被当成「孩子没有数据」）；
 *     ④ 响应头真的让浏览器把它当**下载**（`Content-Disposition`）且**不被缓存**
 *        （`no-store`：这文件含全家信息）。
 *
 * ── 世界钉死 ────────────────────────────────────────────────────────────────
 *   恒用 `ExportModule.register({ hasDatabase: false })`：身份 / 成员位 / 导出端口
 *   三条都注入替身。若按环境推断，组 A 的 501 断言就不再是在测本模块。
 *
 * ── 它**不**证明的事 ────────────────────────────────────────────────────────
 *   替身不证明「真库导得对」（那是 `test-db/export-db.dbtest.ts`）。
 *   也不证明「撤回同意后仍可用」—— 那条在此结构上恒真（守卫列表里没有
 *   `ConsentGuard`），由 `export-wiring.test.ts` 组 B 对着元数据钉住。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import { EXPORT_LIMITS, EXPORT_REPOSITORY, type ExportPort } from '../src/export/export.repository'
import { ExportModule } from '../src/export/export.module'
import { makeExportFake } from './support/export-fake'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'

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
  headers: Headers
}

async function get(url: string, path: string, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, { headers })
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body, headers: res.headers }
}

async function startApp(repository?: ExportPort): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [ExportModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (repository !== undefined) {
    builder.overrideProvider(EXPORT_REPOSITORY).useValue(repository)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app) // 与 main.ts 同一函数（不自己拼一份）
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 「导出未接库」必须是 501，不是空文件 ═══════════════════
describe('组 A：默认装配（导出端口未注入）⇒ 501，绝不冒充「孩子没有数据」', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('GET /export ⇒ 501 EXPORT_MODEL_NOT_IMPLEMENTED（不是 200 + 空数组）', async () => {
    const res = await get(url, '/export', GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'EXPORT_MODEL_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：三道屏障真的挂在路由上 ═════════════════════════════════════════════
describe('组 B：身份 → 屏障一 → 屏障二 —— 缺任何一道都不给导出', () => {
  let app!: INestApplication
  let url = ''
  let port: ReturnType<typeof makeExportFake>

  before(async () => {
    port = makeExportFake()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
  })

  it('缺 x-kp-device-id / x-kp-child-id ⇒ 401 UNAUTHENTICATED，端口零调用', async () => {
    const noDevice = await get(url, '/export', { 'x-kp-child-id': CHILD_ID })
    assert.equal(noDevice.status, 401)
    assert.equal(noDevice.body.code, 'UNAUTHENTICATED')

    const noChild = await get(url, '/export', { 'x-kp-device-id': DEV_DAD })
    assert.equal(noChild.status, 401)
    assert.equal(noChild.body.code, 'UNAUTHENTICATED')

    assert.equal(port.calls.length, 0, '身份没过却读了全份家庭数据 —— 权限成了可选')
  })

  it('没有会话 ⇒ 401 SESSION_NOT_FOUND，端口零调用', async () => {
    const res = await get(url, '/export', { 'x-kp-device-id': DEV_STRANGER, 'x-kp-child-id': CHILD_ID })
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'SESSION_NOT_FOUND')
    assert.equal(port.calls.length, 0)
  })

  it('有会话但不是成员 ⇒ 403 MEMBER_NOT_FOUND，端口零调用（§9.21）', async () => {
    const res = await get(url, '/export', VIEWER)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'MEMBER_NOT_FOUND')
    assert.equal(port.calls.length, 0)
  })

  it('★ 孩子本人 ⇒ 403 FORBIDDEN，端口零调用（矩阵 export_family_data.child = DENY）', async () => {
    const res = await get(url, '/export', CHILD)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.calls.length, 0, '孩子被拒了却已经读过全份数据 —— 拒绝发生在读之后')
  })
})


// ══ 组 C：成功形状 ═══════════════════════════════════════════════════════════
describe('组 C：guardian 200 —— childId 来自会话、九段齐全、可下载且不缓存', () => {
  let app!: INestApplication
  let url = ''
  let port: ReturnType<typeof makeExportFake>

  before(async () => {
    port = makeExportFake()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
  })

  it('端口收到的是**会话里的** childId，而不是 query 里能改的东西', async () => {
    const res = await get(url, '/export?childId=child-2', GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(port.calls, [{ childId: CHILD_ID, limits: EXPORT_LIMITS }])
  })

  it('响应头：attachment + .json（浏览器落盘）+ no-store（全家信息不许被缓存）', async () => {
    const res = await get(url, '/export', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
    assert.match(
      res.headers.get('content-disposition') ?? '',
      /^attachment; filename="family-export-child-1-\d{4}-\d{2}-\d{2}\.json"$/
    )
    assert.equal(res.headers.get('cache-control'), 'no-store')
  })

  it('九段齐全，且 summary 与本文件条数一致', async () => {
    const res = await get(url, '/export', GUARDIAN)
    const body = res.body as Record<string, unknown> & {
      child: { id: string; name: string }
      members: unknown[]
      rules: unknown[]
      habits: unknown[]
      wishes: unknown[]
      records: unknown[]
      approvals: unknown[]
      consents: unknown[]
      auditLogs: unknown[]
      summary: { counts: Record<string, number>; truncated: boolean }
    }

    assert.equal(body.schemaVersion, 1)
    assert.equal(body.child.id, CHILD_ID)
    assert.equal(body.child.name, '小满')
    assert.equal(body.members.length, 2)
    assert.equal(body.rules.length, 1)
    assert.equal(body.habits.length, 1)
    assert.equal(body.wishes.length, 1)
    assert.equal(body.records.length, 2)
    assert.equal(body.approvals.length, 1)
    assert.equal(body.consents.length, 1)
    assert.equal(body.auditLogs.length, 1)
    assert.equal(body.summary.truncated, false)
    assert.deepEqual(body.summary.counts, {
      members: 2,
      rules: 1,
      habits: 1,
      wishes: 1,
      records: 2,
      approvals: 1,
      consents: 1,
      auditLogs: 1
    })
  })
})

// ══ 组 D：孩子已软删 ⇒ 404，不是空文件 ══════════════════════════════════════
describe('组 D：端口说「查不到这个孩子」⇒ 404 CHILD_NOT_FOUND（空文件会被当成数据全丢）', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp(makeExportFake(null)))
  })
  after(async () => {
    await app.close()
  })

  it('404，且响应里没有 child / records 段', async () => {
    const res = await get(url, '/export', GUARDIAN)
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'CHILD_NOT_FOUND')
    assert.equal(res.body.child, undefined)
    assert.equal(res.body.records, undefined)
  })
})


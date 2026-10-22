/**
 * child-http.test.ts —— 孩子档案写入口的 **HTTP 集成测试**（W5-E，2026-10-21）
 *
 * 真起 Nest、真发请求；持久化端口是替身（世界固定 `hasDatabase: false`）。
 * 要证明的是**路由上的事实**：
 *   ① 三个 Guard 真的挂在控制器上（缺身份 401 / child 403 / viewer 403）；
 *   ② `childId` 来自会话 —— 请求体多传 `childId` 必须 400；
 *   ③ 昵称在 service **唯一一处** trim，并按**码点**限长 16（emoji 算 1 个）；
 *   ④ 回包是 `{ childId, name }`，name 以端口返回值为准（服务端可规范化）；
 *   ⑤ 无库装配时 501，绝不假装改名成功。
 *
 * ★ 这里**不**证明「审计真的落了库」——那需要真 Postgres，属于
 *   `children-prisma` 集成用例的范围；替身只能证明控制器把正确的输入交给了端口。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  CHILDREN_REPOSITORY,
  type ChildProfileRow,
  type ChildrenPort,
  type RenameChildInput
} from '../src/children/children.repository'
import { ChildrenModule } from '../src/children/children.module'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'

const CHILD_ID = 'child-1'
const DEV_DAD = 'dev-dad'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'

function identity(deviceId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': CHILD_ID }
}

const GUARDIAN = identity(DEV_DAD)
const CHILD = identity(DEV_KID)
const VIEWER = identity(DEV_GUEST)

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

type PortFake = ChildrenPort & {
  renames: RenameChildInput[]
  /** 端口返回的昵称（模拟服务端规范化），null ⇒ 原样回显输入。 */
  returnedName: string | null
}

function makePort(): PortFake {
  const port: PortFake = {
    renames: [],
    returnedName: null,
    async renameChild(input): Promise<ChildProfileRow> {
      port.renames.push(input)
      return { childId: input.childId, name: port.returnedName ?? input.name }
    }
  }
  return port
}


interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function request(
  baseUrl: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}/child`, {
    method: 'PATCH',
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

async function startApp(
  options: { port?: ChildrenPort } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [ChildrenModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (options.port !== undefined) {
    builder.overrideProvider(CHILDREN_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 501，绝不假装改名成功 ═════════════════════════════════════
describe('组 A：默认装配（档案端口未注入）⇒ 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('PATCH /child ⇒ 501 CHILDREN_PERSISTENCE_NOT_IMPLEMENTED', async () => {
    const res = await request(url, GUARDIAN, { name: '小明' })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'CHILDREN_PERSISTENCE_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：三道屏障 —— 身份 / 成员 / 权限（顺序不能反）══════════════════════════
describe('组 B：身份与权限', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = makePort()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.renames.length = 0
  })

  it('缺设备头 ⇒ 401（身份解析没跑，根本到不了控制器）', async () => {
    const res = await request(url, {}, { name: '小明' })
    assert.equal(res.status, 401)
    assert.equal(port.renames.length, 0)
  })

  it('孩子改档案 ⇒ 403（矩阵：edit_child_profile child DENY）', async () => {
    const res = await request(url, CHILD, { name: '小明' })
    assert.equal(res.status, 403)
    assert.equal(port.renames.length, 0)
  })

  it('viewer ⇒ 403（不是成员，屏障一就拦下）', async () => {
    const res = await request(url, VIEWER, { name: '小明' })
    assert.equal(res.status, 403)
    assert.equal(port.renames.length, 0)
  })

  it('家长改档案 ⇒ 200，孩子 id 与操作人都来自会话', async () => {
    const res = await request(url, GUARDIAN, { name: '小明' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { childId: CHILD_ID, name: '小明' })
    assert.equal(port.renames.length, 1)
    assert.equal(port.renames[0].childId, CHILD_ID)
    assert.equal(port.renames[0].operatorUserId, 'u-dad')
    assert.equal(port.renames[0].operatorRole, 'guardian')
  })
})

// ══ 组 C：请求形状 —— 集合封闭 + 非空 + 码点限长 ═══════════════════════════════
describe('组 C：请求形状与昵称规范化', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = makePort()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.renames.length = 0
    port.returnedName = null
  })

  it('请求体带 childId ⇒ 400（孩子只能来自会话，不能由客户端指定）', async () => {
    const res = await request(url, GUARDIAN, { name: '小明', childId: 'child-2' })
    assert.equal(res.status, 400)
    assert.equal(port.renames.length, 0)
  })

  it('请求体带 points ⇒ 400（档案写入不接受积分字段）', async () => {
    const res = await request(url, GUARDIAN, { name: '小明', points: 100 })
    assert.equal(res.status, 400)
    assert.equal(port.renames.length, 0)
  })

  it('缺 name ⇒ 400', async () => {
    const res = await request(url, GUARDIAN, {})
    assert.equal(res.status, 400)
    assert.equal(port.renames.length, 0)
  })

  it('name 全是空格 ⇒ 400 CHILD_NAME_EMPTY（管道层长度是 3，trim 后为空）', async () => {
    const res = await request(url, GUARDIAN, { name: '   ' })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'CHILD_NAME_EMPTY')
    assert.equal(port.renames.length, 0)
  })

  it('首尾空格被 trim 掉后才落库', async () => {
    const res = await request(url, GUARDIAN, { name: '  小明  ' })
    assert.equal(res.status, 200)
    assert.equal(port.renames[0].name, '小明')
    assert.equal(res.body.name, '小明')
  })

  it('17 个汉字 ⇒ 400 CHILD_NAME_TOO_LONG', async () => {
    const res = await request(url, GUARDIAN, { name: '一二三四五六七八九十一二三四五六七' })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'CHILD_NAME_TOO_LONG')
    assert.equal(port.renames.length, 0)
  })

  it('16 个 emoji ⇒ 200（按码点数，不按 UTF-16 code unit）', async () => {
    const sixteen = '🧒'.repeat(16)
    assert.equal(sixteen.length, 32, '前提：16 个 emoji 是 32 个 code unit')
    const res = await request(url, GUARDIAN, { name: sixteen })
    assert.equal(res.status, 200)
    assert.equal(port.renames[0].name, sixteen)
  })

  it('回包的 name 以端口返回值为准（服务端可规范化）', async () => {
    port.returnedName = '服务端规范化后的名字'
    const res = await request(url, GUARDIAN, { name: '随便写的' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { childId: CHILD_ID, name: '服务端规范化后的名字' })
  })
})


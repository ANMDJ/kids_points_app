/**
 * trash-http.test.ts —— 回收站三条路由的 **HTTP 集成测试**（W5-F，2026-10-21）
 *
 * 真起 Nest、真发请求；三个端口（会话 / 成员 / 回收站）都是替身
 * （世界固定 `hasDatabase: false`）。要证明的是**路由上的事实**：
 *   ① 三个 Guard 真的挂在 `TrashController` 上（缺身份 401 / viewer 无成员位 403）；
 *   ② 矩阵真的分开了「看」与「改」：孩子能 `GET /trash`，
 *      但 `restore` / `purge` 一律 403，**且端口一次都没被调用**；
 *   ③ `childId` 来自会话而不是 URL/查询串（`kind` 不认识 ⇒ 400，不是 404）；
 *   ④ 端口抛出的 404 / 409 原样变成 HTTP 404 / 409（不变成 500）；
 *   ⑤ 无库装配时三条路由都 501 —— **不返回空列表**冒充"回收站是空的"。
 *
 * ★ 这里**不**证明「恢复后真的回到清单」「有流水时拒绝彻底删除」——
 *   那需要真 Postgres，属于 Prisma 集成用例的范围。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import {
  ConflictException,
  NotFoundException,
  type INestApplication
} from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'
import {
  TRASH_REPOSITORY,
  type TrashPort,
  type TrashTargetInput
} from '../src/trash/trash.repository'
import type { TrashItemRow } from '../src/trash/trash.types'
import { TrashModule } from '../src/trash/trash.module'

const CHILD_ID = 'child-1'
const RULE_ID = 'rule-1'
const WISH_ID = 'wish-1'
const HABIT_ID = 'habit-1'

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

/** `u-guest` 刻意没有成员位：屏障一必须给出 403。 */
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

function trashRows(): TrashItemRow[] {
  return [
    {
      kind: 'point_rule',
      id: RULE_ID,
      title: '整理房间',
      deletedAt: new Date('2026-10-20T02:00:00.000Z')
    },
    {
      kind: 'wish',
      id: WISH_ID,
      title: '去游乐园',
      deletedAt: new Date('2026-10-19T02:00:00.000Z')
    },
    {
      kind: 'habit',
      id: HABIT_ID,
      title: '刷牙',
      deletedAt: new Date('2026-10-18T02:00:00.000Z')
    }
  ]
}

type PortFake = TrashPort & {
  lists: string[]
  restores: TrashTargetInput[]
  purges: TrashTargetInput[]
  restoreError: Error | null
  purgeError: Error | null
}

function makePort(): PortFake {
  const port: PortFake = {
    lists: [],
    restores: [],
    purges: [],
    restoreError: null,
    purgeError: null,
    async listTrash(childId) {
      port.lists.push(childId)
      return trashRows()
    },
    async restoreTrash(input) {
      port.restores.push(input)
      if (port.restoreError !== null) throw port.restoreError
      return { kind: input.kind, id: input.id }
    },
    async purgeTrash(input) {
      port.purges.push(input)
      if (port.purgeError !== null) throw port.purgeError
      return { kind: input.kind, id: input.id }
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
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  headers: Record<string, string>
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers })
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
  options: { port?: TrashPort } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [TrashModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (options.port !== undefined) {
    builder.overrideProvider(TRASH_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 501，绝不返回空列表冒充"回收站是空的" ════════════════════
describe('组 A：默认装配（回收站端口未注入）⇒ 三条路由全 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('GET /trash ⇒ 501（空列表会被误读成"删掉的东西已经不在了"）', async () => {
    const res = await request(url, 'GET', '/trash', GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'TRASH_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('POST /trash/:kind/:id/restore ⇒ 501', async () => {
    const res = await request(url, 'POST', `/trash/wish/${WISH_ID}/restore`, GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'TRASH_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('DELETE /trash/:kind/:id ⇒ 501（不会假装已经彻底删除）', async () => {
    const res = await request(url, 'DELETE', `/trash/wish/${WISH_ID}`, GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'TRASH_PERSISTENCE_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：三道屏障 —— 身份 / 成员 / 矩阵（顺序不能反）═══════════════════════════
describe('组 B：看得到 ≠ 改得动', () => {
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
    port.lists.length = 0
    port.restores.length = 0
    port.purges.length = 0
  })

  it('缺身份头 ⇒ 401，端口零调用', async () => {
    const res = await request(url, 'GET', '/trash', {})
    assert.equal(res.status, 401)
    assert.equal(port.lists.length, 0)
  })

  it('viewer 没有成员位 ⇒ 403（屏障一），端口零调用', async () => {
    const res = await request(url, 'GET', '/trash', VIEWER)
    assert.equal(res.status, 403)
    assert.equal(port.lists.length, 0)
  })

  it('孩子 GET /trash ⇒ 200（矩阵 view_trash child ALLOW）', async () => {
    const res = await request(url, 'GET', '/trash', CHILD)
    assert.equal(res.status, 200)
    assert.equal(port.lists.length, 1)
  })

  it('孩子恢复 ⇒ 403 FORBIDDEN，端口零调用（restore_trash_item child DENY）', async () => {
    const res = await request(url, 'POST', `/trash/habit/${HABIT_ID}/restore`, CHILD)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.restores.length, 0)
  })

  it('孩子彻底删除 ⇒ 403 FORBIDDEN，端口零调用（purge_trash_item child DENY）', async () => {
    const res = await request(url, 'DELETE', `/trash/habit/${HABIT_ID}`, CHILD)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.purges.length, 0)
  })
})


// ══ 组 C：成功路径 + 线格式 ════════════════════════════════════════════════════
describe('组 C：家长路径与响应形状', () => {
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
    port.lists.length = 0
    port.restores.length = 0
    port.purges.length = 0
    port.restoreError = null
    port.purgeError = null
  })

  it('GET /trash ⇒ {items:[{kind,id,title,deletedAt}]}，deletedAt 是 ISO 串', async () => {
    const res = await request(url, 'GET', '/trash', GUARDIAN)
    assert.equal(res.status, 200)
    const items = res.body.items as Array<Record<string, unknown>>
    assert.equal(items.length, 3)
    assert.deepEqual(
      items.map((item) => item.kind),
      ['point_rule', 'wish', 'habit']
    )
    assert.equal(items[0].id, RULE_ID)
    assert.equal(items[0].title, '整理房间')
    // ★ 线格式必须是字符串：Date 序列化结果相同，但契约要求显式 toISOString。
    assert.equal(items[0].deletedAt, '2026-10-20T02:00:00.000Z')
    // 返回体里**不**出现 90 天 / expired —— 那是客户端纯函数（判据只保留一份）。
    assert.equal(items[0].expired, undefined)
  })

  it('childId 来自会话（不是查询串）：带 ?childId= 也不影响端口收到的孩子', async () => {
    const res = await request(url, 'GET', '/trash?childId=other-child', GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(port.lists, [CHILD_ID])
  })

  it('恢复 ⇒ 200 {kind,id}，端口收到的是家长身份', async () => {
    const res = await request(url, 'POST', `/trash/habit/${HABIT_ID}/restore`, GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { kind: 'habit', id: HABIT_ID })
    assert.deepEqual(port.restores[0], {
      childId: CHILD_ID,
      kind: 'habit',
      id: HABIT_ID,
      operatorUserId: 'u-dad',
      operatorRole: 'guardian'
    })
  })

  it('彻底删除 ⇒ 200 {kind,id}', async () => {
    const res = await request(url, 'DELETE', `/trash/wish/${WISH_ID}`, GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { kind: 'wish', id: WISH_ID })
    assert.equal(port.purges.length, 1)
  })

  it('未知 kind ⇒ 400 TRASH_KIND_INVALID（不是 404：地址拼错了，不该当成"已经没了"）', async () => {
    const res = await request(url, 'DELETE', `/trash/record/${WISH_ID}`, GUARDIAN)
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'TRASH_KIND_INVALID')
    assert.equal(port.purges.length, 0)
  })

  it('端口 404 TRASH_ITEM_NOT_FOUND ⇒ HTTP 404 + 同一个 code', async () => {
    port.restoreError = new NotFoundException({
      code: 'TRASH_ITEM_NOT_FOUND',
      message: '不在回收站里'
    })
    const res = await request(url, 'POST', `/trash/point_rule/${RULE_ID}/restore`, GUARDIAN)
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'TRASH_ITEM_NOT_FOUND')
  })

  it('端口 409 TRASH_ITEM_REFERENCED ⇒ HTTP 409（不是 500）', async () => {
    port.purgeError = new ConflictException({
      code: 'TRASH_ITEM_REFERENCED',
      message: '还有流水引用'
    })
    const res = await request(url, 'DELETE', `/trash/habit/${HABIT_ID}`, GUARDIAN)
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'TRASH_ITEM_REFERENCED')
  })

  it('端口 409 TRASH_PARENT_RULE_DELETED ⇒ HTTP 409（恢复习惯前先恢复规则）', async () => {
    port.restoreError = new ConflictException({
      code: 'TRASH_PARENT_RULE_DELETED',
      message: '来源规则还在回收站里'
    })
    const res = await request(url, 'POST', `/trash/habit/${HABIT_ID}/restore`, GUARDIAN)
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'TRASH_PARENT_RULE_DELETED')
  })
})

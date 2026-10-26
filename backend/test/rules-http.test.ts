/**
 * rules-http.test.ts —— 规则写入口的 **HTTP 集成测试**（W5-A，2026-10-19）
 *
 * 真起 Nest、真发请求；持久化与幂等端口都是替身（世界固定 `hasDatabase: false`）。
 * 要证明的是**路由上的事实**：
 *   ① 三个 Guard 真的挂在控制器上（缺身份 401 / child、viewer 403）；
 *   ② `childId` 来自会话 —— 请求体多传 `childId` / `direction` 必须 400；
 *   ③ 客户端带符号 `points` 在 service **唯一一处**转成「正数 + direction」；
 *   ④ 编辑把 `expectedVersion` 原样交给端口（乐观锁在库层兑现）；
 *   ⑤ 四个端点都支持 `Idempotency-Key`，且无库装配时一律 501。
 *
 * ★ 这里**不**证明「版本行/审计真的落了库」——那需要真 Postgres，属于
 *   `rules-prisma` 集成用例的范围；替身只能证明控制器把正确的输入交给了端口。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { ConflictException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import {
  IDEMPOTENCY_REPOSITORY,
  type BeginIdempotencyInput,
  type BeginIdempotencyResult,
  type CompleteIdempotencyInput,
  type IdempotencyPort
} from '../src/idempotency/idempotency.repository'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'
import type { HabitRow, RuleRow } from '../src/read/read.repository'
import { RulesModule } from '../src/rules/rules.module'
import {
  RULES_REPOSITORY,
  type AddHabitFromRuleInput,
  type CreateRuleInput,
  type DeleteRuleInput,
  type RulesPort,
  type UpdateRuleInput
} from '../src/rules/rules.repository'

// ★ W7-A：同意闸门（第四道屏障）—— 见 test/support/consent-fake.ts
import { CONSENT_REPOSITORY } from '../src/consent/consent.repository'
import { makeGrantedConsentFake } from './support/consent-fake'

const CHILD_ID = 'child-1'
const RULE_ID = 'rule-1'
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

function ruleRow(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    id: RULE_ID,
    title: '番茄钟写作业',
    condition: '专注 25 分钟',
    dailyLimit: 2,
    points: 3,
    direction: 'reward',
    icon: 'pencil',
    color: '#7bb0e8',
    currentVersion: 1,
    ...overrides
  }
}

function habitRow(overrides: Partial<HabitRow> = {}): HabitRow {
  return {
    id: 'habit-1',
    title: '番茄钟写作业',
    points: 3,
    condition: '专注 25 分钟',
    dailyLimit: 2,
    icon: 'pencil',
    color: '#7bb0e8',
    ruleId: RULE_ID,
    ...overrides
  }
}

const VALID_CREATE = {
  title: '  番茄钟写作业  ',
  condition: '  专注 25 分钟 ',
  dailyLimit: 2,
  points: 3,
  icon: 'pencil',
  color: '#7bb0e8'
}

type PortFake = RulesPort & {
  creates: CreateRuleInput[]
  updates: UpdateRuleInput[]
  deletes: DeleteRuleInput[]
  habitAdds: AddHabitFromRuleInput[]
  createError: Error | null
  updateError: Error | null
  deleteError: Error | null
  habitError: Error | null
}

function makePort(): PortFake {
  const port: PortFake = {
    creates: [],
    updates: [],
    deletes: [],
    habitAdds: [],
    createError: null,
    updateError: null,
    deleteError: null,
    habitError: null,
    async createRule(input) {
      port.creates.push(input)
      if (port.createError !== null) throw port.createError
      return ruleRow({
        title: input.title,
        condition: input.condition,
        dailyLimit: input.dailyLimit,
        points: input.points,
        direction: input.direction,
        icon: input.icon,
        color: input.color
      })
    },
    async updateRule(input) {
      port.updates.push(input)
      if (port.updateError !== null) throw port.updateError
      return ruleRow({
        title: input.title,
        condition: input.condition,
        dailyLimit: input.dailyLimit,
        points: input.points,
        direction: input.direction,
        currentVersion: input.expectedVersion + 1
      })
    },
    async deleteRule(input) {
      port.deletes.push(input)
      if (port.deleteError !== null) throw port.deleteError
      return input.ruleId
    },
    async addHabitFromRule(input) {
      port.habitAdds.push(input)
      if (port.habitError !== null) throw port.habitError
      return habitRow()
    }
  }
  return port
}

/** 内存幂等：键 = `${childId}:${key}`，与库层唯一约束同形。 */
function makeIdempotencyFake(): IdempotencyPort & { begins: BeginIdempotencyInput[] } {
  const records = new Map<
    string,
    { requestHash: string; statusCode: number | null; body: Record<string, unknown> | null }
  >()
  const begins: BeginIdempotencyInput[] = []
  return {
    begins,
    async begin(input): Promise<BeginIdempotencyResult> {
      begins.push(input)
      const id = `${input.childId}:${input.key}`
      const existing = records.get(id)
      if (existing === undefined) {
        records.set(id, { requestHash: input.requestHash, statusCode: null, body: null })
        return { kind: 'started' }
      }
      if (existing.requestHash !== input.requestHash) {
        return { kind: 'conflict', reason: 'HASH_MISMATCH' }
      }
      if (existing.statusCode === null || existing.body === null) {
        return { kind: 'conflict', reason: 'IN_PROGRESS' }
      }
      return { kind: 'replay', statusCode: existing.statusCode, body: existing.body }
    },
    async complete(input: CompleteIdempotencyInput): Promise<void> {
      const id = `${input.childId}:${input.key}`
      const existing = records.get(id)
      if (existing === undefined) throw new Error(`complete 了不存在的幂等记录 ${id}`)
      existing.statusCode = input.statusCode
      existing.body = input.body
    },
    async abort(input): Promise<void> {
      records.delete(`${input.childId}:${input.key}`)
    }
  }
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function request(
  baseUrl: string,
  method: 'POST' | 'PATCH' | 'DELETE',
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

async function startApp(
  options: { port?: RulesPort; idempotency?: IdempotencyPort } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [RulesModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())
    // ★ W7-A：第四道屏障（同意闸门）。这些用例测的是本文件自己的关口，
    //   同意状态作为背景条件恒为 granted —— 撤回/重授予的行为见 consent-http.test.ts。
    .overrideProvider(CONSENT_REPOSITORY)
    .useValue(makeGrantedConsentFake())

  if (options.idempotency !== undefined) {
    builder.overrideProvider(IDEMPOTENCY_REPOSITORY).useValue(options.idempotency)
  }
  if (options.port !== undefined) {
    builder.overrideProvider(RULES_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 501，绝不假装规则已保存 ══════════════════════════════════
describe('组 A：默认装配（规则端口未注入）⇒ 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('POST /point-rules ⇒ 501 RULES_PERSISTENCE_NOT_IMPLEMENTED', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, VALID_CREATE)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'RULES_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('PATCH /point-rules/:id ⇒ 501', async () => {
    const res = await request(url, 'PATCH', `/point-rules/${RULE_ID}`, GUARDIAN, {
      title: '新名字',
      condition: '新条件',
      dailyLimit: 3,
      points: -2,
      expectedVersion: 1
    })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'RULES_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('DELETE /point-rules/:id ⇒ 501（不会假装进了回收站）', async () => {
    const res = await request(url, 'DELETE', `/point-rules/${RULE_ID}`, GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'RULES_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('POST /point-rules/:id/habits ⇒ 501（不会返回一个假习惯）', async () => {
    const res = await request(url, 'POST', `/point-rules/${RULE_ID}/habits`, GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'RULES_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('带 Idempotency-Key ⇒ 先被幂等端口 501 拦下（无库不假装保护已生效）', async () => {
    const res = await request(url, 'POST', '/point-rules', {
      ...GUARDIAN,
      'idempotency-key': 'rule-create-1'
    }, VALID_CREATE)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'IDEMPOTENCY_NOT_IMPLEMENTED')
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
    port.creates.length = 0
  })

  it('缺设备头 ⇒ 401（身份解析没跑，根本到不了控制器）', async () => {
    const res = await request(url, 'POST', '/point-rules', {}, VALID_CREATE)
    assert.equal(res.status, 401)
    assert.equal(port.creates.length, 0)
  })

  it('孩子建规则 ⇒ 403（矩阵：add_rule child DENY）', async () => {
    const res = await request(url, 'POST', '/point-rules', CHILD, VALID_CREATE)
    assert.equal(res.status, 403)
    assert.equal(port.creates.length, 0)
  })

  it('viewer ⇒ 403（矩阵只认 guardian / child，viewer 一律 DENY）', async () => {
    const res = await request(url, 'POST', '/point-rules', VIEWER, VALID_CREATE)
    assert.equal(res.status, 403)
    assert.equal(port.creates.length, 0)
  })

  it('家长建规则 ⇒ 201，且操作人来自会话', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, VALID_CREATE)
    assert.equal(res.status, 201)
    assert.equal(port.creates.length, 1)
    assert.equal(port.creates[0].childId, CHILD_ID)
    assert.equal(port.creates[0].operatorUserId, 'u-dad')
    assert.equal(port.creates[0].operatorRole, 'guardian')
  })
})

// ══ 组 C：请求形状 —— 集合封闭 + 分值规范化 ═════════════════════════════════════
describe('组 C：请求形状与分值规范化', () => {
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
    port.creates.length = 0
  })

  it('请求体带 childId ⇒ 400（孩子只能来自会话，不能由客户端指定）', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, {
      ...VALID_CREATE,
      childId: 'child-2'
    })
    assert.equal(res.status, 400)
    assert.equal(port.creates.length, 0)
  })

  it('请求体带 direction ⇒ 400（奖惩只能由 points 符号派生）', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, {
      ...VALID_CREATE,
      direction: 'penalty'
    })
    assert.equal(res.status, 400)
    assert.equal(port.creates.length, 0)
  })

  it('points=0 ⇒ 400（0 无法决定 direction）', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, {
      ...VALID_CREATE,
      points: 0
    })
    assert.equal(res.status, 400)
    assert.equal(port.creates.length, 0)
  })

  it('dailyLimit=6 ⇒ 400（1–5 是硬性业务规则）', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, {
      ...VALID_CREATE,
      dailyLimit: 6
    })
    assert.equal(res.status, 400)
  })

  it('color 不是 #rrggbb ⇒ 400', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, {
      ...VALID_CREATE,
      color: 'blue'
    })
    assert.equal(res.status, 400)
  })

  it('标题全空白 ⇒ 400 RULE_TITLE_REQUIRED（DTO 的 MinLength 拦不住空格）', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, {
      ...VALID_CREATE,
      title: '   '
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'RULE_TITLE_REQUIRED')
    assert.equal(port.creates.length, 0)
  })

  it('正分 ⇒ 201，端口收到「正数 + reward」，两端都 trim', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, VALID_CREATE)
    assert.equal(res.status, 201)
    assert.equal(port.creates[0].points, 3)
    assert.equal(port.creates[0].direction, 'reward')
    assert.equal(port.creates[0].title, '番茄钟写作业')
    assert.equal(port.creates[0].condition, '专注 25 分钟')
    assert.equal(res.body.points, 3)
    assert.equal(res.body.direction, 'reward')
    assert.equal(res.body.currentVersion, 1)
  })

  it('负分 ⇒ 端口收到「正数 + penalty」，响应 points 回到带符号的 -2', async () => {
    const res = await request(url, 'POST', '/point-rules', GUARDIAN, {
      ...VALID_CREATE,
      points: -2
    })
    assert.equal(res.status, 201)
    assert.equal(port.creates[0].points, 2)
    assert.equal(port.creates[0].direction, 'penalty')
    assert.equal(res.body.points, -2)
    assert.equal(res.body.direction, 'penalty')
  })

  it('空 condition ⇒ 落成「家长约定」（与双端本地实现同口径）', async () => {
    await request(url, 'POST', '/point-rules', GUARDIAN, {
      ...VALID_CREATE,
      condition: '   '
    })
    assert.equal(port.creates[0].condition, '家长约定')
  })
})

// ══ 组 D：编辑 / 删除 / 派生习惯 —— 端口收到的输入是契约 ═══════════════════════
describe('组 D：编辑、删除、加入今天的习惯', () => {
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
    port.updates.length = 0
    port.deletes.length = 0
    port.habitAdds.length = 0
  })

  it('PATCH 把 expectedVersion 原样交给端口，返回新版本', async () => {
    const res = await request(url, 'PATCH', `/point-rules/${RULE_ID}`, GUARDIAN, {
      title: '番茄钟',
      condition: '专注 30 分钟',
      dailyLimit: 3,
      points: -2,
      expectedVersion: 4
    })
    assert.equal(res.status, 200)
    assert.equal(port.updates.length, 1)
    assert.equal(port.updates[0].ruleId, RULE_ID)
    assert.equal(port.updates[0].expectedVersion, 4)
    assert.equal(port.updates[0].points, 2)
    assert.equal(port.updates[0].direction, 'penalty')
    assert.equal(res.body.currentVersion, 5)
    assert.equal(res.body.points, -2)
  })

  it('PATCH 的请求体带 currentVersion ⇒ 400（新版本号只能由服务端算）', async () => {
    const res = await request(url, 'PATCH', `/point-rules/${RULE_ID}`, GUARDIAN, {
      title: '番茄钟',
      condition: '专注 30 分钟',
      dailyLimit: 3,
      points: 2,
      expectedVersion: 4,
      currentVersion: 9
    })
    assert.equal(res.status, 400)
    assert.equal(port.updates.length, 0)
  })

  it('DELETE ⇒ 200 { ruleId }，端口收到会话里的操作人', async () => {
    const res = await request(url, 'DELETE', `/point-rules/${RULE_ID}`, GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ruleId: RULE_ID })
    assert.equal(port.deletes[0].childId, CHILD_ID)
    assert.equal(port.deletes[0].operatorUserId, 'u-dad')
  })

  it('孩子删除 ⇒ 403（delete_rule child DENY）', async () => {
    const res = await request(url, 'DELETE', `/point-rules/${RULE_ID}`, CHILD)
    assert.equal(res.status, 403)
    assert.equal(port.deletes.length, 0)
  })

  it('POST /point-rules/:id/habits ⇒ 201，返回与 GET /home 的 habits 同构的行', async () => {
    const res = await request(url, 'POST', `/point-rules/${RULE_ID}/habits`, GUARDIAN)
    assert.equal(res.status, 201)
    assert.equal(port.habitAdds[0].ruleId, RULE_ID)
    assert.deepEqual(res.body, {
      id: 'habit-1',
      title: '番茄钟写作业',
      points: 3,
      condition: '专注 25 分钟',
      dailyLimit: 2,
      icon: 'pencil',
      color: '#7bb0e8',
      ruleId: RULE_ID
    })
  })
})

// ══ 组 E：端口的 4xx 原样穿过 HTTP（错误码是契约的一部分）════════════════════════
describe('组 E：端口错误码不变形', () => {
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
    port.createError = null
    port.updateError = null
    port.habitError = null
  })

  it('版本冲突 ⇒ 409 RULE_VERSION_CONFLICT + details（客户端据此刷新）', async () => {
    port.updateError = new ConflictException({
      code: 'RULE_VERSION_CONFLICT',
      message: '已经有人改过',
      details: { currentVersion: 5, expectedVersion: 4 }
    })
    const res = await request(url, 'PATCH', `/point-rules/${RULE_ID}`, GUARDIAN, {
      title: '番茄钟',
      condition: '专注 30 分钟',
      dailyLimit: 3,
      points: 2,
      expectedVersion: 4
    })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'RULE_VERSION_CONFLICT')
  })

  it('扣分规则加习惯 ⇒ 409 RULE_IS_PENALTY', async () => {
    port.habitError = new ConflictException({
      code: 'RULE_IS_PENALTY',
      message: '扣分规则不能变成习惯'
    })
    const res = await request(url, 'POST', `/point-rules/${RULE_ID}/habits`, GUARDIAN)
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'RULE_IS_PENALTY')
  })
})

// ══ 组 F：幂等 —— 双击"保存"不会产生两个版本 ═══════════════════════════════════
describe('组 F：Idempotency-Key', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake
  let idempotency: ReturnType<typeof makeIdempotencyFake>

  before(async () => {
    port = makePort()
    idempotency = makeIdempotencyFake()
    ;({ app, url } = await startApp({ port, idempotency }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.creates.length = 0
    port.createError = null
    idempotency.begins.length = 0
  })

  it('同一个 key 重放 ⇒ 只建一次，第二次原样返回首次响应', async () => {
    const headers = { ...GUARDIAN, 'idempotency-key': 'rule-create-1' }
    const first = await request(url, 'POST', '/point-rules', headers, VALID_CREATE)
    const second = await request(url, 'POST', '/point-rules', headers, VALID_CREATE)

    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.deepEqual(second.body, first.body)
    assert.equal(port.creates.length, 1, '重放却再次执行了业务')
    assert.equal(idempotency.begins.length, 2)
    assert.equal(idempotency.begins[0].actionType, 'add_rule')
  })

  it('同一个 key 换个请求体 ⇒ 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const headers = { ...GUARDIAN, 'idempotency-key': 'rule-create-2' }
    await request(url, 'POST', '/point-rules', headers, VALID_CREATE)
    const res = await request(url, 'POST', '/point-rules', headers, {
      ...VALID_CREATE,
      points: 5
    })

    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(port.creates.length, 1)
  })

  it('不带 key 连点两次 ⇒ 两次（显式产品语义，不是“自动去重”）', async () => {
    const first = await request(url, 'POST', '/point-rules', GUARDIAN, VALID_CREATE)
    const second = await request(url, 'POST', '/point-rules', GUARDIAN, VALID_CREATE)
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.equal(port.creates.length, 2)
  })

  it('业务 409 时同一 key 可重试（失败不缓存）', async () => {
    port.createError = new ConflictException({
      code: 'RULE_VERSION_CONFLICT',
      message: '临时冲突'
    })
    const headers = { ...GUARDIAN, 'idempotency-key': 'rule-create-3' }
    const failed = await request(url, 'POST', '/point-rules', headers, VALID_CREATE)
    assert.equal(failed.status, 409)

    port.createError = null
    const retried = await request(url, 'POST', '/point-rules', headers, VALID_CREATE)
    assert.equal(retried.status, 201)
    assert.equal(port.creates.length, 2)
  })
})


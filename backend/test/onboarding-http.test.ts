/**
 * onboarding-http.test.ts —— 首启引导的 **HTTP 集成测试**（W8-A，2026-10-27）
 *
 * 真起 Nest、真发请求；持久化端口是内存替身（`test/support/onboarding-fake.ts`）。
 * 要证明的是**路由上的事实**：
 *   ① 四道屏障的顺序与归属：缺身份 401 / 非成员 403 / `child` 与 `viewer` 403；
 *   ② **读豁免、写受管**：未同意时 `GET /onboarding` 仍 200（否则第①步的同意按钮
 *      渲染不出来），而 `PATCH profile` / `POST complete` 403 `CONSENT_REQUIRED`；
 *   ③ 集合封闭：请求体带 `childId` / 未知键 400；非法学段 / 关注点 400；
 *   ④ 产品规则：至少 1 条模板（`ONBOARDING_NO_TEMPLATE`）、PIN 4–6 位
 *      （`ONBOARDING_PIN_INVALID`）、重复完成 409、模板下架 404；
 *   ⑤ 模板排序真的接进了 HTTP 回包（学段 → 关注点 → 权重 → slug）；
 *   ⑥ 无库装配三个路由全部 501 —— 绝不返回「已完成」的假状态。
 *
 * ★ 这里**不**证明「规则 / 版本行 / PIN 真的落了库」—— 那需要真 Postgres，
 *   属于 `test-db/onboarding-db.dbtest.ts`。替身只能证明「控制器把正确的输入
 *   交给了端口」，而端口的实现是否照做是另一件事。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  CONSENT_REPOSITORY,
  type ConsentPort,
  type ConsentStatusValue
} from '../src/consent/consent.repository'
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
import { OnboardingModule } from '../src/onboarding/onboarding.module'
import {
  ONBOARDING_REPOSITORY,
  type OnboardingPort
} from '../src/onboarding/onboarding.repository'
import {
  FAKE_CHILD_ID,
  makeOnboardingFake,
  type OnboardingFake
} from './support/onboarding-fake'

const CHILD_ID = FAKE_CHILD_ID
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
    { deviceId: DEV_KID, childId: CHILD_ID, userId: 'u-kid', activeRole: 'child', expiresAt }
    // viewer 故意**没有**会话行：屏障一就 403，测不到矩阵 —— 这正是「非成员」的形态。
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

/** 固定状态的同意替身（写入方法抛错：本文件不测同意状态机）。 */
function makeConsentFake(status: ConsentStatusValue): ConsentPort {
  return {
    async readState(childId) {
      return {
        childId,
        status,
        consentVersion: '2026-10-draft',
        grantedAt: status === 'granted' ? '2026-10-26T00:00:00.000Z' : null,
        withdrawnAt: status === 'withdrawn' ? '2026-10-27T00:00:00.000Z' : null
      }
    },
    async recordGrant() {
      throw new Error('用例不应写入同意：见 consent-http.test.ts')
    },
    async recordWithdrawal() {
      throw new Error('用例不应写入同意：见 consent-http.test.ts')
    }
  }
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function request(
  baseUrl: string,
  method: 'GET' | 'PATCH' | 'POST',
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
  options: { port?: OnboardingPort; consent?: ConsentStatusValue } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [OnboardingModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())
    .overrideProvider(CONSENT_REPOSITORY)
    .useValue(makeConsentFake(options.consent ?? 'granted'))

  if (options.port !== undefined) {
    builder.overrideProvider(ONBOARDING_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }

// ══ 组 A：无库装配 —— 三条路由全部 501，绝不假装「已完成」═══════════════════════
describe('组 A：默认装配（引导端口未注入）⇒ 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('GET /onboarding ⇒ 501 ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED', async () => {
    const res = await request(url, 'GET', '/onboarding', GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('PATCH /onboarding/profile ⇒ 501（不是 200 + 空状态）', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', GUARDIAN, {
      ageBand: 'primary_low'
    })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('POST /onboarding/complete ⇒ 501（绝不能「完成」却没有一条规则）', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: ['fake-alpha']
    })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：四道屏障 —— 身份 / 成员 / 矩阵（顺序不能反）════════════════════════════
describe('组 B：身份与权限（读 view_onboarding / 写 apply_onboarding）', () => {
  let app!: INestApplication
  let url = ''
  let port: OnboardingFake

  before(async () => {
    port = makeOnboardingFake()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
  })

  it('缺设备头 ⇒ 401，端口零调用（身份解析没跑）', async () => {
    const res = await request(url, 'GET', '/onboarding', {})
    assert.equal(res.status, 401)
    assert.equal(port.calls.length, 0)
  })

  it('viewer（无会话）⇒ 403', async () => {
    const res = await request(url, 'GET', '/onboarding', VIEWER)
    assert.equal(res.status, 403)
    assert.equal(port.calls.length, 0)
  })

  it('孩子读引导 ⇒ 403（矩阵：view_onboarding child DENY —— 引导采集的是昵称与学段）', async () => {
    const res = await request(url, 'GET', '/onboarding', CHILD)
    assert.equal(res.status, 403)
    assert.equal(port.calls.length, 0)
  })

  it('孩子写草稿 ⇒ 403', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', CHILD, {
      ageBand: 'primary_low'
    })
    assert.equal(res.status, 403)
    assert.equal(port.calls.length, 0)
  })

  it('孩子完成引导 ⇒ 403', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', CHILD, {
      templateSlugs: ['fake-alpha']
    })
    assert.equal(res.status, 403)
    assert.equal(port.calls.length, 0)
  })
})

}


// ══ 组 C：第四道屏障 —— **读豁免、写受管** ═══════════════════════════════════════
describe('组 C：同意闸门（view_onboarding 豁免 / apply_onboarding 受管）', () => {
  let app!: INestApplication
  let url = ''
  let port: OnboardingFake

  before(async () => {
    port = makeOnboardingFake()
    ;({ app, url } = await startApp({ port, consent: 'none' }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
  })

  it('从未同意（none）时 GET /onboarding 仍 200 —— 否则第①步的同意按钮渲染不出来', async () => {
    const res = await request(url, 'GET', '/onboarding', GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.onboarded, false)
    assert.equal((res.body.templates as unknown[]).length, 4)
  })

  it('未同意时写草稿 ⇒ 403 CONSENT_REQUIRED，端口零调用', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', GUARDIAN, {
      ageBand: 'primary_low'
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'CONSENT_REQUIRED')
    assert.equal(
      (res.body.details as Record<string, unknown>).action,
      'apply_onboarding',
      '闸门要报出被拦的动作，客户端才知道去补同意'
    )
    assert.equal(port.calls.length, 0)
  })

  it('未同意时完成引导 ⇒ 403 CONSENT_REQUIRED，**不会**建出任何规则', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: ['fake-alpha']
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'CONSENT_REQUIRED')
    assert.equal((res.body.details as Record<string, unknown>).status, 'none')
    assert.equal(port.calls.length, 0, 'Guard 在 handler 之前，端口一次都不该被调用')
    assert.equal(port.state.onboarded, false)
  })
})

describe('组 C2：已撤回（withdrawn）—— 读仍可、写仍停', () => {
  let app!: INestApplication
  let url = ''
  let port: OnboardingFake

  before(async () => {
    port = makeOnboardingFake()
    ;({ app, url } = await startApp({ port, consent: 'withdrawn' }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
  })

  it('GET 仍 200（引导页要能打开，才能看到「重新同意」）', async () => {
    const res = await request(url, 'GET', '/onboarding', GUARDIAN)
    assert.equal(res.status, 200)
  })

  it('POST complete ⇒ 403，details.status = withdrawn（客户端据此换文案）', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: ['fake-alpha']
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'CONSENT_REQUIRED')
    assert.equal((res.body.details as Record<string, unknown>).status, 'withdrawn')
    assert.equal(port.calls.length, 0)
  })
})


// ══ 组 D：读取与排序 —— 学段 → 关注点命中数 → sortWeight → slug ══════════════════
describe('组 D：GET 的模板顺序（排序真的接进了回包）', () => {
  it('未选学段 / 关注点 ⇒ 纯 sortWeight 降序（100 / 95 / 90 / 80）', async () => {
    const started = await startApp({ port: makeOnboardingFake() })
    try {
      const res = await request(started.url, 'GET', '/onboarding', GUARDIAN)
      assert.equal(res.status, 200)
      const slugs = (res.body.templates as Array<{ slug: string }>).map((item) => item.slug)
      assert.deepEqual(slugs, ['fake-alpha', 'fake-delta', 'fake-beta', 'fake-gamma'])
    } finally {
      await started.app.close()
    }
  })

  it('选了 primary_low + 阅读 ⇒ 学段命中优先，其次命中数，再 sortWeight', async () => {
    const port = makeOnboardingFake({ ageBand: 'primary_low', focusAreas: ['阅读'] })
    const started = await startApp({ port })
    try {
      const res = await request(started.url, 'GET', '/onboarding', GUARDIAN)
      const slugs = (res.body.templates as Array<{ slug: string }>).map((item) => item.slug)
      // delta / beta 同为 primary_low 且都命中「阅读」1 次 ⇒ 比 sortWeight：95 > 90；
      // alpha（100，未命中、非本学段）与 gamma（80）排在后面。
      assert.deepEqual(slugs, ['fake-delta', 'fake-beta', 'fake-alpha', 'fake-gamma'])
    } finally {
      await started.app.close()
    }
  })

  it('回包里带着已落库的草稿（中途退出再进入要能接着走）', async () => {
    const port = makeOnboardingFake({ ageBand: 'primary_high', focusAreas: ['运动'] })
    const started = await startApp({ port })
    try {
      const res = await request(started.url, 'GET', '/onboarding', GUARDIAN)
      assert.equal(res.body.ageBand, 'primary_high')
      assert.deepEqual(res.body.focusAreas, ['运动'])
      assert.equal(res.body.childId, CHILD_ID)
      assert.equal(res.body.onboarded, false)
      assert.equal(res.body.onboardedAt, null)
    } finally {
      await started.app.close()
    }
  })

  it('已完成的孩子 ⇒ onboarded: true 且 onboardedAt 非空', async () => {
    const port = makeOnboardingFake({ onboarded: true })
    const started = await startApp({ port })
    try {
      const res = await request(started.url, 'GET', '/onboarding', GUARDIAN)
      assert.equal(res.body.onboarded, true)
      assert.equal(res.body.onboardedAt, '2026-10-27T00:00:00.000Z')
    } finally {
      await started.app.close()
    }
  })
})

// ══ 组 E：PATCH /onboarding/profile —— 合并语义与集合封闭 ═════════════════════════
describe('组 E：草稿保存（undefined 沿用 / null 清空 / [] 一个都不选）', () => {
  let app!: INestApplication
  let url = ''
  let port: OnboardingFake

  before(async () => {
    port = makeOnboardingFake({ ageBand: 'preschool', focusAreas: ['阅读'] })
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
    port.state.ageBand = 'preschool'
    port.state.focusAreas = ['阅读']
    port.state.onboarded = false
  })

  it('只传 focusAreas ⇒ 学段沿用库里已存的（不被清成 null）', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', GUARDIAN, {
      focusAreas: ['运动', '家务']
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ageBand, 'preschool')
    assert.deepEqual(res.body.focusAreas, ['运动', '家务'])
    const saved = port.calls.find((call) => call.method === 'saveProfile')
    assert.deepEqual(saved?.input, {
      childId: CHILD_ID,
      ageBand: 'preschool',
      focusAreas: ['运动', '家务'],
      operator: { userId: 'u-dad', role: 'guardian' }
    })
  })

  it('ageBand: null ⇒ 显式清空（可跳过 = 可退回未选择）', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', GUARDIAN, {
      ageBand: null
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ageBand, null)
    assert.deepEqual(res.body.focusAreas, ['阅读'], '没传关注点 ⇒ 沿用')
  })

  it('focusAreas: [] ⇒ 一个都不选（与「没传」不同）', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', GUARDIAN, {
      focusAreas: []
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.focusAreas, [])
  })

  it('请求体带 childId ⇒ 400（孩子只来自会话）', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', GUARDIAN, {
      childId: 'child-2',
      ageBand: 'primary_low'
    })
    assert.equal(res.status, 400)
    assert.equal(port.calls.length, 0)
  })

  it('非法学段 ⇒ 400', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', GUARDIAN, { ageBand: 'phd' })
    assert.equal(res.status, 400)
    assert.equal(port.calls.length, 0)
  })

  it('非法关注点 ⇒ 400（集合封闭，不静默丢弃）', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', GUARDIAN, {
      focusAreas: ['打游戏']
    })
    assert.equal(res.status, 400)

// ══ 组 F：POST /onboarding/complete —— 产品规则与成功路径 ═════════════════════════
describe('组 F：完成引导（至少 1 条 / PIN / 幂等 / 明文不出服务端）', () => {
  let app!: INestApplication
  let url = ''
  let port: OnboardingFake

  before(async () => {
    port = makeOnboardingFake()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
    port.state.onboarded = false
    port.state.ageBand = null
    port.state.focusAreas = []
  })

  it('缺 templateSlugs ⇒ 400（必填，不是「默认全选」）', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {})
    assert.equal(res.status, 400)
    assert.equal(port.calls.length, 0)
  })

  it('templateSlugs: [] ⇒ 400 ONBOARDING_NO_TEMPLATE（产品文案，不是英文校验串）', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, { templateSlugs: [] })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'ONBOARDING_NO_TEMPLATE')
    assert.equal(port.calls.length, 0, 'service 判定在端口之前')
  })

  it('全是空白 slug ⇒ 400 ONBOARDING_NO_TEMPLATE（去重/trim 后为 0）', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: ['   ', '']
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'ONBOARDING_NO_TEMPLATE')
  })

  it('超过 18 条 ⇒ 400（DTO 上限，防「一次采纳 500 条」）', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: Array.from({ length: 19 }, (_, index) => `slug-${index}`)
    })
    assert.equal(res.status, 400)
    assert.equal(port.calls.length, 0)
  })

  it('PIN 只给 3 位 ⇒ 400（4–6 位）', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: ['fake-alpha'],
      parentPin: '123'
    })
    assert.equal(res.status, 400)
    assert.equal(port.calls.length, 0)
  })

  it('PIN 给 7 位 ⇒ 400', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: ['fake-alpha'],
      parentPin: '1234567'
    })
    assert.equal(res.status, 400)
  })

  it('PIN 空串 ⇒ 400（「跳过」只有一种写法：省略字段）', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: ['fake-alpha'],
      parentPin: ''
    })
    assert.equal(res.status, 400)
  })

  it('请求体带 childId ⇒ 400', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      childId: 'child-2',
      templateSlugs: ['fake-alpha']
    })
    assert.equal(res.status, 400)
    assert.equal(port.calls.length, 0)
  })

  it('成功：条数去重保序、规则按提交顺序、PIN 以哈希交给端口、明文不出服务端', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      ageBand: 'primary_low',
      focusAreas: ['阅读'],
      templateSlugs: ['fake-gamma', 'fake-alpha', 'fake-gamma'],
      parentPin: '1234'
    })
    assert.equal(res.status, 200, '200 而不是 201：没有新建「一份引导」')
    assert.equal(res.body.childId, CHILD_ID)
    assert.equal(res.body.onboardedAt, '2026-10-27T12:00:00.000Z')

    const rules = res.body.rules as Array<{ title: string; currentVersion: number }>
    assert.deepEqual(
      rules.map((rule) => rule.title),
      ['约定 fake-gamma', '约定 fake-alpha'],
      '重复 slug 去重，且顺序 = 家长点击顺序'
    )
    assert.equal(rules.every((rule) => rule.currentVersion === 1), true)

    const snapshot = port.calls.find((call) => call.method === 'complete')
      ?.input as Record<string, unknown>
    assert.deepEqual(snapshot.templateSlugs, ['fake-gamma', 'fake-alpha'])
    assert.equal(snapshot.ageBand, 'primary_low')
    assert.deepEqual(snapshot.focusAreas, ['阅读'])
    assert.equal(snapshot.childId, CHILD_ID)
    assert.deepEqual(snapshot.operator, { userId: 'u-dad', role: 'guardian' })
    assert.equal(
      String(snapshot.parentPinHash).startsWith('scrypt$'),
      true,
      '端口签名里只有哈希，明文到不了持久化层'
    )
    assert.equal(JSON.stringify(res.body).includes('1234'), false, '回包不得回显 PIN')
    assert.equal(String(snapshot.parentPinHash).includes('1234'), false)
  })

  it('省略 PIN ⇒ 端口收到 parentPinHash: null（第⑥步可跳过）', async () => {
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: ['fake-alpha']
    })
    assert.equal(res.status, 200)
    const snapshot = port.calls.find((call) => call.method === 'complete')
      ?.input as Record<string, unknown>
    assert.equal(snapshot.parentPinHash, null)
  })

  it('重复完成 ⇒ 409 ONBOARDING_ALREADY_COMPLETED（不幂等，绝不悄悄再建一套规则）', async () => {
    port.state.onboarded = true
    const res = await request(url, 'POST', '/onboarding/complete', GUARDIAN, {
      templateSlugs: ['fake-alpha']
    })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'ONBOARDING_ALREADY_COMPLETED')
  })
})

// ══ 组 G：模板在提交瞬间被下架 ⇒ 404（防 TOCTOU 产生孤儿规则）═════════════════════
describe('组 G：模板不可用', () => {
  it('提交的 slug 有已下架的 ⇒ 404 ONBOARDING_TEMPLATE_NOT_AVAILABLE', async () => {
    const port = makeOnboardingFake({ unavailableSlugs: ['fake-beta'] })
    const started = await startApp({ port })
    try {
      const res = await request(started.url, 'POST', '/onboarding/complete', GUARDIAN, {
        templateSlugs: ['fake-alpha', 'fake-beta']
      })
      assert.equal(res.status, 404)
      assert.equal(res.body.code, 'ONBOARDING_TEMPLATE_NOT_AVAILABLE')
      assert.equal(port.state.onboarded, false, '一条都不能建成 —— 全有或全无')
    } finally {
      await started.app.close()
    }
  })
})

    assert.equal(port.calls.length, 0)
  })

  it('focusAreas: null ⇒ 400（「一个都不选」是 []，null 没有语义）', async () => {
    const res = await request(url, 'PATCH', '/onboarding/profile', GUARDIAN, { focusAreas: null })
    assert.equal(res.status, 400)
    assert.equal(port.calls.length, 0)
  })
})

/**
 * consent-http.test.ts —— 同意链路（W7-A，2026-10-26）的**集成判据**
 *
 * 覆盖三件事，缺一不可：
 *   ① 三个端点本身的契约：`GET /consent` / `POST /consent` / `POST /consent/withdraw`；
 *   ② **撤回后写入真的停了**：在一条真实的写端点上（`PATCH /child`）看到
 *      403 `CONSENT_REQUIRED`，且**业务端口一次都没被调用**；
 *   ③ **重新同意后恢复**：撤回 → 授予 → 同一条写又通了。
 *      没有这一条，「可撤回」就是「可永久锁死」—— 合规上不成立（见 `consent-policy.ts` ④）。
 *
 * ── 为什么用真 HTTP + 真守卫链 ──────────────────────────────────────────────
 *   同意闸门挂在 `@UseGuards(身份, 成员, 矩阵, 同意)` 的**第四位**。若这里直接调
 *   `ConsentService.grant()`，就只能证明"函数能跑"，证明不了「守卫链把它挂上了」——
 *   而后者才是"撤回后写入停止"的兑现方式（`04` §5 / `02` §9.20）。
 *   本文件因此起真服务、发真请求，与 `child-http.test.ts` 同一手法。
 *
 * ── 世界钉死 ───────────────────────────────────────────────────────────────
 *   全部显式 `hasDatabase: false`：本文件是**离线**用例。
 *   「无库 ⇒ 501」在这里是**被测对象**（组 A / 组 F），不是需要绕开的障碍。
 *
 * ── 幂等由**适配器**保证，不在这份文件的断言范围内 ─────────────────────────
 *   「同版本重复授予不写审计」「重复撤回不写审计」需要行锁 + 版本比较，
 *   只能在真库里验（`PrismaConsentRepository`）。这里的替身**照抄**同一套外部语义
 *   （幂等 200、从未授予 409），但它证明的是 controller/service 的契约，不是库里的并发正确性。
 *   ★ 不要把替身的幂等当成"幂等已实现"的证据。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { ConflictException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  CHILDREN_REPOSITORY,
  type ChildProfileRow,
  type ChildrenPort,
  type RenameChildInput
} from '../src/children/children.repository'
import { ChildrenModule } from '../src/children/children.module'
import { ConsentHttpModule } from '../src/consent/consent-http.module'
import { consentTextVersion } from '../src/consent/consent.service'
import {
  CONSENT_REPOSITORY,
  type ConsentPort,
  type ConsentState,
  type ConsentStatusValue,
  type RecordConsentInput,
  type WithdrawConsentInput
} from '../src/consent/consent.repository'
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

/** 状态的唯一构造函数 —— 三种状态在用例里都好读。 */
function stateOf(status: ConsentStatusValue): ConsentState {
  return status === 'granted'
    ? {
        childId: CHILD_ID,
        status,
        consentVersion: '2026-10-draft',
        grantedAt: '2026-10-26T00:00:00.000Z',
        withdrawnAt: null
      }
    : status === 'withdrawn'
      ? {
          childId: CHILD_ID,
          status,
          consentVersion: '2026-10-draft',
          grantedAt: '2026-10-26T00:00:00.000Z',
          withdrawnAt: '2026-10-26T01:00:00.000Z'
        }
      : { childId: CHILD_ID, status, consentVersion: null, grantedAt: null, withdrawnAt: null }
}

type ConsentFake = ConsentPort & {
  state: ConsentState
  grants: RecordConsentInput[]
  withdrawals: WithdrawConsentInput[]
  /** 用例直接改状态：模拟"另一个家长在别的设备上撤回了同意"。 */
  setStatus(status: ConsentStatusValue): void
}

/**
 * 同意端口替身：外部语义与 `PrismaConsentRepository` 对齐 ——
 *   · 从未授予时撤回 ⇒ 409 `CONSENT_NOT_GRANTED`（不凭空造一段"曾经同意过"的历史）；
 *   · 已撤回再撤 ⇒ 幂等 200，不多写一条。
 */
function makeConsentFake(initial: ConsentStatusValue = 'none'): ConsentFake {
  const fake: ConsentFake = {
    state: stateOf(initial),
    grants: [],
    withdrawals: [],
    setStatus(status) {
      fake.state = stateOf(status)
    },
    async readState(childId) {
      return { ...fake.state, childId }
    },
    async recordGrant(input) {
      fake.grants.push(input)
      fake.state = {
        childId: input.childId,
        status: 'granted',
        consentVersion: input.consentVersion,
        grantedAt: '2026-10-26T02:00:00.000Z',
        withdrawnAt: null
      }
      return fake.state
    },
    async recordWithdrawal(input) {
      if (fake.state.status === 'none') {
        throw new ConflictException({
          code: 'CONSENT_NOT_GRANTED',
          message: '这个档案没有可撤回的同意记录。'
        })
      }
      if (fake.state.status === 'granted') {
        fake.withdrawals.push(input)
        fake.state = { ...fake.state, status: 'withdrawn', withdrawnAt: '2026-10-26T03:00:00.000Z' }
      }
      return fake.state
    }
  }
  return fake
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function send(
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

/**
 * 同意端点的图。
 * ★ 不传 `consent` ⇒ 走**无库装配**（501）—— 组 A 靠这个，而不是靠"本机没有 .env"。
 */
async function startConsentApp(
  options: { consent?: ConsentPort } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [ConsentHttpModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (options.consent !== undefined) {
    builder.overrideProvider(CONSENT_REPOSITORY).useValue(options.consent)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

type ChildrenFake = ChildrenPort & { renames: RenameChildInput[] }

function makeChildrenFake(): ChildrenFake {
  const fake: ChildrenFake = {
    renames: [],
    async renameChild(input): Promise<ChildProfileRow> {
      fake.renames.push(input)
      return { childId: input.childId, name: input.name }
    }
  }
  return fake
}

/**
 * 真实写端点的图（`PATCH /child`，矩阵动作 `edit_child_profile` = 写侧）。
 * 选它是因为它的业务端口只有一个方法 —— 这样「端口有没有被调用」这件事
 * 就是「写入有没有发生」的准确替身，不会被别的副作用搅浑。
 *
 * ★ `withConsentHttp`：把 `ConsentHttpModule`（三个同意端点）装进**同一张图**。
 *   组 E 要演「在一处撤回、在另一处写」，同一张图才贴近生产（一个进程、一份端口）；
 *   起两个服务只会让用例更难读，也更容易碰到端口相关的偶发失败。
 */
async function startChildrenApp(
  options: { consent?: ConsentPort; children?: ChildrenPort; withConsentHttp?: boolean } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [
      ChildrenModule.register({ hasDatabase: false }),
      ...(options.withConsentHttp === true
        ? [ConsentHttpModule.register({ hasDatabase: false })]
        : [])
    ]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())

  if (options.consent !== undefined) {
    builder.overrideProvider(CONSENT_REPOSITORY).useValue(options.consent)
  }
  if (options.children !== undefined) {
    builder.overrideProvider(CHILDREN_REPOSITORY).useValue(options.children)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 三个端点全 501，绝不返回 `status: 'none'` ═══════════════
describe('组 A：无库装配（同意端口未注入）⇒ 501，不假装"没有同意"', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startConsentApp())
  })
  after(async () => {
    await app.close()
  })

  it('GET /consent ⇒ 501 `CONSENT_PERSISTENCE_NOT_IMPLEMENTED`', async () => {
    const res = await send(url, '/consent', { headers: GUARDIAN })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'CONSENT_PERSISTENCE_NOT_IMPLEMENTED')
    // 关键：不能是 200 + status:'none'。那会把"没查"读成"查了，没同意"。
    assert.equal(res.body.status, undefined, '501 回包里不该出现 status 字段')
  })

  it('POST /consent ⇒ 501（不假装同意已记录）', async () => {
    const res = await send(url, '/consent', {
      method: 'POST',
      headers: GUARDIAN,
      body: { accepted: true }
    })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'CONSENT_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('POST /consent/withdraw ⇒ 501（不假装撤回成功）', async () => {
    const res = await send(url, '/consent/withdraw', { method: 'POST', headers: GUARDIAN })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'CONSENT_PERSISTENCE_NOT_IMPLEMENTED')
  })
})

// ══ 组 B：身份 → 成员 → 矩阵（同意端点不挂第四道闸门，但它自己的三道要看住）═══
describe('组 B：只有家长能看 / 给 / 撤 —— 孩子 403，viewer 403', () => {
  let app!: INestApplication
  let url = ''
  let consent: ConsentFake

  before(async () => {
    consent = makeConsentFake('none')
    ;({ app, url } = await startConsentApp({ consent }))
  })
  after(async () => {
    await app.close()
  })

  it('家长 GET ⇒ 200，三种字段齐全（none 时版本 / 时间都是 null）', async () => {
    const res = await send(url, '/consent', { headers: GUARDIAN })
    assert.equal(res.status, 200)
    assert.deepEqual(Object.keys(res.body).sort(), [
      'childId',
      'consentVersion',
      'grantedAt',
      'status',
      'withdrawnAt'
    ])
    assert.equal(res.body.status, 'none')
    assert.equal(res.body.consentVersion, null)
    assert.equal(res.body.grantedAt, null)
    assert.equal(res.body.withdrawnAt, null)
    assert.equal(res.body.childId, CHILD_ID, '孩子来自会话，不是请求体')
  })

  it('★ 已撤回的档案**仍然读得到状态**（撤回的是处理，不是看一眼的权利）', async () => {
    consent.setStatus('withdrawn')
    const res = await send(url, '/consent', { headers: GUARDIAN })
    assert.equal(res.status, 200, '撤回后连状态都读不到 ⇒ 客户端无法引导家长重新同意')
    assert.equal(res.body.status, 'withdrawn')
    assert.equal(res.body.withdrawnAt, '2026-10-26T01:00:00.000Z')
  })

  it('孩子 GET ⇒ 403（矩阵 view_consent child DENY）', async () => {
    const res = await send(url, '/consent', { headers: CHILD })
    assert.equal(res.status, 403)
  })

  it('孩子 POST /consent ⇒ 403，且端口一次都没被调用（不留半条记录）', async () => {
    consent.grants.length = 0
    const res = await send(url, '/consent', {
      method: 'POST',
      headers: CHILD,
      body: { accepted: true }
    })
    assert.equal(res.status, 403)
    assert.deepEqual(consent.grants, [], '孩子不能给同意 —— 这是监护人的意思表示')
  })

  it('孩子 POST /consent/withdraw ⇒ 403，且没有撤回记录', async () => {
    consent.withdrawals.length = 0
    const res = await send(url, '/consent/withdraw', { method: 'POST', headers: CHILD })
    assert.equal(res.status, 403)
    assert.deepEqual(consent.withdrawals, [], '孩子不能撤回监护人的同意')
  })

  it('viewer ⇒ 403（不是成员，屏障一就拦下）', async () => {
    const res = await send(url, '/consent', { headers: VIEWER })
    assert.equal(res.status, 403)
  })

  it('缺设备头 ⇒ 401（身份是链条第一道）', async () => {
    const res = await send(url, '/consent', { headers: { 'x-kp-child-id': CHILD_ID } })
    assert.equal(res.status, 401)
  })
})

// ══ 组 C：授予 —— 必须是显式的 true；版本由服务端决定 ═════════════════════════
describe('组 C：POST /consent —— 缺省 / false / 非布尔都 400 且不写库', () => {
  let app!: INestApplication
  let url = ''
  let consent: ConsentFake

  before(async () => {
    consent = makeConsentFake('none')
    ;({ app, url } = await startConsentApp({ consent }))
  })
  after(async () => {
    await app.close()
  })

  it('空 body ⇒ 400（"打开了页面"不是同意）', async () => {
    const res = await send(url, '/consent', { method: 'POST', headers: GUARDIAN, body: {} })
    assert.equal(res.status, 400)
    assert.deepEqual(consent.grants, [], '缺字段竟然写了库 —— 那是"默认同意"')
  })

  it('accepted:false ⇒ 400 `CONSENT_NOT_ACCEPTED`，不写库', async () => {
    const res = await send(url, '/consent', {
      method: 'POST',
      headers: GUARDIAN,
      body: { accepted: false }
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'CONSENT_NOT_ACCEPTED')
    assert.deepEqual(consent.grants, [])
  })

  it('accepted 是字符串 ⇒ 400（管道按类型拒绝，不做隐式转换）', async () => {
    const res = await send(url, '/consent', {
      method: 'POST',
      headers: GUARDIAN,
      body: { accepted: 'true' }
    })
    assert.equal(res.status, 400)
    assert.deepEqual(consent.grants, [])
  })

  it('★ 客户端不能自报版本：多带 consentVersion ⇒ 400（集合封闭）', async () => {
    const res = await send(url, '/consent', {
      method: 'POST',
      headers: GUARDIAN,
      body: { accepted: true, consentVersion: 'v9-更宽松' }
    })
    assert.equal(res.status, 400, '允许自报版本 = 让被约束方填写合规事实')
    assert.deepEqual(consent.grants, [])
  })

  it('accepted:true ⇒ 200 recorded；版本来自服务端，operator 来自会话', async () => {
    const res = await send(url, '/consent', {
      method: 'POST',
      headers: { ...GUARDIAN, 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
      body: { accepted: true }
    })
    assert.equal(res.status, 200, '同意是记录一条事实，不是创建可寻址资源 ⇒ 200 而非 201')
    assert.equal(res.body.status, 'granted')
    assert.equal(res.body.consentVersion, consentTextVersion())
    assert.notEqual(res.body.grantedAt, null)
    assert.equal(res.body.withdrawnAt, null)

    assert.equal(consent.grants.length, 1)
    const input = consent.grants[0]!
    assert.equal(input.childId, CHILD_ID)
    assert.equal(input.consentVersion, consentTextVersion(), '版本必须由服务端给出')
    assert.deepEqual(input.operator, { userId: 'u-dad', role: 'guardian' })
    // 留痕原料只到哈希这一层：字段一定存在，但**绝不**是 IP 原文。
    assert.equal(typeof input.ipHash === 'string' || input.ipHash === null, true)
    assert.notEqual(input.ipHash, '203.0.113.9')
  })

  it('授予之后 GET 立刻反映 granted（同一条读路径，不是两套判断）', async () => {
    const res = await send(url, '/consent', { headers: GUARDIAN })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'granted')
  })
})

// ══ 组 D：撤回 —— 从未授予 409；重复撤回幂等；撤回后仍可重新授予 ═════════════
describe('组 D：POST /consent/withdraw', () => {
  let app!: INestApplication
  let url = ''
  let consent: ConsentFake

  before(async () => {
    consent = makeConsentFake('none')
    ;({ app, url } = await startConsentApp({ consent }))
  })
  after(async () => {
    await app.close()
  })

  it('★ 从未授予就撤回 ⇒ 409 `CONSENT_NOT_GRANTED`（不凭空造一段"曾经同意过"）', async () => {
    const res = await send(url, '/consent/withdraw', { method: 'POST', headers: GUARDIAN })
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'CONSENT_NOT_GRANTED')
  })

  it('已授予 ⇒ 200 withdrawn；operator 来自会话', async () => {
    await send(url, '/consent', { method: 'POST', headers: GUARDIAN, body: { accepted: true } })
    const res = await send(url, '/consent/withdraw', { method: 'POST', headers: GUARDIAN })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'withdrawn')
    assert.notEqual(res.body.withdrawnAt, null)
    assert.equal(consent.withdrawals.length, 1)
    assert.deepEqual(consent.withdrawals[0]!.operator, { userId: 'u-dad', role: 'guardian' })
    assert.equal(consent.withdrawals[0]!.childId, CHILD_ID)
  })

  it('重复撤回 ⇒ 仍然 200，且不再多写一条（幂等由适配器保证）', async () => {
    const res = await send(url, '/consent/withdraw', { method: 'POST', headers: GUARDIAN })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'withdrawn')
    assert.equal(consent.withdrawals.length, 1, '重复撤回又写了一条审计 —— 历史会被重复计数')
  })

  it('★ 撤回之后**还能重新授予**（否则"可撤回"变成"可永久锁死"）', async () => {
    const res = await send(url, '/consent', {
      method: 'POST',
      headers: GUARDIAN,
      body: { accepted: true }
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'granted')
    assert.equal(res.body.withdrawnAt, null)
  })
})

// ══ 组 E：★ 撤回后写入停止（真实写端点 `PATCH /child`）—— 撤回 / 恢复的闭环 ═══
describe('组 E：撤回后写入停止；重新同意后恢复（同一张图：同意端点 ＋ 真实写端点）', () => {
  let app!: INestApplication
  let url = ''
  let consent: ConsentFake
  let children: ChildrenFake

  before(async () => {
    consent = makeConsentFake('none')
    children = makeChildrenFake()
    // 同一张图 + 同一个同意端口替身：模拟"家长在一台设备上撤回，另一台设备的写入被拦"。
    ;({ app, url } = await startChildrenApp({ consent, children, withConsentHttp: true }))
  })
  after(async () => {
    await app.close()
  })

  it('从未同意 ⇒ 403 `CONSENT_REQUIRED`（details.status=none），且**端口一次都没被调用**', async () => {
    const res = await send(url, '/child', {
      method: 'PATCH',
      headers: GUARDIAN,
      body: { name: '小明' }
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'CONSENT_REQUIRED')
    assert.equal((res.body.details as Record<string, unknown>).status, 'none')
    assert.deepEqual(children.renames, [], '写入被拒绝了，端口却收到了调用 —— 拒绝发生在错误的地方')
  })

  it('重新同意 ⇒ 同一条写立刻 200（"可撤回"必须同时是"可恢复"）', async () => {
    const granted = await send(url, '/consent', {
      method: 'POST',
      headers: GUARDIAN,
      body: { accepted: true }
    })
    assert.equal(granted.status, 200)

    const res = await send(url, '/child', {
      method: 'PATCH',
      headers: GUARDIAN,
      body: { name: '小明' }
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.name, '小明')
    assert.equal(children.renames.length, 1)
    assert.equal(children.renames[0]!.childId, CHILD_ID)
  })

  it('★ 撤回后同一台设备再次写入 ⇒ 403 `CONSENT_REQUIRED`（details.status=withdrawn）', async () => {
    const withdrawn = await send(url, '/consent/withdraw', {
      method: 'POST',
      headers: GUARDIAN
    })
    assert.equal(withdrawn.status, 200)

    const res = await send(url, '/child', {
      method: 'PATCH',
      headers: GUARDIAN,
      body: { name: '小红' }
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'CONSENT_REQUIRED')
    assert.equal((res.body.details as Record<string, unknown>).status, 'withdrawn')
    assert.equal(children.renames.length, 1, '撤回之后又写了一次 —— "写入停止"没有兑现')
  })

  it('★ 守卫顺序：孩子越权时回 `FORBIDDEN` 而不是 `CONSENT_REQUIRED`（屏障二先答）', async () => {
    const res = await send(url, '/child', {
      method: 'PATCH',
      headers: CHILD,
      body: { name: '小红' }
    })
    assert.equal(res.status, 403)
    assert.equal(
      res.body.code,
      'FORBIDDEN',
      '先问"现在能不能做"再问"你准不准做" —— 顺序反了会让越权看起来像没同意'
    )
  })
})

// ══ 组 F：无库 + 写端点 ⇒ 501（不是"没有同意"，是"没查"）═══════════════════════
describe('组 F：无库装配下写端点 501，且不写库', () => {
  let app!: INestApplication
  let url = ''
  let children: ChildrenFake

  before(async () => {
    children = makeChildrenFake()
    ;({ app, url } = await startChildrenApp({ children }))
  })
  after(async () => {
    await app.close()
  })

  it('PATCH /child ⇒ 501 `CONSENT_PERSISTENCE_NOT_IMPLEMENTED`，端口未被调用', async () => {
    const res = await send(url, '/child', {
      method: 'PATCH',
      headers: GUARDIAN,
      body: { name: '小明' }
    })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'CONSENT_PERSISTENCE_NOT_IMPLEMENTED')
    assert.deepEqual(children.renames, [], '无库时竟然写成功了 —— 那是"默认同意"')
  })
})

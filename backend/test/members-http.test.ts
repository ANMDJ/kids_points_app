/**
 * members-http.test.ts —— 家庭成员三条路由的 **HTTP 集成测试**（W5-H，2026-10-22）
 *
 * 真起 Nest、真发请求；会话 / 成员位 / 成员端口都是替身（世界固定 `hasDatabase: false`）。
 * 要证明的是**路由上的事实**：
 *   ① 无库装配时三条路由全 501 —— 不返回空列表冒充「家里只有我一个人」，
 *      也不假装改成功；
 *   ② 三条路由都走三道屏障：缺身份 401、viewer 无成员位 403、
 *      孩子改角色 / 移出 403 **且端口零调用**（`change_member_role` / `remove_member`
 *      child DENY）；
 *   ③ ★ **会话角色按成员位收口**（W5-H 新增的读路径保险）：一台会话还写着
 *      `guardian`、但成员位已被降成 `child` 的设备，`PATCH /members/:id` 必须 403 ——
 *      没有收口的话矩阵会按 `guardian` 放行，降级就形同虚设；
 *   ④ `view_members` 对孩子开放 ⇒ `GET /members` 200（这是**刻意**的：孩子看得见
 *      家里有谁，但改不了）；`isSelf` 由服务端算（客户端不知道自己的 userId）；
 *   ⑤ 请求体集合封闭：`role` 只能是 child / guardian（`viewer` ⇒ 400，多传
 *      `userId` / `childId` ⇒ 400）；
 *   ⑥ 端口抛的 403 / 404 / 409 **原样透出**（路由不吞、不改写成 400）。
 *
 * ★ 这里**不**证明「最后一位家长不会被降掉」「并发下不会两个都降成功」——
 *   那需要真 Postgres：`test-db/members-db.dbtest.ts` 组 C / D。替身端口只能证明
 *   路由**问对了问题**（把 actor / deviceId / memberId 交对了人）。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import {
  ConflictException,
  ForbiddenException,
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
import {
  MEMBERS_REPOSITORY,
  type ChangeMemberRoleInput,
  type ChangeMemberRoleResult,
  type MembersPort,
  type RemoveMemberInput,
  type RemoveMemberResult
} from '../src/members/members.repository'
import type { MemberRow } from '../src/members/members.types'
import { MembersModule } from '../src/members/members.module'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import {
  MEMBERSHIP_REPOSITORY,
  type MembershipPort
} from '../src/membership/membership.repository'

// ★ W7-A：同意闸门（第四道屏障）—— 见 test/support/consent-fake.ts
import { CONSENT_REPOSITORY } from '../src/consent/consent.repository'
import { makeGrantedConsentFake } from './support/consent-fake'

const CHILD_ID = 'child-1'
const MEMBER_ID = 'member-1'

const DEV_DAD = 'dev-dad'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'
/** 会话写着 guardian、成员位已降成 child 的设备（③ 的被试）。 */
const DEV_DEMOTED = 'dev-demoted'

function identity(deviceId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': CHILD_ID }
}

const GUARDIAN = identity(DEV_DAD)
const CHILD = identity(DEV_KID)
const VIEWER = identity(DEV_GUEST)
const DEMOTED = identity(DEV_DEMOTED)

function makeSessionFake(): DeviceSessionPort {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000)
  const rows: SessionLookupRow[] = [
    { deviceId: DEV_DAD, childId: CHILD_ID, userId: 'u-dad', activeRole: 'guardian', expiresAt },
    { deviceId: DEV_KID, childId: CHILD_ID, userId: 'u-kid', activeRole: 'child', expiresAt },
    { deviceId: DEV_GUEST, childId: CHILD_ID, userId: 'u-guest', activeRole: 'viewer', expiresAt },
    { deviceId: DEV_DEMOTED, childId: CHILD_ID, userId: 'u-exdad', activeRole: 'guardian', expiresAt }
  ]
  return {
    async findSession(deviceId, childId) {
      return rows.find((row) => row.deviceId === deviceId && row.childId === childId) ?? null
    }
  }
}

/** `u-guest` 刻意没有成员位；`u-exdad` 有成员位但**已是 child**（③ 的被试）。 */
function makeMembershipFake(): MembershipPort {
  const rows: MembershipLookupRow[] = [
    { childId: CHILD_ID, userId: 'u-dad', role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: 'u-kid', role: 'child', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: 'u-exdad', role: 'child', status: 'active', restrictions: {} }
  ]
  return {
    async findMembership(childId, userId) {
      return rows.find((row) => row.childId === childId && row.userId === userId) ?? null
    }
  }
}

/** 固定时刻的端口行：ISO 断言才有确定值。 */
const JOINED_AT = new Date('2026-10-01T02:00:00.000Z')
const REMOVED_AT = new Date('2026-10-22T03:00:00.000Z')

const DAD_ROW: MemberRow = {
  memberId: MEMBER_ID,
  userId: 'u-dad',
  displayName: '爸爸',
  role: 'guardian',
  status: 'active',
  joinedAt: JOINED_AT,
  removedAt: null
}

const KID_ROW: MemberRow = {
  memberId: 'member-2',
  userId: 'u-kid',
  displayName: null,
  role: 'child',
  status: 'active',
  joinedAt: new Date('2026-10-02T02:00:00.000Z'),
  removedAt: null
}

/** 成员端口替身：记录**每次调用收到的入参**，并允许注入要抛的错。 */
class PortFake implements MembersPort {
  readonly lists: string[] = []
  readonly roleChanges: ChangeMemberRoleInput[] = []
  readonly removals: RemoveMemberInput[] = []

  listError: Error | null = null
  changeError: Error | null = null
  removeError: Error | null = null
  /** 已移出过的成员：DELETE 仍应 200（构造幂等），形状与首次一致。 */
  alreadyRemoved = false

  reset(): void {
    this.lists.length = 0
    this.roleChanges.length = 0
    this.removals.length = 0
    this.listError = null
    this.changeError = null
    this.removeError = null
    this.alreadyRemoved = false
  }

  async listActiveMembers(childId: string): Promise<MemberRow[]> {
    this.lists.push(childId)
    if (this.listError !== null) throw this.listError
    return [DAD_ROW, KID_ROW]
  }

  async changeMemberRole(input: ChangeMemberRoleInput): Promise<ChangeMemberRoleResult> {
    this.roleChanges.push(input)
    if (this.changeError !== null) throw this.changeError
    // 回显**被改的那一行**与目标角色：证明路径参数与 body 真的都交给了端口。
    const target = [DAD_ROW, KID_ROW].find((row) => row.memberId === input.memberId) ?? KID_ROW
    return { member: { ...target, role: input.role }, changed: target.role !== input.role }
  }

  async removeMember(input: RemoveMemberInput): Promise<RemoveMemberResult> {
    this.removals.push(input)
    if (this.removeError !== null) throw this.removeError
    return { memberId: input.memberId, removedAt: REMOVED_AT, alreadyRemoved: this.alreadyRemoved }
  }
}


interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  payload?: unknown
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headers,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
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
  options: { port?: PortFake } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    imports: [MembersModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())
    // ★ W7-A：第四道屏障（同意闸门）。这些用例测的是本文件自己的关口，
    //   同意状态作为背景条件恒为 granted —— 撤回/重授予的行为见 consent-http.test.ts。
    .overrideProvider(CONSENT_REPOSITORY)
    .useValue(makeGrantedConsentFake())

  if (options.port !== undefined) {
    builder.overrideProvider(MEMBERS_REPOSITORY).useValue(options.port)
  }

  const app = (await builder.compile()).createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ══ 组 A：无库装配 —— 三条路由全 501（不假装成功）════════════════════════════
describe('组 A：默认装配（成员端口未注入）⇒ 三条路由全 501', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('GET /members ⇒ 501（空列表会被误读成"这个家只有我一个人"）', async () => {
    const res = await request(url, 'GET', '/members', GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'MEMBERS_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('PATCH /members/:id ⇒ 501（不假装角色改好了）', async () => {
    const res = await request(url, 'PATCH', `/members/${MEMBER_ID}`, GUARDIAN, {
      role: 'child'
    })
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'MEMBERS_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('DELETE /members/:id ⇒ 501（不假装人已经移出）', async () => {
    const res = await request(url, 'DELETE', `/members/${MEMBER_ID}`, GUARDIAN)
    assert.equal(res.status, 501)
    assert.equal(res.body.code, 'MEMBERS_PERSISTENCE_NOT_IMPLEMENTED')
  })

// ══ 组 B：三道屏障（含 W5-H 新增的角色收口）══════════════════════════════════
describe('组 B：三道屏障 + 角色收口', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = new PortFake()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.reset()
  })

  it('缺身份头 ⇒ 401，端口零调用', async () => {
    const res = await request(url, 'GET', '/members', {})
    assert.equal(res.status, 401)
    assert.equal(port.lists.length, 0)
  })

  it('viewer 没有成员位 ⇒ 403（屏障一），端口零调用', async () => {
    const res = await request(url, 'GET', '/members', VIEWER)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'MEMBER_NOT_FOUND')
    assert.equal(port.lists.length, 0)
  })

  it('孩子改角色 ⇒ 403 FORBIDDEN，端口零调用（change_member_role child DENY）', async () => {
    const res = await request(url, 'PATCH', `/members/${MEMBER_ID}`, CHILD, {
      role: 'guardian'
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.roleChanges.length, 0)
  })

  it('孩子移出成员 ⇒ 403 FORBIDDEN，端口零调用（remove_member child DENY）', async () => {
    const res = await request(url, 'DELETE', `/members/${MEMBER_ID}`, CHILD)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.removals.length, 0)
  })

  it('★ 会话还写着 guardian、成员位已降成 child ⇒ PATCH 403（角色收口，降级立即生效）', async () => {
    // 没有 clampRoleToMembership() 时，矩阵会按会话的 guardian 放行 ——
    // 那样"降级"就只是一次写库，那个人的设备照样能改别人。
    const res = await request(url, 'PATCH', `/members/${MEMBER_ID}`, DEMOTED, {
      role: 'child'
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(port.roleChanges.length, 0)
  })

  it('★ 同一台被降级的设备：GET /members 仍然 200（view_members 两侧 ALLOW）', async () => {
    const res = await request(url, 'GET', '/members', DEMOTED)
    assert.equal(res.status, 200)
    assert.equal(port.lists.length, 1)
  })
})


// ══ 组 C：成功路径、线格式、请求体封闭、端口错误透出 ═══════════════════════════
describe('组 C：家长路径与响应形状', () => {
  let app!: INestApplication
  let url = ''
  let port: PortFake

  before(async () => {
    port = new PortFake()
    ;({ app, url } = await startApp({ port }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.reset()
  })

  it('GET /members ⇒ 200 `{items:[...]}`，孩子 id 来自会话，`isSelf` 由服务端算', async () => {
    const res = await request(url, 'GET', '/members?childId=other-child', GUARDIAN)
    assert.equal(res.status, 200)
    const items = res.body.items as Array<Record<string, unknown>>
    assert.equal(items.length, 2)

    // 顺序与"家长在前"由适配器保证；替身照原样返回，故这里只断言内容。
    const dad = items[0]
    assert.equal(dad.memberId, MEMBER_ID)
    assert.equal(dad.displayName, '爸爸')
    assert.equal(dad.role, 'guardian')
    // ★ 我自己那一行：服务端算（客户端不知道自己的 userId）
    assert.equal(dad.isSelf, true)
    // ★ 时间一律 ISO 串：Date 序列化结果相同，但契约要求显式转换。
    assert.equal(dad.joinedAt, JOINED_AT.toISOString())
    assert.equal(dad.removedAt, null)

    const kid = items[1]
    assert.equal(kid.isSelf, false)
    assert.equal(kid.displayName, null)

    // 查询串里的 childId 不起作用：端口收到的仍是会话里的孩子。
    assert.deepEqual(port.lists, [CHILD_ID])
  })

  it('PATCH /members/:id ⇒ 200 `MemberDto`，端口收到 actor / deviceId / 目标角色', async () => {
    const res = await request(url, 'PATCH', `/members/${MEMBER_ID}`, GUARDIAN, {
      role: 'guardian'
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.memberId, MEMBER_ID)
    assert.equal(res.body.role, 'guardian')

    assert.deepEqual(port.roleChanges, [
      {
        childId: CHILD_ID,
        memberId: MEMBER_ID,
        role: 'guardian',
        operatorUserId: 'u-dad',
        operatorRole: 'guardian',
        deviceId: DEV_DAD
      }
    ])
  })

  it('PATCH role=viewer ⇒ 400（矩阵对 viewer 没有列，降成 viewer 等于制造死账号）', async () => {
    const res = await request(url, 'PATCH', `/members/${MEMBER_ID}`, GUARDIAN, {
      role: 'viewer'
    })
    assert.equal(res.status, 400)
    assert.equal(port.roleChanges.length, 0)
  })

  it('PATCH 多传 userId / childId ⇒ 400（客户端不许声明自己的上下文）', async () => {
    const extraUser = await request(url, 'PATCH', `/members/${MEMBER_ID}`, GUARDIAN, {
      role: 'child',
      userId: 'u-other'
    })
    assert.equal(extraUser.status, 400)
    assert.equal(port.roleChanges.length, 0)

    const extraChild = await request(url, 'PATCH', `/members/${MEMBER_ID}`, GUARDIAN, {
      role: 'child',
      childId: 'other-child'
    })
    assert.equal(extraChild.status, 400)
    assert.equal(port.roleChanges.length, 0)
  })

  it('PATCH 缺 role ⇒ 400（不默认成 child —— 默认值在这里就是一次降级）', async () => {
    const res = await request(url, 'PATCH', `/members/${MEMBER_ID}`, GUARDIAN, {})
    assert.equal(res.status, 400)
    assert.equal(port.roleChanges.length, 0)
  })

  it('DELETE /members/:id ⇒ 200 `{memberId,status,removedAt}`，端口收到家长身份', async () => {
    const res = await request(url, 'DELETE', `/members/${MEMBER_ID}`, GUARDIAN)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      memberId: MEMBER_ID,
      status: 'removed',
      removedAt: REMOVED_AT.toISOString()
    })
    assert.deepEqual(port.removals, [
      {
        childId: CHILD_ID,
        memberId: MEMBER_ID,
        operatorUserId: 'u-dad',
        operatorRole: 'guardian',
        deviceId: DEV_DAD
      }
    ])
  })

  it('DELETE 再删一次 ⇒ 仍是 200，同一个形状（构造幂等，不是 404）', async () => {
    port.alreadyRemoved = true
    const res = await request(url, 'DELETE', `/members/${MEMBER_ID}`, GUARDIAN)
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'removed')
    assert.equal(res.body.removedAt, REMOVED_AT.toISOString())
  })

  it('端口 404 MEMBER_NOT_FOUND 原样透出（跨孩子与不存在同答）', async () => {
    port.changeError = new NotFoundException({ code: 'MEMBER_NOT_FOUND', message: 'x' })
    const res = await request(url, 'PATCH', `/members/${MEMBER_ID}`, GUARDIAN, {
      role: 'child'
    })
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'MEMBER_NOT_FOUND')
  })

  it('端口 403 CANNOT_MODIFY_SELF 原样透出（不改写成 400）', async () => {
    port.changeError = new ForbiddenException({ code: 'CANNOT_MODIFY_SELF', message: 'x' })
    const res = await request(url, 'PATCH', `/members/${MEMBER_ID}`, GUARDIAN, {
      role: 'child'
    })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'CANNOT_MODIFY_SELF')
  })

  it('端口 409 LAST_GUARDIAN_PROTECTED 原样透出', async () => {
    port.removeError = new ConflictException({
      code: 'LAST_GUARDIAN_PROTECTED',
      message: 'x'
    })
    const res = await request(url, 'DELETE', `/members/${MEMBER_ID}`, GUARDIAN)
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'LAST_GUARDIAN_PROTECTED')
    assert.equal(port.removals.length, 1, '请求确实到了端口 —— 拒绝来自业务层，不是被屏障拦下')
  })
})

})

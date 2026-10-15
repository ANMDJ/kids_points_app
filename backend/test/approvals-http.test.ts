/**
 * approvals-http.test.ts —— 审批 HTTP 路径的**集成测试**（真起 Nest 服务 + 真发 HTTP 请求）
 *
 * ── 为什么必须走 HTTP，而不是直接调 `ApprovalsService` ─────────────────────────
 *   B3 的诚实标注是：「`approval-policy.ts` **没有被任何请求调用**」。若这里改成
 *   直接 `new ApprovalsService(mock).createRequest(...)`，那句话**依然成立**
 *   （判定仍然没被 HTTP 消费，只是多了一个测试在调它）。故：起真服务、发真请求、
 *   断言真状态码 —— 测的是「路径」，不是「函数」。
 *
 * ── 为什么跑在编译产物上（见 scripts/run-tests.mjs 文件头）────────────────────
 *   本文件里的「形状封闭」那几条（未知键 / 非法动作 → 400）依赖 `ValidationPipe`，
 *   而管道依赖 `emitDecoratorMetadata`。**esbuild / tsx 不产出它** —— 用 tsx 跑时
 *   管道静默整体失效，这两条会**以 201 通过**（实测：探针返回 `201 {"id":"x1"}`）。
 *   所以 `npm test` 现在先 `tsc` 真编译再跑；否则本文件是**假绿**。
 *
 * ── 覆盖的判据来源 ──────────────────────────────────────────────────────────
 *   `02` §4.5 六条硬约束 + §9.3 / §9.10 / §9.25 / §9.26 / §9.27。
 *   仓储用**内存替身**（`ApprovalsPort` 的实现）—— 真实的 Prisma 实现属 W1/W2；
 *   默认装配（不注入替身）那一组断言的是 **501 fail-closed**，不是「成功」。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { ConflictException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  APPROVALS_REPOSITORY,
  type ApprovalRow,
  type ApprovalsPort,
  type CreateApprovalInput
} from '../src/approvals/approvals.repository'
import { ApprovalsModule } from '../src/approvals/approvals.module'
import { AUDIT_ACTION_SELF_APPROVED, SELF_APPROVAL_NOT_ALLOWED } from '../src/contracts/approval-policy'
import { PERMISSION_MATRIX } from '../src/contracts/permission-matrix'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'

/**
 * 孩子上下文（W1-B）：身份头从两个变三个。
 * 屏障一（成员资格门）问的是 `ChildMember(childId, userId)` —— 没有它，这道门问不出问题，
 * 所以临时身份 Guard 现在**强制要求** `x-kp-child-id`（缺 ⇒ 401，见其文件头）。
 */
const CHILD_ID = 'child-1'

function identity(role: string, userId: string): Record<string, string> {
  return { 'x-kp-role': role, 'x-kp-user-id': userId, 'x-kp-child-id': CHILD_ID }
}

const GUARDIAN = identity('guardian', 'u-dad')
const OTHER_GUARDIAN = identity('guardian', 'u-mom')
const CHILD = identity('child', 'u-kid')
const VIEWER = identity('viewer', 'u-guest')

/**
 * 成员替身（W1-B）：**每一组**都要注入它 —— 否则屏障一在默认装配下返回 501，
 * 组 A 那组"审批写入未落地 ⇒ 501"的断言就会变成在测**屏障一**，而不是在测审批端口。
 * ★ 刻意**没有** `u-guest`（viewer）：他不是任何孩子的成员位 —— 这正是 §9.21 的场景。
 */
function makeMembershipFake(): MembershipPort {
  const members: MembershipLookupRow[] = [
    { childId: CHILD_ID, userId: 'u-dad', role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: 'u-mom', role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: 'u-kid', role: 'child', status: 'active', restrictions: {} }
  ]
  return {
    async findMembership(childId, userId) {
      return members.find((m) => m.childId === childId && m.userId === userId) ?? null
    }
  }
}

interface PortCall {
  method: keyof ApprovalsPort
  input: unknown
}

/**
 * 内存替身：**只**实现端口承诺的语义（`createSelfApproved` = 落库即已决且批准人=申请人；
 * `decide` 带乐观锁）。它不写账本 —— 那正是「未落地」的部分，所以这里不许假装。
 */
function makeFakePort(): ApprovalsPort & { calls: PortCall[]; rows: Map<string, ApprovalRow> } {
  const calls: PortCall[] = []
  const rows = new Map<string, ApprovalRow>()
  let seq = 0

  const build = (
    input: CreateApprovalInput,
    status: string,
    decidedByUserId: string | null
  ): ApprovalRow => {
    seq += 1
    const created: ApprovalRow = {
      id: `ap-${seq}`,
      action: input.action,
      requesterUserId: input.requesterUserId,
      status,
      decidedByUserId,
      executedRecordId: status === 'approved' ? `rec-${seq}` : null
    }
    rows.set(created.id, created)
    return created
  }

  return {
    calls,
    rows,
    async createPending(input) {
      calls.push({ method: 'createPending', input })
      return build(input, 'pending', null)
    },
    async createSelfApproved(input) {
      calls.push({ method: 'createSelfApproved', input })
      // 同一事务：一落库就是 approved，且批准人 == 申请人（自批的唯一判据，不新增字段）
      return build(input, 'approved', input.requesterUserId)
    },
    async findById(id) {
      calls.push({ method: 'findById', input: id })
      return rows.get(id) ?? null
    },
    async decide(input) {
      calls.push({ method: 'decide', input })
      const existing = rows.get(input.id)
      // 乐观锁未命中（已被决过 / 不存在）⇒ 409，绝不覆盖终态（02 §4.4）
      if (existing === undefined || existing.status !== 'pending') {
        throw new ConflictException({ code: 'ALREADY_DECIDED' })
      }
      const updated: ApprovalRow = {
        ...existing,
        status: input.outcome,
        decidedByUserId: input.decidedByUserId
      }
      rows.set(updated.id, updated)
      return updated
    }
  }
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

/** 发一条真 HTTP 请求；响应体尽力按 JSON 解析（非 JSON 时回退成 `{ raw: text }`）。 */
async function send(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'POST',
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
 * 起一个只装 `ApprovalsModule` 的真服务（`useValue` 可替换仓储；不传 = 默认装配）。
 * ★ W1-B 起**恒**注入成员替身：`POST /approvals` 的守卫链是「身份 → 屏障一 → 屏障二/三」，
 *   不注入成员位就停在屏障一的 501 上（那由 `membership-http.test.ts` 组 C 专门测）。
 */
async function startApp(repository?: ApprovalsPort): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({ imports: [ApprovalsModule] })
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())
  if (repository !== undefined) {
    builder.overrideProvider(APPROVALS_REPOSITORY).useValue(repository)
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app) // ★ 与 main.ts 同一函数：测的是**真装配**，不是测试自己搭的
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ── 组 A：默认装配 —— 「写入路径未落地」必须是**可执行断言** ─────────────────────
describe('默认装配（无替身）：审批写入路径未落地 ⇒ 必须 501，不得假装成功', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('未勾选（要落一条 pending）→ 501 APPROVALS_PERSISTENCE_NOT_IMPLEMENTED', async () => {
    const r = await send(url, '/approvals', { body: { action: 'redeem' }, headers: GUARDIAN })
    assert.equal(r.status, 501, '落库没实现却返回了成功 —— 客户端会以为兑换已提交')
    assert.equal(r.body.code, 'APPROVALS_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('显式自批（判定通过，要落 approved + 流水）→ 同样 501', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem', autoApprove: true },
      headers: GUARDIAN
    })
    assert.equal(r.status, 501, '自批的**落库**同样未实现 —— 判定通过不等于已执行')
  })

  it('对照：**拒绝**路径不碰落库 ⇒ 仍是 400（证明 501 不是「一律 501」）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'request_redeem', autoApprove: true },
      headers: CHILD
    })
    assert.equal(r.status, 400, '若这里也是 501，说明 400 分支根本没生效，组 A 的 501 断言就没有对照价值')
    assert.equal(r.body.code, SELF_APPROVAL_NOT_ALLOWED)
  })

  it('decide 端点（第一步就要查库）→ 501', async () => {
    const r = await send(url, '/approvals/ap-1/decide', {
      body: { decision: 'approved' },
      headers: GUARDIAN
    })
    assert.equal(r.status, 501)
    assert.equal(r.body.code, 'APPROVALS_PERSISTENCE_NOT_IMPLEMENTED')
  })
})

// ── 组 B：判定（注入内存替身）—— `02` §4.5 六条硬约束 ＋ §9.25–§9.27 ──────────
describe('判定（§4.5 六条硬约束 / §9.25–§9.27）', () => {
  let app!: INestApplication
  let url = ''
  let port!: ReturnType<typeof makeFakePort>

  before(async () => {
    port = makeFakePort()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  // 用例之间**清干净**：否则某条用例的落库会变成下一条的输入（D-a 阶段踩过"红在别的理由上"）
  beforeEach(() => {
    port.calls.length = 0
    port.rows.clear()
  })

  it('§9.27 前半：单家长唯一家长提交 redeem、不带 autoApprove → 202 + pending（**不许自动批准**）', async () => {
    const r = await send(url, '/approvals', { body: { action: 'redeem' }, headers: GUARDIAN })
    assert.equal(r.status, 202)
    assert.equal(r.body.status, 'pending')
    assert.equal(r.body.decidedByUserId, null)
    assert.equal(
      port.calls.some((c) => c.method === 'createSelfApproved'),
      false,
      '没勾选却调用了自批落库 —— 「只有一位家长就自动批准」正是 P4 明确否掉的'
    )
  })

  it('§9.27 后半：同一家长二次确认（decide）→ 200 + approved + selfApproved=true + 审计名', async () => {
    const created = await send(url, '/approvals', { body: { action: 'redeem' }, headers: GUARDIAN })
    const id = String(created.body.id)
    const r = await send(url, `/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: GUARDIAN // 同一位家长（两次请求同一个 x-kp-user-id）
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'approved')
    assert.equal(r.body.selfApproved, true, '批准人 == 申请人却判成"不是自批"')
    assert.equal(r.body.auditAction, AUDIT_ACTION_SELF_APPROVED)
  })

  it('§9.25 一步式：家长 redeem + autoApprove:true → 201 + approved + 审计名（与"他人批准"同一路径）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem', autoApprove: true },
      headers: GUARDIAN
    })
    assert.equal(r.status, 201)
    assert.equal(r.body.status, 'approved')
    assert.equal(r.body.decidedByUserId, r.body.requesterUserId, '自批必须落成 decidedByUserId == requesterUserId')
    assert.equal(r.body.selfApproved, true)
    assert.equal(r.body.auditAction, AUDIT_ACTION_SELF_APPROVED)
    const call = port.calls.find((c) => c.method === 'createSelfApproved')
    assert.ok(call !== undefined, '显式勾选却走了 createPending —— 会变成"等别人批"的死锁')
  })

  it('§9.26 孩子 request_redeem + autoApprove:true → **400 且点名**，且**一行都没落**', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'request_redeem', autoApprove: true },
      headers: CHILD
    })
    assert.equal(r.status, 400, '静默降级成 pending 会让客户端以为已批，而库里那条没人看见')
    assert.equal(r.body.code, SELF_APPROVAL_NOT_ALLOWED)
    assert.equal(port.calls.length, 0, '被拒的请求不得产生任何落库调用（拒在落库之前）')
  })

  it('硬约束 3：`autoApprove` 为非布尔 / false / null ⇒ 一律 202 pending（不批）', async () => {
    for (const autoApprove of ['true', 1, {}, [], false, null]) {
      port.calls.length = 0
      const r = await send(url, '/approvals', { body: { action: 'redeem', autoApprove }, headers: GUARDIAN })
      assert.equal(
        r.status,
        202,
        `autoApprove=${JSON.stringify(autoApprove)} 没被当成"未勾选"（严格 === true 才算勾选）`
      )
      assert.equal(r.body.status, 'pending')
      assert.equal(
        port.calls.some((c) => c.method === 'createSelfApproved'),
        false,
        `autoApprove=${JSON.stringify(autoApprove)} 竟触发了自批落库`
      )
    }
  })

  it('硬约束 3 的反面：显式 `true` 必须**真的**自批（否则上面那条会因为"一律 pending"而恒真）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem', autoApprove: true },
      headers: GUARDIAN
    })
    assert.equal(r.status, 201)
    assert.equal(port.calls.some((c) => c.method === 'createPending'), false)
  })

  it('硬约束 2/4：不需要审批的动作（add_wish，矩阵 guardian=ALLOW）传 autoApprove → 400', async () => {
    assert.equal(PERMISSION_MATRIX.add_wish.guardian, 'ALLOW', '前提变了：add_wish 现在需要审批？')
    const r = await send(url, '/approvals', {
      body: { action: 'add_wish', autoApprove: true },
      headers: GUARDIAN
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, SELF_APPROVAL_NOT_ALLOWED)
  })

  // ★ 行为变更（W1-B，2026-10-15）：viewer 现在被**屏障一**（`MembershipGuard`）拦下 ——
  //   `viewer` 不是任何孩子的成员位（`MemberRole` 只有 guardian / child），
  //   所以 403 的码从 `FORBIDDEN` 变成 **`MEMBER_NOT_FOUND`**。
  //   这不是"覆盖丢失"，而是**顺序**的设计后果（屏障一先于屏障二，`02` §3）：
  //   · 「viewer 在矩阵里无列 ⇒ 一律 DENY」仍由 `permission-matrix.test.ts` 的纯函数穷举钉着；
  //   · 「屏障一先于屏障二」由 `membership-http.test.ts` 组 A 的**顺序**用例钉着。
  //   ★ W1-A 时同一条用例的码是 FORBIDDEN（当时还没有屏障一）—— 两次改动都有意为之，不是漂移。
  it('fail-closed：viewer 提任何请求 → 403 MEMBER_NOT_FOUND（他不是任何孩子的成员位）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem', autoApprove: true },
      headers: VIEWER
    })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'MEMBER_NOT_FOUND')
  })
})


// ── 组 C：入口闸门（形状 / 身份）与 decide 的边界 ─────────────────────────────
describe('入口闸门与 decide 边界', () => {
  let app!: INestApplication
  let url = ''
  let port!: ReturnType<typeof makeFakePort>

  before(async () => {
    port = makeFakePort()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
    port.rows.clear()
  })

  it('形状封闭：未知键 → 400（ValidationPipe 真的生效 —— 用 tsx 跑时这里会**静默返回 201**）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem', foo: 1 },
      headers: GUARDIAN
    })
    assert.equal(
      r.status,
      400,
      '多余键被吞掉了 —— 说明 esbuild/tsx 那套「管道静默失效」又回来了（见 run-tests.mjs 文件头）'
    )
  })

  it('形状封闭：非法动作（不在 25 个 ActionType 内）→ 400', async () => {
    const r = await send(url, '/approvals', { body: { action: 'nope' }, headers: GUARDIAN })
    assert.equal(r.status, 400)
  })

  it('形状封闭：缺 action → 400', async () => {
    const r = await send(url, '/approvals', { body: { autoApprove: true }, headers: GUARDIAN })
    assert.equal(r.status, 400)
  })

  it('身份：缺 `x-kp-role` / `x-kp-user-id` → 401，且**不落库**（绝不默认成 guardian）', async () => {
    const r = await send(url, '/approvals', { body: { action: 'redeem' }, headers: {} })
    assert.equal(r.status, 401)
    assert.equal(port.calls.length, 0)
  })

  it('身份：角色值不在白名单 → 401', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem' },
      headers: { 'x-kp-role': 'admin', 'x-kp-user-id': 'u-x' }
    })
    assert.equal(r.status, 401)
  })

  it('身份：同一请求里塞两个角色值（合并头）→ 401，**不挑一个**（歧义输入不产生权限）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem' },
      headers: { 'x-kp-role': 'guardian, child', 'x-kp-user-id': 'u-x' }
    })
    assert.equal(r.status, 401)
    assert.equal(port.calls.length, 0)
  })
})


// ── 组 D：生产闸门 与 decide 的边界 ─────────────────────────────────────────
describe('生产闸门与 decide 边界', () => {
  let app!: INestApplication
  let url = ''
  let port!: ReturnType<typeof makeFakePort>

  before(async () => {
    port = makeFakePort()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
    port.rows.clear()
  })

  it('身份：`NODE_ENV=production` → 503（临时角色头**禁止**上生产）', async () => {
    const saved = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const r = await send(url, '/approvals', { body: { action: 'redeem' }, headers: GUARDIAN })
      assert.equal(r.status, 503, '生产环境竟接受了客户端自报的角色 —— 那就是提权后门')
      assert.equal(r.body.code, 'IDENTITY_NOT_IMPLEMENTED')
      assert.equal(port.calls.length, 0)
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = saved
    }
  })

  it('decide：孩子没有批准资格 → 403，且**不调用** decide（判定在读库之后、写库之前）', async () => {
    const created = await send(url, '/approvals', { body: { action: 'redeem' }, headers: GUARDIAN })
    const id = String(created.body.id)
    port.calls.length = 0
    const r = await send(url, `/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: CHILD
    })
    assert.equal(r.status, 403)
    assert.equal(
      port.calls.some((c) => c.method === 'decide'),
      false,
      '没资格却走到了写库 —— 屏障失效'
    )
  })

  it('§9.10 双击「同意」：第二次 → 409 ALREADY_DECIDED（乐观锁口径只认 pending）', async () => {
    const created = await send(url, '/approvals', { body: { action: 'redeem' }, headers: GUARDIAN })
    const id = String(created.body.id)
    const first = await send(url, `/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: GUARDIAN
    })
    assert.equal(first.status, 200)
    const second = await send(url, `/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: GUARDIAN
    })
    assert.equal(second.status, 409)
    assert.equal(second.body.code, 'ALREADY_DECIDED')
    assert.equal(port.calls.filter((c) => c.method === 'decide').length, 1, '第二次不该再写一次')
  })

  it('decide：不存在的 id → 404 APPROVAL_NOT_FOUND', async () => {
    const r = await send(url, '/approvals/ap-nope/decide', {
      body: { decision: 'approved' },
      headers: GUARDIAN
    })
    assert.equal(r.status, 404)
    assert.equal(r.body.code, 'APPROVAL_NOT_FOUND')
  })

  it('decide：客户端**不能**指定系统态（expired / invalidated / withdrawn）→ 400', async () => {
    const created = await send(url, '/approvals', { body: { action: 'redeem' }, headers: GUARDIAN })
    const id = String(created.body.id)
    for (const decision of ['expired', 'invalidated', 'withdrawn']) {
      const r = await send(url, `/approvals/${id}/decide`, { body: { decision }, headers: GUARDIAN })
      assert.equal(r.status, 400, `${decision} 竟能由客户端写进去 —— 审批会变成万能状态写入口`)
    }
  })

  it('decide：**别人**批准 → selfApproved=false（审计能区分"我批的"与"别人批的"）', async () => {
    const created = await send(url, '/approvals', { body: { action: 'redeem' }, headers: GUARDIAN })
    const id = String(created.body.id)
    const r = await send(url, `/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: OTHER_GUARDIAN
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.selfApproved, false)
    assert.equal(r.body.auditAction, null, '别人批准不该记成 self_approved')
  })
})


// ── 组 E：判定**只有一处** —— 改矩阵，HTTP 行为必须跟着变 ─────────────────────
describe('唯一事实源：判定必须完全由矩阵导出', () => {
  let app!: INestApplication
  let url = ''
  let port!: ReturnType<typeof makeFakePort>

  before(async () => {
    port = makeFakePort()
    ;({ app, url } = await startApp(port))
  })
  after(async () => {
    await app.close()
  })

  it('把矩阵 `review_approvals.child` 改成 ALLOW ⇒ 孩子传 autoApprove **立刻**可自批（201）', async () => {
    const baseline = await send(url, '/approvals', {
      body: { action: 'request_redeem', autoApprove: true },
      headers: CHILD
    })
    assert.equal(baseline.status, 400, '前提变了：矩阵里孩子本来不该能自批')

    // 运行期改矩阵（`as const` 只在类型层面；运行时是普通对象）—— 这**就是**在测
    // 「HTTP 路径没有第二份名单」：若 service/controller 里手写了 `role === 'guardian'`，
    // 本行改完之后行为**不会**变，下面这条断言就会红。
    const row = PERMISSION_MATRIX.review_approvals as unknown as { child: string }
    Object.assign(row, { child: 'ALLOW' })
    try {
      const r = await send(url, '/approvals', {
        body: { action: 'request_redeem', autoApprove: true },
        headers: CHILD
      })
      assert.equal(
        r.status,
        201,
        '矩阵改了行为却没变 —— 说明判定被抄到了 service/controller（02 §4.5「唯一实现点」）'
      )
      assert.equal(r.body.selfApproved, true)
    } finally {
      Object.assign(row, { child: 'DENY' }) // 还原：矩阵是共享单例
    }
  })

  it('还原后立刻复核：孩子又回到 400（防止上一条的 finally 没生效而污染其它用例）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'request_redeem', autoApprove: true },
      headers: CHILD
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, SELF_APPROVAL_NOT_ALLOWED)
  })
})


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
 *   `02` §4.5 六条硬约束 + §9.3 / §9.10 / §9.25 / §9.26 / §9.27；W3-C 追加 §9.40。
 *   仓储用**内存替身**（`ApprovalsPort` 的实现）—— 真实 Prisma 实现由
 *   `test-db/approvals-execution-db` / `approvals-closing-db` 负责（真库、真事务）。
 *   **不注入替身**那一组断言的是 **501 fail-closed**，不是「成功」。
 *   ★ 本文件的世界**显式钉死**在无库（`ApprovalsModule.register({ hasDatabase: false })`，W2-D）——
 *   所以"默认装配"在这里的含义是**审批端口未注入**，与本机有没有 `.env` 无关。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { ConflictException, NotFoundException, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  APPROVALS_REPOSITORY,
  type ApprovalListRow,
  type ApprovalRow,
  type ApprovalsPort,
  type CreateApprovalInput,
  type ListApprovalsInput
} from '../src/approvals/approvals.repository'
import { ApprovalsModule } from '../src/approvals/approvals.module'
import { AUDIT_ACTION_SELF_APPROVED, SELF_APPROVAL_NOT_ALLOWED } from '../src/contracts/approval-policy'
import { PERMISSION_MATRIX } from '../src/contracts/permission-matrix'
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

/**
 * 身份（W1-C，2026-10-15）：客户端**不再自报角色**。
 * 它只说「我是哪台设备（`x-kp-device-id`）、在哪个孩子的档案上（`x-kp-child-id`）」，
 * 角色与 userId 由**服务端会话行**给出 —— 设备 ↔ 身份的对应见 `makeSessionFake()`。
 * 屏障一（`ChildMember(childId, userId)`）也依赖同一份身份，故 childId 仍必需。
 */
const CHILD_ID = 'child-1'

const DEV_DAD = 'dev-dad'
const DEV_MOM = 'dev-mom'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'

function identity(deviceId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': CHILD_ID }
}

const GUARDIAN = identity(DEV_DAD)
const OTHER_GUARDIAN = identity(DEV_MOM)
const CHILD = identity(DEV_KID)
const VIEWER = identity(DEV_GUEST)

/**
 * 会话替身（W1-C）：`DeviceSession(deviceId, childId)` 的线上替身。
 * 角色在这里、且**只在这里** —— 这正是本文件「客户端自报角色无效」那条用例的意义。
 */
function makeSessionFake(): DeviceSessionPort {
  const future = (): Date => new Date(Date.now() + 5 * 60 * 1000)
  const rows: SessionLookupRow[] = [
    { deviceId: DEV_DAD, childId: CHILD_ID, userId: 'u-dad', activeRole: 'guardian', expiresAt: future() },
    { deviceId: DEV_MOM, childId: CHILD_ID, userId: 'u-mom', activeRole: 'guardian', expiresAt: future() },
    { deviceId: DEV_KID, childId: CHILD_ID, userId: 'u-kid', activeRole: 'child', expiresAt: future() },
    { deviceId: DEV_GUEST, childId: CHILD_ID, userId: 'u-guest', activeRole: 'viewer', expiresAt: future() }
  ]
  return {
    async findSession(deviceId, childId) {
      return rows.find((r) => r.deviceId === deviceId && r.childId === childId) ?? null
    }
  }
}

/**
 * 成员替身（W1-B）：**每一组**都要注入它 —— 否则屏障一在**无库装配**下返回 501，
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
function makeFakePort(): ApprovalsPort & { calls: PortCall[]; rows: Map<string, SeedRow> } {
  const calls: PortCall[] = []
  const rows = new Map<string, SeedRow>()
  let seq = 0

  /**
   * payload 快照的替身：形状按动作给出（列表用例要读到 `summary`）。
   * ★ 真适配器会查心愿/规则并把标题快照进来；这里只保证**形状合法**，
   *   列表语义（排序 / 过滤 / 游标）才是本文件要验的东西。
   */
  const payloadOf = (input: CreateApprovalInput): Record<string, unknown> => {
    switch (input.action) {
      case 'redeem':
      case 'request_redeem':
        return {
          wishId: input.targetId ?? 'wish-1',
          titleSnapshot: '乐高',
          costSnapshot: 100
        }
      case 'request_points_bonus':
        return {
          amount: input.amount ?? 5,
          reason: input.reason ?? '帮忙洗碗',
          ruleId: null,
          ruleTitleSnapshot: null,
          habitId: null,
          habitTitleSnapshot: null
        }
      case 'add_wish':
        return { title: input.title ?? '新心愿', cost: input.cost ?? 40, emoji: input.emoji ?? '🎁' }
      default:
        return {}
    }
  }

  const build = (
    input: CreateApprovalInput,
    status: string,
    decidedByUserId: string | null
  ): ApprovalListRow => {
    seq += 1
    const createdAt = new Date(Date.UTC(2026, 9, 20, 0, 0, seq))
    const created: ApprovalListRow = {
      id: `ap-${seq}`,
      childId: input.childId,
      action: input.action,
      requesterUserId: input.requesterUserId,
      status,
      decidedByUserId,
      executedRecordId: status === 'approved' ? `rec-${seq}` : null,
      payload: payloadOf(input),
      createdAt,
      decidedAt: status === 'pending' ? null : createdAt,
      expiresAt: new Date(createdAt.getTime() + 72 * 60 * 60 * 1000)
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
    async findById(id, childId) {
      calls.push({ method: 'findById', input: { id, childId } })
      const row = rows.get(id)
      // ★ 与真适配器同一语义（W3-B）：`childId` 是查询条件，不是事后比较。
      return row !== undefined && row.childId === childId ? row : null
    },
    async decide(input) {
      calls.push({ method: 'decide', input })
      const existing = rows.get(input.id)
      // 乐观锁未命中（已被决过 / 不存在 / 不是这个孩子）⇒ 409，绝不覆盖终态（02 §4.4）
      if (
        existing === undefined ||
        existing.childId !== input.childId ||
        existing.status !== 'pending'
      ) {
        throw new ConflictException({ code: 'ALREADY_DECIDED' })
      }
      const updated: ApprovalRow = {
        ...existing,
        status: input.outcome,
        decidedByUserId: input.decidedByUserId
      }
      rows.set(updated.id, updated)
      return updated
    },
    async withdraw(input) {
      calls.push({ method: 'withdraw', input })
      const existing = rows.get(input.id)
      if (existing === undefined || existing.childId !== input.childId) {
        throw new NotFoundException({ code: 'APPROVAL_NOT_FOUND' })
      }
      if (existing.status !== 'pending') {
        throw new ConflictException({ code: 'ALREADY_DECIDED' })
      }
      // 撤回**不写账本**：替身里除了状态，什么都不改（真适配器同理）。
      const updated: ApprovalRow = { ...existing, status: 'withdrawn' }
      rows.set(updated.id, updated)
      return updated
    },
    async listForChild(input: ListApprovalsInput) {
      calls.push({ method: 'listForChild', input })
      const status = input.status ?? 'pending'
      const filtered = [...rows.values()]
        .map(asListRow)
        .filter((row) => row.childId === input.childId)
        .filter((row) => status === 'all' || row.status === status)
        .filter((row) => {
          if (input.cursor === undefined) return true
          const cursor = input.cursor
          if (row.createdAt.getTime() !== cursor.createdAt.getTime()) {
            return row.createdAt.getTime() < cursor.createdAt.getTime()
          }
          return row.id < cursor.id
        })
        // 与真适配器同一排序：createdAt desc, id desc
        .sort((a, b) => {
          const diff = b.createdAt.getTime() - a.createdAt.getTime()
          return diff !== 0 ? diff : b.id.localeCompare(a.id)
        })
      return filtered.slice(0, input.limit + 1)
    },
    async expireDue(now, limit) {
      calls.push({ method: 'expireDue', input: { now, limit } })
      let expired = 0
      for (const [id, row] of [...rows]) {
        if (row.status === 'pending') {
          rows.set(id, { ...row, status: 'expired' })
          expired += 1
        }
      }
      return expired
    }
  }
}

/**
 * 直接 `port.rows.set(...)` 塞进来的行只有判定字段（用例只关心状态 / 归属）；
 * 走端口建出来的行则自带 payload 与时间戳。`SeedRow` 让两种都能存进同一张表，
 * `asListRow` 只补**缺的**列 —— 已经给了的必须原样保留（否则列表用例读到的是默认值）。
 */
type SeedRow = ApprovalRow &
  Partial<Pick<ApprovalListRow, 'payload' | 'createdAt' | 'decidedAt' | 'expiresAt'>>

/** 手工造行的时间基线：写死不取 `now`，游标断言才可复现。 */
const SEED_CREATED_AT = new Date('2026-10-19T00:00:00.000Z')
/** 手工造行的默认快照（形状合法的 redeem），列表语义与它无关。 */
const SEED_PAYLOAD = { wishId: 'wish-1', titleSnapshot: '乐高', costSnapshot: 100 }

function asListRow(row: SeedRow): ApprovalListRow {
  const createdAt = row.createdAt ?? SEED_CREATED_AT
  return {
    ...row,
    payload: row.payload ?? SEED_PAYLOAD,
    createdAt,
    decidedAt: row.decidedAt !== undefined ? row.decidedAt : row.status === 'pending' ? null : createdAt,
    expiresAt: row.expiresAt ?? new Date(createdAt.getTime() + 72 * 60 * 60 * 1000)
  }
}

/**
 * 幂等端口替身：把「插入进行中 / 唯一冲突 / 重放」做成内存状态机。
 * ★ 它的意义是证明 **HTTP 层真的调用了端口**，而不是在 controller 里另写一份判断。
 */
function makeIdempotencyFake(): IdempotencyPort & {
  rows: Map<string, { requestHash: string; statusCode: number | null; body: Record<string, unknown> | null }>
} {
  const rows = new Map<
    string,
    { requestHash: string; statusCode: number | null; body: Record<string, unknown> | null }
  >()
  const idOf = (input: { childId: string; key: string }): string => `${input.childId}:${input.key}`

  return {
    rows,
    async begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult> {
      const id = idOf(input)
      const existing = rows.get(id)
      if (existing === undefined) {
        rows.set(id, { requestHash: input.requestHash, statusCode: null, body: null })
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
      const id = idOf(input)
      const existing = rows.get(id)
      if (existing === undefined) throw new Error('complete 之前没有 begin')
      rows.set(id, {
        requestHash: input.requestHash,
        statusCode: input.statusCode,
        body: input.body
      })
    },
    async abort(input: { key: string; childId: string; requestHash: string }): Promise<void> {
      rows.delete(idOf(input))
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
 * 起一个只装 `ApprovalsModule` 的真服务（`useValue` 可替换仓储；`repository` 不传 = **审批端口**
 * 保持默认的 501 实现 —— 组 A 靠这个）。
 * ★ 装配世界**钉死**在"无库"（`ApprovalsModule.register({ hasDatabase: false })`，W2-D）：
 *   子模块是动态的 ⇒ 不传参就会按环境推断，而本文件是离线用例。
 * ★ W1-B 起**恒**注入成员替身：`POST /approvals` 的守卫链是「身份 → 屏障一 → 屏障二/三」，
 *   不注入成员位就停在屏障一的 501 上（那由 `membership-http.test.ts` 组 C 专门测）。
 * ★ W1-C 起**恒**注入会话替身：身份是链条第一道，不喂它连屏障一都到不了
 *   （"**无库装配**下身份层 501" 由 `device-session-http.test.ts` 组 D 专门钉住 ——
 *   该文件同样把世界写死成 `hasDatabase: false`）。
 */
async function startApp(
  repository?: ApprovalsPort,
  idempotency?: IdempotencyPort
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({
    // ★ 显式 `hasDatabase: false`（W2-D 起 `ApprovalsModule` 会把世界转发给两个子模块）：
    //   本文件是**离线**用例 —— 不传参就会按环境推断，导出过 `DATABASE_URL` 的机器上
    //   会导入 `PrismaModule` 并连上真库（组 A 的三个端口都被替身覆盖，所以它不会红，
    //   只会变慢 ＋ 碰真数据）。世界必须钉死，"默认装配"在这份文件里的含义是
    //   **审批端口未注入**，而不是"脚手架里没有库"。
    imports: [ApprovalsModule.register({ hasDatabase: false })]
  })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())
  if (repository !== undefined) {
    builder.overrideProvider(APPROVALS_REPOSITORY).useValue(repository)
  }
  if (idempotency !== undefined) {
    builder.overrideProvider(IDEMPOTENCY_REPOSITORY).useValue(idempotency)
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app) // ★ 与 main.ts 同一函数：测的是**真装配**，不是测试自己搭的
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ── 组 A：审批端口保持默认（501）—— 「写入路径未落地」必须是**可执行断言** ─────────
// ★ 组名里的"无替身"指的是**审批端口**没有替身（`startApp()` 不传 repository）；
//   身份与资格**恒**是替身（见 `startApp()` 的两条 override）—— 它们是链条的前两道，
//   不喂就永远到不了审批端口，那时这里测的就不是"写入未落地"了。
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

  it('带 `Idempotency-Key` 但无库 ⇒ 501 `IDEMPOTENCY_NOT_IMPLEMENTED`（不假装重放保护生效）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem', targetId: 'wish-1' },
      headers: { ...GUARDIAN, 'idempotency-key': 'no-db-key' }
    })
    assert.equal(r.status, 501)
    assert.equal(r.body.code, 'IDEMPOTENCY_NOT_IMPLEMENTED')
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

  it('★ 目标动作在矩阵里 `DENY`（child add_rule）⇒ 403 `ACTION_NOT_ALLOWED`，连申请都不许提', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'add_rule' },
      headers: CHILD
    })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'ACTION_NOT_ALLOWED')
    assert.equal(
      port.calls.length,
      0,
      '矩阵 DENY 的动作仍走到了端口 —— 「为 DENY 动作提审批」可以绕过矩阵'
    )
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

  it('身份：缺 `x-kp-device-id` ⇒ 401，且**不落库**（绝不默认成 guardian）', async () => {
    const r = await send(url, '/approvals', { body: { action: 'redeem' }, headers: {} })
    assert.equal(r.status, 401)
    assert.equal(port.calls.length, 0)
  })

  it('★ 身份：自报 `x-kp-role: guardian` **完全无效** —— 会话是 child ⇒ 仍 400', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'request_redeem', autoApprove: true },
      // 客户端声称自己是家长（W1-A/W1-B 的临时口径）。W1-C 起这些头**不被读取**。
      headers: { ...CHILD, 'x-kp-role': 'guardian' }
    })
    assert.equal(
      r.status,
      400,
      '客户端自报的角色生效了 —— 身份又回到"客户端说了算"（W1-C 的核心回归）'
    )
    assert.equal(
      r.body.code,
      'SELF_APPROVAL_NOT_ALLOWED',
      '应当是**孩子**自批被判非法（判定用的是会话里的 child），而不是别的 400'
    )
    assert.equal(port.calls.length, 0)
  })

  it('★ 身份：冒用 `x-kp-user-id` 无效 —— 会话是 u-dad ⇒ 自批仍被拒（不是 u-mom 在自批）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem', autoApprove: true },
      headers: { ...GUARDIAN, 'x-kp-user-id': 'u-kid' }
    })
    assert.equal(r.status, 201, '家长自批本该成功（矩阵与策略都允许显式自批）')
    const decided = port.calls.filter((c) => c.method === 'createSelfApproved')
    assert.equal(decided.length, 1)
    assert.equal(
      (decided[0].input as { requesterUserId: string }).requesterUserId,
      'u-dad',
      '落库的申请人变成了客户端报的那个 —— 身份被请求头覆盖了'
    )
  })

  it('身份：设备头里塞两个 deviceId（合并值）⇒ 401，**不挑一个**（歧义输入不产生身份）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem' },
      headers: { 'x-kp-device-id': `${DEV_DAD}, ${DEV_MOM}`, 'x-kp-child-id': CHILD_ID }
    })
    assert.equal(r.status, 401)
    assert.equal(r.body.code, 'SESSION_NOT_FOUND')
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

  it('★ W3-B：跨孩子的审批 id **与不存在相同** → 404，且绝不调用 decide（不扣别家的分）', async () => {
    // 「另一家」的一条 pending：`child-2`，申请人 u-other。
    port.rows.set('ap-other', {
      id: 'ap-other',
      childId: 'child-2',
      action: 'redeem',
      requesterUserId: 'u-other',
      status: 'pending',
      decidedByUserId: null,
      executedRecordId: null
    })

    const r = await send(url, '/approvals/ap-other/decide', {
      body: { decision: 'approved' },
      headers: GUARDIAN // 屏障一看的是 x-kp-child-id = child-1 —— 他对 child-1 是合法 guardian
    })
    assert.equal(
      r.status,
      404,
      '跨孩子的审批被批准了 —— 家长只要拿到别家的 id 就能扣别人家的分（租户隔离失效）'
    )
    assert.equal(r.body.code, 'APPROVAL_NOT_FOUND')
    assert.equal(
      port.calls.some((c) => c.method === 'decide'),
      false,
      '跨孩子却调用了 decide —— service 只是把 id 原样交给端口，没有把 childId 当键'
    )
    // 读也必须带 childId（否则“先读后比”还能被竞态绕开）。
    const read = port.calls.find((c) => c.method === 'findById')
    assert.deepEqual(read?.input, { id: 'ap-other', childId: CHILD_ID })
    assert.equal(port.rows.get('ap-other')?.status, 'pending', '跨孩子请求改动了别家的行')
  })

  it('已是 `expired` 的 decide（重试）→ 409 `APPROVAL_EXPIRED`，不是 `ALREADY_DECIDED`', async () => {
    port.rows.set('ap-expired', {
      id: 'ap-expired',
      childId: CHILD_ID,
      action: 'redeem',
      requesterUserId: 'u-dad',
      status: 'expired',
      decidedByUserId: null,
      executedRecordId: null
    })
    const r = await send(url, '/approvals/ap-expired/decide', {
      body: { decision: 'approved' },
      headers: GUARDIAN
    })
    assert.equal(r.status, 409)
    assert.equal(
      r.body.code,
      'APPROVAL_EXPIRED',
      '过期重试变成了 ALREADY_DECIDED —— 同一个事实两种错误码，客户端无法统一提示'
    )
    assert.equal(port.calls.some((c) => c.method === 'decide'), false)
  })
})


// ── 组 F：撤回（W3-B）—— 第 5 个终态只能由申请人本人、在 pending 上触发 ─────────
describe('撤回（W3-B）：`withdrawn` 是申请人的动作，不是批准', () => {
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

  /** 建一条请求并返回 id（替身不校验 targetId / 执行器，只测状态机）。 */
  async function create(headers: Record<string, string>, action = 'redeem'): Promise<string> {
    const r = await send(url, '/approvals', { body: { action }, headers })
    assert.ok(r.status === 202, `建请求失败：${r.status} ${JSON.stringify(r.body)}`)
    return String(r.body.id)
  }

  it('★ 申请人撤回自己的 pending → 200 `withdrawn`；端口收到的是**申请人 + childId**', async () => {
    const id = await create(GUARDIAN)
    const r = await send(url, `/approvals/${id}/withdraw`, { headers: GUARDIAN })

    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'withdrawn')
    assert.equal(r.body.decidedByUserId, null, '撤回不是“谁批准了”，不该写批准人')
    assert.equal(r.body.executedRecordId, null, '撤回不该产生流水')

    const call = port.calls.find((c) => c.method === 'withdraw')
    assert.deepEqual(call?.input, {
      id,
      childId: CHILD_ID,
      requesterUserId: 'u-dad',
      requesterRole: 'guardian'
    })
    assert.equal(port.rows.get(id)?.status, 'withdrawn')
  })

  it('★ 另一位家长撤回 → 403 `NOT_REQUESTER`，且**不调用**端口（语义必须用 rejected）', async () => {
    const id = await create(GUARDIAN) // 申请人 u-dad
    const r = await send(url, `/approvals/${id}/withdraw`, { headers: OTHER_GUARDIAN })

    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'NOT_REQUESTER')
    assert.equal(
      port.calls.some((c) => c.method === 'withdraw'),
      false,
      '非本人却走到了写库 —— “谁能撤回”被抄成了 controller 里的角色判断'
    )
    assert.equal(port.rows.get(id)?.status, 'pending')
  })

  it('孩子撤回**自己**的申请 → 200（矩阵 `withdraw_request` 对孩子是 ALLOW）', async () => {
    const id = await create(CHILD, 'request_redeem')
    const r = await send(url, `/approvals/${id}/withdraw`, { headers: CHILD })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'withdrawn')
    assert.equal((port.calls.find((c) => c.method === 'withdraw')?.input as { requesterUserId: string }).requesterUserId, 'u-kid')
  })

  it('§9.7 批准后撤回 → 409 `ALREADY_DECIDED`，且**不调用** withdraw（已扣的分不会倒着改）', async () => {
    const id = await create(GUARDIAN)
    const ok = await send(url, `/approvals/${id}/decide`, { body: { decision: 'approved' }, headers: GUARDIAN })
    assert.equal(ok.status, 200)
    port.calls.length = 0

    const r = await send(url, `/approvals/${id}/withdraw`, { headers: GUARDIAN })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'ALREADY_DECIDED')
    assert.equal(port.calls.some((c) => c.method === 'withdraw'), false)
  })

  it('已撤回再撤 → 409 `ALREADY_DECIDED`（只认 pending，与 §4.4 同一口径）', async () => {
    const id = await create(GUARDIAN)
    assert.equal((await send(url, `/approvals/${id}/withdraw`, { headers: GUARDIAN })).status, 200)
    const again = await send(url, `/approvals/${id}/withdraw`, { headers: GUARDIAN })
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'ALREADY_DECIDED')
  })

  it('已是 `expired` 的撤回（重试）→ 409 `APPROVAL_EXPIRED`（与 decide 同一口径）', async () => {
    port.rows.set('ap-expired', {
      id: 'ap-expired',
      childId: CHILD_ID,
      action: 'redeem',
      requesterUserId: 'u-dad',
      status: 'expired',
      decidedByUserId: null,
      executedRecordId: null
    })
    const r = await send(url, '/approvals/ap-expired/withdraw', { headers: GUARDIAN })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'APPROVAL_EXPIRED')
    assert.equal(port.calls.some((c) => c.method === 'withdraw'), false)
  })

  it('不存在的 id → 404 `APPROVAL_NOT_FOUND`', async () => {
    const r = await send(url, '/approvals/ap-nope/withdraw', { headers: GUARDIAN })
    assert.equal(r.status, 404)
    assert.equal(r.body.code, 'APPROVAL_NOT_FOUND')
  })

  it('★ 跨孩子撤回 → 404（与不存在同一回答），端口 withdraw 未被调用', async () => {
    port.rows.set('ap-other', {
      id: 'ap-other',
      childId: 'child-2',
      action: 'redeem',
      requesterUserId: 'u-dad', // 同一个人，但这条属于**另一家**
      status: 'pending',
      decidedByUserId: null,
      executedRecordId: null
    })
    const r = await send(url, '/approvals/ap-other/withdraw', { headers: GUARDIAN })
    assert.equal(r.status, 404)
    assert.equal(r.body.code, 'APPROVAL_NOT_FOUND')
    assert.equal(port.calls.some((c) => c.method === 'withdraw'), false)
  })

  it('viewer 撤回 → 403 `MEMBER_NOT_FOUND`（屏障一先于矩阵，02 §3）', async () => {
    const r = await send(url, '/approvals/ap-whatever/withdraw', { headers: VIEWER })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'MEMBER_NOT_FOUND')
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


// ── 组 H：`Idempotency-Key` 的 HTTP 重放保护（W3-C）──────────────────────────
describe('组 H：Idempotency-Key 的 HTTP 重放保护（W3-C）', () => {
  let app!: INestApplication
  let url = ''
  let port!: ReturnType<typeof makeFakePort>
  let idem!: ReturnType<typeof makeIdempotencyFake>

  before(async () => {
    port = makeFakePort()
    idem = makeIdempotencyFake()
    ;({ app, url } = await startApp(port, idem))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    port.calls.length = 0
    port.rows.clear()
    idem.rows.clear()
  })

  const withKey = (key: string): Record<string, string> => ({
    ...GUARDIAN,
    'idempotency-key': key
  })

  it('★ 同一个 key + 同一个请求 ⇒ 第二次**直接返回首次响应**，业务只执行一次', async () => {
    const body = { action: 'redeem', targetId: 'w-1' }
    const first = await send(url, '/approvals', { body, headers: withKey('k-create') })
    const second = await send(url, '/approvals', { body, headers: withKey('k-create') })

    assert.equal(first.status, 202)
    assert.equal(second.status, 202)
    assert.equal(second.body.id, first.body.id, '重放生成了第二条 pending —— 幂等键没有生效')
    assert.equal(
      port.calls.filter((c) => c.method === 'createPending').length,
      1,
      '第二次仍然调用了业务端口 —— controller 没有消费幂等端口'
    )
    assert.equal(idem.rows.size, 1)
  })

  it('★ 同一个 key + **不同**请求体 ⇒ 409 IDEMPOTENCY_KEY_REUSED（不得静默复用首次结果）', async () => {
    const first = await send(url, '/approvals', {
      body: { action: 'redeem', targetId: 'w-1' },
      headers: withKey('k-reuse')
    })
    assert.equal(first.status, 202)

    const second = await send(url, '/approvals', {
      body: { action: 'redeem', targetId: 'w-2' },
      headers: withKey('k-reuse')
    })
    assert.equal(second.status, 409)
    assert.equal(second.body.code, 'IDEMPOTENCY_KEY_REUSED')
    assert.equal(
      port.calls.filter((c) => c.method === 'createPending').length,
      1,
      '同键不同请求仍然执行了第二次业务'
    )
  })

  it('★ decide 重放：第二次仍 200（而不是 ALREADY_DECIDED），业务只批准一次', async () => {
    const created = await send(url, '/approvals', {
      body: { action: 'redeem', targetId: 'w-decide' },
      headers: GUARDIAN
    })
    assert.equal(created.status, 202)
    const id = String(created.body.id)
    const body = { decision: 'approved' }

    const first = await send(url, `/approvals/${id}/decide`, {
      body,
      headers: withKey('k-decide')
    })
    const second = await send(url, `/approvals/${id}/decide`, {
      body,
      headers: withKey('k-decide')
    })

    assert.equal(first.status, 200)
    assert.equal(second.status, 200, '网络重试拿到了 409 —— 客户端会以为批准失败')
    assert.equal(second.body.status, 'approved')
    assert.equal(
      port.calls.filter((c) => c.method === 'decide').length,
      1,
      '重放仍然调用了 decide —— 第二次会被乐观锁挡成 409，说明幂等层没生效'
    )
  })

  it('不带 key ⇒ 完全不碰幂等端口（幂等是可选能力，不是强制）', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem', targetId: 'w-nokey' },
      headers: GUARDIAN
    })
    assert.equal(r.status, 202)
    assert.equal(idem.rows.size, 0)
  })

  it('非法 key（> 200 字符）⇒ 400 INVALID_IDEMPOTENCY_KEY，且不执行业务', async () => {
    const r = await send(url, '/approvals', {
      body: { action: 'redeem', targetId: 'w-bad-key' },
      headers: withKey('x'.repeat(201))
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'INVALID_IDEMPOTENCY_KEY')
    assert.equal(port.calls.length, 0)
  })
})

// ── 组 E：家长收件箱（W5-D）────────────────────────────────────────────────────
// 这一组回答的是一个**产品层**的空洞：审批写入从 W3-A 起就是真的，但**没人看得到**
// 待批的申请 —— 家长端没有列表端点，孩子提交后只能靠「通知」（不存在）知道。
// 判据：`02` §4.1 / §4.3（TTL）/ §4.2（`autoReason` 与 rejected 分开）。
describe('组 E：收件箱列表（GET /approvals，W5-D）', () => {
  let app!: INestApplication
  let url = ''
  let port!: ReturnType<typeof makeFakePort>

  const get = async (query = ''): Promise<HttpResult> =>
    send(url, `/approvals${query}`, { method: 'GET', headers: GUARDIAN })

  const itemsOf = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
    body.items as Array<Record<string, unknown>>

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

  it('空收件箱 ⇒ 200 空页（不是 404/500 —— 「没有待批」是正常状态）', async () => {
    const r = await get()
    assert.equal(r.status, 200)
    assert.deepEqual(itemsOf(r.body), [])
    assert.equal(r.body.hasMore, false)
    assert.equal(r.body.nextCursor, null)
    const call = port.calls.find((c) => c.method === 'listForChild')
    assert.deepEqual(
      (call?.input as { childId: string }).childId,
      CHILD_ID,
      'childId 必须来自会话，而不是 query'
    )
    assert.equal((call?.input as { limit: number }).limit, 20, '默认每页 20')
  })


  it('默认只返回 `pending`，并按「新的在前」排序；摘要按动作给出结构化字段', async () => {
    const first = await send(url, '/approvals', {
      body: { action: 'redeem', targetId: 'w-leg' },
      headers: GUARDIAN
    })
    const second = await send(url, '/approvals', {
      body: { action: 'request_points_bonus', amount: 6, reason: '洗碗' },
      headers: GUARDIAN
    })
    // 一条已拒绝的：默认视图**不该**出现
    const rejected = await send(url, '/approvals', {
      body: { action: 'redeem', targetId: 'w-old' },
      headers: GUARDIAN
    })
    await send(url, `/approvals/${String(rejected.body.id)}/decide`, {
      body: { decision: 'rejected' },
      headers: GUARDIAN
    })

    const r = await get()
    assert.equal(r.status, 200)
    const items = itemsOf(r.body)
    assert.deepEqual(
      items.map((item) => item.id),
      [second.body.id, first.body.id],
      '顺序必须是最新在前；已拒绝的不该出现在 pending 视图'
    )

    const redeem = items[1].summary as Record<string, unknown>
    assert.equal(redeem.kind, 'redeem')
    assert.equal(redeem.title, '乐高')
    assert.equal(redeem.cost, 100)
    // ★ 服务端**不**下发「兑换乐高需要 100 分」这种展示串：文案由客户端派生
    assert.equal(typeof redeem.text, 'undefined')

    const bonus = items[0].summary as Record<string, unknown>
    assert.equal(bonus.kind, 'bonus')
    assert.equal(bonus.amount, 6)
    assert.equal(bonus.reason, '洗碗')

    // 时间戳是 ISO 字符串，且 pending 的 decidedAt 必须是 null
    assert.equal(typeof items[0].createdAt, 'string')
    assert.equal(items[0].decidedAt, null)
    assert.equal(typeof items[0].expiresAt, 'string')
    assert.equal(r.body.hasMore, false)
  })

  it('`status=rejected` / `status=all` 能取到终态（收件箱不只「待批」）', async () => {
    const created = await send(url, '/approvals', {
      body: { action: 'redeem', targetId: 'w-1' },
      headers: GUARDIAN
    })
    const id = String(created.body.id)
    await send(url, `/approvals/${id}/decide`, {
      body: { decision: 'rejected' },
      headers: GUARDIAN
    })

    const rejected = await get('?status=rejected')
    assert.equal(rejected.status, 200)
    assert.deepEqual(itemsOf(rejected.body).map((item) => item.id), [id])
    assert.equal(itemsOf(rejected.body)[0].status, 'rejected')

    const pending = await get('?status=pending')
    assert.deepEqual(itemsOf(pending.body), [])

    const all = await get('?status=all')
    assert.equal(itemsOf(all.body).length, 1)
  })




  it('键集翻页：limit=2 → 第二页不重复、不遗漏，最后一页 nextCursor 必须为 null', async () => {
    const ids: unknown[] = []
    for (const target of ['w-1', 'w-2', 'w-3']) {
      const created = await send(url, '/approvals', {
        body: { action: 'redeem', targetId: target },
        headers: GUARDIAN
      })
      ids.push(created.body.id)
    }

    const first = await get('?limit=2')
    assert.equal(first.status, 200)
    assert.deepEqual(itemsOf(first.body).map((item) => item.id), [ids[2], ids[1]])
    assert.equal(first.body.hasMore, true)
    const cursor = first.body.nextCursor
    assert.equal(typeof cursor, 'string', '有下一页却没给 nextCursor —— 客户端取不回第二页')

    const second = await get(`?limit=2&cursor=${encodeURIComponent(String(cursor))}`)
    assert.equal(second.status, 200)
    assert.deepEqual(itemsOf(second.body).map((item) => item.id), [ids[0]])
    assert.equal(second.body.hasMore, false)
    assert.equal(second.body.nextCursor, null)
  })

  it('坏游标 ⇒ 400 INVALID_APPROVAL_CURSOR（绝不静默退回第一页）', async () => {
    const r = await get('?cursor=not-a-cursor')
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'INVALID_APPROVAL_CURSOR')
    assert.equal(port.calls.some((c) => c.method === 'listForChild'), false, '坏游标不该查库')
  })

  it('未知 status / limit 越界 / 未知参数 ⇒ 400（形状 = 集合封闭）', async () => {
    for (const query of ['?status=duh', '?limit=0', '?limit=101', '?limit=1.5', '?childId=child-2']) {
      const r = await get(query)
      assert.equal(r.status, 400, `${query} 应该被 400 拦下`)
    }
  })

  it('孩子没有 `review_approvals` ⇒ 403，且端口一次都没被调用（矩阵照旧是唯一判据）', async () => {
    const r = await send(url, '/approvals', { method: 'GET', headers: CHILD })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'FORBIDDEN')
    assert.equal(port.calls.length, 0)
  })

  it('★ 跨孩子隔离：另一家的 pending 不会出现在这个孩子的收件箱里', async () => {
    port.rows.set('ap-other', {
      id: 'ap-other',
      childId: 'child-2',
      action: 'redeem',
      requesterUserId: 'u-other',
      status: 'pending',
      decidedByUserId: null,
      executedRecordId: null
    })
    const r = await get('?status=all')
    assert.equal(r.status, 200)
    assert.deepEqual(itemsOf(r.body), [], '列表把别家的审批带出来了 —— 这是最严重的一类越权')
  })

  it('payload 坏掉的一行仍然出现在列表里，但 summary=null（不把整页打成 500）', async () => {
    port.rows.set('ap-broken', {
      id: 'ap-broken',
      childId: CHILD_ID,
      action: 'redeem',
      requesterUserId: 'u-kid',
      status: 'pending',
      decidedByUserId: null,
      executedRecordId: null,
      // 历史行 / 迁移半途的行可能就是这个样子：列表不能因此整页 500
      payload: { oops: true }
    })
    const r = await get()
    assert.equal(r.status, 200)
    assert.equal(itemsOf(r.body).length, 1)
    assert.equal(itemsOf(r.body)[0].summary, null)
  })
})

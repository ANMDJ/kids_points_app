/**
 * membership-http.test.ts —— **屏障一（成员资格门）＋ 屏障三（成员级收紧）** 的集成测试
 *                                 （真起 Nest ＋ 真发 HTTP 请求）
 *
 * ── 这一步在修什么（W1-B，2026-10-15）──────────────────────────────────────
 *   在此之前：`MembershipModule` 是**空壳**（零调用者），`member-restrictions.ts` 的
 *   `stricter()` **没有被任何请求路径调用**（D-b 交接单的原文）。也就是：
 *     · "这个人跟这个孩子有没有关系"从来没人问过 —— 只要角色头合法，
 *       就能对**任意** childId 走权限矩阵；
 *     · 家长为单个孩子加的限制（`restrictions`）**不生效**，而且不生效这件事**没人看得见**。
 *   本文件测的就是这两件事**真的发生在请求路径上**。
 *
 * ── 为什么必须走 HTTP（与 B4 / W1-A 同一理由）──────────────────────────────
 *   漏挂 Guard、三道屏障顺序颠倒、元数据没被读到、`kpMember` 没被填上 ——
 *   这些**装配层**的失败在"直调 guard 函数"的测试里全都看不见。
 *   故：起真服务、发真请求、断言真状态码。
 *
 * ── 判据来源 ─────────────────────────────────────────────────────────────
 *   `02` §3（三道屏障的顺序与语义）／§9.21（非成员 → 403 `MEMBER_NOT_FOUND`）
 *   ／§9.22（限制不能放宽矩阵的 DENY）。
 *
 * ── ⚠️ 诚实标注（不粉饰）──────────────────────────────────────────────────
 *   ① 成员位来自**内存替身** —— 真 Prisma 查询**已由 W2-D 交付**（有库绑定
 *      `PrismaMembershipRepository`）；本文件世界钉死**无库**，故组 C 验的是
 *      无库兜底（501），以及"**不会没查就过**"；
 *   ② 身份（角色 + userId）**来自服务端会话**（W1-C，2026-10-15）：客户端只出示
 *      `x-kp-device-id` ＋ `x-kp-child-id`（会话在本文件里是内存替身；真查询已由 W2-D 交付）；
 *   ③ `requireApprovalForBonusOver`（金额阈值）在 HTTP 路径上**尚未生效** —— 组 B 有一条钉住现状；
 *   ④ 更进一步：**三条限制键都不作用于 `request_approval`**，而 `POST /approvals` 的矩阵动作正是它
 *      ⇒ **屏障三在 `/approvals` 上结构性不生效**（它作用于 dispatcher 落地后的
 *      add_wish / undo_check_in / request_points_bonus）。组 B 用**同一套守卫链**的探针端点验证，
 *      并有一条用例把这个"结构性"事实本身钉住。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { Controller, Get, Module, UseGuards, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  APPROVALS_REPOSITORY,
  type ApprovalRow,
  type ApprovalsPort,
  type CreateApprovalInput
} from '../src/approvals/approvals.repository'
import { ApprovalsModule } from '../src/approvals/approvals.module'
import { DeviceSessionGuard } from '../src/device-session/device-session.guard'
import { DeviceSessionModule } from '../src/device-session/device-session.module'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import type { SessionLookupRow } from '../src/device-session/session.gate'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MembershipGuard } from '../src/membership/membership.guard'
import { MembershipModule } from '../src/membership/membership.module'
import {
  MEMBERSHIP_REPOSITORY,
  type MembershipPort
} from '../src/membership/membership.repository'
import { PermissionsGuard } from '../src/permissions/permissions.guard'
import { PermissionsModule } from '../src/permissions/permissions.module'
import { RequireAction } from '../src/permissions/require-action.decorator'

const CHILD_ID = 'child-1'
/** 第二个孩子：只用于证明"childId 真的参与判定"。 */
const OTHER_CHILD_ID = 'child-2'

/** 设备 ↔ (角色, userId) 的对应关系见 `makeSessionFake()` 的基线表。 */
const DEV_DAD = 'dev-dad'
const DEV_MOM = 'dev-mom'
const DEV_KID = 'dev-kid'
const DEV_GUEST = 'dev-guest'
const DEV_REMOVED = 'dev-removed'
const DEV_STRANGER = 'dev-stranger'

/**
 * 身份（W1-C 起）：客户端只说「**我是哪台设备**、在**哪个孩子**的档案上」。
 * 角色与 userId 一律由会话行给出 —— 这正是屏障一与屏障二赖以成立的前提。
 */
function headers(deviceId: string, childId: string = CHILD_ID): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': childId }
}

const GUARDIAN = headers(DEV_DAD)
const OTHER_GUARDIAN = headers(DEV_MOM)
const CHILD = headers(DEV_KID)
const VIEWER = headers(DEV_GUEST)
/** 有会话、但**没有任何成员位**的用户（屏障一必须拦下他）。 */
const STRANGER = headers(DEV_STRANGER)

// ── 内存替身：设备会话（DeviceSessionPort，W1-C）──────────────────────────────
interface SessionFake extends DeviceSessionPort {
  rows: Map<string, SessionLookupRow>
  reset(): void
  put(row: SessionLookupRow): void
  /** 把某台设备的会话改成**已过期**（验 §9.19：guardian 过期 ⇒ 回落 child）。 */
  expire(deviceId: string, childId?: string): void
}

function sessionKey(deviceId: string, childId: string): string {
  return `${deviceId}::${childId}`
}

function makeSessionFake(): SessionFake {
  const rows = new Map<string, SessionLookupRow>()
  const future = (): Date => new Date(Date.now() + 5 * 60 * 1000)

  const baseline: SessionLookupRow[] = [
    { deviceId: DEV_DAD, childId: CHILD_ID, userId: 'u-dad', activeRole: 'guardian', expiresAt: future() },
    // ★ dev-dad 在**另一个孩子**的档案上也有会话：于是"换个孩子"这条用例
    //   才能测到**屏障一**（而不是在身份层就 401 了）。身份层的 childId 同源校验
    //   由 session-gate / device-session-http 两个文件负责。
    { deviceId: DEV_DAD, childId: OTHER_CHILD_ID, userId: 'u-dad', activeRole: 'guardian', expiresAt: future() },
    { deviceId: DEV_MOM, childId: CHILD_ID, userId: 'u-mom', activeRole: 'guardian', expiresAt: future() },
    { deviceId: DEV_KID, childId: CHILD_ID, userId: 'u-kid', activeRole: 'child', expiresAt: future() },
    { deviceId: DEV_GUEST, childId: CHILD_ID, userId: 'u-guest', activeRole: 'viewer', expiresAt: future() },
    { deviceId: DEV_REMOVED, childId: CHILD_ID, userId: 'u-removed', activeRole: 'child', expiresAt: future() },
    { deviceId: DEV_STRANGER, childId: CHILD_ID, userId: 'u-stranger', activeRole: 'guardian', expiresAt: future() }
  ]

  const fake: SessionFake = {
    rows,
    reset() {
      rows.clear()
      for (const row of baseline) rows.set(sessionKey(row.deviceId, row.childId), row)
    },
    put(row) {
      rows.set(sessionKey(row.deviceId, row.childId), row)
    },
    expire(deviceId, childId = CHILD_ID) {
      const row = rows.get(sessionKey(deviceId, childId))
      assert.ok(row !== undefined, `前提变了：${deviceId} 本该有会话`)
      rows.set(sessionKey(deviceId, childId), { ...row, expiresAt: new Date(Date.now() - 1) })
    },
    async findSession(deviceId, childId) {
      return rows.get(sessionKey(deviceId, childId)) ?? null
    }
  }
  fake.reset()
  return fake
}

// ── 内存替身：成员位（MembershipPort）────────────────────────────────────────
interface MembershipFake extends MembershipPort {
  rows: Map<string, MembershipLookupRow>
  /** 恢复基线（成员位表是**可变**的：有的用例故意把某个人的位删掉／改成 removed／写坏）。 */
  reset(): void
  /** 给某人的成员位加上限制（组 B 的每一条都在改这一处）。 */
  limit(userId: string, restrictions: unknown, childId?: string): void
  put(row: MembershipLookupRow): void
}

function makeMembershipFake(): MembershipFake {
  const key = (childId: string, userId: string): string => `${childId}|${userId}`
  const rows = new Map<string, MembershipLookupRow>()

  const baseline: MembershipLookupRow[] = [
    { childId: CHILD_ID, userId: 'u-dad', role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: 'u-mom', role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: 'u-kid', role: 'child', status: 'active', restrictions: {} },
    // 已移除的成员位：屏障一必须回 MEMBER_REMOVED（而不是"没这一行"）
    { childId: CHILD_ID, userId: 'u-removed', role: 'child', status: 'removed', restrictions: {} }
    // ★ 刻意**没有** `u-stranger` —— 非成员用例靠它的缺席。
  ]

  const fake: MembershipFake = {
    rows,
    reset() {
      rows.clear()
      for (const row of baseline) rows.set(key(row.childId, row.userId), row)
    },
    put(row) {
      rows.set(key(row.childId, row.userId), row)
    },
    limit(userId, restrictions, childId = CHILD_ID) {
      const row = rows.get(key(childId, userId))
      assert.ok(row !== undefined, `前提变了：${userId} 本该有成员位`)
      rows.set(key(childId, userId), { ...row, restrictions })
    },
    async findMembership(childId, userId) {
      return rows.get(key(childId, userId)) ?? null
    }
  }
  fake.reset()
  return fake
}

// ── 内存替身：审批端口（只为了证明"请求**走到了**业务层"）────────────────────────
interface ApprovalsFake extends ApprovalsPort {
  calls: Array<{ method: keyof ApprovalsPort; input: unknown }>
}

function makeApprovalsFake(): ApprovalsFake {
  const calls: ApprovalsFake['calls'] = []
  const build = (input: CreateApprovalInput, status: string): ApprovalRow => ({
    id: 'ap-1',
    action: input.action,
    requesterUserId: input.requesterUserId,
    status,
    decidedByUserId: status === 'approved' ? input.requesterUserId : null,
    executedRecordId: null
  })
  return {
    calls,
    async createPending(input) {
      calls.push({ method: 'createPending', input })
      return build(input, 'pending')
    },
    async createSelfApproved(input) {
      calls.push({ method: 'createSelfApproved', input })
      return build(input, 'approved')
    },
    async findById(id) {
      calls.push({ method: 'findById', input: id })
      return null // 没有这条 —— 非成员用例必须**在**这次调用之前就被拦下
    },
    async decide(input) {
      calls.push({ method: 'decide', input })
      throw new Error('不该走到这里：能被 decide 的用例不在本文件范围内')
    }
  }
}

/**
 * 探针控制器：把屏障三要验的两个动作各钉一个端点。
 * 为什么需要它：业务端点（`/approvals`）只覆盖 `request_approval` / `review_approvals`，
 * 而屏障三的 `undo_check_in`（矩阵已 DENY，测"不能放宽"）与
 * `request_points_bonus`（阈值键的目标动作）都不在里面。
 * ★ 守卫链与业务端点**一模一样**（身份 → 资格 → 矩阵＋收紧）——
 *   探针若挂不同的守卫，它证明的就不是线上那条链。
 */
@Controller('probe')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
class ProbeController {
  /** 矩阵 `undo_check_in`：child DENY / guardian ALLOW。 */
  @Get('undo-check-in')
  @RequireAction('undo_check_in')
  undoCheckIn(): { reached: string } {
    return { reached: 'undo-check-in' }
  }

  /** 矩阵 `add_wish`：child REQUIRE_APPROVAL / guardian ALLOW（屏障三的目标动作之一）。 */
  @Get('add-wish')
  @RequireAction('add_wish')
  addWish(): { reached: string } {
    return { reached: 'add-wish' }
  }

  /** 矩阵 `request_points_bonus`：child ALLOW（阈值键的目标动作）。 */
  @Get('bonus')
  @RequireAction('request_points_bonus')
  bonus(): { reached: string } {
    return { reached: 'bonus' }
  }
}

@Module({
  // ★ 全部显式 `hasDatabase: false`（W2-D 起这两个子模块是**动态**的）：本文件是**离线**用例 ——
  //   不传参就会按环境推断，导出过 `DATABASE_URL` 的机器上会在装配阶段导入 `PrismaModule`
  //   并连上真库，而组 C 期望的 501 会变成"真查询之后的 401"（同一份用例两副面孔）。
  //   ★ `ApprovalsModule` 也必须传同一个值：它内部注册的子模块与本文件这几行**必须是同一个世界**
  //     —— Nest 对"token 相同的动态模块"会折叠，对"options 不同的"**不会**，
  //     于是同一份用例里会出现两套注册（谁生效取决于导入顺序，静默且难查）。
  imports: [
    ApprovalsModule.register({ hasDatabase: false }),
    MembershipModule.register({ hasDatabase: false }),
    PermissionsModule,
    DeviceSessionModule.register({ hasDatabase: false })
  ],
  controllers: [ProbeController],
  providers: [DeviceSessionGuard]
})
class MembershipProbeModule {}

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
 * 起一个只装探针模块的真服务。
 * ★ `membership` **不传**时走**无库装配**（`NotImplementedMembershipRepository` = 501）—— 组 C 靠这个。
 * ★ 会话替身**恒注入**（W1-C）：身份是这条链的第一道，不喂它整条链会在身份层就断
 *   （那时组 C 测到的就不是"屏障一没落地"了）。"无库装配下身份层 501"
 *   由 `device-session-http.test.ts` 组 D 专门钉住。
 */
async function startApp(
  options: { membership?: MembershipPort; approvals?: ApprovalsPort } = {}
): Promise<{ app: INestApplication; url: string }> {
  const builder = Test.createTestingModule({ imports: [MembershipProbeModule] })
    .overrideProvider(DEVICE_SESSION_REPOSITORY)
    .useValue(makeSessionFake())
  if (options.membership !== undefined) {
    builder.overrideProvider(MEMBERSHIP_REPOSITORY).useValue(options.membership)
  }
  if (options.approvals !== undefined) {
    builder.overrideProvider(APPROVALS_REPOSITORY).useValue(options.approvals)
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app) // ★ 与 main.ts 同一函数：测的是**真装配**
  await app.listen(0, '127.0.0.1')
  return { app, url: await app.getUrl() }
}

// ── 组 A：屏障一（资格门）────────────────────────────────────────────────────
describe('组 A：屏障一 —— 成员资格门（02 §3 / §9.21）', () => {
  let app!: INestApplication
  let url = ''
  let membership!: MembershipFake
  let approvals!: ApprovalsFake

  before(async () => {
    membership = makeMembershipFake()
    approvals = makeApprovalsFake()
    ;({ app, url } = await startApp({ membership, approvals }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    membership.reset()
    approvals.calls.length = 0
  })

  it('非成员 ⇒ 403 MEMBER_NOT_FOUND，且**审批端口一次都没被调用**（拦在业务之前）', async () => {
    const r = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'redeem' },
      headers: STRANGER
    })
    assert.equal(r.status, 403, '非成员进了业务层 —— 屏障一没拦住')
    assert.equal(r.body.code, 'MEMBER_NOT_FOUND')
    assert.equal(approvals.calls.length, 0, '403 必须在业务之前：拦不住（只事后报错）就等于没拦')
  })

  it('★ childId 真的参与判定：同一家长换个孩子 ⇒ 403 MEMBER_NOT_FOUND', async () => {
    const ok = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'redeem' },
      headers: GUARDIAN
    })
    assert.equal(ok.status, 202, '前提变了：u-dad 本该是 child-1 的成员')

    const r = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'redeem' },
      headers: headers(DEV_DAD, OTHER_CHILD_ID)
    })
    assert.equal(
      r.status,
      403,
      '换了孩子仍然放行 —— 说明判定用的是"你是不是**某个**孩子的成员"（childId 被忽略了）'
    )
    assert.equal(r.body.code, 'MEMBER_NOT_FOUND')
  })

  it('成员位已失效（status = removed）⇒ 403 MEMBER_REMOVED（不是 MEMBER_NOT_FOUND）', async () => {
    const r = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'redeem' },
      headers: headers(DEV_REMOVED)
    })
    assert.equal(r.status, 403)
    assert.equal(
      r.body.code,
      'MEMBER_REMOVED',
      '被移出家庭的成员必须与"从来没有成员位"分开报 —— 两者对客户端/审计的含义不同'
    )
  })

  it('对照：active 成员 ⇒ 穿过屏障一到达业务层（202 pending）', async () => {
    for (const [who, h] of [
      ['家长', GUARDIAN],
      ['另一位家长', OTHER_GUARDIAN],
      ['孩子', CHILD]
    ] as const) {
      approvals.calls.length = 0
      const r = await send(url, '/approvals', {
        method: 'POST',
        body: { action: 'redeem' },
        headers: h
      })
      assert.equal(r.status, 202, `${who} 是合法成员却被屏障一拦下了`)
      assert.ok(approvals.calls.length > 0, `${who} 没走到业务层`)
    }
  })

  it('缺 `x-kp-child-id` ⇒ 401 UNAUTHENTICATED（身份**不完整**，不是"跳过检查"）', async () => {
    const r = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'redeem' },
      headers: { 'x-kp-device-id': DEV_DAD }
    })
    assert.equal(r.status, 401, '缺孩子上下文竟被放行 —— 那次屏障一无从判定，却没人发现')
    assert.equal(r.body.code, 'UNAUTHENTICATED')
    assert.equal(approvals.calls.length, 0)
  })

  it('顺序：viewer（无成员位）⇒ 403 MEMBER_NOT_FOUND，**不是** FORBIDDEN（屏障一先于屏障二）', async () => {
    const r = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'redeem' },
      headers: VIEWER
    })
    assert.equal(r.status, 403)
    assert.equal(
      r.body.code,
      'MEMBER_NOT_FOUND',
      'viewer 先收到了"矩阵拒绝"—— 说明屏障二跑在屏障一前面（顺序反了）'
    )
  })

  it('decide 端点同样受屏障一保护：非成员点"同意" ⇒ 403，而不是 404 / 501', async () => {
    const r = await send(url, '/approvals/ap-1/decide', {
      method: 'POST',
      body: { decision: 'approved' },
      headers: STRANGER
    })
    assert.equal(
      r.status,
      403,
      '非成员走到了业务层（404 没有这条 / 501 未实现）—— 屏障一只挂在 POST /approvals 上了？'
    )
    assert.equal(r.body.code, 'MEMBER_NOT_FOUND')
    assert.equal(approvals.calls.length, 0)
  })
})

// ── 组 B：屏障三（成员级收紧）────────────────────────────────────────────────
describe('组 B：屏障三 —— 成员级收紧（02 §3 / §9.22）', () => {
  let app!: INestApplication
  let url = ''
  let membership!: MembershipFake
  let approvals!: ApprovalsFake

  before(async () => {
    membership = makeMembershipFake()
    approvals = makeApprovalsFake()
    ;({ app, url } = await startApp({ membership, approvals }))
  })
  after(async () => {
    await app.close()
  })
  beforeEach(() => {
    membership.reset()
    approvals.calls.length = 0
  })

  it('`childCannotAddWish`：孩子 add_wish 由 403 APPROVAL_REQUIRED 收紧为 403 **FORBIDDEN**', async () => {
    membership.limit('u-kid', { childCannotAddWish: true })
    const r = await send(url, '/probe/add-wish', { headers: CHILD })
    assert.equal(r.status, 403)
    assert.equal(
      r.body.code,
      'FORBIDDEN',
      '仍是 APPROVAL_REQUIRED ⇒ 这条成员级限制根本没生效（家长配了等于没配）'
    )
    assert.equal(r.body.reached, undefined, '业务方法被执行了 —— 屏障三没拦住')
  })

  it('对照：同一端点同角色、**没有**该限制 ⇒ 403 APPROVAL_REQUIRED（差异确实来自限制）', async () => {
    const r = await send(url, '/probe/add-wish', { headers: CHILD })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'APPROVAL_REQUIRED')
  })

  it('`childCannot*` 只管孩子：家长带同一条限制 ⇒ 照常放行（200，限制对孩子才有意义）', async () => {
    membership.limit('u-dad', { childCannotAddWish: true })
    const r = await send(url, '/probe/add-wish', { headers: GUARDIAN })
    assert.equal(
      r.status,
      200,
      '家长的 ALLOW 被孩子的限制收紧了 —— 键的语义搞反了（childCannotAddWish ≠ guardianCannotAddWish）'
    )
    assert.equal(r.body.reached, 'add-wish')
  })

  it('★ 诚实标注：三条限制键**都不**作用于 `request_approval` ⇒ 屏障三在 /approvals 上结构性不生效', async () => {
    // 这条用例把"哪些端点会被屏障三收紧"这件事钉住，免得将来有人以为 `/approvals` 已被收紧：
    //   `POST /approvals` 的矩阵动作是 `request_approval`（body 里的 `action` 是**被申请的动作**，
    //   不是端点动作），而三条限制键分别作用于 add_wish / undo_check_in / request_points_bonus。
    //   那三个动作的业务端点在 dispatcher（02 §6）落地前**不存在** ⇒ 本组用探针端点验同一套守卫链。
    membership.limit('u-kid', {
      childCannotAddWish: true,
      childCannotUndoCheckIn: true,
      requireApprovalForBonusOver: 0
    })
    const r = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'add_wish' }, // ← 被申请的动作；端点的矩阵动作仍是 request_approval
      headers: CHILD
    })
    assert.equal(r.status, 202, '端点的矩阵动作是 request_approval（child ALLOW），不该被这三个键收紧')
    assert.equal(r.body.status, 'pending')
  })

  it('§9.22：矩阵 DENY 的动作（undo_check_in）＋ 任何限制 ⇒ 仍 403 FORBIDDEN（不能放宽）', async () => {
    for (const restrictions of [
      {},
      { childCannotUndoCheckIn: true },
      { childCannotUndoCheckIn: false }, // “关掉限制”这个念头：它**不能**让 DENY 变成 ALLOW
      { childCannotAddWish: true, requireApprovalForBonusOver: 0 }
    ]) {
      membership.limit('u-kid', restrictions)
      const r = await send(url, '/probe/undo-check-in', { headers: CHILD })
      assert.equal(
        r.status,
        403,
        `restrictions=${JSON.stringify(restrictions)} 竟放行了矩阵 DENY 的动作`
      )
      assert.equal(r.body.code, 'FORBIDDEN')
      assert.equal(r.body.reached, undefined, '业务方法被执行了 —— 屏障三把 DENY 放宽了')
    }
  })

  it('⚠️ 现状钉住：金额阈值键在 HTTP 路径上**不生效**（本 Guard 拿不到金额）', async () => {
    membership.limit('u-kid', { requireApprovalForBonusOver: 0 }) // 阈值 0：任何正数都该"要审批"
    const r = await send(url, '/probe/bonus', { headers: CHILD })
    assert.equal(
      r.status,
      200,
      '★ 这条不是在庆祝：金额属 dispatcher 的 payload（02 §6 尚未落地），屏障三此刻**判不动**阈值。' +
        '若这里变成 403，说明 dispatcher 已落地 —— 那时请把本条改写成' +
        '"amount > 阈值 ⇒ 403 APPROVAL_REQUIRED"，并补一条金额不足的对照'
    )
    assert.equal(r.body.reached, 'bonus')
  })

  it('restrictions 形状坏了（拼错键 / 字符串 / 数组）⇒ 500，**不是** 403、更不是放行', async () => {
    for (const bad of [{ childCannotAddwis: true }, 'null', []]) {
      membership.put({
        childId: CHILD_ID,
        userId: 'u-kid',
        role: 'child',
        status: 'active',
        restrictions: bad
      })
      const r = await send(url, '/probe/bonus', { headers: CHILD })
      assert.equal(
        r.status,
        500,
        `restrictions=${JSON.stringify(bad)} 没被当成"数据坏了"：若 403，它会被当成权限问题排查很久；` +
          '若 200，一条写坏的限制就静默失效了'
      )
      assert.equal(r.body.code, 'INVALID_MEMBER_RESTRICTIONS')
    }
  })
})

// ── 组 C：无库装配 —— 「成员查询未落地」必须是**可执行断言** ─────────────────
describe('组 C：无库装配（不注入成员替身）：屏障一 fail-closed ⇒ 501，不得放行', () => {
  let app!: INestApplication
  let url = ''

  before(async () => {
    ;({ app, url } = await startApp())
  })
  after(async () => {
    await app.close()
  })

  it('合法身份的请求 ⇒ 501 MEMBERSHIP_QUERY_NOT_IMPLEMENTED（**不是** 202）', async () => {
    const r = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'redeem' },
      headers: GUARDIAN
    })
    assert.equal(r.status, 501, '成员查询没实现却放行了 —— 等于把资格判定整个跳过')
    assert.equal(r.body.code, 'MEMBERSHIP_QUERY_NOT_IMPLEMENTED')
  })

  it('非成员身份同样 501（此刻连"查不到"都判不出来 —— 但**绝不**因此放行）', async () => {
    const r = await send(url, '/probe/bonus', { headers: STRANGER })
    assert.equal(r.status, 501)
    assert.equal(r.body.code, 'MEMBERSHIP_QUERY_NOT_IMPLEMENTED')
  })
})

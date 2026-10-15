/**
 * permissions-guard.test.ts —— 屏障二（权限矩阵）的**集成测试**（真起 Nest + 真发 HTTP）
 *
 * ── 这一步在修什么 ────────────────────────────────────────────────────────
 *   `PERMISSION_MATRIX` 写得很完整，但在 W1-A 之前**没有任何调用者**：
 *   `resolveVerdict()` 只被单测调过。一张没人查的权限表＝事实上的注释 ——
 *   它不会拦住任何请求。本文件测的就是「矩阵**真的**在拦人」这件事。
 *
 * ── 为什么必须走 HTTP ────────────────────────────────────────────────────
 *   直接 `new PermissionsGuard().canActivate(假 context)` 只能证明"这个函数会返回 false"，
 *   不能证明"请求进不来"。而本项目要防的失败形态恰恰在**装配层**：
 *   漏挂 Guard、Guard 顺序颠倒、元数据没被读到 —— 这些在直调测试里全都看不见。
 *   故：起真服务、发真请求、断言真状态码（与 B4 的 `approvals-http.test.ts` 同一理由）。
 *
 * ── 判定来源 ─────────────────────────────────────────────────────────────
 *   `02` §3 屏障二（DENY → 403 ／ REQUIRE_APPROVAL → 转审批 ／ ALLOW → 放行）
 *   ＋ `02` §2（`viewer` 一律 DENY）。
 *
 * ── ⚠️ 诚实标注（不粉饰，三件事分开记）────────────────────────────────────
 *   ① 本文件里的 actor **仍来自临时头**（`x-kp-role` / `x-kp-user-id` / `x-kp-child-id`）——
 *      屏障二本身是真的，但它保护的"角色"尚未由服务端确立（那要等 W1-C 的 `DeviceSession`）。
 *      即：**屏障二是真的，「我是谁」目前还是假的** —— 不要读成"权限已就绪"。
 *   ② W1-B 起探针链上**多了屏障一**（`MembershipGuard`）：资格判定也是真的，
 *      但成员位来自**内存替身**（真 Prisma 查询属 W2）。
 *   ③ 于是 `viewer` 在本文件所测的链上**永远到不了屏障二**（他不是任何孩子的成员位）——
 *      "viewer ⇒ DENY" 这条判据的 HTTP 形态因此变成 `MEMBER_NOT_FOUND`，
 *      而矩阵层面的那一条仍由 `permission-matrix.test.ts` 的纯函数用例钉着。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { Controller, Get, Module, UseGuards, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import { ApprovalsModule } from '../src/approvals/approvals.module'
import { PERMISSION_MATRIX } from '../src/contracts/permission-matrix'
import { TemporaryRoleHeaderGuard } from '../src/device-session/temporary-role.guard'
import type { MembershipLookupRow } from '../src/membership/membership.gate'
import { MembershipGuard } from '../src/membership/membership.guard'
import { MembershipModule } from '../src/membership/membership.module'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'
import { PermissionsGuard } from '../src/permissions/permissions.guard'
import { PermissionsModule } from '../src/permissions/permissions.module'
import { RequireAction } from '../src/permissions/require-action.decorator'

/**
 * 身份三件套（W1-B 起第三个头必需）：谁 ＋ 什么角色 ＋ **对哪个孩子**。
 * 屏障一要拿 childId 去问"这个人跟这个孩子有没有关系"，缺它 ⇒ 401（见临时身份 Guard）。
 */
const CHILD_ID = 'child-1'

function identity(role: string, userId: string): Record<string, string> {
  return { 'x-kp-role': role, 'x-kp-user-id': userId, 'x-kp-child-id': CHILD_ID }
}

const GUARDIAN = identity('guardian', 'u-dad')
const CHILD = identity('child', 'u-kid')
const VIEWER = identity('viewer', 'u-guest')

/**
 * 成员替身（W1-B）：探针链上现在有三道屏障，屏障一的端口必须喂进来 ——
 * 否则默认实现（501）会把**所有**请求挡在屏障二之前，本文件的断言就全都变成在测屏障一。
 * ★ 刻意**没有** `u-guest`（viewer）：他不是任何孩子的成员位 —— 于是 viewer 到不了屏障二，
 *   这是「屏障一先于屏障二」的**设计后果**，不是覆盖丢失（见下方各组的说明）。
 */
function makeMembershipFake(): MembershipPort {
  const members: MembershipLookupRow[] = [
    { childId: CHILD_ID, userId: 'u-dad', role: 'guardian', status: 'active', restrictions: {} },
    { childId: CHILD_ID, userId: 'u-kid', role: 'child', status: 'active', restrictions: {} }
  ]
  return {
    async findMembership(childId, userId) {
      return members.find((m) => m.childId === childId && m.userId === userId) ?? null
    }
  }
}

/**
 * 探针控制器：用**真装饰器 + 真 Guard** 把几种判定各钉一个端点。
 * 为什么不只用业务端点（`/approvals`）：业务端点的动作只有 `request_approval` /
 * `review_approvals` 两个，覆盖不到 `REQUIRE_APPROVAL` 与"漏标"这两条分支。
 */
@Controller('probe')
// ★ 守卫链与实际业务端点（`/approvals`）**完全一致**：身份 → 屏障一 → 屏障二/三。
//   若这里少挂一道，本文件证明的就不是线上那条链（那正是"看起来在测权限"的失败形态）。
@UseGuards(TemporaryRoleHeaderGuard, MembershipGuard, PermissionsGuard)
class ProbeController {
  /** 矩阵 `view_child_points`：两种角色都 ALLOW。 */
  @Get('allow')
  @RequireAction('view_child_points')
  allow(): { reached: string } {
    return { reached: 'allow' }
  }

  /** 矩阵 `review_approvals`：guardian ALLOW / child DENY。 */
  @Get('deny-for-child')
  @RequireAction('review_approvals')
  denyForChild(): { reached: string } {
    return { reached: 'deny-for-child' }
  }

  /** 矩阵 `add_wish`：guardian ALLOW / child REQUIRE_APPROVAL（同一端点验两侧，天然对照）。 */
  @Get('needs-approval')
  @RequireAction('add_wish')
  needsApproval(): { reached: string } {
    return { reached: 'needs-approval' }
  }

  /** ★ 故意**不声明** `@RequireAction` —— 屏障二必须**拒绝**，而不是放行。 */
  @Get('undeclared')
  undeclared(): { reached: string } {
    return { reached: 'undeclared' }
  }
}

@Module({
  imports: [PermissionsModule, ApprovalsModule, MembershipModule],
  controllers: [ProbeController],
  providers: [TemporaryRoleHeaderGuard]
})
class GuardProbeModule {}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

/** 发一条真 HTTP 请求（响应体尽力按 JSON 解析）。 */
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

let app!: INestApplication
let url = ''

before(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [GuardProbeModule] })
    // 成员替身：屏障一的端口（不注入 ⇒ 501，整条链在屏障一就断了）
    .overrideProvider(MEMBERSHIP_REPOSITORY)
    .useValue(makeMembershipFake())
    .compile()
  app = moduleRef.createNestApplication()
  applyGlobalPipes(app) // 与 main.ts 同一函数：测的是**真装配**，不是测试自己搭的
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()
})
after(async () => {
  await app.close()
})

// ── 组 A：矩阵判定真的生效（ALLOW / DENY / viewer）────────────────────────────
describe('组 A：矩阵判定（02 §3 屏障二）', () => {
  it('`view_child_points` 双角色 ALLOW ⇒ 都放行（对照：不是「一律拒绝」）', async () => {
    for (const [name, headers] of [
      ['guardian', GUARDIAN],
      ['child', CHILD]
    ] as const) {
      const r = await send(url, '/probe/allow', { headers })
      assert.equal(r.status, 200, `${name} 本该 ALLOW 却被拒 —— 矩阵没被正确消费`)
      assert.equal(r.body.reached, 'allow')
    }
  })

  it('`review_approvals`：child DENY ⇒ 403，且**业务方法没被执行**', async () => {
    const r = await send(url, '/probe/deny-for-child', { headers: CHILD })
    assert.equal(r.status, 403, '孩子在矩阵里是 DENY，却没被拦住')
    assert.equal(r.body.code, 'FORBIDDEN')
    // 关键：403 必须**先于**业务方法 —— 拦不住（只事后报错）就等于没拦。
    assert.equal(r.body.reached, undefined, '业务方法被执行了：屏障二只是"事后报错"')
  })

  it('`review_approvals`：guardian ALLOW ⇒ 放行（同一端点两侧对照）', async () => {
    const r = await send(url, '/probe/deny-for-child', { headers: GUARDIAN })
    assert.equal(r.status, 200)
    assert.equal(r.body.reached, 'deny-for-child')
  })

  it('viewer ⇒ 403 MEMBER_NOT_FOUND（★ 屏障一先拦：他不是任何孩子的成员位）', async () => {
    const r = await send(url, '/probe/allow', { headers: VIEWER })
    assert.equal(r.status, 403, 'viewer 竟能通过 —— 只读角色退化成了可写角色')
    // ★ 行为变更（W1-B）：`viewer` 不是合法 `MemberRole`（只有 guardian / child），
    //   所以他**过不了屏障一** —— 403 的码是 MEMBER_NOT_FOUND，而不是屏障二的 FORBIDDEN。
    //   "viewer 在矩阵里无列 ⇒ 一律 DENY" 这条判据仍由 `permission-matrix.test.ts`
    //   的纯函数穷举钉着（那里不经 HTTP，不受屏障一影响）；两处各钉各的，不要互为证据。
    assert.equal(r.body.code, 'MEMBER_NOT_FOUND')
  })
})

// ── 组 B：fail-closed（不知道 ⇒ 拒绝，而不是放行）────────────────────────────
describe('组 B：fail-closed 四处', () => {
  it('端点漏标 @RequireAction ⇒ 403 NO_ACTION_DECLARED（不是放行）', async () => {
    const r = await send(url, '/probe/undeclared', { headers: GUARDIAN })
    assert.equal(r.status, 403, '漏标的端点被放行了 —— 忘写一行注解就等于开关权限')
    assert.equal(r.body.code, 'NO_ACTION_DECLARED')
  })

  it('漏标的端点对**任何**角色都拒绝（含 guardian —— 不是"只拦孩子"）', async () => {
    for (const [name, headers] of [
      ['guardian', GUARDIAN],
      ['child', CHILD]
    ] as const) {
      const r = await send(url, '/probe/undeclared', { headers })
      assert.equal(r.status, 403, `${name} 通过了漏标端点`)
      assert.equal(
        r.body.code,
        'NO_ACTION_DECLARED',
        `${name} 被**别的理由**拒了 —— 屏障二的漏标分支没生效（403 来自别处时这条用例会假绿）`
      )
    }
    // ★ viewer 到不了这条分支：他在**屏障一**就被拦下（不是任何孩子的成员位）。
    //   这是「屏障一先于屏障二」的设计后果（02 §3），不是覆盖丢失 ——
    //   顺序本身由 `membership-http.test.ts` 组 A 的专门用例钉着。
    const viewer = await send(url, '/probe/undeclared', { headers: VIEWER })
    assert.equal(viewer.status, 403)
    assert.equal(viewer.body.code, 'MEMBER_NOT_FOUND')
  })

  it('REQUIRE_APPROVAL（child + add_wish）⇒ 403 APPROVAL_REQUIRED，**不静默放行**', async () => {
    const r = await send(url, '/probe/needs-approval', { headers: CHILD })
    assert.equal(r.status, 403, 'REQUIRE_APPROVAL 被当成 ALLOW 放行了：需要家长点头的事悄悄生效')
    assert.equal(r.body.code, 'APPROVAL_REQUIRED')
    assert.equal(r.body.reached, undefined, '业务方法被执行了 —— 审批被绕过')
  })

  it('同一端点的 guardian 是 ALLOW ⇒ 放行（证明上一条不是"这个端点坏了"）', async () => {
    const r = await send(url, '/probe/needs-approval', { headers: GUARDIAN })
    assert.equal(r.status, 200)
    assert.equal(r.body.reached, 'needs-approval')
  })
  it('身份 Guard 先于屏障二：缺身份头 ⇒ 401（不是 403，也不是 500）', async () => {
    const r = await send(url, '/probe/allow')
    assert.equal(r.status, 401, '身份缺失必须由第一道 Guard 拦下；403/500 说明顺序或职责错了')
    assert.equal(r.body.code, 'UNAUTHENTICATED')
  })
})



// ── 组 C：**真实业务端点**也必须过屏障二（不只是探针）──────────────────────────
describe('组 C：业务端点 /approvals 的屏障二', () => {
  it('child 提出申请（request_approval 双角色 ALLOW）⇒ 穿过屏障二到达端口（501）', async () => {
    const r = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'redeem' },
      headers: CHILD
    })
    assert.equal(
      r.status,
      501,
      '501 = 已走过 Guard 并到达默认端口（落库未实现，B4 口径）。若为 403，说明矩阵被误读'
    )
    assert.equal(r.body.code, 'APPROVALS_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('child 批准（review_approvals = DENY）⇒ 403，且**不是** 501 / 409', async () => {
    const r = await send(url, '/approvals/ap-1/decide', {
      method: 'POST',
      body: { decision: 'approved' },
      headers: CHILD
    })
    assert.equal(r.status, 403, '孩子批准竟走到了业务层（501）或状态机（409）—— 屏障二没拦住')
    assert.equal(r.body.code, 'FORBIDDEN')
  })

  it('viewer 提出申请 ⇒ 403 MEMBER_NOT_FOUND（屏障一先拦；他不是任何孩子的成员位）', async () => {
    const r = await send(url, '/approvals', {
      method: 'POST',
      body: { action: 'redeem' },
      headers: VIEWER
    })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'MEMBER_NOT_FOUND')
  })
})

// ── 组 D：**唯一事实源** —— 运行期改矩阵，HTTP 行为必须跟着变 ─────────────────
// 若 Guard 之外还存在第二份判定（service / controller 里手写的 role 比较），
// 下面的断言会**红**：矩阵改了，行为不变 ⇒ 屏障二就只是"看起来在拦人"。
describe('组 D：矩阵是唯一事实源（改矩阵 ⇒ HTTP 行为跟着变）', () => {
  it('`review_approvals.child` 改成 ALLOW ⇒ 孩子 decide **立刻**不再 403（变 501）', async () => {
    const baseline = await send(url, '/approvals/ap-1/decide', {
      method: 'POST',
      body: { decision: 'approved' },
      headers: CHILD
    })
    assert.equal(baseline.status, 403, '前提变了：矩阵里孩子本来不该能批准')

    // 运行期改矩阵（`as const` 只在类型层面；运行时是普通对象）。
    const row = PERMISSION_MATRIX.review_approvals as unknown as { child: string }
    Object.assign(row, { child: 'ALLOW' })
    try {
      const r = await send(url, '/approvals/ap-1/decide', {
        method: 'POST',
        body: { decision: 'approved' },
        headers: CHILD
      })
      assert.equal(
        r.status,
        501,
        '矩阵改了行为却没变 —— 说明 Guard 之外还有第二份判定，屏障二就不唯一了'
      )
    } finally {
      Object.assign(row, { child: 'DENY' }) // 还原：矩阵是共享单例
    }
  })

  it('还原后复核：孩子又回到 403（防止上一条的 finally 没生效而污染其它组）', async () => {
    const r = await send(url, '/approvals/ap-1/decide', {
      method: 'POST',
      body: { decision: 'approved' },
      headers: CHILD
    })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'FORBIDDEN')
  })

  it('`add_wish.child` 由 REQUIRE_APPROVAL 改成 ALLOW ⇒ 探针端点从 403 变 200', async () => {
    const baseline = await send(url, '/probe/needs-approval', { headers: CHILD })
    assert.equal(baseline.status, 403)

    const row = PERMISSION_MATRIX.add_wish as unknown as { child: string }
    Object.assign(row, { child: 'ALLOW' })
    try {
      const r = await send(url, '/probe/needs-approval', { headers: CHILD })
      assert.equal(r.status, 200, '矩阵从 REQUIRE_APPROVAL 改成 ALLOW 后仍被拒 —— 判定被抄了一份')
      assert.equal(r.body.reached, 'needs-approval')
    } finally {
      Object.assign(row, { child: 'REQUIRE_APPROVAL' })
    }
  })

  it('还原后复核：探针又回到 403 APPROVAL_REQUIRED', async () => {
    const r = await send(url, '/probe/needs-approval', { headers: CHILD })
    assert.equal(r.status, 403)
    assert.equal(r.body.code, 'APPROVAL_REQUIRED')
  })
})



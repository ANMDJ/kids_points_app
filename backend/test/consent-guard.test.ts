/**
 * consent-guard.test.ts —— 第四道屏障（同意闸门）的**单元判据**（W7-A，2026-10-26）
 *
 * ── 为什么直接 new Guard，而不是只靠 HTTP 用例 ──────────────────────────────
 *   这里要钉的是「**Guard 内部**的分支」：漏元数据、身份层没跑、`none` / `withdrawn`
 *   两种拒绝、豁免动作**不查库**、无库 501 原样传播。
 *   这些分支有的在 HTTP 上很难构造（例如"故意漏标 `@RequireAction`"需要一棵坏掉的图），
 *   有的需要断言**副作用**（豁免动作到底有没有读库 —— HTTP 只看得到 200）。
 *
 * ── 本文件**不**重复 consent-http.test.ts 的事 ──────────────────────────────
 *   「撤回后写入真的停了」「重新同意后恢复」是**路径**问题（守卫链顺序 + 真端口），
 *   在那边用真 HTTP 测；这里只回答"单个 Guard 在各个输入下的判定"。
 *
 * ── 期望的状态码从异常对象读，不从 HTTP 读 ─────────────────────────────────
 *   `ForbiddenException.getStatus()` / `getResponse()` 就是 Nest 最终序列化的内容，
 *   断言它们与断言 HTTP 响应体等价，而且不必起服务。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ForbiddenException, type ExecutionContext } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'

import { ConsentGuard } from '../src/consent/consent.guard'
import {
  NotImplementedConsentRepository,
  type ConsentPort,
  type ConsentState
} from '../src/consent/consent.repository'
import type { ActionType } from '../src/contracts/permission-matrix'
import type { RequestWithActor } from '../src/permissions/actor'

const CHILD_ID = 'child-1'

/** 只回一个固定动作的 Reflector 替身（真实实现只是元数据查找，不值得起 Nest）。 */
function reflectorOf(action: ActionType | string | undefined): Reflector {
  return { getAllAndOverride: () => action } as unknown as Reflector
}

/** 只包住 request 的 ExecutionContext 替身 —— Guard 只用到 `switchToHttp().getRequest()`。 */
function contextOf(req: Partial<RequestWithActor>): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req })
  } as unknown as ExecutionContext
}

const GUARDIAN: RequestWithActor = {
  headers: {},
  kpActor: { userId: 'u-dad', role: 'guardian' },
  kpChildId: CHILD_ID
}

/** 可计数 / 可改状态的端口替身：用来断言「**有没有**查库」这件事本身。 */
function makePort(state: ConsentState) {
  const calls: string[] = []
  const port: ConsentPort = {
    async readState(childId) {
      calls.push(childId)
      return { ...state, childId }
    },
    async recordGrant() {
      throw new Error('guard 不该写同意')
    },
    async recordWithdrawal() {
      throw new Error('guard 不该写同意')
    }
  }
  return { port, calls }
}

const GRANTED: ConsentState = {
  childId: CHILD_ID,
  status: 'granted',
  consentVersion: '2026-10-draft',
  grantedAt: '2026-10-26T00:00:00.000Z',
  withdrawnAt: null
}
const WITHDRAWN: ConsentState = {
  ...GRANTED,
  status: 'withdrawn',
  withdrawnAt: '2026-10-26T01:00:00.000Z'
}
const NONE: ConsentState = {
  childId: CHILD_ID,
  status: 'none',
  consentVersion: null,
  grantedAt: null,
  withdrawnAt: null
}

/** 取 `ForbiddenException` 的响应体（Nest 会把它序列化成 JSON）。 */
function responseOf(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof ForbiddenException, `期望 403 CONSENT_REQUIRED，实际：${String(error)}`)
  assert.equal(error.getStatus(), 403)
  return error.getResponse() as Record<string, unknown>
}

test('有有效同意 ⇒ 放行，且查的是**请求里那个孩子**', async () => {
  const { port, calls } = makePort(GRANTED)
  const guard = new ConsentGuard(reflectorOf('check_in_habit'), port)

  assert.equal(await guard.canActivate(contextOf(GUARDIAN)), true)
  assert.deepEqual(calls, [CHILD_ID], '同意状态必须按 kpChildId 查，不能查一个写死的 id')
})

test('★ 已撤回 ⇒ 403 `CONSENT_REQUIRED`，details.status = withdrawn（客户端据此换文案）', async () => {
  const { port } = makePort(WITHDRAWN)
  const guard = new ConsentGuard(reflectorOf('add_wish'), port)

  const body = responseOf(await guard.canActivate(contextOf(GUARDIAN)).catch((err) => err))
  assert.equal(body.code, 'CONSENT_REQUIRED')
  const details = body.details as Record<string, unknown>
  assert.equal(details.status, 'withdrawn')
  assert.equal(details.action, 'add_wish', 'details 必须点名动作 —— 否则排查要猜是哪个端点被拦')
  assert.equal(details.withdrawnAt, WITHDRAWN.withdrawnAt)
  assert.match(String(body.message), /撤回/)
})

test('★ 从未同意（`none`）**也**拒绝：没有证据 ≠ 证据说可以', async () => {
  const { port } = makePort(NONE)
  const guard = new ConsentGuard(reflectorOf('adjust_points'), port)

  const body = responseOf(await guard.canActivate(contextOf(GUARDIAN)).catch((err) => err))
  assert.equal(body.code, 'CONSENT_REQUIRED')
  assert.equal((body.details as Record<string, unknown>).status, 'none')
  // 文案必须与"已撤回"不同：一个该引导去首次同意，一个该重新同意。
  assert.match(String(body.message), /还没有/)
})

test('豁免动作**根本不查库**（读路径不能因为无库而 501）', async () => {
  const { port, calls } = makePort(WITHDRAWN)
  const guard = new ConsentGuard(reflectorOf('view_records'), port)

  assert.equal(await guard.canActivate(contextOf(GUARDIAN)), true)
  assert.deepEqual(calls, [], '读路径查了同意状态 —— 无库装配下会把所有读取变成 501')
})

test('豁免的写动作（撤回申请 / 管理同意 / 切模式）同样不查库 —— 否则撤回后无法恢复', async () => {
  for (const action of ['withdraw_request', 'manage_consent', 'switch_role_mode'] as const) {
    const { port, calls } = makePort(WITHDRAWN)
    const guard = new ConsentGuard(reflectorOf(action), port)
    assert.equal(await guard.canActivate(contextOf(GUARDIAN)), true, `${action} 应豁免`)
    assert.deepEqual(calls, [], `${action} 不该读同意状态`)
  }
})

test('fail-closed：矩阵里没有的动作按「写」处理（会去要同意）', async () => {
  const { port, calls } = makePort(NONE)
  const guard = new ConsentGuard(reflectorOf('not_in_matrix'), port)

  const body = responseOf(await guard.canActivate(contextOf(GUARDIAN)).catch((err) => err))
  assert.equal(body.code, 'CONSENT_REQUIRED')
  assert.deepEqual(calls, [CHILD_ID], '未知动作被当成读放行了 —— 与 resolveVerdict 的方向相反')
})

test('装配错误必须响亮：漏标 `@RequireAction` ⇒ 抛错（不是放行）', async () => {
  const { port } = makePort(GRANTED)
  const guard = new ConsentGuard(reflectorOf(undefined), port)

  await assert.rejects(
    async () => guard.canActivate(contextOf(GUARDIAN)),
    /RequireAction/,
    '找不到动作元数据却放行了 —— 任何漏标的写端点都会永久绕过同意闸门'
  )
})

test('身份层没跑必须响亮：缺 `kpActor` / `kpChildId` ⇒ 抛错（不是"没有孩子 ⇒ 免检"）', async () => {
  const { port } = makePort(GRANTED)

  await assert.rejects(
    async () =>
      new ConsentGuard(reflectorOf('add_wish'), port).canActivate(contextOf({ headers: {} })),
    /kpActor/
  )
  await assert.rejects(
    async () =>
      new ConsentGuard(reflectorOf('add_wish'), port).canActivate(
        contextOf({ headers: {}, kpActor: GUARDIAN.kpActor })
      ),
    /kpChildId/
  )
})

test('★ 无库：501 原样传播，绝不 `return true`（"查不到" ≠ "没有限制"）', async () => {
  const guard = new ConsentGuard(
    reflectorOf('check_in_habit'),
    new NotImplementedConsentRepository()
  )

  await assert.rejects(
    async () => guard.canActivate(contextOf(GUARDIAN)),
    (err: unknown) => {
      const exception = err as {
        getStatus?: () => number
        getResponse?: () => Record<string, unknown>
      }
      assert.equal(exception.getStatus?.(), 501)
      assert.equal(exception.getResponse?.().code, 'CONSENT_PERSISTENCE_NOT_IMPLEMENTED')
      return true
    }
  )
})

test('异常形状封闭：403 的 details 只有 status / consentVersion / withdrawnAt / action', async () => {
  const { port } = makePort(WITHDRAWN)
  const guard = new ConsentGuard(reflectorOf('delete_wish'), port)

  const body = responseOf(await guard.canActivate(contextOf(GUARDIAN)).catch((err) => err))
  assert.deepEqual(Object.keys(body.details as Record<string, unknown>).sort(), [
    'action',
    'consentVersion',
    'status',
    'withdrawnAt'
  ])
})

test('闸门**不看 HTTP 方法**：`GET` 也绕不过一个写动作（读豁免只能靠分类改）', async () => {
  // `GET /invites` / `GET /approvals` 复用写动作，因此撤回后也会 403。
  // 有人会觉得"读应该还能用"，然后在 Guard 里加一行 `req.method === 'GET' ⇒ true` ——
  // 那会让「哪些读被豁免」变成第二份隐式清单，而表面上看仍然"符合预期"。
  const { port } = makePort(WITHDRAWN)
  const guard = new ConsentGuard(reflectorOf('review_approvals'), port)
  const req = { ...GUARDIAN, method: 'GET' } as unknown as RequestWithActor

  const body = responseOf(await guard.canActivate(contextOf(req)).catch((err) => err))
  assert.equal(body.code, 'CONSENT_REQUIRED')
})

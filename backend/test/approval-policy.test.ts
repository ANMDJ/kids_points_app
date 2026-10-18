/**
 * approval-policy.test.ts —— 自批策略的**性质测试**（`02` §4.5 ／ PRD §14.1 P4）
 *
 * 为什么值得测：「谁可以批准」此前**全仓无定义**，而 `redeem` 对两端都是
 * `REQUIRE_APPROVAL` —— 判据写错的方向有两种，**都不报错**：
 *   · 太松（没勾选也批 / 孩子也能自批）→ 审计里出现没有人点过同意的批准，孩子绕过家长；
 *   · 太紧（谁都不能自批）→ 单家长家庭的兑换**永远转不出去**，到 TTL 被 `expired` 扫掉。
 * 两条都不会让编译器说一句话，所以把它们钉成用例。
 *
 * 本文件与 `scripts/honesty-probe.mjs` 项 D 的分工：那边保证「动作清单」不漂移，
 * 这边保证「自批判据」与矩阵**逐一相等**（不允许出现第二处名单）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDIT_ACTION_SELF_APPROVED,
  AUDIT_ACTION_WITHDRAWN,
  SELF_APPROVAL_NOT_ALLOWED,
  canDecide,
  canReview,
  canSelfApprove,
  canWithdraw,
  decideRequestOutcome,
  isSelfApproved,
  withdrawDenial
} from '../src/contracts/approval-policy'
import { ALL_ACTIONS, PERMISSION_MATRIX, type ActionType, type Role } from '../src/contracts/permission-matrix'

const ROLES: Role[] = ['guardian', 'child']
const ALL_ROLES: (Role | 'viewer')[] = ['guardian', 'child', 'viewer']

test('默认安全（fail-closed）：**没勾选就不批** —— 缺字段 / false / 非布尔一律 pending', () => {
  for (const autoApprove of [undefined, false, null, 0, 1, 'true', {}]) {
    const outcome = decideRequestOutcome({ action: 'redeem', requesterRole: 'guardian', autoApprove })
    assert.deepEqual(
      outcome,
      { kind: 'PENDING' },
      `autoApprove=${String(JSON.stringify(autoApprove))} 竟被当成"显式勾选"（真值判断会让 'true' / 1 混进来）`
    )
  }
})

test('需求本体：单家长家庭不再死锁 —— guardian 对自己的 redeem 显式自批 → 直接批准', () => {
  // 这条就是用户裁定要修的那个场景：只有一位家长时，**必须**由本人把兑换批出去。
  assert.equal(canSelfApprove('redeem', 'guardian'), true)
  assert.deepEqual(
    decideRequestOutcome({ action: 'redeem', requesterRole: 'guardian', autoApprove: true }),
    { kind: 'SELF_APPROVED' },
    'guardian 自批 redeem 被拒 —— 单家长家庭会重新卡死'
  )
})

test('孩子永远不能自批（矩阵 review_approvals 对孩子 = DENY）：显式勾选必须被**拒绝**而不是静默忽略', () => {
  for (const action of ['add_wish', 'request_redeem', 'redeem'] as ActionType[]) {
    assert.equal(canSelfApprove(action, 'child'), false, `${action} 竟然允许孩子自批`)
    assert.deepEqual(
      decideRequestOutcome({ action, requesterRole: 'child', autoApprove: true }),
      { kind: 'REJECTED', code: SELF_APPROVAL_NOT_ALLOWED },
      `${action}：孩子传 autoApprove 后既不报错也不点名（若变成 PENDING 就是静默忽略 —— 客户端会以为已批）`
    )
  }
})

test('参数与动作不匹配也拒：不需要审批（ALLOW）或本来就 DENY 的动作传 autoApprove → REJECTED', () => {
  // 与 `member-restrictions.ts` 的"多余键也拒"同一口径：形状 = 集合封闭，不静默吞掉无意义参数。
  for (const action of [
    'add_wish',
    'adjust_points',
    'view_rules',
    'review_approvals',
    'invite_member',
    'reset_demo_data'
  ] as ActionType[]) {
    assert.deepEqual(
      decideRequestOutcome({ action, requesterRole: 'guardian', autoApprove: true }),
      { kind: 'REJECTED', code: SELF_APPROVAL_NOT_ALLOWED },
      `${action}（矩阵 guardian=${PERMISSION_MATRIX[action].guardian}）不该允许走自批`
    )
  }
})

test('viewer 一律不能批准、也不能自批（fail-closed，同 06 §3.1 决策 D6）', () => {
  assert.equal(canReview('viewer'), false)
  for (const action of ALL_ACTIONS) {
    assert.equal(canSelfApprove(action, 'viewer'), false, `${action} 对 viewer 可自批`)
  }
  assert.equal(canDecide({ status: 'pending' }, 'viewer'), false)
})

test('自批资格**完全由矩阵导出**（唯一事实源）：穷举 25×2 与定义式逐项相等', () => {
  for (const action of ALL_ACTIONS) {
    for (const role of ROLES) {
      const expected =
        PERMISSION_MATRIX[action][role] === 'REQUIRE_APPROVAL' &&
        PERMISSION_MATRIX.review_approvals[role] === 'ALLOW'
      assert.equal(
        canSelfApprove(action, role),
        expected,
        `${action}.${role} 与矩阵导出式不一致 —— 说明存在第二处定义（权限只能在一处定义，02 §2）`
      )
    }
  }
})

test('不变量：自批**不得扩大任何角色的权限**，且允许面**不得为空**', () => {
  for (const action of ALL_ACTIONS) {
    for (const role of ROLES) {
      if (canSelfApprove(action, role)) {
        assert.equal(
          PERMISSION_MATRIX[action][role],
          'REQUIRE_APPROVAL',
          `${action}.${role}：自批把一个非审批动作变成可直接执行（等于偷偷放宽矩阵）`
        )
      }
    }
  }
  // 空集也能让上面那条恒真 —— 必须反向钉住"至少有一处允许"，否则"全都禁止"会假绿。
  assert.ok(
    ALL_ACTIONS.some((action) => canSelfApprove(action, 'guardian')),
    'guardian 对任何动作都不能自批 —— 单家长家庭的兑换仍会死锁'
  )
})

test('两步式（二次确认）：申请人本人可批准 pending；终态不可再决', () => {
  assert.equal(canReview('guardian'), true)
  assert.equal(canReview('child'), false, '孩子不该有批准资格（矩阵 review_approvals = DENY）')
  assert.equal(canDecide({ status: 'pending' }, 'guardian'), true)
  assert.equal(canDecide({ status: 'pending' }, 'child'), false)
  for (const status of ['approved', 'rejected', 'withdrawn', 'invalidated', 'expired']) {
    assert.equal(canDecide({ status }, 'guardian'), false, `${status} 是终态，竟还能再决（同 02 §4.4 乐观锁口径）`)
  }
})

test('自批可被判据识别（审计可辨），未决不算自批 —— 不新增字段（同 D4 口径）', () => {
  assert.equal(AUDIT_ACTION_SELF_APPROVED, 'approval.self_approved')
  assert.equal(isSelfApproved({ requesterUserId: 'u1', decidedByUserId: 'u1' }), true)
  assert.equal(isSelfApproved({ requesterUserId: 'u1', decidedByUserId: 'u2' }), false, '别人批准不是自批')
  assert.equal(isSelfApproved({ requesterUserId: 'u1', decidedByUserId: null }), false, '未决不算自批')
})

test('三种结果互斥且穷尽（消费方按 kind 分支，不会把"没资格"当成"等审批"）', () => {
  const seen = new Set<string>()
  for (const autoApprove of [undefined, true]) {
    for (const action of ALL_ACTIONS) {
      for (const role of ALL_ROLES) {
        seen.add(decideRequestOutcome({ action, requesterRole: role, autoApprove }).kind)
      }
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    ['PENDING', 'REJECTED', 'SELF_APPROVED'],
    '穷举 25 动作 × 3 角色 × 勾选/不勾选 时漏了某种结果 —— 判定分支有洞'
  )
})

test('撤回（W3-B）：只有申请人本人、只有 pending 能撤 —— 三种拒绝原因必须分得开', () => {
  const pending = { status: 'pending', requesterUserId: 'u-kid' }

  assert.equal(withdrawDenial(pending, { userId: 'u-kid', role: 'child' }), null)
  assert.equal(canWithdraw(pending, { userId: 'u-kid', role: 'child' }), true, '孩子撤自己的申请应当允许')

  // 另一位家长：不是“没资格”，而是“不是你提的”。两种 403 的语义不同
  // （NOT_REQUESTER 要提示“请用拒绝”；FORBIDDEN 才是角色不允许）。
  assert.equal(
    withdrawDenial(pending, { userId: 'u-dad', role: 'guardian' }),
    'NOT_REQUESTER',
    '非申请人被压成了普通 FORBIDDEN —— 客户端无法提示“另一位家长请用 decide(rejected)”'
  )

  // viewer 在矩阵里没有 withdraw_request 列 ⇒ 先按角色拒绝（fail-closed）。
  assert.equal(
    withdrawDenial(pending, { userId: 'u-kid', role: 'viewer' }),
    'WITHDRAW_FORBIDDEN_ROLE'
  )

  // 五个终态都不可撤回（含 withdrawn 本身 —— 与 §4.4 只认 pending 同一口径）。
  for (const status of ['approved', 'rejected', 'withdrawn', 'invalidated', 'expired']) {
    assert.equal(
      withdrawDenial({ status, requesterUserId: 'u-kid' }, { userId: 'u-kid', role: 'child' }),
      'ALREADY_DECIDED',
      `${status} 是终态，竟还能撤回`
    )
  }

  assert.equal(AUDIT_ACTION_WITHDRAWN, 'approval.withdrawn')
})

test('撤回：角色判据直接来自矩阵（改矩阵 ⇒ 判定跟着变，不存在第二份名单）', () => {
  const row = PERMISSION_MATRIX.withdraw_request as unknown as { child: string }
  const pending = { status: 'pending', requesterUserId: 'u-kid' }

  assert.equal(withdrawDenial(pending, { userId: 'u-kid', role: 'child' }), null)
  Object.assign(row, { child: 'DENY' })
  try {
    assert.equal(
      withdrawDenial(pending, { userId: 'u-kid', role: 'child' }),
      'WITHDRAW_FORBIDDEN_ROLE',
      '矩阵改了判定却没变 —— “谁能撤回”被抄到了 approval-policy 之外'
    )
  } finally {
    Object.assign(row, { child: 'ALLOW' }) // 矩阵是共享单例，必须还原
  }
})

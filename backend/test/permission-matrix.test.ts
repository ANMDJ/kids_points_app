/**
 * permission-matrix.test.ts —— 权限矩阵（屏障二）的**性质测试**
 *
 * 与 `scripts/honesty-probe.mjs` 检查项 D 的分工：
 *   · 那边（静态）：矩阵动作 ↔ `schema.prisma` 的 `enum ActionType` **字面量逐条相等**；
 *   · 这边（行为）：矩阵的**形状完整 / 取值合法 / fail-closed / 方向性**，以及 E18 那条产品级不变量。
 *
 * 为什么值得测：权限只能在一处定义（02 §2）。矩阵少一列、多一个非法值、或屏障三**把 DENY 放宽**，
 * 都会让"某条路径悄悄多了权限"—— 而三端编译器都不会说一句话（与 D9 / D3b 同类病）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ALL_ACTIONS,
  PERMISSION_MATRIX,
  VERDICT_SEVERITY,
  resolveVerdict,
  stricter,
  type ActionType,
  type Role,
  type Verdict
} from '../src/contracts/permission-matrix'

const VERDICTS: Verdict[] = ['ALLOW', 'REQUIRE_APPROVAL', 'DENY']
const ROLES: Role[] = ['guardian', 'child']

test('规模与唯一性：32 个动作，且无重复（与 PRD §7 / contracts JSON 同规模）', () => {
  assert.equal(ALL_ACTIONS.length, 32)
  assert.equal(new Set(ALL_ACTIONS).size, 32, '动作键有重复')
})

test('W5-J 我的申请：两个角色都能看自己提的；viewer 仍 fail-closed', () => {
  // 与 `review_approvals` 的方向**刻意不同**：那个是「待我批准」（child DENY），
  // 这个是「我提过什么」（child ALLOW）。把两者合并 = 孩子获得批准视图。
  assert.equal(resolveVerdict('view_own_approvals', 'guardian'), 'ALLOW')
  assert.equal(resolveVerdict('view_own_approvals', 'child'), 'ALLOW')
  assert.equal(resolveVerdict('view_own_approvals', 'viewer'), 'DENY')
  assert.equal(resolveVerdict('review_approvals', 'child'), 'DENY')
})

test('W5-H 成员管理：看成员两侧都放行，改角色 / 移出只给家长（02 §2）', () => {
  // 三个动作的方向不能靠"实现时记对"—— 矩阵是唯一事实源，这里把它钉住：
  // 一旦有人把 change_member_role 放宽成 child ALLOW，孩子就能给自己升权。
  assert.equal(resolveVerdict('view_members', 'guardian'), 'ALLOW')
  assert.equal(resolveVerdict('view_members', 'child'), 'ALLOW')
  assert.equal(resolveVerdict('change_member_role', 'guardian'), 'ALLOW')
  assert.equal(resolveVerdict('change_member_role', 'child'), 'DENY')
  assert.equal(resolveVerdict('remove_member', 'guardian'), 'ALLOW')
  assert.equal(resolveVerdict('remove_member', 'child'), 'DENY')
  // viewer 没有列 ⇒ 一律 DENY（fail-closed），包括"看成员"。
  assert.equal(resolveVerdict('view_members', 'viewer'), 'DENY')
})

test('形状完整：每个动作必须恰好有 guardian / child 两列（不得缺角色列）', () => {
  for (const action of ALL_ACTIONS) {
    assert.deepEqual(
      Object.keys(PERMISSION_MATRIX[action]).sort(),
      ['child', 'guardian'],
      `${action} 的角色列不是恰好两列`
    )
  }
})

test('取值合法：每个判定都在三值集合内（防强转 / JSON 注入非法值）', () => {
  for (const action of ALL_ACTIONS) {
    for (const role of ROLES) {
      const verdict = PERMISSION_MATRIX[action][role]
      assert.ok(VERDICTS.includes(verdict), `${action}.${role} 取值非法：${String(verdict)}`)
    }
  }
})

test('E18 反回退：reset_demo_data 双侧必须 DENY（客户端"生产可重置数据"是已修的严重缺陷）', () => {
  assert.equal(resolveVerdict('reset_demo_data', 'guardian'), 'DENY')
  assert.equal(resolveVerdict('reset_demo_data', 'child'), 'DENY')
})

test('fail-closed：未知角色 viewer 与未知动作一律 DENY，绝不默认放行', () => {
  for (const action of ALL_ACTIONS) {
    assert.equal(resolveVerdict(action, 'viewer'), 'DENY', `${action} 对 viewer 放行了`)
  }
  const unknown = 'no_such_action' as unknown as ActionType
  assert.equal(resolveVerdict(unknown, 'guardian'), 'DENY')
  assert.equal(resolveVerdict(unknown, 'child'), 'DENY')
})

test('不变式：孩子的判定永远不会比家长更宽（屏障三「只能收紧」的代数基础）', () => {
  for (const action of ALL_ACTIONS) {
    const guardian = PERMISSION_MATRIX[action].guardian
    const child = PERMISSION_MATRIX[action].child
    // 「孩子不会更宽」= 两者取更严的那个，就是孩子那个
    //（反例：若写成 `=== guardian`，则 child=DENY / guardian=ALLOW 的动作会假红）
    assert.equal(
      stricter(child, guardian),
      child,
      `${action}：child=${child} 比 guardian=${guardian} 更宽`
    )
  }
})

test('stricter 的代数性质：幂等 / ALLOW 是单位元 / DENY 吸收 / 交换 / 结合', () => {
  for (const a of VERDICTS) {
    assert.equal(stricter(a, a), a, `幂等性被破坏：${a}`)
    assert.equal(stricter(a, 'ALLOW'), a, `ALLOW 不是单位元：${a}`)
    assert.equal(stricter(a, 'DENY'), 'DENY', `DENY 未吸收：${a}`)
    for (const b of VERDICTS) {
      assert.equal(stricter(a, b), stricter(b, a), `交换律被破坏：${a}/${b}`)
      for (const c of VERDICTS) {
        assert.equal(
          stricter(stricter(a, b), c),
          stricter(a, stricter(b, c)),
          `结合律被破坏：${a}/${b}/${c}`
        )
      }
    }
  }
})

test('严苛度排序与 stricter 一致：DENY > REQUIRE_APPROVAL > ALLOW', () => {
  assert.equal(VERDICT_SEVERITY.DENY > VERDICT_SEVERITY.REQUIRE_APPROVAL, true)
  assert.equal(VERDICT_SEVERITY.REQUIRE_APPROVAL > VERDICT_SEVERITY.ALLOW, true)
  assert.equal(stricter('REQUIRE_APPROVAL', 'ALLOW'), 'REQUIRE_APPROVAL')
  assert.equal(stricter('DENY', 'REQUIRE_APPROVAL'), 'DENY')
})

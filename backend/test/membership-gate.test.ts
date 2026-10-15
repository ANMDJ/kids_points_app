/**
 * membership-gate.test.ts —— 屏障一（成员资格门）**判定内核**的纯函数用例
 *
 * ── 为什么内核要单独测（而不再靠 HTTP 用例顺带覆盖）────────────────────────
 *   ① HTTP 用例只能喂「有成员位 / 没有成员位 / 已移除」三种**代表性**输入，
 *      而内核的病往往在**边界**上：`null` 与"未知状态"这类分支最容易被写成
 *      "查不到就跳过"（本仓库的头号失败形态：默认放行）；
 *   ② 形状把关（`toMembership()`）必须能**离线穷举**裸 `Json` 的各种坏形状 ——
 *      那些形状在真库里出现一次就够了，不需要也不应该在 HTTP 层每样都造一遍。
 *   两者分工：本文件管「判定对不对」，`membership-http.test.ts` 管「装没装上、顺序对不对」。
 *
 * ── 判据来源 ─────────────────────────────────────────────────────────────
 *   `02` §3（屏障一的伪码）／§9.21（非成员 → 403 `MEMBER_NOT_FOUND`）
 *   ＋ D3b（`restrictions` 是裸 `Json`，形状由 `validateRestrictions()` 唯一裁定）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MemberRowShapeError,
  resolveMembership,
  toMembership,
  type MembershipLookupRow
} from '../src/membership/membership.gate'

/** 一条合法的成员位（各用例按需改字段）。 */
function row(overrides: Partial<MembershipLookupRow> = {}): MembershipLookupRow {
  return {
    childId: 'child-1',
    userId: 'u-dad',
    role: 'guardian',
    status: 'active',
    restrictions: {},
    ...overrides
  }
}

// ── 组 A：资格判定（fail-closed 两条）───────────────────────────────────────
describe('组 A：屏障一的判定（resolveMembership）', () => {
  it('查不到成员位（null）⇒ MEMBER_NOT_FOUND（**不是放行**）', () => {
    const v = resolveMembership(null)
    assert.equal(v.kind, 'DENY')
    assert.equal(v.kind === 'DENY' ? v.code : '', 'MEMBER_NOT_FOUND')
  })

  it('status = removed ⇒ MEMBER_REMOVED', () => {
    const v = resolveMembership(row({ status: 'removed' }))
    assert.equal(v.kind, 'DENY')
    assert.equal(v.kind === 'DENY' ? v.code : '', 'MEMBER_REMOVED')
  })

  it('★ 未知状态（如将来新增的 `banned`）也 ⇒ MEMBER_REMOVED（不认识 ≠ 有效资格）', () => {
    // 这条是刻意写成"穷举式的反面"：实现若写成 `status === 'removed' ? DENY : ALLOW`，
    // 将来 Prisma 枚举加一个值，那道门就会**对所有该状态的人放行** —— 静默、无提示。
    const v = resolveMembership(row({ status: 'banned' }))
    assert.equal(v.kind, 'DENY', '一个没见过的状态被当成了"有效成员位"')
    assert.equal(v.kind === 'DENY' ? v.code : '', 'MEMBER_REMOVED')
  })

  it('status = active ⇒ ALLOW，并把**原始行**原样带出（供形状把关继续处理）', () => {
    const source = row({ userId: 'u-kid', role: 'child' })
    const v = resolveMembership(source)
    assert.equal(v.kind, 'ALLOW')
    assert.equal(v.kind === 'ALLOW' ? v.row : undefined, source)
  })
})

// ── 组 B：形状把关（400 与 500 的分界 —— 数据坏了 ≠ 没权限）──────────────────
describe('组 B：形状把关（toMembership —— 裸 Json 的守卫）', () => {
  it('角色非法（如 viewer）⇒ MemberRowShapeError(INVALID_MEMBER_ROLE)', () => {
    try {
      toMembership(row({ role: 'viewer' }))
      assert.fail('非法的 MemberRole 被当成了可用成员位 —— 它会让矩阵查不到列，语义变得模糊')
    } catch (err) {
      assert.ok(err instanceof MemberRowShapeError)
      assert.equal(err.code, 'INVALID_MEMBER_ROLE')
      assert.ok(err.message.includes('viewer'), '错误必须点名收到的值')
    }
  })

  it('restrictions 键名拼错（D3b 最典型的静默失效）⇒ INVALID_MEMBER_RESTRICTIONS 且点名', () => {
    try {
      toMembership(row({ restrictions: { childCannotAddwis: true } }))
      assert.fail('拼错键的限制被接受了 —— 它会静默失效（限制看起来配了，其实没生效）')
    } catch (err) {
      assert.ok(err instanceof MemberRowShapeError)
      assert.equal(err.code, 'INVALID_MEMBER_RESTRICTIONS')
      assert.ok(
        err.message.includes('childCannotAddwis'),
        '错误必须点名那个多余的键，否则排查的人只知道"形状不对"'
      )
    }
  })

  it('restrictions 整体类型错（null / 数组 / 字符串）⇒ 一律 INVALID_MEMBER_RESTRICTIONS', () => {
    for (const bad of [null, [], '{}']) {
      try {
        toMembership(row({ restrictions: bad }))
        assert.fail(`restrictions=${JSON.stringify(bad)} 被接受了`)
      } catch (err) {
        assert.ok(err instanceof MemberRowShapeError, `restrictions=${JSON.stringify(bad)}`)
        assert.equal(err.code, 'INVALID_MEMBER_RESTRICTIONS')
      }
    }
  })

  it('对照：合法形状（含空 `{}`）⇒ 通过，且 restrictions 原样带出', () => {
    const restrictions = { childCannotAddWish: true, requireApprovalForBonusOver: 50 }
    const member = toMembership(row({ restrictions }))
    assert.deepEqual(member.restrictions, restrictions)
    assert.equal(member.role, 'guardian')
    assert.deepEqual(toMembership(row({ restrictions: {} })).restrictions, {})
  })
})

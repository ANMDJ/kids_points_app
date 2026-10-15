/**
 * member-restrictions.test.ts —— `ChildMember.restrictions` 形状守卫的**行为测试**
 *
 * 与 `scripts/check-restrictions.ts`（离线自检）的关系：那边是**阶段 D-b 的一次性自检脚本**，
 * 这边是**常设测试套件**（阶段 B1 引入框架后的第一份用例），将来 W1/W2 的用例都落在这里。
 * 两者都保留：自检脚本可在无框架环境直接跑，测试套件由 `npm run ci` 守着。
 *
 * 守的是 **D3b 要修的病**：裸 `Json` 的形状只写在注释里 → 拼错键 / 类型不对**没人拦**，
 * 限制会**静默失效**（比报错危险得多）。Prisma 表达不了 `Json` 内部形状，所以只能靠应用层守卫。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_RESTRICTIONS,
  RESTRICTION_KEYS,
  tightenVerdict,
  validateRestrictions,
  type ChildMemberRestrictions,
  type RestrictionKey
} from '../src/contracts/member-restrictions'
import {
  ALL_ACTIONS,
  VERDICT_SEVERITY,
  resolveVerdict
} from '../src/contracts/permission-matrix'

test('空形状 `{}` 合法（`@default("{}")` 的语义：不加限制是合法状态）', () => {
  assert.deepEqual(validateRestrictions(DEFAULT_RESTRICTIONS), [])
})

test('三键齐全的合法形状通过', () => {
  const errors = validateRestrictions({
    childCannotUndoCheckIn: true,
    childCannotAddWish: false,
    requireApprovalForBonusOver: 50
  })
  assert.deepEqual(errors, [])
})

/**
 * 坏值表用 `Record<RestrictionKey, unknown>` 声明 —— 这是**穷尽性检查**：
 * 往 `RESTRICTION_KEYS` 加键而忘了在这里补一行，`npm run typecheck:tests` 就红。
 * （与 `check-restrictions.ts` A3 同款技巧：让"漏测"变成编译错误，而不是靠人记得。）
 */
const BAD_VALUE_BY_KEY: Record<RestrictionKey, unknown> = {
  childCannotUndoCheckIn: 'yes', // 字符串不是布尔
  childCannotAddWish: 1, // 数字不是布尔
  requireApprovalForBonusOver: -1 // 负数越界（@Min(0)）
}

for (const key of RESTRICTION_KEYS) {
  test(`键 ${key}：注入坏值必须被拒，且错误**只**点名它自己`, () => {
    const errors = validateRestrictions({ [key]: BAD_VALUE_BY_KEY[key] })
    assert.ok(errors.length >= 1, `应当报错，实际错误数组为 ${JSON.stringify(errors)}`)
    for (const message of errors) {
      assert.match(message, new RegExp(`^${key}：`), `错误必须点名 ${key}，实际：${message}`)
    }
  })
}

test('拼错的键必须被拒（集合封闭）—— 否则限制悄悄失效，而没有任何别的东西会拦', () => {
  const errors = validateRestrictions({ childCannotAddwis: true })
  assert.equal(errors.length, 1, `期望恰好 1 条错误，实际：${JSON.stringify(errors)}`)
  assert.match(errors[0], /childCannotAddwis/)
})

test('非对象必须被拒，且错误里说明**实际收到了什么**（null / 数组 / 字符串 / 数字）', () => {
  const cases: Array<[unknown, string]> = [
    [null, 'null'],
    [[], '数组'],
    ['x', 'string'],
    [7, 'number']
  ]
  for (const [value, expected] of cases) {
    const errors = validateRestrictions(value)
    assert.equal(errors.length, 1, `${String(value)} 应当恰好报 1 条`)
    assert.match(errors[0], new RegExp(expected))
  }
})

test('阈值边界：0 合法；负数 / 小数 / 字符串数字 / 布尔都不合法', () => {
  assert.deepEqual(validateRestrictions({ requireApprovalForBonusOver: 0 }), [])
  for (const bad of [-1, 1.5, '50', true]) {
    const errors = validateRestrictions({ requireApprovalForBonusOver: bad })
    assert.ok(errors.length >= 1, `应当拒 ${JSON.stringify(bad)}`)
    assert.match(errors[0], /requireApprovalForBonusOver/)
  }
})

/* ══════════════════════════════════════════════════════════════════════════
 * 屏障三（成员级收紧）的**判定核** —— W1-B 新增
 *
 * 判据：`02` §3（最终判定 = min(矩阵判定, 成员级限制)，DENY > REQUIRE_APPROVAL > ALLOW）
 *      ＋ §9.22（限制**永远不能**把矩阵的 DENY 放宽）
 * ══════════════════════════════════════════════════════════════════════════ */

test('屏障三：`childCannotAddWish` 把孩子 add_wish 从"要审批"收紧成"不许"', () => {
  const matrix = resolveVerdict('add_wish', 'child')
  assert.equal(matrix, 'REQUIRE_APPROVAL', '前提变了：矩阵里孩子 add_wish 本来需要审批')
  assert.equal(
    tightenVerdict(matrix, { childCannotAddWish: true }, { action: 'add_wish', role: 'child' }),
    'DENY'
  )
  // 对照：不加这条限制 ⇒ 保持矩阵判定（证明上一条的差异确实来自限制）
  assert.equal(
    tightenVerdict(matrix, {}, { action: 'add_wish', role: 'child' }),
    'REQUIRE_APPROVAL'
  )
})

test('屏障三：`childCannot*` 只约束**孩子**（家长不受影响 —— 键名就是证据）', () => {
  const restrictions = { childCannotAddWish: true, childCannotUndoCheckIn: true }
  const guardianAddWish = resolveVerdict('add_wish', 'guardian')
  assert.equal(guardianAddWish, 'ALLOW')
  assert.equal(
    tightenVerdict(guardianAddWish, restrictions, { action: 'add_wish', role: 'guardian' }),
    'ALLOW',
    '家长的 ALLOW 被孩子的成员级限制收紧了 —— 那把 key 的语义搞反了'
  )
  assert.equal(
    tightenVerdict(
      resolveVerdict('undo_check_in', 'guardian'),
      restrictions,
      { action: 'undo_check_in', role: 'guardian' }
    ),
    'ALLOW'
  )
})

test('屏障三：`childCannotUndoCheckIn` 对当前矩阵不改变结果（矩阵已 DENY），但也不会放宽', () => {
  const matrix = resolveVerdict('undo_check_in', 'child')
  assert.equal(matrix, 'DENY', '前提变了：矩阵里孩子本来就不能撤销打卡')
  for (const value of [true, false]) {
    assert.equal(
      tightenVerdict(matrix, { childCannotUndoCheckIn: value }, {
        action: 'undo_check_in',
        role: 'child'
      }),
      'DENY',
      `childCannotUndoCheckIn=${String(value)} 改变了结果 —— 限制只能更严`
    )
  }
})

test('屏障三：`requireApprovalForBonusOver` —— 严格大于才收紧，且按**幅度**判定', () => {
  const restrictions = { requireApprovalForBonusOver: 50 }
  const matrix = resolveVerdict('request_points_bonus', 'child')
  assert.equal(matrix, 'ALLOW')

  const at = (amount: number | undefined): string =>
    tightenVerdict(matrix, restrictions, { action: 'request_points_bonus', role: 'child', amount })

  assert.equal(at(50), 'ALLOW', '"超过 N 分"是**严格**大于：恰好 50 不该被收紧')
  assert.equal(at(51), 'REQUIRE_APPROVAL')
  assert.equal(at(-51), 'REQUIRE_APPROVAL', '负数被跳过 = fail-open；02 §3 讲的是幅度（±50）')
  assert.equal(at(0), 'ALLOW')
  assert.equal(
    at(undefined),
    'ALLOW',
    '★ 金额未知时**不判**（而不是当成 0、也不是一律要审批）。' +
      '这是当前 HTTP 路径的真实状态：唯一调用方拿不到金额 —— 见 membership-http.test.ts 组 B 的同名用例'
  )
})

test('屏障三：不传限制（空对象）⇒ 与矩阵**逐条**相等（25 动作 × 2 角色）', () => {
  for (const action of ALL_ACTIONS) {
    for (const role of ['guardian', 'child'] as const) {
      assert.equal(
        tightenVerdict(resolveVerdict(action, role), {}, { action, role }),
        resolveVerdict(action, role),
        `${action}.${role}：没有成员级限制时判定必须与矩阵逐字相同`
      )
    }
  }
})

/**
 * §9.22 的**一般形式**：不是"挑几个动作试试"，而是穷举
 * 25 动作 × 2 角色 × 6 种限制 × 5 种金额，断言两件事：
 *   ① 收紧后的严苛度**永远 ≥** 矩阵判定（限制只能更严）；
 *   ② 矩阵为 `DENY` 时，结果**恒为** `DENY`（永不放宽）—— 这正是 §9.22 的那一条。
 * 外加"非平凡"守卫：至少要有组合**真的**被收紧了，否则整段可能是恒真。
 */
test('§9.22 方向性（穷举）：限制只能更严，矩阵 DENY 恒不被放宽', () => {
  const variants: ChildMemberRestrictions[] = [
    {},
    { childCannotUndoCheckIn: true },
    { childCannotAddWish: true },
    { requireApprovalForBonusOver: 0 },
    { requireApprovalForBonusOver: 50 },
    { childCannotUndoCheckIn: true, childCannotAddWish: true, requireApprovalForBonusOver: 0 }
  ]
  const amounts = [undefined, 0, 50, 51, -1000]

  let checked = 0
  let tightened = 0
  for (const action of ALL_ACTIONS) {
    for (const role of ['guardian', 'child'] as const) {
      const matrixVerdict = resolveVerdict(action, role)
      for (const restrictions of variants) {
        for (const amount of amounts) {
          const result = tightenVerdict(matrixVerdict, restrictions, { action, role, amount })
          checked += 1
          if (VERDICT_SEVERITY[result] < VERDICT_SEVERITY[matrixVerdict]) {
            assert.fail(
              `${action}.${role}（${JSON.stringify(restrictions)}, amount=${String(amount)}）：` +
                `限制把 ${matrixVerdict} 放宽成了 ${result} —— §9.22 说这永远不允许`
            )
          }
          if (matrixVerdict === 'DENY') {
            assert.equal(result, 'DENY', `${action}.${role}：矩阵的 DENY 被限制放宽了`)
          }
          if (VERDICT_SEVERITY[result] > VERDICT_SEVERITY[matrixVerdict]) tightened += 1
        }
      }
    }
  }

  assert.ok(checked >= 1500, `穷举组合数异常：${checked}`)
  assert.ok(
    tightened > 0,
    '没有任何组合被收紧 —— 这段"穷举"是恒真的，它证明不了方向性（也就抓不到把 stricter() 写丢）'
  )
})

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
  validateRestrictions,
  type RestrictionKey
} from '../src/contracts/member-restrictions'

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

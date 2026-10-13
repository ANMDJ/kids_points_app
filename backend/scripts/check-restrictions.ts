/**
 * check-restrictions.ts —— `ChildMember.restrictions` 形状守卫的离线自检（**不需要数据库**）
 *
 * 用法：npm run restrictions:check（已接进 `npm run ci`，第 9 步）
 *
 * 两部分（照 `scripts/check-templates.ts` 的既有范式 —— 后端没有 jest/vitest）：
 *   A. 校验**真实形态**：`@default("{}")`、三键齐全、每个键确实各有一条运行时约束
 *   B. **反向自测**：逐个注入坏形状，断言守卫**确实报错**，且错误**点名**出问题的那个键
 *
 * 为什么必须有 B：一个永远通过的检查等于没有检查 —— 这正是本项目 D13 的教训。
 * 这里守的是**裸 `Json`**（D3b）：守卫要是坏了，坏形状会一路写进库，
 * 而且**没有任何别的东西会拦**（Prisma 无法表达 `Json` 的内部形状）。
 *
 * ★ 与 `check-templates.ts` 的第 3 条对照：那里的 B 段只断言"报错了"，
 *   这里额外要求**错误点名那个键**（`childCannotAddwis 拼错` 与 `阈值越界` 必须能区分开），
 *   并加一组**差分对照**（B2）：每次只把一个键改坏 → 恰好 1 条错误、且就是那个键。
 */

import {
  DEFAULT_RESTRICTIONS,
  RESTRICTION_KEYS,
  validateRestrictions,
  type ChildMemberRestrictions,
  type RestrictionKey
} from '../src/contracts/member-restrictions'

let failures = 0

function report(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`)
}

// ── A. 真实形态校验 ─────────────────────────────────────────────
const emptyErrors = validateRestrictions(DEFAULT_RESTRICTIONS)
report(
  'A1. 空形状 `{}` 必须通过（`@default("{}")` 的语义 —— 不加限制是合法状态）',
  emptyErrors.length === 0,
  emptyErrors.join('\n      ')
)

const fullRestrictions: ChildMemberRestrictions = {
  childCannotUndoCheckIn: true,
  childCannotAddWish: false,
  requireApprovalForBonusOver: 50
}
const fullErrors = validateRestrictions(fullRestrictions)
report('A2. 三个键齐全的合法形状必须通过', fullErrors.length === 0, fullErrors.join('\n      '))

/**
 * A3. 键清单 ↔ 运行时约束**一一对应**：
 * 对每个键注入一个"错类型"的值，必须**报错、且点名那个键**。
 * 这条比 A2 重要 —— A2 只能证明"合法输入被放行"，A3 才能证明"类型确实在生效"。
 * `Record<RestrictionKey, unknown>` 是**穷尽性检查**：往 `RESTRICTION_KEYS` 加键而忘了在这里补一行，
 * 编译期（`npm run typecheck:tools`）就会红。
 */
const wrongValueFor: Record<RestrictionKey, unknown> = {
  childCannotUndoCheckIn: 'yes',
  childCannotAddWish: 1,
  requireApprovalForBonusOver: '50'
}
const unguarded = RESTRICTION_KEYS.filter((key) => {
  const errors = validateRestrictions({ [key]: wrongValueFor[key] })
  return !(errors.length > 0 && errors.some((e) => e.includes(key)))
})
report(
  `A3. ${RESTRICTION_KEYS.length} 个键各自都有运行时约束（注入错类型必须被拒且点名）`,
  unguarded.length === 0,
  unguarded.length
    ? `没被拦下 / 没点名：${unguarded.join(', ')}`
    : '每键都拦得住错类型，且错误点名了它自己'
)

// ── B. 反向自测：坏形状必须被拒（且错误必须点名）──────────────────
const cases: Array<{ name: string; bad: unknown; mustName?: string }> = [
  // 键名拼错 = D3b 最典型的静默失效（多了个键、原限制键却没给上）
  { name: '未知键（childCannotAddWish 拼成 childCannotAddwis）', bad: { childCannotAddwis: true }, mustName: 'childCannotAddwis' },
  { name: '合法键 + 一个多余键混在一起', bad: { childCannotUndoCheckIn: true, extraKey: 1 }, mustName: 'extraKey' },
  { name: '布尔键收到字符串 "yes"', bad: { childCannotUndoCheckIn: 'yes' }, mustName: 'childCannotUndoCheckIn' },
  { name: '布尔键收到数字 1', bad: { childCannotAddWish: 1 }, mustName: 'childCannotAddWish' },
  { name: '阈值收到字符串 "50"', bad: { requireApprovalForBonusOver: '50' }, mustName: 'requireApprovalForBonusOver' },
  { name: '阈值越界（-1）', bad: { requireApprovalForBonusOver: -1 }, mustName: 'requireApprovalForBonusOver' },
  { name: '阈值非整数（1.5）', bad: { requireApprovalForBonusOver: 1.5 }, mustName: 'requireApprovalForBonusOver' },
  // 整体不是对象（裸 Json 里什么都可能存）
  { name: '整体是 null', bad: null },
  { name: '整体是数组', bad: [] },
  { name: '整体是字符串 "{}"', bad: '{}' }
]

const notCaught = cases.filter((c) => {
  const errors = validateRestrictions(c.bad)
  if (errors.length === 0) return true
  const mustName = c.mustName
  return mustName !== undefined && !errors.some((e) => e.includes(mustName))
})
report(
  `B. 反向自测：${cases.length} 类坏形状必须被拒绝，且（键级错误）必须点名`,
  notCaught.length === 0,
  notCaught.length === 0
    ? `${cases.length} 类全部被拦下`
    : `未被拦下 / 没点名：${notCaught.map((c) => c.name).join(', ')}`
)

/**
 * B2. 差分对照：从 A2 的**合法形状**出发，每次只把一个键改坏 →
 * 必须报错，且**每条错误都点名那个键**（不许牵连别的键）。
 * 没有这一条，"报错"可能来自别的键（互相掩盖），"逐键点名"就无法成立。
 * ⚠️ 不要求"恰好 1 条"：一个坏值可以同时违反 `@IsInt()` 与 `@Min(0)`
 *    （实测：`'50'` 两条都违反）—— 要钉的是"错误都指向同一个键"，不是错误条数。
 */
const diffs = RESTRICTION_KEYS.map((key) => ({
  key,
  errors: validateRestrictions({ ...fullRestrictions, [key]: wrongValueFor[key] })
}))
const badDiffs = diffs.filter(
  (d) => !(d.errors.length > 0 && d.errors.every((e) => e.startsWith(`${d.key}：`)))
)
report(
  'B2. 差分对照：每次只改坏一个键 → 错误只点名那个键（不牵连别的键）',
  badDiffs.length === 0,
  badDiffs.length === 0
    ? `${RESTRICTION_KEYS.length} 个键各自独立可定位`
    : badDiffs
        .map((d) => `${d.key} → ${d.errors.length} 条：${d.errors.join(' | ') || '（无）'}`)
        .join('; ')
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `FAILED ${failures} 项`}`)
process.exitCode = failures === 0 ? 0 : 1

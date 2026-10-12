/**
 * check-templates.ts —— 模板库离线自检（**不需要数据库**）
 *
 * 用法：npm run templates:check
 *
 * 两部分：
 *   A. 校验真实模板数据（图标名 / 配色 / 分值 / slug / 关注点覆盖度）
 *   B. **反向自测**：故意注入一个坏模板，验证校验器**确实会报错**
 *
 * 为什么必须有 B：一个永远通过的检查等于没有检查 ——
 * 这正是本项目 D13 的教训（断言把缺陷编码成了正确行为）。
 * 校验器本身也需要被校验。
 */

import {
  RULE_TEMPLATES,
  validateTemplates,
  type RuleTemplateSeed
} from '../prisma/seed/templates.data'

let failures = 0

function report(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`)
}

// ── A. 真实数据校验 ─────────────────────────────────────────────
const errors = validateTemplates(RULE_TEMPLATES)
report(
  `A. 模板数据自检（${RULE_TEMPLATES.length} 条）`,
  errors.length === 0,
  errors.join('\n      ')
)

const penaltyCount = RULE_TEMPLATES.filter((t) => t.direction === 'penalty').length
const rewardCount = RULE_TEMPLATES.filter((t) => t.direction === 'reward').length
console.log(
  `      分布：reward ${rewardCount} 条 / penalty ${penaltyCount} 条` +
    `（penalty 的 points 恒为正，展示时取负 —— 修 A1 的根源）`
)

// ── B. 反向自测：坏数据必须被拒绝 ────────────────────────────────
const good = RULE_TEMPLATES[0]
const cases: Array<{ name: string; bad: RuleTemplateSeed }> = [
  {
    name: '不存在的图标名',
    bad: { ...good, icon: 'nonexistent-icon' as RuleTemplateSeed['icon'] }
  },
  { name: '分值越界（99 分）', bad: { ...good, points: 99 } },
  { name: '扣分模板分值超规范（penalty + 9 分）', bad: { ...good, direction: 'penalty', points: 9 } },
  { name: '配色不在色板中', bad: { ...good, color: '#123456' } },
  { name: '非法学段', bad: { ...good, ageBand: 'phd' as RuleTemplateSeed['ageBand'] } },
  {
    name: '非法关注点',
    // ★ 这里的 `as unknown as` 是**故意的**：本用例就是要注入一个类型系统之外的坏数据，
    //   验证校验器在**运行时**能否拦住它。原先写的是 `as RuleTemplateSeed['focusAreas']`
    //   （双重转换缺一层）—— 该文件此前不在任何 tsconfig 的 include 里，
    //   所以这个类型错误**从未被编译期发现**（见 06-w0-report.md §2 缺陷）。
    bad: { ...good, focusAreas: ['打游戏'] as unknown as RuleTemplateSeed['focusAreas'] }
  },
  { name: 'slug 非 kebab-case', bad: { ...good, slug: 'Bad_Slug' } }
]

const notCaught = cases.filter((c) => validateTemplates([c.bad]).length === 0)
report(
  'B. 反向自测：坏模板必须被拒绝',
  notCaught.length === 0,
  notCaught.length === 0
    ? `7 类坏数据全部被拦下`
    : `未被拦下：${notCaught.map((c) => c.name).join(', ')}`
)

// 覆盖度检查也必须能失败：把某个关注点的模板全部剔除
const withoutReading = RULE_TEMPLATES.filter((t) => !t.focusAreas.includes('阅读'))
const coverageCaught = validateTemplates(withoutReading).some((e) => e.includes('阅读'))
report(
  'B2. 反向自测：关注点空分组必须被拒绝',
  coverageCaught,
  coverageCaught ? '剔除「阅读」后校验器报出空分组' : '剔除「阅读」后校验器未报错'
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `FAILED ${failures} 项`}`)
process.exitCode = failures === 0 ? 0 : 1

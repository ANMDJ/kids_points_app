import type { AgeBand, RuleDirection } from '@prisma/client'

import {
  FOCUS_AREAS,
  isAgeBandName,
  isFocusAreaName,
  type AgeBandName,
  type FocusAreaName
} from '../contracts/onboarding'

/**
 * 首启引导的**纯规则**（W8-A，2026-10-27）—— 无 IO、无 Nest 依赖。
 *
 * 为什么单独一层：排序策略与去重规则是**业务判断**，必须能被单测直接钉住。
 * 若写进 service / repository，测试就得起 Nest 或连真库，规则本身反而看不清
 * （这是 W7-D `deletion.policy.ts` 的同一手法）。
 *
 * 本文件回答四个问题：
 *   ① 家长勾的关注点里，哪些是合法的、怎么去重且保持顺序；
 *   ② 模板卡片按什么顺序排（学段 → 关注点 → 自有权重 → slug）；
 *   ③ 采纳的 slug 怎么去重、为什么要拒绝空列表；
 *   ④ 一次 `complete` 提交里，学段 / 关注点缺省时沿用哪一份（中途退出再进入）。
 */

/** 仓储返回的模板行（**只含客户端需要的列**，不含 `id` / `createdAt` 等内部字段）。 */
export interface RuleTemplateRow {
  slug: string
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: RuleDirection
  icon: string
  color: string
  ageBand: AgeBand
  focusAreas: string[]
  sortWeight: number
}

/** 排序依据：家长在第③④步选了什么（都可以不选）。 */
export interface TemplateSortPreferences {
  ageBand: AgeBand | null
  focusAreas: readonly string[]
}

/**
 * 关注点清洗：**保序去重** + 只保留 6 个合法值。
 *
 * 为什么「静默丢弃非法值」而不是抛错：DTO 已经用 `@IsIn(each)` 把非法值拦在
 * 管道层（400）。能走到这里还出现非法值只可能是**库里的旧数据**
 * （例如关注点改名后残留的旧标签）—— 那时把整次读取打红没有意义，
 * 保留其余合法值、丢掉不认识的那个才是可解释的行为。
 * ★ 但 DTO 是真正的前门：客户端直接提交非法值会 400，不会走到这里。
 */
export function normalizeFocusAreas(input: readonly string[]): FocusAreaName[] {
  const seen = new Set<string>()
  const result: FocusAreaName[] = []
  for (const raw of input) {
    const value = raw.trim()
    if (!isFocusAreaName(value) || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * 模板排序（`04` §2 第⑤步：**排序而非硬过滤**）。
 *
 * 比较链（每一级都必须稳定，否则同一份输入两次请求可能给出不同顺序，
 * 客户端在「翻看卡片」时会看到位置跳动）：
 *   1. 学段**精确相等**优先；其它学段排后面（不是隐藏 —— `preschool` 只有 1 条，
 *      硬过滤会让幼儿园家长看到空白列表）；
 *   2. 关注的关注点命中数降序；
 *   3. 模板自有 `sortWeight` 降序（内容侧表达「这条更常用」）；
 *   4. `slug` 升序 —— 最后一级必须**确定**，否则第 3 级并列时顺序由库返回顺序决定。
 *
 * ★ 未选学段 / 未选关注点时：1、2 两级全部并列，等价于「按 sortWeight 排」。
 *   这正是 `04` §2「③④ 可跳过」的语义 —— 跳过不影响能不能用。
 */
export function rankTemplates(
  templates: readonly RuleTemplateRow[],
  preferences: TemplateSortPreferences
): RuleTemplateRow[] {
  const wanted = new Set(preferences.focusAreas)
  const score = (template: RuleTemplateRow): number =>
    template.focusAreas.reduce((count, area) => (wanted.has(area) ? count + 1 : count), 0)

  return [...templates].sort((a, b) => {
    const ageA = preferences.ageBand !== null && a.ageBand === preferences.ageBand ? 1 : 0
    const ageB = preferences.ageBand !== null && b.ageBand === preferences.ageBand ? 1 : 0
    if (ageA !== ageB) return ageB - ageA

    const scoreA = score(a)
    const scoreB = score(b)
    if (scoreA !== scoreB) return scoreB - scoreA

    if (a.sortWeight !== b.sortWeight) return b.sortWeight - a.sortWeight
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  })
}

/**
 * 采纳的 slug：去重保序。
 *
 * 保持客户端点击顺序：「采纳 3 条」生成规则的先后顺序就是家长看到的顺序，
 * 首页习惯列表（按创建时间排）因此与引导里一致。
 */
export function normalizeTemplateSlugs(input: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of input) {
    const value = raw.trim()
    if (value.length === 0 || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * 家长 PIN 的格式规则 **现在住在 `common/pin-format.ts`**（W8-C 搬家）。
 *
 * 这里保留 re-export 的唯一理由是**调用点不动**：`dto/complete-onboarding.dto.ts`
 * 与 `test/onboarding-policy.test.ts` 一直是从本文件取 `PIN_PATTERN` /
 * `isPinFormatValid` 的，搬家的目的是让 `auth/`（切家长模式）与 `onboarding/`
 * 共用同一份正则，而不是为了让每个 import 都改一遍。
 *
 * ★ 新增代码请直接 `import { isPinFormatValid } from '../common/pin-format'`。
 */
export { PIN_PATTERN, isPinFormatValid } from '../common/pin-format'


/**
 * 合并「本次提交」与「已落库的中间状态」（`04` §6 用例 4.12）。
 *
 * 语义：
 *   · `undefined` ⇒ 沿用库里已保存的值（中途退出再进入，partial 不回滚）；
 *   · `null`（只对学段）⇒ **显式清空** —— 「我改主意不选学段」必须能表达，
 *     否则用户无法从 primary_low 退回「未选择」。
 *
 * 注意 `focusAreas` 没有 `null`：空数组就是「一个都不选」，与「没有传」
 * （沿用旧值）不同。这两种意图必须能区分，故用 `undefined` vs `[]`。
 */
export function mergeProfile(
  submittedAgeBand: AgeBandName | null | undefined,
  currentAgeBand: AgeBand | null,
  submittedFocusAreas: readonly string[] | undefined,
  currentFocusAreas: readonly string[]
): { ageBand: AgeBand | null; focusAreas: string[] } {
  const ageBand =
    submittedAgeBand === undefined
      ? currentAgeBand
      : submittedAgeBand === null
        ? null
        : submittedAgeBand

  const focusAreas =
    submittedFocusAreas === undefined
      ? [...currentFocusAreas]
      : normalizeFocusAreas(submittedFocusAreas)

  return { ageBand, focusAreas }
}

/** 仅用于测试断言「6 个关注点常量没被随手改小」。 */
export const FOCUS_AREA_COUNT = FOCUS_AREAS.length

/** 模板学段是否合法 —— 供种子自检与真库用例复用。 */
export function isKnownAgeBand(value: string): value is AgeBandName {
  return isAgeBandName(value)
}

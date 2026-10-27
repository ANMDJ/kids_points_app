/**
 * 首启引导的**跨层契约常量**（W8-A，2026-10-27 / `04` §2、§4）。
 *
 * ── 为什么这些值要单独一个文件 ───────────────────────────────────────────────
 *   它们同时被四处消费：
 *     ① DTO 校验（`@IsIn`）—— 请求体只接受这 4 个学段 / 6 个关注点；
 *     ② 仓储层排序（`onboarding.policy.ts`）—— 决定模板卡片怎么排；
 *     ③ 种子数据的离线自检（`prisma/seed/templates.data.ts`）—— 模板里的
 *        `focusAreas` 必须逐字落在这 6 个值里（否则「按关注点排序」永远对不上）；
 *     ④ 测试 —— 用同一份常量断言「模板覆盖 6 个关注点」。
 *
 *   若把取值写进 DTO 的装饰器里，另外三处只能手抄；而本项目反复踩过的
 *   「两份手抄必然漂移」（D9 / `02` §2）在这里的后果是**引导选不到模板**。
 *
 * ── ⚠️ 与 schema 的关系 ─────────────────────────────────────────────────────
 *   `AgeBand` 是 Prisma 枚举（`prisma/schema.prisma`），`FocusArea` **不是**枚举：
 *   它落在 `Child.focusAreas String[]` / `RuleTemplate.focusAreas String[]`，
 *   数据库无法约束取值 —— 所以运行时校验必须在这里做，且**只能做一次**。
 *   新增关注点 = 改本文件 + 补模板内容 + 重跑 `npm run templates:check`。
 */

/** 与 `prisma/schema.prisma` 的 `enum AgeBand` 逐字一致（`honesty:probe` 外的人工对账）。 */
export const AGE_BANDS = ['preschool', 'primary_low', 'primary_high', 'junior_high'] as const

export type AgeBandName = (typeof AGE_BANDS)[number]

/**
 * 6 个关注点（`04` §2 第④步）。
 *
 * ★ 这些是**展示与排序用**的中文标签，不是 slug —— 模板数据里存的就是它们，
 *   客户端的多选器也从这里取。改名等于改数据：现有 `Child.focusAreas` 里
 *   的旧值会变成「未知关注点」，故只允许**追加**，不允许静默改名。
 */
export const FOCUS_AREAS = [
  '作业专注',
  '生活习惯',
  '阅读',
  '运动',
  '情绪管理',
  '家务'
] as const

export type FocusAreaName = (typeof FOCUS_AREAS)[number]

const AGE_BAND_SET: ReadonlySet<string> = new Set(AGE_BANDS)
const FOCUS_AREA_SET: ReadonlySet<string> = new Set(FOCUS_AREAS)

export function isAgeBandName(value: string): value is AgeBandName {
  return AGE_BAND_SET.has(value)
}

export function isFocusAreaName(value: string): value is FocusAreaName {
  return FOCUS_AREA_SET.has(value)
}

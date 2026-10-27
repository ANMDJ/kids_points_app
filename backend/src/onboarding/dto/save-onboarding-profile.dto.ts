import { ArrayMaxSize, IsArray, IsIn, IsOptional, ValidateIf } from 'class-validator'

import { AGE_BANDS, FOCUS_AREAS, type AgeBandName, type FocusAreaName } from '../../contracts/onboarding'

/**
 * `PATCH /onboarding/profile` 的请求体（W8-A，2026-10-27 / `04` §2 第③④步）。
 *
 * ── 为什么要这个端点 ────────────────────────────────────────────────────────
 *   「中途退出再进入要接着走」（`04` §6 4.12）。若只在 `complete` 时落库，
 *   家长在④选完 6 个关注点、退出、再进来，会发现关注点全没了 ——
 *   引导退化成「必须一口气走完」，这正是规格明令禁止的体验。
 *
 * ── 为什么两个字段都可省略 ──────────────────────────────────────────────────
 *   `undefined` = 「这一步没动，沿用库里已有的值」（service 用 `mergeProfile` 合并）。
 *   ③ 学段允许 `null` = 「显式清空」：从 `primary_low` 退回「未选择」必须能表达，
 *   否则 S6「可跳过」就成了单向门。
 *   ④ 关注点用 `[]` 表示「一个都不选」，与「没传」不同 —— 两种意图必须可分。
 *
 * ── 集合封闭 ────────────────────────────────────────────────────────────────
 *   `forbidNonWhitelisted` 保证传 `childId` / `onboardedAt` 一律 400：
 *   「对哪个孩子」来自会话（`x-kp-child-id`），「是否完成」由 `complete` 决定，
 *   草稿端点没有第三个字段的位置。
 */
export class SaveOnboardingProfileDto {
  @IsOptional()
  @IsIn([...AGE_BANDS])
  ageBand?: AgeBandName | null

  // ★ 不用 `@IsOptional()`：它会连 `null` 一起放过，而 `null` 在这里没有语义
  //   （「一个都不选」是 `[]`）。用 `ValidateIf` 只跳过 `undefined`，让 `null` 被
  //   `@IsArray()` 拦成 400 —— 少一个需要 service 单独防御的分支。
  @ValidateIf((_dto, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(FOCUS_AREAS.length)
  @IsIn([...FOCUS_AREAS], { each: true })
  focusAreas?: FocusAreaName[]
}

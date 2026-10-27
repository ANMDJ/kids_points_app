/**
 * 首启引导端口的**测试替身**（W8-A，2026-10-27）。
 *
 * ── 为什么用替身而不是真库 ──────────────────────────────────────────────────
 *   `test/onboarding-http.test.ts` 要证明的是**路由上的事实**：四道屏障、集合封闭、
 *   错误码、`childId` / `operator` 来自会话。这些都与「行怎么落库」无关。
 *   真库的证据在 `test-db/onboarding-db.dbtest.ts`（那里连模板下架的 TOCTOU 都能造）。
 *
 * ── 为什么模板要造 4 条、覆盖 3 个学段 ─────────────────────────────────────
 *   排序的四级比较链（学段 → 关注点命中数 → sortWeight → slug）需要**同分**才能
 *   显出第 3、4 级。只造 1–2 条会让 `rankTemplates` 的 bug 在 HTTP 层不可见。
 *   ★ 这里的 slug 用 `fake-` 前缀：不与真实模板库（`prisma/seed`）撞名，
 *     排查时一眼能看出「这是替身返回的」。
 */
import { ConflictException, NotFoundException } from '@nestjs/common'
import type { AgeBand, RuleDirection } from '@prisma/client'

import type {
  CompleteOnboardingInput,
  CompleteOnboardingResult,
  OnboardingPort,
  OnboardingSnapshot,
  OnboardingState,
  SaveProfileInput
} from '../../src/onboarding/onboarding.repository'
import type { RuleTemplateRow } from '../../src/onboarding/onboarding.policy'

export const FAKE_CHILD_ID = 'child-1'

/** 4 条模板：故意让「学段」与「sortWeight」冲突，排序必须听学段的。 */
export function fakeTemplates(): RuleTemplateRow[] {
  const row = (
    slug: string,
    ageBand: AgeBand,
    focusAreas: string[],
    sortWeight: number,
    direction: RuleDirection = 'reward'
  ): RuleTemplateRow => ({
    slug,
    title: `约定 ${slug}`,
    condition: `条件 ${slug}`,
    dailyLimit: 1,
    points: direction === 'penalty' ? 2 : 3,
    direction,
    icon: 'star',
    color: '#7bb0e8',
    ageBand,
    focusAreas,
    sortWeight
  })

  return [
    row('fake-alpha', 'primary_high', ['作业专注'], 100),
    row('fake-beta', 'primary_low', ['阅读', '生活习惯'], 90),
    row('fake-gamma', 'preschool', ['情绪管理'], 80, 'penalty'),
    row('fake-delta', 'primary_low', ['阅读'], 95)
  ]
}

export interface OnboardingCall {
  method: 'readSnapshot' | 'readState' | 'saveProfile' | 'complete'
  input?: unknown
}

export interface OnboardingFake extends OnboardingPort {
  calls: OnboardingCall[]
  state: OnboardingState
  templates: RuleTemplateRow[]
}

export interface MakeOnboardingFakeOptions {
  onboarded?: boolean
  ageBand?: AgeBand | null
  focusAreas?: string[]
  /** 让 `complete` 把这批 slug 当成「不在模板库里」（模拟下架 / TOCTOU）。 */
  unavailableSlugs?: string[]
}

/**
 * 内存端口。
 *
 * ★ `readState` 与 `saveProfile` / `complete` 共用同一个 `state` 对象 ——
 *   这样「PATCH 草稿 → GET 回读」这类跨请求断言才有意义（各自返回新对象就会假绿）。
 */
export function makeOnboardingFake(
  options: MakeOnboardingFakeOptions = {}
): OnboardingFake {
  const state: OnboardingState = {
    childId: FAKE_CHILD_ID,
    onboarded: options.onboarded ?? false,
    onboardedAt: options.onboarded === true ? '2026-10-27T00:00:00.000Z' : null,
    ageBand: options.ageBand ?? null,
    focusAreas: [...(options.focusAreas ?? [])]
  }
  const templates = fakeTemplates()
  const calls: OnboardingCall[] = []
  const unavailable = new Set(options.unavailableSlugs ?? [])

  const snapshot = (): OnboardingSnapshot => ({
    state: { ...state, focusAreas: [...state.focusAreas] },
    templates: templates.map((template) => ({ ...template, focusAreas: [...template.focusAreas] }))
  })

  return {
    calls,
    state,
    templates,

    async readSnapshot(childId: string): Promise<OnboardingSnapshot> {
      calls.push({ method: 'readSnapshot', input: { childId } })
      return snapshot()
    },

    async readState(childId: string): Promise<OnboardingState> {
      calls.push({ method: 'readState', input: { childId } })
      return { ...state, focusAreas: [...state.focusAreas] }
    },

    async saveProfile(input: SaveProfileInput): Promise<OnboardingState> {
      calls.push({ method: 'saveProfile', input })
      if (state.onboarded) {
        throw new ConflictException({
          code: 'ONBOARDING_ALREADY_COMPLETED',
          message: '这个孩子已经完成首次引导，不能重复提交。'
        })
      }
      state.ageBand = input.ageBand
      state.focusAreas = [...input.focusAreas]
      return { ...state, focusAreas: [...state.focusAreas] }
    },

    async complete(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> {
      calls.push({ method: 'complete', input })
      if (state.onboarded) {
        throw new ConflictException({
          code: 'ONBOARDING_ALREADY_COMPLETED',
          message: '这个孩子已经完成首次引导，不能重复提交。'
        })
      }
      const missing = input.templateSlugs.filter((slug) => unavailable.has(slug))
      if (missing.length > 0) {
        throw new NotFoundException({
          code: 'ONBOARDING_TEMPLATE_NOT_AVAILABLE',
          message: `这些约定已不在模板库里：${missing.join('、')}。`
        })
      }

      const onboardedAt = '2026-10-27T12:00:00.000Z'
      state.onboarded = true
      state.onboardedAt = onboardedAt
      state.ageBand = input.ageBand
      state.focusAreas = [...input.focusAreas]

      return {
        childId: state.childId,
        onboardedAt,
        rules: input.templateSlugs.map((slug) => {
          const template = templates.find((item) => item.slug === slug)
          if (template === undefined) {
            throw new NotFoundException({
              code: 'ONBOARDING_TEMPLATE_NOT_AVAILABLE',
              message: `模板 ${slug} 不在模板库里。`
            })
          }
          return {
            ruleId: `rule-${slug}`,
            title: template.title,
            condition: template.condition,
            dailyLimit: template.dailyLimit,
            points: template.points,
            direction: template.direction,
            icon: template.icon,
            color: template.color,
            currentVersion: 1
          }
        })
      }
    }
  }
}

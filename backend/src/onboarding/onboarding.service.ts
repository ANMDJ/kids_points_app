import { BadRequestException, Inject, Injectable } from '@nestjs/common'

import type { CompleteOnboardingDto } from './dto/complete-onboarding.dto'
import type { SaveOnboardingProfileDto } from './dto/save-onboarding-profile.dto'
import { hashPin } from '../common/pin-hash'
import {
  isPinFormatValid,
  mergeProfile,
  normalizeFocusAreas,
  normalizeTemplateSlugs,
  rankTemplates,
  type RuleTemplateRow
} from './onboarding.policy'
import {
  ONBOARDING_REPOSITORY,
  type CompleteOnboardingResult,
  type OnboardingOperator,
  type OnboardingPort,
  type OnboardingState
} from './onboarding.repository'

/** `GET /onboarding` 的回包：状态 + **已排序**的模板卡片。 */
export interface OnboardingView extends OnboardingState {
  templates: RuleTemplateRow[]
}

/**
 * 首启引导的业务层（W8-A，2026-10-27 / `04` §2–§6）。
 *
 * ── 这一层负责的三件事 ──────────────────────────────────────────────────────
 *   ① **把「排序」和「合并」这两个纯规则接进流程**（规则本身在 `onboarding.policy.ts`）；
 *   ② 做**不信客户端的**判定：至少选 1 条模板、slug 去重、PIN 格式；
 *   ③ 把 PIN 明文在这里转成哈希 —— 让「明文」的生命周期止于本函数，
 *      仓储层签名里只有 `parentPinHash`，**没有**任何能接收明文的参数。
 *
 * ── 为什么「至少 1 条」不在 DTO 里用 `@ArrayMinSize(1)` ─────────────────────
 *   那样只会得到 `VALIDATION_FAILED`（一串英文的 class-validator 消息），
 *   而这条恰恰是**产品规则**：`04` §6 4.2 要求「无法继续，提示至少选一条」。
 *   产品规则要带产品文案与可识别的 code，所以放在 service。
 *   ★ 上限仍然由 DTO 拦（那是「防滥用」，不是产品语义）。
 *
 * ── 幂等性 ──────────────────────────────────────────────────────────────────
 *   `saveProfile` 幂等（相同值不写库、不写审计）；
 *   `complete` **不幂等**且**故意**如此：第二次调用 409，不会悄悄再建一套规则。
 *   重复采纳会重复生成规则 —— 那是账本级的脏数据，不能靠「反正看起来一样」放过。
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(ONBOARDING_REPOSITORY) private readonly repository: OnboardingPort
  ) {}

  async read(childId: string): Promise<OnboardingView> {
    const { state, templates } = await this.repository.readSnapshot(childId)
    return {
      ...state,
      templates: rankTemplates(templates, {
        ageBand: state.ageBand,
        focusAreas: state.focusAreas
      })
    }
  }

  async saveProfile(
    childId: string,
    dto: SaveOnboardingProfileDto,
    operator: OnboardingOperator
  ): Promise<OnboardingState> {
    // `undefined` 交给仓储层以外的合并逻辑处理 —— 这里必须先读现状，
    // 否则「只改关注点、不动学段」会被写成 `ageBand: null`（把家长选的学段清掉）。
    const current = await this.repository.readState(childId)
    const merged = mergeProfile(dto.ageBand, current.ageBand, dto.focusAreas, current.focusAreas)

    return await this.repository.saveProfile({
      childId,
      ageBand: merged.ageBand,
      focusAreas: merged.focusAreas,
      operator
    })
  }

  async complete(
    childId: string,
    dto: CompleteOnboardingDto,
    operator: OnboardingOperator
  ): Promise<CompleteOnboardingResult> {
    const slugs = normalizeTemplateSlugs(dto.templateSlugs)
    if (slugs.length === 0) {
      throw new BadRequestException({
        code: 'ONBOARDING_NO_TEMPLATE',
        message: '至少选一条约定才能完成引导（可以之后再在规则页里增删）。'
      })
    }
    if (slugs.length > 18) {
      throw new BadRequestException({
        code: 'ONBOARDING_TOO_MANY_TEMPLATES',
        message: `一次最多采纳 18 条约定（本次 ${slugs.length} 条）。`
      })
    }

    // 第⑥步：双端客户端自 2026-11-03 起必填（`43` §8 D7），但服务端仍允许省略 ——
    // 那是**旧版本装机客户端**的路径，不是新客户端可以走的；只要传了就必须是 4–6 位数字。
    // ★ 这里再判一次（DTO 已判）：service 是唯一业务判据，将来非 HTTP 入口也走这里。
    if (dto.parentPin !== undefined && !isPinFormatValid(dto.parentPin)) {
      throw new BadRequestException({
        code: 'ONBOARDING_PIN_INVALID',
        message: '家长 PIN 必须是 4–6 位数字；不想设置就省略这个字段。'
      })
    }

    const current = await this.repository.readState(childId)
    const merged = mergeProfile(dto.ageBand, current.ageBand, dto.focusAreas, current.focusAreas)

    const parentPinHash = dto.parentPin === undefined ? null : await hashPin(dto.parentPin)

    return await this.repository.complete({
      childId,
      ageBand: merged.ageBand,
      focusAreas: normalizeFocusAreas(merged.focusAreas),
      templateSlugs: slugs,
      parentPinHash,
      operator
    })
  }
}

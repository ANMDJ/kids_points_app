import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf
} from 'class-validator'

import { AGE_BANDS, FOCUS_AREAS, type AgeBandName } from '../../contracts/onboarding'
import { PIN_PATTERN } from '../onboarding.policy'

/**
 * `POST /onboarding/complete` 的请求体（W8-A，2026-10-27 / `04` §2 第⑤–⑦步）。
 *
 * ── 三个字段各自回答什么 ────────────────────────────────────────────────────
 *   `templateSlugs`：家长勾了哪些约定 —— **必填**，且由 service 判「至少 1 条」
 *                    （`04` §6 4.2：一条都不选不能继续）。
 *   `ageBand` / `focusAreas`：第③④步的**最终值**。可省略 ⇒ 沿用 `PATCH profile`
 *                    已经存下的草稿（家长走回上一步改了关注点，再下一步提交，
 *                    不该要求客户端重传 —— 但重传也不会错，语义是「以本次为准」）。
 *   `parentPin`：第⑥步的 4–6 位数字。**双端引导自 2026-11-03 起必填**
 *                （`43` §8 D7：网站码注册只发 5 分钟家长窗口，窗口到期后回落
 *                `child`，那时既进不了家长模式、也没有权限补设 PIN）。
 *                服务端仍接受省略，只为**旧版本装机客户端**保留 —— 新客户端漏传是 bug。
 *
 * ── 为什么 `parentPin` 允许省略但不允许空串 ─────────────────────────────────
 *   `""` 不是「跳过」，是「输入框被清空但客户端仍提交了字段」—— 那是客户端 bug。
 *   `@Matches(/^\d{4,6}$/)` 对空串直接 400，`undefined` 才是唯一的跳过写法。
 *   这样「省略 = 跳过」在类型层与校验层都只有一个入口。
 *
 * ── 为什么没有 `childId` ────────────────────────────────────────────────────
 *   同 `PATCH /child`：孩子来自会话。若允许请求体带 `childId`，
 *   在「会话孩子 A、请求体孩子 B」时我们必须二选一相信 —— 不必要的歧义。
 */
export class CompleteOnboardingDto {
  @IsOptional()
  @IsIn([...AGE_BANDS])
  ageBand?: AgeBandName | null

  @ValidateIf((_dto, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(FOCUS_AREAS.length)
  @IsIn([...FOCUS_AREAS], { each: true })
  focusAreas?: string[]

  // 必填：缺字段 / `null` / 非数组都在管道层 400。
  // 上限 18 = 模板库当前条数（`prisma/seed/templates.data.ts`），
  // 防止「一次采纳 500 条」把事务拖成批量导入 —— 那会绕过规则页的单条编辑语义。
  @IsArray()
  @ArrayMaxSize(18)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  templateSlugs!: string[]

  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @Matches(PIN_PATTERN, {
    message: '家长 PIN 必须是 4–6 位数字；不想设置就省略这个字段（不是传空串）。'
  })
  parentPin?: string
}

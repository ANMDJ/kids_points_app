import { IsString, Matches } from 'class-validator'

import { DATE_CODE_PATTERN } from '../date-verification-code'

/**
 * `POST /auth/date-code` 的请求体（W9-C，2026-10-29）。
 *
 * ── 为什么只有一个 `code`，且**没有** userId / deviceId ────────────────────────
 *   本端点只回答"这个码对不对"，不签发任何东西、不读任何用户数据
 *   （见 `date-verification-code.ts` 文件头的「它是什么、不是什么」）。
 *   一旦 body 里出现 userId，它立刻就变成了"用可推导的码登录"——那条路是
 *   明确不走的（那需要一个随机、一次性、有 TTL 的凭据）。
 *
 * ── 形状在这里拦，而不是在 service 里 ─────────────────────────────────────────
 *   非 6 位数字 ⇒ **400**（请求形状错，不是"猜错了"）。把它放到 service 里判，
 *   客户端会收到 200 `{ valid:false }`，于是"少打一位"与"算错了"变成同一句话。
 */
export class VerifyDateCodeDto {
  @IsString()
  @Matches(DATE_CODE_PATTERN, {
    message: '验证码是 6 位数字：MMDD + 两位星期（周一 01 … 周日 07），例如周四的 10 月 29 日是 102904。'
  })
  code!: string
}

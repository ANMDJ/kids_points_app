import { IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `POST /auth/child-session` 的请求体（W9-A，2026-10-29 / `40` §8.4）。
 *
 * ── 为什么 childId 在 body 而不是头里 ────────────────────────────────────────
 *   这是**选择**动作（"我要在这台设备上进入这个孩子"），与后续请求的
 *   `x-kp-child-id`（会话已存在之后的上下文）不是同一种语义。
 *   技能上两者都能用头表达，但把"选择"混进"上下文"会让人以为
 *   换一个 `x-kp-child-id` 就能换孩子 —— 那条路必须 401（`SESSION_NOT_FOUND`），
 *   正是本端点存在的理由。
 *
 * ★ 这里**不**校验"你是否有权进入这个孩子"：那要读成员位，属适配器事务
 *   （读与写必须在同一临界区，否则中间被移除成员位就会写出一行越权会话）。
 */
export class ChildSessionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  childId!: string
}

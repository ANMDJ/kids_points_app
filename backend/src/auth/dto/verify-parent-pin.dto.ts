import { IsString, MaxLength } from 'class-validator'

/**
 * `POST /auth/parent-pin/verify` 的请求体（2026-11-04，本机 PIN 锁）。
 *
 * ── 为什么只有一个字段，且与 `EnterParentModeDto` 一模一样 ────────────────
 *   它要回答的问题只有一句「这个 PIN 对不对」。「谁在问」由会话决定
 *   （`DeviceSession.userId`），「问哪个孩子」由 `x-kp-child-id` 决定 ——
 *   请求体里再带 userId / childId 就是第二、第三份「我是谁」。
 *
 * ── 为什么**不**复用 `EnterParentModeDto` ──────────────────────────────────
 *   两个 DTO 的字段一样，但**语义不同**，而语义会变：
 *   · `POST /auth/parent-mode` = 提权（写 `activeRole` + `expiresAt`）；
 *   · 这里 = 只回答对错（不写会话行）。
 *   共用同一个类会让后人以为「改一个等于改两个」，也会让 OpenAPI / 用例的
 *   意图变模糊。真正的校验规则（4–6 位数字、格式错不计次）仍然只有
 *   `service` 里那一处，DTO 只做防滥用（`@MaxLength`）。
 */
export class VerifyParentPinDto {
  @IsString()
  @MaxLength(32)
  pin!: string
}

import { IsString, MaxLength } from 'class-validator'

/**
 * `POST /auth/parent-mode` 的请求体（W8-C，2026-10-27 / `02` §7）。
 *
 * ── 只有一个字段：家长 PIN ──────────────────────────────────────────────────
 *   「切到谁」由**服务端会话**决定（`DeviceSession.userId`），「切到哪个孩子」
 *   由 `x-kp-child-id` 选择器决定 —— 请求体里再带 `childId` / `userId` / `role`
 *   就是第二、第三份「我是谁」，不一致时只能二选一相信（同 `PATCH /child` 的理由）。
 *
 * ── ★ 为什么这里**不**用 `@Matches(PIN_PATTERN)`（与引导的 DTO 不同）──────────
 *   引导里 PIN 是**用户新设**的（键盘只有数字，格式错只可能是客户端 bug），
 *   所以在管道层 400 是准确的。
 *   这里 PIN 是**家长在手忙脚乱时敲进去的猜测**：3 位、7 位、混进一个字母都是
 *   正常的人类输入，而它们**不该**被算成一次"猜错"（见
 *   `auth/parent-mode.policy.ts` 的口径 ②）。要区分"格式错（不计次）"与
 *   "值错（计一次）"，就必须让请求**走到 service**，由 `isPinFormatValid()`
 *   给出带产品文案的 `PARENT_PIN_FORMAT_INVALID`。
 *   管道层只留 `@MaxLength` —— 那是**防滥用**（拒绝 10KB 的"PIN"），不是产品语义。
 */
export class EnterParentModeDto {
  @IsString()
  @MaxLength(32)
  pin!: string
}

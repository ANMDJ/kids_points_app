import { IsString, MaxLength, MinLength } from 'class-validator'

/**
 * `POST /records/check-in` 的请求体（W4-D）。
 *
 * ★ 只有 `habitId`：孩子、操作人、来源、时间**都不是**客户端说了算的。
 *   `childId` 来自会话（`x-kp-child-id`），操作人来自设备会话 —— 让客户端传
 *   `childId` 等于把"给谁加分"交给请求体，这是最糟的一类越权。
 *   形状封闭由全局 `ValidationPipe({ whitelist, forbidNonWhitelisted })` 保证：
 *   多传 `childId` / `points` 一律 400，而不是静默忽略后按自己的意思加分。
 */
export class CheckInHabitDto {
  /** 要打卡的习惯 id；必须属于会话里的孩子（跨孩子按 404 回答）。 */
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  habitId!: string
}

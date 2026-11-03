import { IsInt, Max, Min } from 'class-validator'

import { KID_MODE_MAX_MINUTES, KID_MODE_MIN_MINUTES } from '../kid-mode.policy'

/**
 * `POST /auth/kid-mode` 的请求体（W14，2026-11-03 / `51-kid-mode-window.md`）。
 *
 * ── 只有一个字段：这次给孩子用多少分钟 ──────────────────────────────────────
 *   「给谁用」由服务端会话决定（这台设备在这个孩子上的 `DeviceSession`），
 *   「开多久」才是家长的选择。请求体里再带 childId / role 就是第二份身份
 *   （同 `EnterParentModeDto` 的理由）。
 *
 * ── 为什么上限在 DTO 里也卡一次 ──────────────────────────────────────────────
 *   `@Max(30)` 让 31 分钟在**管道层**就 400（客户端能拿到"请求不合法"，
 *   而不是走到业务层再被夹成 30 —— 静默夹会让家长以为设了 45 分钟）。
 *   服务端内核 `clampKidModeMinutes()` 仍然再夹一次，守住非 HTTP 调用方。
 *   ★ `@Min` / `@Max` 引用**同一份**常量（`kid-mode.policy.ts`），不写裸数字：
 *     三端副本由 `tools/kid-mode-check.mjs` 逐字比对。
 */
export class EnterKidModeDto {
  @IsInt()
  @Min(KID_MODE_MIN_MINUTES)
  @Max(KID_MODE_MAX_MINUTES)
  durationMinutes!: number
}

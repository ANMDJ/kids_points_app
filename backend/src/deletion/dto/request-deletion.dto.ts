import { IsBoolean, IsDefined } from 'class-validator'

/**
 * `POST /family-deletion` 的请求体（W7-D，2026-10-27）。
 *
 * ── 为什么只有一个布尔值 ────────────────────────────────────────────────────
 *   删除对象**只能**是会话里的孩子（`x-kp-child-id` 解析出的 `kpChildId`），
 *   冷却期由服务端政策决定，`scheduledFor` 由服务端算 —— 请求体里没有第二个
 *   字段的位置。`forbidNonWhitelisted` 会把 `childId` / `days` / `userId` 一律 400。
 *
 * ── 为什么必须是显式的 `true` ───────────────────────────────────────────────
 *   「没带字段就默认确认」是删除流程里最危险的一种宽松：任何重放旧 body、
 *   任何忘了带参数的调用都会变成一次不可逆的操作。因此：
 *     · 缺字段 ⇒ 管道层 400（`@IsDefined()`）；
 *     · `false` ⇒ 业务层 400 `FAMILY_DELETION_NOT_CONFIRMED`。
 *   这与 W7-A 的 `accepted: true` 同一口径：**确认必须是布尔真值**。
 */
export class RequestDeletionDto {
  @IsDefined()
  @IsBoolean()
  confirmed!: boolean
}

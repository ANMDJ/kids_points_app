import { IsIn, IsInt, Max, Min } from 'class-validator'

import { MAX_INVITE_TTL_DAYS, MAX_INVITE_USES } from '../invite-code'
import type { InviteRole } from '../invites.types'

/**
 * `POST /invites` 的请求体（W5-G，2026-10-22）。
 *
 * ── 集合封闭 ────────────────────────────────────────────────────────────────
 *   只有三个键：`role` / `maxUses` / `expiresInDays`。
 *   `childId` 来自会话（身份），`code` 由服务端生成（凭据），
 *   `usedCount` / `createdAt` 由库给 —— 客户端多传任何一个都是 400，
 *   与 `POST /point-rules` 拒绝 `direction`、`POST /records/adjust` 拒绝
 *   `balanceAfter` 同一口径：**客户端不许决定自己拿到什么凭据**。
 *
 * ── 为什么 `role` 只能用字面量枚举，不用 `@IsEnum(MemberRole)` ──────────────
 *   `MemberRole` 里还有 `viewer`，而矩阵对 viewer 没有列（一律 DENY，D6）。
 *   发一张 viewer 邀请码 = 邀请一个**加入后什么都做不了**的人 ——
 *   这种码发出去只会变成一张「看起来很客气、实际是死路」的票。
 *   所以这里显式只收 `child | guardian`；要放开 viewer，必须先在矩阵里加列。
 */
export class CreateInviteDto {
  @IsIn(['child', 'guardian'])
  role!: InviteRole

  /** 这个码最多能被几个人用（1..10）。 */
  @IsInt()
  @Min(1)
  @Max(MAX_INVITE_USES)
  maxUses!: number

  /** 有效期（天，1..30）。绝对时刻由服务端算 —— 客户端不能指定 `expiresAt`。 */
  @IsInt()
  @Min(1)
  @Max(MAX_INVITE_TTL_DAYS)
  expiresInDays!: number
}

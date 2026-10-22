import { IsIn } from 'class-validator'

import type { MutableMemberRole } from '../members.types'

/**
 * `PATCH /members/:id` 的请求体（W5-H，2026-10-22）。
 *
 * ── 集合封闭 ────────────────────────────────────────────────────────────────
 *   只有一个键：`role`。
 *   `childId` 来自会话（身份），`memberId` 来自路径，`status` / `removedAt`
 *   由库给 —— 客户端多传任何一个都是 400，与 `POST /invites` 拒绝 `childId`
 *   同一口径：**客户端不许自己声明自己的上下文**。
 *
 * ── 为什么不是 `@IsEnum(MemberRole)` ────────────────────────────────────────
 *   `MemberRole` 里还有 `viewer`。把某人降成 viewer = 让他看得见、什么都做不了
 *   （矩阵对 viewer 一律 DENY，06 §3 D6）。这不是"降权"，是制造一个死账号；
 *   要支持 viewer，必须先给矩阵加列。
 */
export class UpdateMemberRoleDto {
  @IsIn(['child', 'guardian'])
  role!: MutableMemberRole
}

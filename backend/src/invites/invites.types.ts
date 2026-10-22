/**
 * 邀请码的**线格式**与**端口行**（W5-G，2026-10-22）
 *
 * ── 服务端只下发事实，不下发结论 ────────────────────────────────────────────
 *   `GET /invites` 给 `usedCount` / `maxUses` / `expiresAt` / `revoked`，
 *   **不**给 `expired` 或 `status: 'usable'`。与 `GET /trash` 同一条纪律
 *   （W5-F ②）：一个结论只算一次，算在界面那一侧；服务端再算一遍就等于
 *   两份「什么叫过期」的判据，而它们迟早会不一致。
 */
import type { MemberRole } from '@prisma/client'

/** 能被邀请的角色。`viewer` **不在**其中 —— 见 `CreateInviteDto` 与 02 §2 D6。 */
export type InviteRole = 'child' | 'guardian'

/** 端口行（仓储读出来的形状）。 */
export interface InviteRow {
  id: string
  childId: string
  code: string
  role: InviteRole
  maxUses: number
  usedCount: number
  expiresAt: Date
  revoked: boolean
  createdAt: Date
}

/** `POST /invites` 的回包 / `GET /invites` 的条目（时间一律 ISO 串）。 */
export interface InviteCodeDto {
  id: string
  code: string
  role: InviteRole
  maxUses: number
  usedCount: number
  expiresAt: string
  revoked: boolean
  createdAt: string
}

/** `GET /invites` 的回包。 */
export interface InviteListResponse {
  items: InviteCodeDto[]
}

/** `POST /invites/:id/revoke` 的回包 —— 与请求**验明正身**（同 `{kind,id}` 的手法）。 */
export interface InviteRevokeResponse {
  id: string
  revoked: true
}

/**
 * `POST /invites/accept` 的回包。
 *
 * 客户端据此知道三件事：**进了哪个孩子**、**是什么角色**、**本设备会话到什么时候**。
 * 这里刻意**不**回 `memberId` / `inviteId`：它们对用户没有意义，
 * 而出现在线格式里就会有人开始依赖它们（第二个事实源）。
 */
export interface InviteAcceptResponse {
  childId: string
  role: InviteRole
  sessionExpiresAt: string
}

/** 加入成功后落库的成员位角色类型（与 `MemberRole` 对齐，避免在适配器里裸写字符串）。 */
export type InviteMemberRole = Extract<MemberRole, 'child' | 'guardian'>

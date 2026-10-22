/**
 * 回收站的**线格式类型**（W5-F，2026-10-21）。
 *
 * ── 90 天保留期为什么不在这里 ─────────────────────────────────────────────
 *   「还能恢复几天」是由 `deletedAt` 派生的**纯函数**，双端各有一份已测试的实现
 *   （`lib/models/trash.dart` 的 `isTrashExpired` / `kids_points_mp/src/data/trash.ts`）。
 *   服务端再算一次 `expiresAt` 会引入第二个 90 天常量 —— 一旦有一边改了，界面与
 *   接口就会给出两个互相矛盾的答案。这里只下发**事实**（删除时刻），判定留给客户端。
 *
 *   服务端也**不**自动清理过期条目：到期不等于必须删（docs/design/08 §3.5），
 *   彻底删除永远是用户的显式动作（`DELETE /trash/:kind/:id`）。
 */

/** 回收站里允许出现的三类配置 —— 线值与审计前缀同名。 */
export const TRASH_KINDS = ['point_rule', 'wish', 'habit'] as const

export type TrashKind = (typeof TRASH_KINDS)[number]

/** 仓储层的一行（`deletedAt` 是 Date，出服务层时才转 ISO 串）。 */
export interface TrashItemRow {
  kind: TrashKind
  id: string
  title: string
  deletedAt: Date
}

/** `GET /trash` 的响应项。 */
export interface TrashItemDto {
  kind: TrashKind
  id: string
  title: string
  /** ISO-8601；客户端据此算「还能恢复几天」与是否过期。 */
  deletedAt: string
}

/** `GET /trash` 的响应体（没有分页：回收站是低频、小集合）。 */
export interface TrashListResponse {
  items: TrashItemDto[]
}

/** `POST /trash/:kind/:id/restore` 与 `DELETE /trash/:kind/:id` 的响应。 */
export interface TrashMutationResponse {
  kind: TrashKind
  id: string
}

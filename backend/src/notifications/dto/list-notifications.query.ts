import { Type } from 'class-transformer'
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

/**
 * `GET /notifications` 的查询参数（W5-L，2026-10-23）。
 *
 * ── 为什么没有 `recipientUserId` ──────────────────────────────────────────
 *   收件人**恒为会话 actor**。一旦接受 query 参数，改一个字符串就能读别人的
 *   通知（审批结论、家庭动态），而屏障二只判「你能不能看这个孩子的通知」——
 *   它管不了「你看的是不是你那一条」。与 `GET /approvals/mine` 同一条纪律：
 *   收口条件来自会话，query 里根本没有这个字段。
 *
 * ── 为什么 `limit` 有上界 ─────────────────────────────────────────────────
 *   不限制上限的 `?limit=1000000` 会把整张通知表读进内存（公开可触发的性能事故）。
 *   100 是当前上界：消息面板一次最多 100 条，客户端滚动加载更多。
 */
export class ListNotificationsQueryDto {
  /** 1–100，默认 20（默认值由 controller 落，DTO 保持「没传就是没传」）。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number

  /**
   * 键集游标：把上一页响应里的 `nextCursor` **原样**回传。
   *
   * 这里只做形状校验；语义解析在 service。格式错 ⇒ 400
   * `INVALID_NOTIFICATION_CURSOR`，**绝不**静默退回第一页（那会让「加载更多」
   * 无限重复同一页）。
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string
}

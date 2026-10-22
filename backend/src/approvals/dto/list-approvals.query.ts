import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'

import { APPROVAL_STATUS_FILTERS, type ApprovalStatusFilter } from '../approvals.repository'

/**
 * `GET /approvals` 的查询参数（W5-D，家长收件箱）。
 *
 * ── 默认是 `pending` ────────────────────────────────────────────────────────
 *   这个端点的主场景是「有没有需要我处理的」。默认给 `all` 会让列表一打开
 *   就被历史终态淹没，家长要自己翻到待处理的几条。
 *   「已处理」视图由客户端显式传 `status=approved|rejected|...`。
 *
 * ── `limit` 上界 100（比 `/records` 的 200 小）─────────────────────────────
 *   收件箱一行比流水一行重（要解析 payload 生成摘要），且正常家庭同时待处理
 *   的申请是个位数。上界只是挡「?limit=1000000」这类公开可触发的内存事故。
 *
 * ── 未知键一律 400 ──────────────────────────────────────────────────────────
 *   全局 `ValidationPipe({ whitelist, forbidNonWhitelisted })` 已保证 ——
 *   与 `ListRecordsQueryDto` 同一口径（形状 = 集合封闭）。
 */
export class ListApprovalsQueryDto {
  /** 省略 ⇒ `pending`；`all` ⇒ 不筛（历史全览）。 */
  @IsOptional()
  @IsIn(APPROVAL_STATUS_FILTERS)
  status?: ApprovalStatusFilter

  /** 1–100，默认 20（默认值由 service 落，DTO 保持「没传就是没传」）。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number

  /**
   * 键集游标：把上一页响应里的 `nextCursor` **原样**回传。
   *
   * ★ 这里只做形状校验（非空字符串 / 长度上界）；语义解析在 service
   *   （`decodeApprovalCursor`）。格式错 ⇒ 400 `INVALID_APPROVAL_CURSOR`。
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string
}

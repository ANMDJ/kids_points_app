import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator'

import type { RecordCategory } from '@prisma/client'

const RECORD_CATEGORIES = ['praise', 'exchange', 'adjust'] as const

/**
 * `GET /records` 的查询参数（W4-A）。
 *
 * ── 为什么 `limit` 也校验上界 ───────────────────────────────────────────────
 *   不限制上限的 `?limit=1000000` 会把整本账读进内存：这是一个**公开可触发**的
 *   性能事故，不需要任何越权。200 是本阶段的上界（记录页一次最多 200 条，
 *   客户端滚动加载更多）。
 *
 * ── 为什么未知键一律 400 ────────────────────────────────────────────────────
 *   全局 `ValidationPipe({ whitelist, forbidNonWhitelisted })` 已保证；
 *   这条与 `member-restrictions.ts`（D3b）同一口径：形状 = 集合封闭。
 */
export class ListRecordsQueryDto {
  /** 省略 = 全部（记录页「全部」标签）。 */
  @IsOptional()
  @IsIn(RECORD_CATEGORIES)
  category?: RecordCategory

  /** 1–200，默认 50（默认值由 controller 落，DTO 保持「没传就是没传」）。 */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number
}

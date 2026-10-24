import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import {
  PUSH_RETRY_RETENTION_STATUSES,
  type DeleteSettledPushRetryInput,
  type PushRetryRetentionPort
} from './push-retry.retention'

/**
 * 保留清理端口的 **Prisma 适配器**（W6-D，2026-10-24）。
 *
 * ── 为什么手写 SQL 而不是 `deleteMany` ─────────────────────────────────────
 *   `deleteMany` 不支持 `limit`。没有上限的 `DELETE` 在积压多时会长时间持锁、
 *   一次撑出巨大的 WAL，而且**不能中途退出**。这里用「子查询选 id + 外层按 id 删」：
 *     `WHERE id IN (SELECT id ... ORDER BY updatedAt LIMIT n)`
 *   Postgres 先取 n 个候选 id（走 `(status, updatedAt)` 索引），再按主键删，
 *   锁范围可控、可重复调用。
 *
 * ── 为什么状态要再过一次运行期校验 ──────────────────────────────────────────
 *   TypeScript 的联合类型在运行时不存在。若将来有人用 `as` 或用 JS 调用，
 *   传进 `'pending'` 就等于「删掉还没发出去的行」。这里用白名单挡住 ——
 *   宁可抛错让 worker 记 error，也不在 SQL 里相信调用方的类型。
 */
@Injectable()
export class PrismaPushRetryRetention implements PushRetryRetentionPort {
  constructor(private readonly prisma: PrismaService) {}

  async deleteSettled(input: DeleteSettledPushRetryInput): Promise<number> {
    if (!PUSH_RETRY_RETENTION_STATUSES.includes(input.status)) {
      throw new Error(
        `拒绝按状态 "${String(input.status)}" 清理推送队列：只允许终态 ${PUSH_RETRY_RETENTION_STATUSES.join(' / ')}`
      )
    }
    const limit = Math.max(1, Math.floor(input.limit))
    return this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM "PushRetryJob"
      WHERE "id" IN (
        SELECT "id"
        FROM "PushRetryJob"
        WHERE "status" = ${input.status}::"PushRetryStatus"
          AND "updatedAt" < ${input.before}
        ORDER BY "updatedAt" ASC
        LIMIT ${limit}
      )
    `)
  }
}

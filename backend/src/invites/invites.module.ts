import { Module } from '@nestjs/common'

/**
 * 邀请码（docs/design/02 §8）
 *
 * ★ 并发安全：不能用「先查后改」——
 *   校验剩余次数 → 插入成员 → 次数 +1 若分步执行，**并发下会超发**。
 *   必须用**单条条件 UPDATE** 原子占位：
 *
 *     UPDATE "InviteCode"
 *        SET "usedCount" = "usedCount" + 1, "usedByUserId" = $1, "usedAt" = now()
 *      WHERE code = $2 AND "usedCount" < "maxUses"
 *        AND "expiresAt" > now() AND revoked = false
 *      RETURNING id
 *     -- 返回 0 行 → 409 INVITE_CODE_UNAVAILABLE
 *
 *   数据库行锁保证至多 maxUses 个请求拿到 RETURNING 行。
 *   比「先查后改」或分布式锁都更简单可靠。
 *
 * ⚠ 与 02 §8 示例的差异：示例 SQL 用了 snake_case 列名（`used_count`），
 *   而 prisma/schema.prisma **未使用 @map**，故列名是 camelCase 且必须带引号。
 *   —— 见 docs/design/06-w0-report.md §3「待确认决策 D5」。
 *
 * ⚠ W0 状态：**签名占位**。验收用例见 02 §9.6（并发 10 请求 / maxUses=3 → 恰好 3 成功）。
 */
@Module({})
export class InvitesModule {}

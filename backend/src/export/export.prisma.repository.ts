import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'
import type {
  ExportHabitRow,
  ExportLimits,
  ExportMemberRow,
  ExportPort,
  ExportRuleRow,
  ExportWishRow,
  FamilyExportSnapshot
} from './export.repository'

/**
 * 家庭数据导出的 **Prisma 适配器**（W7-C，2026-10-27）—— `ExportPort` 的真实现。
 *
 * ── 三条口径，写下来免得后来者“优化”掉 ──────────────────────────────────────
 *   ① **一个事务读全份**：导出的价值在于「这是一份同时刻的快照」。分成十几次
 *      独立查询时，家长拿到的文件可能出现「规则版本已 +1、流水还是旧版」的
 *      自相矛盾组合，对账时无法解释。
 *   ② **不按 `status` 过滤**（见端口文件头）：回收站里的项也要出现，否则
 *      流水里的 `ruleId` / `habitId` / `wishId` 会指向文件里不存在的行。
 *   ③ **只选需要的列**：`User.openId`、`pinHash`、`ipHash`、`idempotencyKey`
 *      一律不选（数据最小化）。`select` 是白名单，新增敏感列不会自动漏出去。
 *
 * ── 截断 ────────────────────────────────────────────────────────────────────
 *   三张大表先 `count()` 再 `take(limit)`：`count` 让文件能诚实写出
 *   「共 N 条，本文件含 M 条」。小集合取 `limit + 1` 条来判定是否截断，
 *   不额外计数（它们正常只有几十行；真到 2000 行时，条数本身也不再重要）。
 *
 * ── 真库证据 ────────────────────────────────────────────────────────────────
 *   离线用例只能证明「键与形状」（`test/export-wiring.test.ts`）；
 *   「接了库真的导得对」由真库用例覆盖（`test-db/export-db.dbtest.ts`）。
 */
@Injectable()
export class PrismaExportRepository implements ExportPort {
  constructor(private readonly prisma: PrismaService) {}

  async collect(childId: string, limits: ExportLimits): Promise<FamilyExportSnapshot | null> {
    // ★ `findFirst({ id, status })` 而不是 `findUnique({ id })`：已软删的孩子
    //   不是「正常但没数据」，而是「这个档案已经不在」（与 ReadPort 同一条）。
    const child = await this.prisma.child.findFirst({
      where: { id: childId, status: 'active' },
      select: {
        id: true,
        name: true,
        pointsBalance: true,
        ageBand: true,
        focusAreas: true,
        onboardedAt: true,
        createdAt: true
      }
    })
    if (child === null) return null

    const smallTake = limits.small + 1
    const [
      memberRows,
      ruleRows,
      habitRows,
      wishRows,
      recordRows,
      approvalRows,
      consentRows,
      auditRows,
      recordTotal,
      approvalTotal,
      auditLogTotal
    ] = await this.prisma.$transaction([
      this.prisma.childMember.findMany({
        where: { childId },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        take: smallTake,
        select: {
          userId: true,
          role: true,
          status: true,
          joinedAt: true,
          removedAt: true,
          user: { select: { displayName: true } }
        }
      }),
      this.prisma.pointRule.findMany({
        where: { childId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: smallTake,
        select: {
          id: true,
          title: true,
          condition: true,
          dailyLimit: true,
          points: true,
          direction: true,
          icon: true,
          color: true,
          currentVersion: true,
          status: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
          // 版本**永久保留**（02 §5.6）：导出必须包含整条变更史，
          // 否则「当时为什么是 +1」在文件里解释不了。
          versions: {
            orderBy: { version: 'asc' },
            select: {
              version: true,
              title: true,
              condition: true,
              dailyLimit: true,
              points: true,
              direction: true,
              changeNote: true,
              changedByUserId: true,
              changedAt: true
            }
          }
        }
      }),
      this.prisma.habit.findMany({
        where: { childId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: smallTake,
        select: {
          id: true,
          sourceRuleId: true,
          title: true,
          points: true,
          condition: true,
          dailyLimit: true,
          icon: true,
          color: true,
          status: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      this.prisma.wish.findMany({
        where: { childId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: smallTake,
        select: {
          id: true,
          title: true,
          cost: true,
          emoji: true,
          coverStyle: true,
          redeemed: true,
          redeemedAt: true,
          status: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      // 账本按时间**正序**导出：家长要按滚动求和核对 `balanceAfter`（I2），
      // 倒序会让人从最后一笔往前减，极易算错。
      this.prisma.pointRecord.findMany({
        where: { childId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limits.records,
        select: {
          id: true,
          titleSnapshot: true,
          conditionSnapshot: true,
          dailyLimitSnapshot: true,
          costSnapshot: true,
          pointsDelta: true,
          category: true,
          source: true,
          note: true,
          operatorUserId: true,
          operatorRole: true,
          balanceAfter: true,
          ruleId: true,
          ruleVersion: true,
          habitId: true,
          wishId: true,
          reversesRecordId: true,
          reversedAt: true,
          createdAt: true
        }
      }),
      this.prisma.approvalRequest.findMany({
        where: { childId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limits.approvals,
        select: {
          id: true,
          requesterUserId: true,
          requesterRole: true,
          actionType: true,
          payload: true,
          status: true,
          autoReason: true,
          decidedByUserId: true,
          decidedAt: true,
          decisionNote: true,
          expiresAt: true,
          executedRecordId: true,
          createdAt: true,
          updatedAt: true
        }
      }),
      this.prisma.guardianConsent.findMany({
        where: { childId },
        orderBy: [{ grantedAt: 'asc' }],
        take: smallTake,
        select: {
          consentVersion: true,
          status: true,
          grantedAt: true,
          withdrawnAt: true,
          grantedByUserId: true
        }
      }),
      this.prisma.auditLog.findMany({
        where: { childId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limits.auditLogs,
        select: {
          actorUserId: true,
          actorRole: true,
          action: true,
          targetType: true,
          targetId: true,
          before: true,
          after: true,
          createdAt: true
        }
      }),
      this.prisma.pointRecord.count({ where: { childId } }),
      this.prisma.approvalRequest.count({ where: { childId } }),
      this.prisma.auditLog.count({ where: { childId } })
    ])

    const truncatedSmall: string[] = []

    const members: ExportMemberRow[] = cap(memberRows, limits.small, 'members', truncatedSmall).map(
      (row) => ({
        userId: row.userId,
        displayName: row.user.displayName,
        role: row.role,
        status: row.status,
        joinedAt: row.joinedAt,
        removedAt: row.removedAt
      })
    )
    const rules: ExportRuleRow[] = cap(ruleRows, limits.small, 'rules', truncatedSmall)
    const habits: ExportHabitRow[] = cap(habitRows, limits.small, 'habits', truncatedSmall)
    const wishes: ExportWishRow[] = cap(wishRows, limits.small, 'wishes', truncatedSmall)

    return {
      child,
      members,
      rules,
      habits,
      wishes,
      records: recordRows,
      approvals: approvalRows.map((row) => ({ ...row, actionType: row.actionType as string })),
      consents: cap(consentRows, limits.small, 'consents', truncatedSmall),
      auditLogs: auditRows,
      totals: { records: recordTotal, approvals: approvalTotal, auditLogs: auditLogTotal },
      truncatedSmall
    }
  }
}

/**
 * 小集合的截断：多取一条用来判定「是真的正好 N 条，还是还有更多」。
 * 只比 `length === limit` 会把「恰好 N 条」误报成截断。
 */
function cap<T>(rows: T[], limit: number, name: string, truncated: string[]): T[] {
  if (rows.length <= limit) return rows
  truncated.push(name)
  return rows.slice(0, limit)
}


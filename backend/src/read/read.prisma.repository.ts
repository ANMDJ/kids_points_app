import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'
import type {
  HomeSnapshotRow,
  ListRecordsInput,
  ReadPort,
  RecordPageRow,
  RecordRow
} from './read.repository'

/**
 * 只读端口的 **Prisma 适配器**（W4-A，2026-10-18）—— `ReadPort` 的真实现。
 *
 * 这一层只回答「**怎么把行读出来**」，不回答：
 *   · 谁能读（三道屏障在 HTTP 层）；
 *   · 文案怎么拼（`subtitle` 由客户端按 `source + createdAt + note` 派生 —— 03 A4/E19）；
 *   · 负数怎么表示（规则库里的 `points` 恒为正，带符号转换在 service 的 mapper）。
 *
 * ── 三个口径，写下来免得后来者“优化”掉 ──────────────────────────────────────
 *   ① **只读 `active`**：习惯 / 规则 / 心愿的软删项进回收站，不属于「今天的习惯」。
 *      回收站自己的读端点是后续工作，不能靠给本端点加 `includeDeleted` 混在一起。
 *   ② **冲正要从统计里扣掉**：`goodHabitCount` 数的是**未被冲正**的表扬流水。
 *      只按 `category='praise'` 数，会让「撤销打卡」后战绩仍 +1（与客户端
 *      `checkedCountToday()` 的口径直接矛盾 —— 见 `habit.dart` 的四条排除）。
 *   ③ **流水按 `(createdAt desc, id desc)`**：同一毫秒的两条记录在真库里确实存在
 *      （账本端口会做严格递增修正，但历史数据仍可能同值）。只按时间排序时，
 *      分页边界可能重复或漏行；`id` 是稳定次序的兜底。
 *
 * ── 真库证据 ────────────────────────────────────────────────────────────────
 *   离线用例（`test/read-wiring.test.ts`）只能证明「把哪个键交给了 Prisma」；
 *   「接了库真的读得对」由 `test-db/read-db.dbtest.ts` 证明（写入故意带冲正 / 软删 /
 *   扣分规则，再从 HTTP 读回）。
 */
@Injectable()
export class PrismaReadRepository implements ReadPort {
  constructor(private readonly prisma: PrismaService) {}

  async loadHome(childId: string): Promise<HomeSnapshotRow | null> {
    // ★ 用 `findFirst({ id, status })` 而不是 `findUnique({ id })`：
    //   软删的孩子不能被当成「正常但没数据」返回 —— 那是两种完全不同的答复。
    const child = await this.prisma.child.findFirst({
      where: { id: childId, status: 'active' },
      select: { id: true, name: true, pointsBalance: true }
    })
    if (child === null) return null

    // 一个事务里读五份数据：这是**一份**快照，不是五次独立查询。
    // （隔离级别仍是 Postgres 默认的 read committed —— 这里不承诺跨表线性一致，
    //   但至少不会读到「习惯已更新、规则还是旧的」这种由连接池切换造成的撕裂。）
    const [habits, rules, wishes, goodHabitCount, rewardCount] =
      await this.prisma.$transaction([
        this.prisma.habit.findMany({
          where: { childId, status: 'active' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            title: true,
            points: true,
            condition: true,
            dailyLimit: true,
            icon: true,
            color: true,
            sourceRuleId: true
          }
        }),
        this.prisma.pointRule.findMany({
          where: { childId, status: 'active' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            title: true,
            condition: true,
            dailyLimit: true,
            points: true,
            direction: true,
            icon: true,
            color: true,
            currentVersion: true
          }
        }),
        this.prisma.wish.findMany({
          where: { childId, status: 'active' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            title: true,
            cost: true,
            emoji: true,
            coverStyle: true,
            redeemed: true
          }
        }),
        // 见文件头 ②：`reversedBy: { none: {} }` 排除已被冲正的表扬流水。
        // `source != correction` 是第二道保险（冲正行正常是 adjust，但数据不应靠这一点）。
        this.prisma.pointRecord.count({
          where: {
            childId,
            category: 'praise',
            source: { not: 'correction' },
            reversedBy: { none: {} }
          }
        }),
        // 兑换次数 = 已兑换的心愿数（A5：只有兑换能递增它）。
        this.prisma.wish.count({ where: { childId, redeemed: true } })
      ])

    return {
      child,
      goodHabitCount,
      rewardCount,
      habits: habits.map((row) => ({
        id: row.id,
        title: row.title,
        points: row.points,
        condition: row.condition,
        dailyLimit: row.dailyLimit,
        icon: row.icon,
        color: row.color,
        ruleId: row.sourceRuleId
      })),
      rules,
      wishes
    }
  }

  async listRecords(input: ListRecordsInput): Promise<RecordPageRow | null> {
    // ★ 先确认孩子仍 active —— 与 `loadHome` 同一道兜底。
    //   `PointRecord` 没有 `status`，它按 childId 只增不改；因此「孩子已软删」
    //   无法从流水本身看出来，必须回到 `Child` 行问一次。
    const child = await this.prisma.child.findFirst({
      where: { id: input.childId, status: 'active' },
      select: { id: true }
    })
    if (child === null) return null

    // 多取一条判定 `hasMore`：本页正好满 ≠ 还有下一页（可能恰好读完）。
    const rows = await this.prisma.pointRecord.findMany({
      where: {
        childId: input.childId,
        ...(input.category === undefined ? {} : { category: input.category }),
        // 键集翻页：排序是 (createdAt desc, id desc)，因此「下一页」是
        // 时间更早，或同一毫秒但 id 更小。两条件缺一不可 ——
        // 只比时间会把同一毫秒的剩余行全部漏掉。
        ...(input.before === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.before.createdAt } },
                { createdAt: input.before.createdAt, id: { lt: input.before.id } }
              ]
            })
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        titleSnapshot: true,
        pointsDelta: true,
        category: true,
        source: true,
        operatorRole: true,
        note: true,
        habitId: true,
        ruleId: true,
        ruleVersion: true,
        wishId: true,
        reversesRecordId: true,
        reversedAt: true,
        balanceAfter: true,
        createdAt: true
      }
    })

    const hasMore = rows.length > input.limit
    return { rows: hasMore ? rows.slice(0, input.limit) : rows, hasMore }
  }
}

/** 导出给用例做形状断言（`RecordRow` 的字段改动会在这里立刻变成类型错误）。 */
export type { RecordRow }

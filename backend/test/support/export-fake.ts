/**
 * 家庭数据导出的**测试替身**（W7-C，2026-10-27）。
 *
 * ── 为什么放在 support 而不是各文件里各写一份 ────────────────────────────────
 *   `export-http.test.ts` 关心「HTTP 上长什么样」，`export-wiring.test.ts`
 *   关心「交给 Prisma 的键」与「纯函数映射」。两者用的是**同一份**快照形状 ——
 *   各自手抄一份时，字段一旦增删，只有一边会红，另一边会悄悄少覆盖一个字段。
 *
 * ── 这份快照刻意“每段都非空”────────────────────────────────────────────────
 *   空数组能让任何映射函数看起来都对。因此九段全部有行，且：
 *     · 规则带 **2 个版本**（只导当前版 = 丢掉变更史）；
 *     · 流水 **正序** 且 `balanceAfter` 逐笔可滚动核对（I2）；
 *     · 审批带 `payload.costSnapshot`（02 §4.3 的快照语义）；
 *     · 同意记录是 `withdrawn` —— 与「撤回后仍可导出」的语义对齐。
 *
 * ★ 替身**不**证明真库读得对：那是 `test-db/export-db.dbtest.ts` 的事。
 */
import type {
  ExportLimits,
  ExportPort,
  FamilyExportSnapshot
} from '../../src/export/export.repository'

/** 一条「各段都非空」的完整快照。`childId` 由调用方给，避免与其它用例的档案串台。 */
export function makeExportSnapshot(childId = 'child-1'): FamilyExportSnapshot {
  const at = (day: string): Date => new Date(`${day}T01:00:00.000Z`)
  return {
    child: {
      id: childId,
      name: '小满',
      pointsBalance: 4,
      ageBand: 'primary_low',
      focusAreas: ['study', 'chores'],
      onboardedAt: at('2026-09-01'),
      createdAt: at('2026-08-15')
    },
    members: [
      {
        userId: 'u-dad',
        displayName: '爸爸',
        role: 'guardian',
        status: 'active',
        joinedAt: at('2026-08-15'),
        removedAt: null
      },
      {
        userId: 'u-kid',
        displayName: '小满',
        role: 'child',
        status: 'active',
        joinedAt: at('2026-08-15'),
        removedAt: null
      }
    ],
    rules: [
      {
        id: 'r-1',
        title: '完成作业',
        condition: '当天作业全部完成',
        dailyLimit: 2,
        points: 3,
        direction: 'reward',
        icon: 'book',
        color: '#81C784',
        currentVersion: 2,
        status: 'active',
        deletedAt: null,
        createdAt: at('2026-09-02'),
        updatedAt: at('2026-09-10'),
        versions: [
          {
            version: 1,
            title: '完成作业',
            condition: '当天作业全部完成',
            dailyLimit: 1,
            points: 2,
            direction: 'reward',
            changeNote: '初始版本',
            changedByUserId: 'u-dad',
            changedAt: at('2026-09-02')
          },
          {
            version: 2,
            title: '完成作业',
            condition: '当天作业全部完成',
            dailyLimit: 2,
            points: 3,
            direction: 'reward',
            changeNote: '每天可加 2 次',
            changedByUserId: 'u-dad',
            changedAt: at('2026-09-10')
          }
        ]
      }
    ],
    habits: [
      {
        id: 'h-1',
        sourceRuleId: 'r-1',
        title: '番茄钟写作业',
        points: 1,
        condition: '专注 25 分钟',
        dailyLimit: 2,
        icon: 'timer',
        color: '#FFB74D',
        status: 'active',
        deletedAt: null,
        createdAt: at('2026-09-03'),
        updatedAt: at('2026-09-03')
      }
    ],
    wishes: [
      {
        id: 'w-1',
        title: '去科技馆',
        cost: 20,
        emoji: '🔬',
        coverStyle: 'A',
        redeemed: false,
        redeemedAt: null,
        status: 'active',
        deletedAt: null,
        createdAt: at('2026-09-05'),
        updatedAt: at('2026-09-05')
      }
    ],
    records: [
      {
        id: 'rec-1',
        titleSnapshot: '完成作业',
        conditionSnapshot: '当天作业全部完成',
        dailyLimitSnapshot: 2,
        costSnapshot: null,
        pointsDelta: 3,
        category: 'praise',
        source: 'guardian',
        note: '按时完成',
        operatorUserId: 'u-dad',
        operatorRole: 'guardian',
        balanceAfter: 3,
        ruleId: 'r-1',
        ruleVersion: 2,
        habitId: null,
        wishId: null,
        reversesRecordId: null,
        reversedAt: null,
        createdAt: at('2026-09-11')
      },
      {
        id: 'rec-2',
        titleSnapshot: '番茄钟写作业',
        conditionSnapshot: '专注 25 分钟',
        dailyLimitSnapshot: 2,
        costSnapshot: null,
        pointsDelta: 1,
        category: 'praise',
        source: 'child_self',
        note: '',
        operatorUserId: 'u-kid',
        operatorRole: 'child',
        balanceAfter: 4,
        ruleId: null,
        ruleVersion: null,
        habitId: 'h-1',
        wishId: null,
        reversesRecordId: null,
        reversedAt: null,
        createdAt: at('2026-09-12')
      }
    ],
    approvals: [
      {
        id: 'ap-1',
        requesterUserId: 'u-kid',
        requesterRole: 'child',
        actionType: 'redeem',
        payload: { wishId: 'w-1', costSnapshot: 20 },
        status: 'pending',
        autoReason: null,
        decidedByUserId: null,
        decidedAt: null,
        decisionNote: null,
        expiresAt: at('2026-09-15'),
        executedRecordId: null,
        createdAt: at('2026-09-12'),
        updatedAt: at('2026-09-12')
      }
    ],
    consents: [
      {
        consentVersion: '2026-10-draft',
        status: 'withdrawn',
        grantedAt: at('2026-09-01'),
        withdrawnAt: at('2026-10-01'),
        grantedByUserId: 'u-dad'
      }
    ],
    auditLogs: [
      {
        actorUserId: 'u-dad',
        actorRole: 'guardian',
        action: 'rule.update',
        targetType: 'PointRule',
        targetId: 'r-1',
        before: { points: 2 },
        after: { points: 3 },
        createdAt: at('2026-09-10')
      }
    ],
    totals: { records: 2, approvals: 1, auditLogs: 1 },
    truncatedSmall: []
  }
}

/** 记录调用的端口替身（断言「导出读的是会话里的 childId」这类事实）。 */
export function makeExportFake(
  snapshot: FamilyExportSnapshot | null = makeExportSnapshot()
): ExportPort & { calls: { childId: string; limits: ExportLimits }[] } {
  const calls: { childId: string; limits: ExportLimits }[] = []
  return {
    calls,
    async collect(childId, limits) {
      calls.push({ childId, limits })
      return snapshot
    }
  }
}

import type { FamilyExportSnapshot } from './export.repository'

/**
 * 导出文件的**形状**（W7-C）—— 这是给家长看的契约，比内部的 `Prisma` 行更保守。
 *
 * ── 三条原则 ────────────────────────────────────────────────────────────────
 *   ① **时间一律 ISO-8601 字符串**（`2026-10-27T09:00:00.000Z`）：导出文件会被
 *      搬到别处解析，JSON 里的 `Date` 一旦序列化成毫秒数或本地时间就没法追溯。
 *      `null` 保持 `null`（不写成 `''`）—— 「没有值」与「空字符串」必须区分。
 *   ② **`schemaVersion` 是硬承诺**：字段只增不改名；客户端 `showExportSheet`
 *      在版本不认识时应当提示「文件来自更新版本」，而不是猜测字段含义。
 *   ③ **不做重排 / 不做脱敏重写**：`summary` 之外逐段直出，条数、顺序与库里一致，
 *      `balanceAfter` 才能按正序滚动核对（I2）。
 *
 * ── `summary` 里的诚实字段 ──────────────────────────────────────────────────
 *   `truncated` + `totals` 让「这份文件不完整」这件事**写在文件里**，
 *   而不是只活在服务端日志里。任何一段被 `EXPORT_LIMITS` 截断都会置位。
 */

export const EXPORT_SCHEMA_VERSION = 1

export interface ExportDocument {
  schemaVersion: number
  generator: string
  generatedAt: string
  child: ExportChildDocument
  members: ExportMemberDocument[]
  rules: ExportRuleDocument[]
  habits: ExportHabitDocument[]
  wishes: ExportWishDocument[]
  records: ExportRecordDocument[]
  approvals: ExportApprovalDocument[]
  consents: ExportConsentDocument[]
  auditLogs: ExportAuditDocument[]
  summary: ExportSummary
}

export interface ExportSummary {
  /** 本文件实际包含的条数（不是库里的总数）。 */
  counts: {
    members: number
    rules: number
    habits: number
    wishes: number
    records: number
    approvals: number
    consents: number
    auditLogs: number
  }
  /** 库里**全量**条数（三张大表）；与 `counts` 不等即说明被截断。 */
  totals: {
    records: number
    approvals: number
    auditLogs: number
  }
  /** 是否被单次导出上限截断 —— true 时客户端必须提示「文件不完整」。 */
  truncated: boolean
  /** 被截断的段名（空数组 = 完整）。 */
  truncatedSections: string[]
}

export interface ExportChildDocument {
  id: string
  name: string
  /** 当前余额（与最后一条流水的 `balanceAfter` 一致；空账本时为 0）。 */
  pointsBalance: number
  ageBand: string | null
  focusAreas: string[]
  onboardedAt: string | null
  createdAt: string
}

export interface ExportMemberDocument {
  userId: string
  displayName: string | null
  role: string
  status: string
  joinedAt: string
  removedAt: string | null
}

export interface ExportRuleVersionDocument {
  version: number
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: string
  changeNote: string | null
  changedByUserId: string
  changedAt: string
}

export interface ExportRuleDocument {
  id: string
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: string
  icon: string
  color: string
  currentVersion: number
  status: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
  versions: ExportRuleVersionDocument[]
}

export interface ExportHabitDocument {
  id: string
  sourceRuleId: string | null
  title: string
  points: number
  condition: string
  dailyLimit: number
  icon: string
  color: string
  status: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ExportWishDocument {
  id: string
  title: string
  cost: number
  emoji: string
  coverStyle: string
  redeemed: boolean
  redeemedAt: string | null
  status: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}



export interface ExportRecordDocument {
  id: string
  titleSnapshot: string
  conditionSnapshot: string | null
  dailyLimitSnapshot: number | null
  costSnapshot: number | null
  pointsDelta: number
  category: string
  source: string
  note: string
  operatorUserId: string | null
  operatorRole: string | null
  balanceAfter: number
  ruleId: string | null
  ruleVersion: number | null
  habitId: string | null
  wishId: string | null
  reversesRecordId: string | null
  reversedAt: string | null
  createdAt: string
}

export interface ExportApprovalDocument {
  id: string
  requesterUserId: string
  requesterRole: string
  actionType: string
  payload: unknown
  status: string
  autoReason: string | null
  decidedByUserId: string | null
  decidedAt: string | null
  decisionNote: string | null
  expiresAt: string
  executedRecordId: string | null
  createdAt: string
  updatedAt: string
}

export interface ExportConsentDocument {
  consentVersion: string
  status: string
  grantedAt: string
  withdrawnAt: string | null
  grantedByUserId: string
}

export interface ExportAuditDocument {
  actorUserId: string | null
  actorRole: string | null
  action: string
  targetType: string
  targetId: string | null
  before: unknown
  after: unknown
  createdAt: string
}

/**
 * 快照 → 导出文件。
 *
 * ★ 纯函数：不碰库、不读时钟（`generatedAt` 由调用方传入）。这样离线用例
 *   可以对同一份快照断言**逐字节稳定**的输出，`generatedAt` 也不必被 mock。
 */
export function buildExportDocument(
  snapshot: FamilyExportSnapshot,
  generatedAt: Date
): ExportDocument {
  const counts = {
    members: snapshot.members.length,
    rules: snapshot.rules.length,
    habits: snapshot.habits.length,
    wishes: snapshot.wishes.length,
    records: snapshot.records.length,
    approvals: snapshot.approvals.length,
    consents: snapshot.consents.length,
    auditLogs: snapshot.auditLogs.length
  }

  const truncated = new Set(snapshot.truncatedSmall)
  if (counts.records < snapshot.totals.records) truncated.add('records')
  if (counts.approvals < snapshot.totals.approvals) truncated.add('approvals')
  if (counts.auditLogs < snapshot.totals.auditLogs) truncated.add('auditLogs')

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generator: 'kids-points-backend',
    generatedAt: generatedAt.toISOString(),
    child: {
      id: snapshot.child.id,
      name: snapshot.child.name,
      pointsBalance: snapshot.child.pointsBalance,
      ageBand: snapshot.child.ageBand,
      focusAreas: snapshot.child.focusAreas,
      onboardedAt: iso(snapshot.child.onboardedAt),
      createdAt: iso(snapshot.child.createdAt) as string
    },
    members: snapshot.members.map((row) => ({
      ...row,
      joinedAt: iso(row.joinedAt) as string,
      removedAt: iso(row.removedAt)
    })),
    rules: snapshot.rules.map((row) => ({
      ...row,
      deletedAt: iso(row.deletedAt),
      createdAt: iso(row.createdAt) as string,
      updatedAt: iso(row.updatedAt) as string,
      versions: row.versions.map((version) => ({
        ...version,
        changedAt: iso(version.changedAt) as string
      }))
    })),
    habits: snapshot.habits.map((row) => ({
      ...row,
      deletedAt: iso(row.deletedAt),
      createdAt: iso(row.createdAt) as string,
      updatedAt: iso(row.updatedAt) as string
    })),
    wishes: snapshot.wishes.map((row) => ({
      ...row,
      redeemedAt: iso(row.redeemedAt),
      deletedAt: iso(row.deletedAt),
      createdAt: iso(row.createdAt) as string,
      updatedAt: iso(row.updatedAt) as string
    })),
    records: snapshot.records.map((row) => ({
      ...row,
      reversedAt: iso(row.reversedAt),
      createdAt: iso(row.createdAt) as string
    })),
    approvals: snapshot.approvals.map((row) => ({
      ...row,
      decidedAt: iso(row.decidedAt),
      expiresAt: iso(row.expiresAt) as string,
      createdAt: iso(row.createdAt) as string,
      updatedAt: iso(row.updatedAt) as string
    })),
    consents: snapshot.consents.map((row) => ({
      ...row,
      grantedAt: iso(row.grantedAt) as string,
      withdrawnAt: iso(row.withdrawnAt)
    })),
    auditLogs: snapshot.auditLogs.map((row) => ({
      ...row,
      createdAt: iso(row.createdAt) as string
    })),
    summary: {
      counts,
      totals: snapshot.totals,
      truncated: truncated.size > 0,
      // 固定顺序：文件 diff 时段的顺序不该随查询顺序变化。
      truncatedSections: SECTION_ORDER.filter((section) => truncated.has(section))
    }
  }
}

/** 段名顺序 = 文件里的段顺序，用于 `truncatedSections` 的稳定排序。 */
const SECTION_ORDER = [
  'members',
  'rules',
  'habits',
  'wishes',
  'records',
  'approvals',
  'consents',
  'auditLogs'
] as const

/** `Date` → ISO 字符串；`null` 保持 `null`（不塌缩成 `''`）。 */
function iso(value: Date): string
function iso(value: Date | null): string | null
function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString()
}


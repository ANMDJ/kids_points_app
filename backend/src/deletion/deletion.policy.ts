import {
  FAMILY_DELETION_COOLING_DAYS,
  REDACTED_TEXT,
  type FamilyDeletionRedactionCounts,
  type FamilyDeletionState,
  type FamilyDeletionStateValue,
  type FamilyDeletionSummary
} from './deletion.repository'

/**
 * 家庭数据删除的**纯策略**（W7-D）—— 不碰数据库、不读时钟。
 *
 * 抽出来的理由与 `push-retry.policy.ts` / `approval-policy.ts` 相同：
 * 「还有几天」「能不能撤销」「payload 该抹掉哪些键」这些规则必须能被
 * **逐条断言**，而不是埋在 SQL 与 `new Date()` 之间。
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** 冷却期截止时刻 = 申请时刻 + N 天。 */
export function coolingDeadline(requestedAt: Date, days: number = FAMILY_DELETION_COOLING_DAYS): Date {
  return new Date(requestedAt.getTime() + days * DAY_MS)
}

/**
 * 距执行还有几天 —— **向上取整**，最小 0。
 *
 * 向上取整是刻意的：还剩 0.2 天时说「0 天」会让家长以为「已经删了」；
 * 说「1 天」才是实话（还没到）。到期后固定给 0（worker 可能还没跑）。
 */
export function daysRemaining(scheduledFor: Date, now: Date): number {
  const remaining = scheduledFor.getTime() - now.getTime()
  if (remaining <= 0) return 0
  return Math.ceil(remaining / DAY_MS)
}

/** 仓储里一行 `FamilyDeletionRequest` 的最小形状（只取状态机需要的列）。 */
export interface DeletionRequestRow {
  id: string
  status: FamilyDeletionStateValue | 'pending' | 'cancelled' | 'executed'
  requestedAt: Date
  scheduledFor: Date
  cancelledAt: Date | null
  executedAt: Date | null
  summary: unknown
}

/** 把一行请求映射成对外状态（`null` ⇒ `none`）。时间一律 ISO 字符串。 */
export function toDeletionState(
  childId: string,
  row: DeletionRequestRow | null,
  now: Date
): FamilyDeletionState {
  if (row === null) {
    return {
      childId,
      status: 'none',
      requestedAt: null,
      scheduledFor: null,
      cancelledAt: null,
      executedAt: null,
      daysRemaining: null,
      canCancel: false,
      summary: null
    }
  }

  const pending = row.status === 'pending'
  return {
    childId,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    scheduledFor: row.scheduledFor.toISOString(),
    cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
    executedAt: row.executedAt === null ? null : row.executedAt.toISOString(),
    daysRemaining: pending ? daysRemaining(row.scheduledFor, now) : null,
    // ★ 只有 pending 能撤销：executed 已经匿名化，cancelled 无需再撤。
    canCancel: pending,
    summary: row.status === 'executed' ? parseSummary(row.summary) : null
  }
}

/**
 * 解析落库的执行摘要。
 *
 * ★ 形状不符 ⇒ `null`（不是抛错、也不是补默认值）。
 *   摘要只用于「回放当时做了什么」；把它猜出来就是在**伪造证据**。
 *   界面拿到 `null` 会显示「执行摘要缺失」，这是正确的信号。
 */
export function parseSummary(value: unknown): FamilyDeletionSummary | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const redacted = raw.redacted
  const kept = raw.kept
  if (typeof raw.coolingDays !== 'number') return null
  if (typeof raw.note !== 'string') return null
  if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) return null
  if (kept === null || typeof kept !== 'object' || Array.isArray(kept)) return null

  const keys: Array<keyof FamilyDeletionRedactionCounts> = [
    'child',
    'members',
    'rules',
    'ruleVersions',
    'habits',
    'wishes',
    'records',
    'approvals',
    'consents',
    'notifications'
  ]
  const counts = redacted as Record<string, unknown>
  for (const key of keys) {
    if (typeof counts[key] !== 'number') return null
  }
  const keptRaw = kept as Record<string, unknown>
  if (typeof keptRaw.records !== 'number' || typeof keptRaw.pointsBalance !== 'number') return null

  return {
    coolingDays: raw.coolingDays,
    redacted: Object.fromEntries(keys.map((key) => [key, counts[key]])) as unknown as FamilyDeletionRedactionCounts,
    kept: { records: keptRaw.records, pointsBalance: keptRaw.pointsBalance },
    note: raw.note
  }
}

/**
 * payload 里**允许原样保留**的键：标识符与枚举/数值。
 *
 * ★ 判据是**白名单**（fail-closed）：新增一个描述性字段时，默认会被抹掉；
 *   只有显式列在这里的「结构键」才留。反过来（黑名单）一旦漏列，新字段就会
 *   带着个人信息留在库里，而且没有任何用例会红 —— 这正是最坏的一种。
 */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  'id',
  'status',
  'type',
  'action',
  'category',
  'source',
  'direction',
  'role',
  'coverStyle',
  'emoji',
  'icon',
  'color',
  'currency'
])

function isStructuralKey(key: string): boolean {
  return STRUCTURAL_KEYS.has(key) || key === 'id' || key.endsWith('Id')
}

/**
 * 递归抹掉 payload 里的描述性文本。
 *
 * ★ 保留结构（键、数值、布尔、标识符）是刻意的：审批的 `costSnapshot` 等数值
 *   是账本对账依据（02 §4.3），把它们一起清掉会让「为什么扣了 20 分」无法解释。
 *   被抹掉的只有「写了什么」，不是「发生了什么」。
 * ★ 数组保持数组、对象保持对象 —— 形状不变，只是叶子被替换。
 */
export function redactPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    // 数组只可能来自**非结构键**（结构键在上面的循环里被整体保留）；
    // 因此数组里的字符串叶子同样按「描述性文本」处理。
    return value.map((item) => (typeof item === 'string' ? REDACTED_TEXT : redactPayload(item)))
  }
  if (value === null || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isStructuralKey(key)) {
      out[key] = child
      continue
    }
    // 非结构键下的**字符串**一律抹掉；数值 / 布尔 / null 保留（它们是「发生了什么」）。
    out[key] = typeof child === 'string' ? REDACTED_TEXT : redactPayload(child)
  }
  return out
}

/** 执行摘要里的固定说明（写进摘要，避免读者把「保留流水」读成「没删」）。 */
export const DELETION_KEPT_NOTE =
  '账本流水与余额按 02 §5.7 I5 保留（append-only / 可对账）；描述性文本与身份痕迹已匿名化。'

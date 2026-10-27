import { Injectable, NotImplementedException } from '@nestjs/common'
import type {
  AgeBand,
  ApprovalStatus,
  AutoReason,
  ConsentStatus,
  MemberRole,
  MemberStatus,
  RecordCategory,
  RecordSource,
  RecordStatus,
  RuleDirection,
  WishCoverStyle
} from '@prisma/client'

/**
 * 家庭数据导出的**持久化端口**（W7-C，2026-10-27）。
 *
 * ── 为什么需要它（而不是在 controller 里直接 `prisma.*`）─────────────────────
 *   与 `ReadPort` / `MembersPort` 同一条理由：离线的 `npm test` 不许连库。
 *   无 `DATABASE_URL` 时绑定本文件末尾的 501 实现 ——「导出还没接库」因此是
 *   **可执行断言**，而不是注释里的一句承诺。
 *
 * ── 导出的边界：只导「这个孩子的数据」────────────────────────────────────────
 *   所有查询都以 `childId` 收口。**不**跨孩子、**不**带 `User.openId`、
 *   **不**带 `ChildMember.pinHash` / `GuardianConsent.ipHash` / `PointRecord.idempotencyKey`
 *   —— 前两者是登录凭据与口令材料，后者是内部重放键，都不是「可携带的家庭数据」。
 *   最小化不是“顺手少选两列”，而是 GDPR / 个保法的「数据最小化」要求：
 *   导出的文件往往会被转发、存进网盘，越少携带凭据越安全。
 *
 * ── 为什么允许导出软删项 ────────────────────────────────────────────────────
 *   回收站里的规则 / 习惯 / 心愿仍是「已存在的历史」；导出若把它们藏起来，
 *   家长拿到的文件就解释不了流水里的引用（`ruleId` 指向一条看不到的规则）。
 *   因此这里**不过滤** `status`，软删项带 `status` / `deletedAt` 原样导出。
 *
 * ── 限额 ────────────────────────────────────────────────────────────────────
 *   一次导出把全库塞进内存是不负责任的。三张大表（流水 / 审批 / 审计）按
 *   `EXPORT_LIMITS` 截断，并在文件里写 `summary.truncated` /
 *   `recordTotal` 等全量计数 —— **截断必须是看得见的**，不能悄悄返回半份数据
 *   当完整导出。
 */

/** Nest 注入令牌（unique symbol：不与会话 / 成员 / 只读端口的令牌撞名）。 */
export const EXPORT_REPOSITORY = Symbol('EXPORT_REPOSITORY')

/**
 * 单次导出的行数上限。
 *
 * 数值取舍：一个用了三年的家庭大约几万条流水；5 万条 × ~200B ≈ 10MB，
 * 双端复制 / 下载都还能接受。调大这些常数等于调大单次请求的内存峰值，
 * 因此不做成环境变量（避免「生产悄悄配成 100 万」）。
 */
export const EXPORT_LIMITS = {
  /** 积分流水（账本）。 */
  records: 50000,
  /** 审批申请。 */
  approvals: 5000,
  /** 审计日志。 */
  auditLogs: 5000,
  /** 小集合：成员 / 规则 / 习惯 / 心愿 / 同意记录。 */
  small: 2000
} as const

export type ExportLimits = typeof EXPORT_LIMITS

export interface ExportChildRow {
  id: string
  name: string
  pointsBalance: number
  ageBand: AgeBand | null
  focusAreas: string[]
  onboardedAt: Date | null
  createdAt: Date
}

export interface ExportMemberRow {
  userId: string
  displayName: string | null
  role: MemberRole
  status: MemberStatus
  joinedAt: Date
  removedAt: Date | null
}

export interface ExportRuleVersionRow {
  version: number
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: RuleDirection
  changeNote: string | null
  changedByUserId: string
  changedAt: Date
}

export interface ExportRuleRow {
  id: string
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: RuleDirection
  icon: string
  color: string
  currentVersion: number
  status: RecordStatus
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
  versions: ExportRuleVersionRow[]
}

export interface ExportHabitRow {
  id: string
  sourceRuleId: string | null
  title: string
  points: number
  condition: string
  dailyLimit: number
  icon: string
  color: string
  status: RecordStatus
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface ExportRecordRow {
  id: string
  titleSnapshot: string
  conditionSnapshot: string | null
  dailyLimitSnapshot: number | null
  costSnapshot: number | null
  pointsDelta: number
  category: RecordCategory
  source: RecordSource
  note: string
  operatorUserId: string | null
  operatorRole: MemberRole | null
  balanceAfter: number
  ruleId: string | null
  ruleVersion: number | null
  habitId: string | null
  wishId: string | null
  reversesRecordId: string | null
  reversedAt: Date | null
  createdAt: Date
}

export interface ExportApprovalRow {
  id: string
  requesterUserId: string
  requesterRole: MemberRole
  actionType: string
  /** 申请时的参数快照（含 `costSnapshot`，02 §4.3）。原样导出，不改写。 */
  payload: unknown
  status: ApprovalStatus
  autoReason: AutoReason | null
  decidedByUserId: string | null
  decidedAt: Date | null
  decisionNote: string | null
  expiresAt: Date
  executedRecordId: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ExportConsentRow {
  consentVersion: string
  status: ConsentStatus
  grantedAt: Date
  withdrawnAt: Date | null
  grantedByUserId: string
}

/**
 * 审计日志行。
 *
 * ★ 刻意**不**导出 `ipHash` / `deviceId`：它们是可关联到设备与网络的最小化凭据，
 *   对「了解孩子数据被谁改过」没有帮助，却会随文件扩散。
 */
export interface ExportAuditRow {
  actorUserId: string | null
  actorRole: MemberRole | null
  action: string
  targetType: string
  targetId: string | null
  before: unknown
  after: unknown
  createdAt: Date
}

/**
 * 一份快照 = 一个事务里读出的**同一时刻**的家庭数据。
 *
 * `totals` 只有三张可能被截断的表：小集合一旦截断也会在 `truncatedSmall`
 * 里出现（正常应为空）。
 */
export interface FamilyExportSnapshot {
  child: ExportChildRow
  members: ExportMemberRow[]
  rules: ExportRuleRow[]
  habits: ExportHabitRow[]
  wishes: ExportWishRow[]
  records: ExportRecordRow[]
  approvals: ExportApprovalRow[]
  consents: ExportConsentRow[]
  auditLogs: ExportAuditRow[]
  totals: {
    records: number
    approvals: number
    auditLogs: number
  }
  /** 小集合被 `limits.small` 截断的段名（正常应为空）。 */
  truncatedSmall: string[]
}

export interface ExportPort {
  /**
   * 读一份可导出的家庭快照。
   *
   * ★ 孩子不存在 / 已软删 ⇒ `null`（**不是**空文档）。与 `ReadPort.loadHome`
   *   同一条口径：若返回空文档，家长会拿到一份「什么都没有」的导出，
   *   而真实原因是这个档案已经不在库里 —— 又一种「把失败装成正常」。
   */
  collect(childId: string, limits: ExportLimits): Promise<FamilyExportSnapshot | null>
}

/**
 * 无库装配的默认实现：**响亮 501**，绝不返回空文档。
 *
 * 为什么空文档最糟：导出的用途是「家长确认孩子的数据都在」。一份
 * `records: []` 的合法 JSON 会被当成「孩子没有记录」，而实际是查询没接库；
 * 家长可能会据此认为数据丢了，或者更糟 —— 拿这份空文件去主张权利。
 */
@Injectable()
export class NotImplementedExportRepository implements ExportPort {
  async collect(_childId: string, _limits: ExportLimits): Promise<FamilyExportSnapshot | null> {
    throw new NotImplementedException({
      code: 'EXPORT_MODEL_NOT_IMPLEMENTED',
      message:
        '家庭数据导出尚未接库（无 DATABASE_URL 的装配）。' +
        '★ 绝不返回空文档：那会把「导出未实现」显示成「孩子没有数据」。'
    })
  }
}

export interface ExportWishRow {
  id: string
  title: string
  cost: number
  emoji: string
  coverStyle: WishCoverStyle
  redeemed: boolean
  redeemedAt: Date | null
  status: RecordStatus
  deletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

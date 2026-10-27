import { Injectable, NotImplementedException } from '@nestjs/common'

/**
 * 家庭数据删除的**端口**（W7-D，2026-10-27）。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────────
 *   `02` §9.20 / `04` §5 承诺了「可导出 + 可删除」。W7-C 已交付导出；
 *   本模块交付删除的另一半：**申请 → 冷却期 → 二次确认后的执行**。
 *   删除不是物理 `DELETE`（账本 append-only，02 §5.7 I5）—— 它是**就地匿名化**：
 *   把描述性文本换成 {@link REDACTED_TEXT}，把口令 / IP / UA / 邀请痕迹抹掉，
 *   把孩子的档案标为 `deleted`；积分的**数值与结构**原样保留。
 *
 * ── 为什么「保留数值」不是偷懒 ──────────────────────────────────────────────
 *   流水是账本：`balanceAfter` 逐笔可滚动核对（I2）。把流水删掉会让
 *   「孩子曾经有过多少分」无法回答，也会破坏对账不变量。合规要求的是
 *   **身份不可识别**，不是**历史不存在**。因此摘要里如实写出
 *   「保留 N 条流水、余额 M 分」，让删除的边界可被检查，而不是被含糊掉。
 *
 * ── 无库装配：501，绝不假装已删 ─────────────────────────────────────────────
 *   与 `NotImplementedExportRepository` 同一口径：没有库就返回
 *   `501 FAMILY_DELETION_NOT_IMPLEMENTED`。**绝不能**回 200 + 「已删除」——
 *   那会让家长以为数据没了，实际一行没动（最坏的一种假绿）。
 */

/** 冷却期天数（产品政策常数，**不做成环境变量**）。 */
export const FAMILY_DELETION_COOLING_DAYS = 7

/** 匿名化后写入的描述性文本（客户端原样显示，不做二次解释）。 */
export const REDACTED_TEXT = '[已删除]'

/** 请求要求的显式确认字段名（`POST /family-deletion` 必须带 `confirmed: true`）。 */
export const DELETION_CONFIRMATION_FIELD = 'confirmed'

export const DELETION_REPOSITORY = Symbol('DELETION_REPOSITORY')

/** 对外的删除状态（`none` = 从未申请过）。 */
export type FamilyDeletionStateValue = 'none' | 'pending' | 'cancelled' | 'executed'

/** 各表被改写的行数。**0 也写出来** —— 「这一段为什么没动」必须可回答。 */
export interface FamilyDeletionRedactionCounts {
  child: number
  members: number
  rules: number
  ruleVersions: number
  habits: number
  wishes: number
  records: number
  approvals: number
  consents: number
  notifications: number
}

/** 执行摘要（落库到 `FamilyDeletionRequest.summary`，读取时原样回放）。 */
export interface FamilyDeletionSummary {
  /** 冷却期天数（执行时的政策值 —— 政策变了也不改写历史摘要）。 */
  coolingDays: number
  redacted: FamilyDeletionRedactionCounts
  /**
   * 原样保留的结构数据。`records` 是**保留**的流水条数，`pointsBalance`
   * 是孩子的最终余额 —— 两者一起构成「账本没被抹掉」的证据。
   */
  kept: { records: number; pointsBalance: number }
  /** 保留说明（固定文案，写进摘要以免读者误解「没删干净」）。 */
  note: string
}

/** `GET /family-deletion` 的响应体。 */
export interface FamilyDeletionState {
  childId: string
  status: FamilyDeletionStateValue
  requestedAt: string | null
  scheduledFor: string | null
  cancelledAt: string | null
  executedAt: string | null
  /** 距执行还有几天（向上取整，最小 0）；非 `pending` 时为 `null`。 */
  daysRemaining: number | null
  /** 现在是否还能撤销（仅 `pending` 为 true —— 执行后不可逆）。 */
  canCancel: boolean
  summary: FamilyDeletionSummary | null
}

/** 操作人（来自会话 + 成员位，客户端无法指定）。 */
export interface DeletionOperator {
  userId: string
  role: 'guardian' | 'child' | 'viewer'
}

export interface RequestDeletionInput {
  childId: string
  operator: DeletionOperator
  now: Date
}

export interface CancelDeletionInput {
  childId: string
  operator: DeletionOperator
  now: Date
}

export interface ExecuteDueInput {
  now: Date
  limit: number
}

/** 一次已执行的删除（worker 的返回，供日志 / 用例断言）。 */
export interface ExecutedDeletion {
  requestId: string
  childId: string
  summary: FamilyDeletionSummary
}

export interface DeletionPort {
  readState(childId: string, now: Date): Promise<FamilyDeletionState>
  requestDeletion(input: RequestDeletionInput): Promise<FamilyDeletionState>
  cancelDeletion(input: CancelDeletionInput): Promise<FamilyDeletionState>
  /** 执行所有 `scheduledFor <= now` 的 pending 请求（最多 `limit` 条）。 */
  executeDue(input: ExecuteDueInput): Promise<ExecutedDeletion[]>
}

/**
 * 无库装配的端口：**一律 501**。
 *
 * ★ 它存在是为了让「没有 DATABASE_URL」这件事在**第一次点击**时就响亮地说出来，
 *   而不是返回一个看起来成功的状态（那会让人以为数据已被删除）。
 */
@Injectable()
export class NotImplementedDeletionRepository implements DeletionPort {
  private fail(operation: string): never {
    throw new NotImplementedException({
      code: 'FAMILY_DELETION_NOT_IMPLEMENTED',
      message:
        `当前进程没有 DATABASE_URL（无库装配）⇒ 家庭数据删除不可用：${operation} 没有实现。` +
        '删除会改写多张表的描述性字段，必须由数据库保证同一个事务内完成；' +
        '这里**拒绝**而不是假装成功 —— 返回「已删除」而实际没删，比报错危险得多。'
    })
  }

  readState(): Promise<FamilyDeletionState> {
    return Promise.resolve(this.fail('readState'))
  }

  requestDeletion(): Promise<FamilyDeletionState> {
    return Promise.resolve(this.fail('requestDeletion'))
  }

  cancelDeletion(): Promise<FamilyDeletionState> {
    return Promise.resolve(this.fail('cancelDeletion'))
  }

  executeDue(): Promise<ExecutedDeletion[]> {
    return Promise.resolve(this.fail('executeDue'))
  }
}

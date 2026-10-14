import { Injectable, NotImplementedException } from '@nestjs/common'

import type { ActionType, Role } from '../contracts/permission-matrix'

/**
 * 审批的**持久化端口**（端口 / 适配器里的「端口」）。
 *
 * ── 为什么要有这一层（而不是让 service 直接拿 PrismaService）──────────────
 *   ① `02` §4.5 硬约束 5 要求「自批与**他人批准**走同一套重校验 ＋ 同一事务 ＋ 同一流水」
 *      —— 这件事只有**知道事务的人**能做，故把它收成一个明确的端口方法
 *      （`createSelfApproved` 承诺的就是「同一事务」，而不是调用方自己拼两步）；
 *   ② 端口的默认实现是**显式 501**（见文件末尾）：W1 之前它**不许**假装成功。
 *      这样「审批写入还没落地」是一个**可执行断言**，而不是注释里的一句话。
 *
 * ⚠️ 目前的真实状态：**没有任何实现**（默认实现只会抛 501）。
 *    真正的 Prisma 实现属于 W1/W2/W3（还要同时写 `PointRecord` 流水 + `AuditLog`）。
 */

/** Nest 注入令牌（用 unique symbol 避免字符串撞名）。 */
export const APPROVALS_REPOSITORY = Symbol('APPROVALS_REPOSITORY')

/** 一条审批请求的**读模型**（只含策略与响应需要的字段，不假装是完整 Prisma 模型）。 */
export interface ApprovalRow {
  id: string
  action: ActionType
  requesterUserId: string
  /** `pending` / `approved` / `rejected` / `withdrawn` / `invalidated` / `expired`（§4.1）。 */
  status: string
  /** 未决时 `null` —— `isSelfApproved()` 的输入（自批 = 与 `requesterUserId` 相等）。 */
  decidedByUserId: string | null
  /** 批准执行后产生的账本记录（`02` §4.3 的 `executedRecordId`，单向表达）。 */
  executedRecordId: string | null
}

/** 建请求的入参（**只含**落库需要的字段）。 */
export interface CreateApprovalInput {
  action: ActionType
  targetId?: string
  requesterUserId: string
  requesterRole: Role | 'viewer'
}

export interface DecideApprovalInput {
  id: string
  outcome: 'approved' | 'rejected'
  decidedByUserId: string
}

export interface ApprovalsPort {
  /** 建一条 `pending`，**不执行**任何业务（等家庭里另一位 guardian 来批，或本人二次确认）。 */
  createPending(input: CreateApprovalInput): Promise<ApprovalRow>

  /**
   * 建请求 + **同一事务内**直接批准（`02` §4.5 形态②）。
   * 落库后 `decidedByUserId === requesterUserId`（自批的唯一判据，不新增字段）。
   */
  createSelfApproved(input: CreateApprovalInput): Promise<ApprovalRow>

  /** 取一条（未找到返回 `null`，**不抛异常** —— 「没有这条」是正常分支，404 由上层决定）。 */
  findById(id: string): Promise<ApprovalRow | null>

  /**
   * 批准 / 拒绝，**乐观锁**：`UPDATE … WHERE id = ? AND status = 'pending'`（§4.4）。
   * 未命中（已被决过 / 已过期）⇒ 抛 `ConflictException(ALREADY_DECIDED)`，**绝不覆盖**终端态。
   */
  decide(input: DecideApprovalInput): Promise<ApprovalRow>
}

/**
 * 默认实现：**一律 501**。
 *
 * 这不是占位符里最省事的写法，而是**刻意的 fail-closed**：
 * 若这里返回任何编造的成功响应，客户端会以为兑换已经批了，而库里什么都没有 ——
 * 那正是本仓库最不能接受的「假绿」。501 让「写入路径未落地」**响亮可见**。
 */
@Injectable()
export class NotImplementedApprovalsRepository implements ApprovalsPort {
  private fail(method: keyof ApprovalsPort): never {
    throw new NotImplementedException({
      code: 'APPROVALS_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        `审批写入路径尚未落地（W1/W2）：${String(method)} 没有实现。` +
        '自批的**判定**已可用（src/contracts/approval-policy.ts），但落库 + 账本流水 + 审计属于 W1/W2。'
    })
  }

  createPending(input: CreateApprovalInput): Promise<ApprovalRow> {
    void input
    return Promise.resolve(this.fail('createPending'))
  }

  createSelfApproved(input: CreateApprovalInput): Promise<ApprovalRow> {
    void input
    return Promise.resolve(this.fail('createSelfApproved'))
  }

  findById(id: string): Promise<ApprovalRow | null> {
    void id
    return Promise.resolve(this.fail('findById'))
  }

  decide(input: DecideApprovalInput): Promise<ApprovalRow> {
    void input
    return Promise.resolve(this.fail('decide'))
  }
}

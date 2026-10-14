import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common'

import {
  AUDIT_ACTION_SELF_APPROVED,
  canDecide,
  canReview,
  decideRequestOutcome,
  isSelfApproved
} from '../contracts/approval-policy'
import type { Actor } from '../permissions/actor'
import {
  APPROVALS_REPOSITORY,
  type ApprovalRow,
  type ApprovalsPort
} from './approvals.repository'
import type { CreateApprovalRequestDto } from './dto/create-approval-request.dto'
import type { DecideApprovalRequestDto } from './dto/decide-approval-request.dto'

/** service 的返回：状态码由判定结果决定（202 待批 / 201 自批已执行），故显式带出来。 */
export interface ServiceResult {
  statusCode: number
  body: unknown
}

/** 响应体（只暴露契约需要的字段；不把整行 Prisma 记录漏给客户端）。 */
function toBody(row: ApprovalRow): Record<string, unknown> {
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    requesterUserId: row.requesterUserId,
    decidedByUserId: row.decidedByUserId,
    executedRecordId: row.executedRecordId
  }
}

/**
 * 审批的**唯一业务装配点** —— 「谁可以批准」的判定**全部**来自
 * `src/contracts/approval-policy.ts`（`02` §4.5「唯一实现点」）。
 *
 * ★ 本文件**不许**出现任何 `role === 'guardian'` / `role !== 'child'` 这类判定：
 *   一旦出现，就等于在矩阵之外开了第二处权限定义 —— 两份真相必然漂移（§2 / D9 的教训）。
 *   `approvals-http.test.ts` 里有一条用例专门钉住这一点（把矩阵的行改掉，本文件的
 *   行为必须跟着变；否则说明判定被抄了一份）。
 *
 * ⚠️ 诚实标注：**落库 / 账本流水 / 审计写入属于 W1–W3**，本文件目前只产出
 *   「应当是什么结果」；真正的写入由 `ApprovalsPort` 承担，而它的默认实现是 **501**。
 */
@Injectable()
export class ApprovalsService {
  // 显式 `@Inject`：**不依赖 `emitDecoratorMetadata`**。
  // 这既让 tsx / esbuild 这类不产出 metadata 的加载器不至于静默注入失败，
  // 也让令牌改名时编译期就能发现（字符串令牌写错是运行时才炸）。
  constructor(@Inject(APPROVALS_REPOSITORY) private readonly port: ApprovalsPort) {}

  /**
   * `POST /approvals` —— 建一条审批请求（`02` §9.3 / §9.25 / §9.26 / §9.27）。
   */
  async createRequest(dto: CreateApprovalRequestDto, actor: Actor): Promise<ServiceResult> {
    const outcome = decideRequestOutcome({
      action: dto.action,
      requesterRole: actor.role,
      autoApprove: dto.autoApprove
    })

    switch (outcome.kind) {
      case 'REJECTED':
        // ★ 硬约束 4：显式要求自批却没资格 → **400 并点名**。
        //   绝不静默降级成 `pending`：那会让客户端以为已批，而库里那条没人看见。
        //   注意这里**在落库之前**就返回 —— 拒掉的请求不产生任何行（用例断言 port 未被调用）。
        throw new BadRequestException({
          code: outcome.code,
          message:
            `动作 ${dto.action} 对角色 ${actor.role} 不允许自批（02 §4.5 硬约束 2/4）：` +
            '自批资格 = 该动作需要审批 且 该角色具备批准资格（矩阵 review_approvals = ALLOW）。'
        })

      case 'PENDING': {
        const row = await this.port.createPending({
          action: dto.action,
          targetId: dto.targetId,
          requesterUserId: actor.userId,
          requesterRole: actor.role
        })
        return { statusCode: HttpStatus.ACCEPTED, body: toBody(row) }
      }

      case 'SELF_APPROVED': {
        // ★ 硬约束 5：与「他人批准」**同一套**执行路径（端口承诺同一事务 + 同一流水）。
        const row = await this.port.createSelfApproved({
          action: dto.action,
          targetId: dto.targetId,
          requesterUserId: actor.userId,
          requesterRole: actor.role
        })
        return {
          statusCode: HttpStatus.CREATED,
          body: {
            ...toBody(row),
            // ★ 硬约束 6：审计可辨 —— 判据是「批准人 == 申请人」，不新增字段。
            selfApproved: isSelfApproved(row),
            auditAction: isSelfApproved(row) ? AUDIT_ACTION_SELF_APPROVED : null
          }
        }
      }
    }

    // 穷尽性保险：`RequestOutcome` 将来若加分支，这里会编译报错（而不是静默返回 undefined）。
    throw new Error(`未处理的判定结果：${JSON.stringify(outcome)}`)
  }

  /**
   * `POST /approvals/:id/decide` —— 批准 / 拒绝（两步式自批也走这里，§4.4 / §4.5）。
   */
  async decide(
    id: string,
    dto: DecideApprovalRequestDto,
    actor: Actor
  ): Promise<ServiceResult> {
    const row = await this.port.findById(id)
    if (row === null) {
      throw new NotFoundException({ code: 'APPROVAL_NOT_FOUND', message: `没有这条审批请求：${id}` })
    }

    if (!canDecide(row, actor.role)) {
      // 分开两种原因（都是 `canDecide` 为 false，但客户端要的处置完全不同）：
      //   · 没批准资格 → 403（孩子 / viewer 不该走到这里）
      //   · 已决 / 非法态 → 409（双击「同意」的第二次，§4.4 乐观锁口径 / §9.10）
      if (!canReview(actor.role)) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: `角色 ${actor.role} 没有批准资格（矩阵 review_approvals）。`
        })
      }
      throw new ConflictException({
        code: 'ALREADY_DECIDED',
        message: `这条审批已是终态：${row.status}（02 §4.4 乐观锁只认 status = 'pending'）。`
      })
    }

    const decided = await this.port.decide({
      id,
      outcome: dto.decision,
      decidedByUserId: actor.userId
    })
    const selfApproved = isSelfApproved(decided)
    return {
      statusCode: HttpStatus.OK,
      body: {
        ...toBody(decided),
        selfApproved,
        auditAction: selfApproved ? AUDIT_ACTION_SELF_APPROVED : null
      }
    }
  }
}

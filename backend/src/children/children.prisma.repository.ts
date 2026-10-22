import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type {
  ChildProfileRow,
  ChildrenPort,
  RenameChildInput
} from './children.repository'

/**
 * 孩子档案写入的 **Prisma 适配器**（W5-E，2026-10-21）。
 *
 * ── 一个事务里做三件事（缺一不可）──────────────────────────────────────────
 *   1. `SELECT ... FOR UPDATE` 锁住这个孩子（同时顺带确认它还是 active）；
 *   2. 改名（`Child.name`）；
 *   3. 写 `AuditLog { action: 'child.rename' }`，快照只有 `name` 这一个字段。
 *
 *   为什么必须锁：改名本身是单行 UPDATE，看似不需要锁；但审计要写「改之前
 *   是什么」，先读后写就是 TOCTOU —— 两位家长同时改，第二次的 before 会读到
 *   已经被覆盖的值，审计里就出现「A→C」，而真实轨迹是「A→B→C」。行锁把
 *   「读旧值 / 写新值 / 记快照」收进同一临界区。
 *
 * ── 同名改名的语义 ──────────────────────────────────────────────────────────
 *   `name === 当前值` ⇒ **直接返回 200，不写 UPDATE、不写审计**。
 *   理由：PATCH 的语义是「把资源改成这个状态」，状态没变就没有变更可记；
 *   若每次都插一条 `child.rename`，客户端重试一次就会在审计里留下两条一模一样的
 *   「A→A」记录（把审计当噪声）。这也让 `PATCH /child` 天然幂等，不需要
 *   `Idempotency-Key`（同名重复提交不会产生第二份副作用）。
 */
@Injectable()
export class PrismaChildrenRepository implements ChildrenPort {
  constructor(private readonly prisma: PrismaService) {}

  async renameChild(input: RenameChildInput): Promise<ChildProfileRow> {
    try {
      return await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient): Promise<ChildProfileRow> => {
          const current = await this.lockChild(tx, input.childId)

          if (current.name === input.name) {
            return { childId: current.id, name: current.name }
          }

          const updated = await tx.child.update({
            where: { id: current.id },
            data: { name: input.name }
          })

          await tx.auditLog.create({
            data: {
              childId: updated.id,
              actorUserId: input.operatorUserId,
              actorRole: input.operatorRole,
              action: 'child.rename',
              targetType: 'Child',
              targetId: updated.id,
              before: { name: current.name },
              after: { name: updated.name }
            }
          })

          return { childId: updated.id, name: updated.name }
        }
      )
    } catch (error) {
      this.mapWriteError(error)
    }
  }

  /** 锁住 active 的孩子并读出当前昵称；不存在 / 已删除 ⇒ 404（跨孩子一律同答）。 */
  private async lockChild(
    tx: Prisma.TransactionClient,
    childId: string
  ): Promise<{ id: string; name: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM "Child"
      WHERE id = ${childId} AND status = 'active'
      FOR UPDATE`
    const row = rows[0]
    if (row === undefined) {
      throw new NotFoundException({
        code: 'CHILD_NOT_FOUND',
        message: `孩子 ${childId} 不存在或已删除 —— 拒绝改一个不存在的档案。`
      })
    }
    return row
  }

  /** 把可预期的库层失败翻成 4xx（其余原样抛出 ⇒ 500，不伪装成业务拒绝）。 */
  private mapWriteError(err: unknown): never {
    if (err instanceof HttpException) throw err

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        throw new NotFoundException({
          code: 'CHILD_NOT_FOUND',
          message: '这个孩子已经不存在了（可能刚被删除），昵称没有保存。',
          details: err.meta ?? null
        })
      }
      if (err.code === 'P2002') {
        throw new ConflictException({
          code: 'CHILD_NAME_CONFLICT',
          message: '写入违反唯一约束，昵称没有保存。请重试；若仍失败请联系管理员。',
          details: err.meta ?? null
        })
      }
    }

    throw err
  }
}

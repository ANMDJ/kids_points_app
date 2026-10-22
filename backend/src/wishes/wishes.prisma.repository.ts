import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { pickCoverStyle } from '../contracts/wish-cover-style'
import { PrismaService } from '../prisma/prisma.service'
import type { WishRow } from '../read/read.repository'
import type { CreateWishInput, DeleteWishInput, WishesPort } from './wishes.repository'

/** 审计快照：只放**事实**（可回放），不放展示串。 */
function wishSnapshot(wish: {
  id: string
  title: string
  cost: number
  emoji: string
  coverStyle: string
  redeemed: boolean
  status: string
  deletedAt: Date | null
}): Prisma.InputJsonObject {
  return {
    id: wish.id,
    title: wish.title,
    cost: wish.cost,
    emoji: wish.emoji,
    coverStyle: wish.coverStyle,
    redeemed: wish.redeemed,
    status: wish.status,
    deletedAt: wish.deletedAt === null ? null : wish.deletedAt.toISOString()
  }
}

function toWishRow(wish: {
  id: string
  title: string
  cost: number
  emoji: string
  coverStyle: 'A' | 'B' | 'C' | 'D'
  redeemed: boolean
}): WishRow {
  return {
    id: wish.id,
    title: wish.title,
    cost: wish.cost,
    emoji: wish.emoji,
    coverStyle: wish.coverStyle,
    redeemed: wish.redeemed
  }
}

/**
 * 心愿写入的 Prisma 实现（W5-B，2026-10-20）。
 *
 * 两条纪律（与 `rules.prisma.repository.ts` 同一套手法）：
 *   ① **事务 + 孩子行锁**：同一孩子的写入排队。锁的是 `Child` 行（不是心愿行），
 *      因为「配色空档」是一个**集合级**事实 —— 只锁单行挡不住两条并发新增撞出同色。
 *   ② **审计与业务同一事务**：审计写失败 ⇒ 业务回滚（宁可没加上，也不要「加上了但查不到谁加的」）。
 */
@Injectable()
export class PrismaWishesRepository implements WishesPort {
  constructor(private readonly prisma: PrismaService) {}

  async createWish(input: CreateWishInput): Promise<WishRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockChild(tx, input.childId)

        // ① 先看空档。`taken` 只取**活动**心愿：回收站里的不该继续占着配色。
        const active = await tx.wish.findMany({
          where: { childId: input.childId, status: 'active' },
          select: { coverStyle: true }
        })
        const taken = active.map((row) => row.coverStyle)

        // ② 先落一行拿到 id（哈希兜底分支要用它），再在同一事务里定色。
        //    占位配色取「空档优先」的结果：有空格时它**就是**最终值（不需要第二次 update）。
        //    中间态永远不会逃出事务 —— 外部要么看到最终配色，要么什么都看不到。
        const created = await tx.wish.create({
          data: {
            childId: input.childId,
            title: input.title,
            cost: input.cost,
            emoji: input.emoji,
            coverStyle: pickCoverStyle(taken, ''),
            redeemed: false,
            status: 'active'
          }
        })

        const coverStyle = pickCoverStyle(taken, created.id)
        const wish =
          coverStyle === created.coverStyle
            ? created
            : await tx.wish.update({
                where: { id: created.id },
                data: { coverStyle }
              })

        await tx.auditLog.create({
          data: {
            childId: input.childId,
            actorUserId: input.operatorUserId,
            actorRole: input.operatorRole,
            action: 'wish.create',
            targetType: 'Wish',
            targetId: wish.id,
            before: Prisma.JsonNull,
            after: wishSnapshot(wish)
          }
        })

        return toWishRow(wish)
      })
    } catch (err) {
      // 唯一约束在这里不该发生（心愿没有业务唯一键）：宁可 500，也不伪装成业务拒绝。
      this.mapWriteError(err)
    }
  }

  async deleteWish(input: DeleteWishInput): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockChild(tx, input.childId)

        const existing = await tx.wish.findFirst({
          where: { id: input.wishId, childId: input.childId }
        })
        if (existing === null) {
          throw new NotFoundException({
            code: 'WISH_NOT_FOUND',
            message:
              `心愿 ${input.wishId} 不存在或不属于孩子 ${input.childId} —— ` +
              '拒绝删除（跨孩子一律按不存在回答）。'
          })
        }

        // 幂等：已经软删过的不再写第二条审计（重复点删除不该在审计里留下两条「删除」）。
        if (existing.status === 'deleted') return existing.id

        const deleted = await tx.wish.update({
          where: { id: existing.id },
          data: { status: 'deleted', deletedAt: new Date() }
        })

        await tx.auditLog.create({
          data: {
            childId: input.childId,
            actorUserId: input.operatorUserId,
            actorRole: input.operatorRole,
            action: 'wish.delete',
            targetType: 'Wish',
            targetId: deleted.id,
            before: wishSnapshot(existing),
            after: wishSnapshot(deleted)
          }
        })

        return deleted.id
      })
    } catch (err) {
      this.mapWriteError(err)
    }
  }

  /** 锁孩子行（同一孩子的写入排队），顺带确认孩子仍然 active。 */
  private async lockChild(tx: Prisma.TransactionClient, childId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Child"
      WHERE id = ${childId} AND status = 'active'
      FOR UPDATE`
    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'CHILD_NOT_FOUND',
        message: `孩子 ${childId} 不存在或已删除 —— 心愿写入无处可落。`
      })
    }
  }

  /** 把库层失败翻成 5xx（业务拒绝已是 `HttpException`，原样抛出）。 */
  private mapWriteError(err: unknown): never {
    if (err instanceof HttpException) throw err
    throw new InternalServerErrorException({
      code: 'WISH_WRITE_FAILED',
      message: `心愿写入失败：${err instanceof Error ? err.message : String(err)}`
    })
  }
}

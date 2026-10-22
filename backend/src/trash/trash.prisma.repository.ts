import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { habitSnapshot, ruleSnapshot, wishSnapshot } from '../audit/config-snapshots'
import { lockChildBalance } from '../ledger/ledger.append'
import { PrismaService } from '../prisma/prisma.service'
import type { TrashPort, TrashTargetInput } from './trash.repository'
import type { TrashItemRow, TrashKind } from './trash.types'

/**
 * 回收站的 **Prisma 适配器**（W5-F，2026-10-21）。
 *
 * ── 三类对象为什么放在同一个适配器里 ──────────────────────────────────────
 *   回收站是**一个**界面、**一套**权限、**一种**语义（"我删掉的东西还能拿回来"）。
 *   如果按 `rules` / `wishes` / `habits` 拆成三个回收站实现，三个模块会各自回答
 *   "恢复时要不要校验父级""能不能删掉有流水的""重复删除算不算成功" ——
 *   这正是本仓库反复避免的"同一件事两份判据"。
 *
 * ── 三条铁律 ──────────────────────────────────────────────────────────────
 *   ① **只有 `status='deleted'` 的才在回收站里**：恢复/彻底删除都先验这一点
 *      （彻底删除对"还在用"的条目返回 409，绝不让一次误点直接抹掉配置）。
 *   ② **有流水就不许彻底删除**：`PointRecord` 通过 `ruleId` / `wishId` / `habitId`
 *      回指配置；物理行一旦消失，历史就再也解释不清（对账 I2 会断在"这条为什么 +5"）。
 *      这里显式数一次并 409，而不是等外键报错（`PointRecord.ruleId` 没有外键）。
 *   ③ **写就写审计**：恢复与彻底删除都在同事务写 `AuditLog`，
 *      `before` 是变更前的完整快照，彻底删除的 `after` 是 `null`。
 *
 * ── 为什么先 `lockChildBalance()` ─────────────────────────────────────────
 *   它与记账/打卡共用同一把行锁（`SELECT … FROM "Child" … FOR UPDATE`）。
 *   有了它，「数流水的 count」与「物理删除」之间不可能插进一笔新流水；
 *   否则会出现"数的时候 0 条、删的瞬间来了一条打卡"的孤儿引用。
 */

/** 三类对象的展示名（只用于错误文案；不进响应体 —— 响应只有 kind/id）。 */
const KIND_LABEL: Record<TrashKind, string> = {
  point_rule: '规则',
  wish: '心愿',
  habit: '习惯'
}

@Injectable()
export class PrismaTrashRepository implements TrashPort {
  constructor(private readonly prisma: PrismaService) {}

  async listTrash(childId: string): Promise<TrashItemRow[]> {
    // 三个查询一次发出（`$transaction([...])` 是批量，不是交互事务）。
    // ★ 只挑 4 列：回收站列表不读快照，避免把整行配置搬到接口上。
    const [rules, wishes, habits] = await this.prisma.$transaction([
      this.prisma.pointRule.findMany({
        where: { childId, status: 'deleted' },
        select: { id: true, title: true, deletedAt: true, updatedAt: true }
      }),
      this.prisma.wish.findMany({
        where: { childId, status: 'deleted' },
        select: { id: true, title: true, deletedAt: true, updatedAt: true }
      }),
      this.prisma.habit.findMany({
        where: { childId, status: 'deleted' },
        select: { id: true, title: true, deletedAt: true, updatedAt: true }
      })
    ])

    /** `deletedAt` 为空的 deleted 行只可能来自手工改库 —— 用 `updatedAt` 兜底，不丢条目。 */
    const at = (row: { deletedAt: Date | null; updatedAt: Date }): Date =>
      row.deletedAt ?? row.updatedAt

    const rows: TrashItemRow[] = [
      ...rules.map((r) => ({
        kind: 'point_rule' as const,
        id: r.id,
        title: r.title,
        deletedAt: at(r)
      })),
      ...wishes.map((w) => ({
        kind: 'wish' as const,
        id: w.id,
        title: w.title,
        deletedAt: at(w)
      })),
      ...habits.map((h) => ({
        kind: 'habit' as const,
        id: h.id,
        title: h.title,
        deletedAt: at(h)
      }))
    ]

    // 新删的排前面；同一毫秒按 id 稳定排序（两次请求结果一致，界面不会"跳"）。
    return rows.sort(
      (a, b) => b.deletedAt.getTime() - a.deletedAt.getTime() || a.id.localeCompare(b.id)
    )
  }

  async restoreTrash(input: TrashTargetInput): Promise<{ kind: TrashKind; id: string }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // 与记账/打卡同一把锁：恢复「习惯」时读到的规则状态不会被并发删除改写。
        await lockChildBalance(tx, input.childId)

        switch (input.kind) {
          case 'point_rule': {
            const existing = await tx.pointRule.findFirst({
              where: { id: input.id, childId: input.childId }
            })
            if (existing === null) throw this.notFound(input)
            // 幂等：本来就没删 ⇒ 原样返回，不写第二条审计。
            if (existing.status === 'active') return { kind: input.kind, id: existing.id }

            const restored = await tx.pointRule.update({
              where: { id: existing.id },
              data: { status: 'active', deletedAt: null }
            })
            await tx.auditLog.create({
              data: {
                childId: input.childId,
                actorUserId: input.operatorUserId,
                actorRole: input.operatorRole,
                action: 'point_rule.restore',
                targetType: 'PointRule',
                targetId: restored.id,
                before: ruleSnapshot(existing),
                after: ruleSnapshot(restored)
              }
            })
            return { kind: input.kind, id: restored.id }
          }

          case 'wish': {
            const existing = await tx.wish.findFirst({
              where: { id: input.id, childId: input.childId }
            })
            if (existing === null) throw this.notFound(input)
            if (existing.status === 'active') return { kind: input.kind, id: existing.id }

            const restored = await tx.wish.update({
              where: { id: existing.id },
              data: { status: 'active', deletedAt: null }
            })
            await tx.auditLog.create({
              data: {
                childId: input.childId,
                actorUserId: input.operatorUserId,
                actorRole: input.operatorRole,
                action: 'wish.restore',
                targetType: 'Wish',
                targetId: restored.id,
                before: wishSnapshot(existing),
                after: wishSnapshot(restored)
              }
            })
            return { kind: input.kind, id: restored.id }
          }

          case 'habit': {
            const existing = await tx.habit.findFirst({
              where: { id: input.id, childId: input.childId }
            })
            if (existing === null) throw this.notFound(input)

            // ★ 来源规则还在回收站里 ⇒ 409，而不是"恢复出来但一打卡就报 HABIT_RULE_GONE"。
            //   规则被彻底删除时 `sourceRuleId` 由 `onDelete: SetNull` 置空，走不到这里。
            if (existing.sourceRuleId !== null) {
              const rule = await tx.pointRule.findFirst({
                where: { id: existing.sourceRuleId, childId: input.childId },
                select: { title: true, status: true }
              })
              if (rule !== null && rule.status === 'deleted') {
                throw new ConflictException({
                  code: 'TRASH_PARENT_RULE_DELETED',
                  message:
                    `习惯「${existing.title}」来自规则「${rule.title}」，而那条规则还在回收站里 —— ` +
                    '请先恢复规则，再恢复这个习惯（否则打卡会立刻 HABIT_RULE_GONE）。',
                  kind: input.kind,
                  id: existing.id
                })
              }
            }

            if (existing.status === 'active') return { kind: input.kind, id: existing.id }

            const restored = await tx.habit.update({
              where: { id: existing.id },
              data: { status: 'active', deletedAt: null }
            })
            await tx.auditLog.create({
              data: {
                childId: input.childId,
                actorUserId: input.operatorUserId,
                actorRole: input.operatorRole,
                action: 'habit.restore',
                targetType: 'Habit',
                targetId: restored.id,
                before: habitSnapshot(existing),
                after: habitSnapshot(restored)
              }
            })
            return { kind: input.kind, id: restored.id }
          }
        }
      })
    } catch (err) {
      this.mapWriteError(err, 'restoreTrash')
    }
  }

  async purgeTrash(input: TrashTargetInput): Promise<{ kind: TrashKind; id: string }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockChildBalance(tx, input.childId)

        switch (input.kind) {
          case 'point_rule': {
            const existing = await tx.pointRule.findFirst({
              where: { id: input.id, childId: input.childId }
            })
            if (existing === null) throw this.notFound(input)
            this.assertPurgeable(existing.status, input)

            // ★ 流水通过 `ruleId` 回指规则（该列**没有**外键：删了不会报错，只会断账）。
            const records = await tx.pointRecord.count({
              where: { childId: input.childId, ruleId: existing.id }
            })
            if (records > 0) throw this.referenced(input, records)

            await tx.auditLog.create({
              data: {
                childId: input.childId,
                actorUserId: input.operatorUserId,
                actorRole: input.operatorRole,
                action: 'point_rule.purge',
                targetType: 'PointRule',
                targetId: existing.id,
                before: ruleSnapshot(existing),
                after: Prisma.JsonNull
              }
            })
            // 版本行是 `onDelete: Restrict`：必须显式先删（I3 的复合外键从两侧同时消失）。
            await tx.pointRuleVersion.deleteMany({ where: { ruleId: existing.id } })
            await tx.pointRule.delete({ where: { id: existing.id } })
            return { kind: input.kind, id: existing.id }
          }

          case 'wish': {
            const existing = await tx.wish.findFirst({
              where: { id: input.id, childId: input.childId }
            })
            if (existing === null) throw this.notFound(input)
            this.assertPurgeable(existing.status, input)

            const records = await tx.pointRecord.count({
              where: { childId: input.childId, wishId: existing.id }
            })
            if (records > 0) throw this.referenced(input, records)

            await tx.auditLog.create({
              data: {
                childId: input.childId,
                actorUserId: input.operatorUserId,
                actorRole: input.operatorRole,
                action: 'wish.purge',
                targetType: 'Wish',
                targetId: existing.id,
                before: wishSnapshot(existing),
                after: Prisma.JsonNull
              }
            })
            await tx.wish.delete({ where: { id: existing.id } })
            return { kind: input.kind, id: existing.id }
          }

          case 'habit': {
            const existing = await tx.habit.findFirst({
              where: { id: input.id, childId: input.childId }
            })
            if (existing === null) throw this.notFound(input)
            this.assertPurgeable(existing.status, input)

            const records = await tx.pointRecord.count({
              where: { childId: input.childId, habitId: existing.id }
            })
            if (records > 0) throw this.referenced(input, records)

            await tx.auditLog.create({
              data: {
                childId: input.childId,
                actorUserId: input.operatorUserId,
                actorRole: input.operatorRole,
                action: 'habit.purge',
                targetType: 'Habit',
                targetId: existing.id,
                before: habitSnapshot(existing),
                after: Prisma.JsonNull
              }
            })
            await tx.habit.delete({ where: { id: existing.id } })
            return { kind: input.kind, id: existing.id }
          }
        }
      })
    } catch (err) {
      this.mapWriteError(err, 'purgeTrash')
    }
  }

  /** 目标不在库里 / 不属于这个孩子（跨孩子一律按不存在回答）。 */
  private notFound(input: TrashTargetInput): NotFoundException {
    return new NotFoundException({
      code: 'TRASH_ITEM_NOT_FOUND',
      message:
        `${KIND_LABEL[input.kind]} ${input.id} 不在回收站里（不存在、不属于孩子 ` +
        `${input.childId}，或已被彻底删除）。`,
      kind: input.kind,
      id: input.id
    })
  }

  /** 彻底删除只对「已软删」的条目开放 —— 避免一次误点从在用列表里抹掉配置。 */
  private assertPurgeable(status: string, input: TrashTargetInput): void {
    if (status === 'deleted') return
    throw new ConflictException({
      code: 'TRASH_ITEM_NOT_DELETED',
      message:
        `${KIND_LABEL[input.kind]} ${input.id} 还在使用中（status=${status}）—— ` +
        '请先把它移到回收站，再彻底删除。',
      kind: input.kind,
      id: input.id
    })
  }

  /** 还有流水指着它 ⇒ 不许物理删除（否则历史记录无法解释）。 */
  private referenced(input: TrashTargetInput, records: number): ConflictException {
    return new ConflictException({
      code: 'TRASH_ITEM_REFERENCED',
      message:
        `${KIND_LABEL[input.kind]} ${input.id} 已被 ${records} 条流水引用（历史打卡/兑换）—— ` +
        '彻底删除会让这些记录无法解释。保留在回收站即可：它不会出现在任何清单里。',
      kind: input.kind,
      id: input.id,
      records
    })
  }

  /** 把库层失败翻成 4xx（其余原样抛出 ⇒ 500，不伪装成业务拒绝）。 */
  private mapWriteError(err: unknown, operation: 'restoreTrash' | 'purgeTrash'): never {
    if (err instanceof ConflictException || err instanceof NotFoundException) throw err

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        throw new NotFoundException({
          code: 'TRASH_ITEM_NOT_FOUND',
          message: `${operation} 期间这一项已经不存在了 —— 请刷新回收站。`
        })
      }
      if (err.code === 'P2003') {
        // 理论上被「count + 孩子行锁」挡住；真的漏了也**不能**回落成 500。
        throw new ConflictException({
          code: 'TRASH_ITEM_REFERENCED',
          message: '还有记录引用这一项，数据库拒绝了物理删除 —— 请改用「恢复」或保留在回收站。'
        })
      }
    }
    throw err
  }
}

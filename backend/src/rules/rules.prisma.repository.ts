import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type { HabitRow, RuleRow } from '../read/read.repository'
import type {
  AddHabitFromRuleInput,
  CreateRuleInput,
  DeleteRuleInput,
  RulesPort,
  UpdateRuleInput
} from './rules.repository'

/**
 * 规则写入的 **Prisma 适配器**（W5-A，2026-10-19）。
 *
 * ── 三个事务的形状（顺序有理由，不要重排）──────────────────────────────────
 *   新建：锁孩子 → 建 PointRule → 建 PointRuleVersion v1 → 写 AuditLog
 *   编辑：锁孩子 → 读规则（active）→ 校验 expectedVersion → 归档 v+1 →
 *         条件更新主体（`WHERE currentVersion = expected`）→ 同步派生习惯 → 写审计
 *   派生：锁孩子 → 读规则（active）→ 拒绝扣分规则 / 重复习惯 → 建 Habit → 写审计
 *
 *   ★ `PointRuleVersion` 在**改主体之前**插入、且与主体更新同一事务：
 *     先改主体再补版本，中间那一瞬 `currentVersion` 会指向一条不存在的行。
 *     事务外看不见这个中间态，但把顺序写对可以让「回放」在任何隔离级别下都成立。
 *
 * ── 为什么编辑要 "先读后条件更新" ─────────────────────────────────────────
 *   两个家长同时从第 3 版提交：都读到 3；第一个条件更新成功（→4），第二个
 *   的 `UPDATE ... WHERE currentVersion = 3` 影响 0 行 ⇒ 409 `RULE_VERSION_CONFLICT`。
 *   只靠"读到的版本"判断（TOCTOU）会在两个事务都读到 3 时双双通过 —— 那是
 *   第二种"最后写入者赢"，正是 C10 要消灭的东西。
 *
 * ── 版本行永不删 ──────────────────────────────────────────────────────────
 *   删除只把 `PointRule.status` 改成 `deleted`；历史流水的
 *   `(ruleId, ruleVersion)` 复合外键仍指向版本行（I3）。
 */
@Injectable()
export class PrismaRulesRepository implements RulesPort {
  constructor(private readonly prisma: PrismaService) {}

  async createRule(input: CreateRuleInput): Promise<RuleRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockChild(tx, input.childId)

        const created = await tx.pointRule.create({
          data: {
            childId: input.childId,
            title: input.title,
            condition: input.condition,
            dailyLimit: input.dailyLimit,
            points: input.points,
            direction: input.direction,
            icon: input.icon,
            color: input.color,
            currentVersion: 1
          }
        })

        await tx.pointRuleVersion.create({
          data: {
            ruleId: created.id,
            version: 1,
            title: created.title,
            condition: created.condition,
            dailyLimit: created.dailyLimit,
            points: created.points,
            direction: created.direction,
            changedByUserId: input.operatorUserId,
            changeNote: '新建规则'
          }
        })

        await tx.auditLog.create({
          data: {
            childId: input.childId,
            actorUserId: input.operatorUserId,
            actorRole: input.operatorRole,
            action: 'point_rule.create',
            targetType: 'PointRule',
            targetId: created.id,
            before: Prisma.JsonNull,
            after: ruleSnapshot(created)
          }
        })

        return toRuleRow(created)
      })
    } catch (err) {
      this.mapWriteError(err)
    }
  }


  async updateRule(input: UpdateRuleInput): Promise<RuleRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockChild(tx, input.childId)

        const existing = await tx.pointRule.findFirst({
          where: { id: input.ruleId, childId: input.childId, status: 'active' }
        })
        if (existing === null) {
          throw new NotFoundException({
            code: 'RULE_NOT_FOUND',
            message:
              `规则 ${input.ruleId} 不存在、不属于孩子 ${input.childId}，或已被删除 —— ` +
              '拒绝编辑（跨孩子一律按不存在回答）。'
          })
        }
        if (existing.currentVersion !== input.expectedVersion) {
          throw new ConflictException({
            code: 'RULE_VERSION_CONFLICT',
            message:
              `规则 ${input.ruleId} 当前是第 ${existing.currentVersion} 版，` +
              `而本次编辑基于第 ${input.expectedVersion} 版 —— ` +
              '拒绝覆盖别人的修改，请刷新规则后重试。',
            details: {
              ruleId: input.ruleId,
              currentVersion: existing.currentVersion,
              expectedVersion: input.expectedVersion
            }
          })
        }

        const nextVersion = existing.currentVersion + 1

        // ① 先归档新版本（装的是**新值**）—— 见文件头「三个事务的形状」。
        await tx.pointRuleVersion.create({
          data: {
            ruleId: existing.id,
            version: nextVersion,
            title: input.title,
            condition: input.condition,
            dailyLimit: input.dailyLimit,
            points: input.points,
            direction: input.direction,
            changedByUserId: input.operatorUserId,
            changeNote: '编辑规则'
          }
        })

        // ② 条件更新主体：`WHERE currentVersion = expectedVersion` 是并发安全的那一半。
        const updated = await tx.pointRule.updateMany({
          where: {
            id: existing.id,
            childId: input.childId,
            status: 'active',
            currentVersion: input.expectedVersion
          },
          data: {
            title: input.title,
            condition: input.condition,
            dailyLimit: input.dailyLimit,
            points: input.points,
            direction: input.direction,
            currentVersion: nextVersion
          }
        })
        if (updated.count !== 1) {
          // 事务回滚会把刚插入的版本行一并撤掉 —— 不会留下"版本 +1 但主体没改"。
          throw new ConflictException({
            code: 'RULE_VERSION_CONFLICT',
            message:
              `规则 ${input.ruleId} 在本次编辑期间被其他人改过（条件更新影响 0 行）—— ` +
              '请刷新后重试。',
            details: { ruleId: input.ruleId, expectedVersion: input.expectedVersion }
          })
        }

        // ③ 派生同步：由这条规则生成的首页习惯跟着新规走（§3.2「未来从新规」）。
        //    习惯是规则的**派生**，不单独写审计 —— 否则一次修改会产生两条审计。
        await tx.habit.updateMany({
          where: {
            childId: input.childId,
            sourceRuleId: existing.id,
            status: 'active'
          },
          data: {
            title: input.title,
            condition: input.condition,
            dailyLimit: input.dailyLimit,
            points: input.points
          }
        })

        const after = {
          ...ruleSnapshot(existing),
          title: input.title,
          condition: input.condition,
          dailyLimit: input.dailyLimit,
          points: input.points,
          direction: input.direction,
          currentVersion: nextVersion
        }

        // ④ 审计：before / after 是真快照（C11）。
        await tx.auditLog.create({
          data: {
            childId: input.childId,
            actorUserId: input.operatorUserId,
            actorRole: input.operatorRole,
            action: 'point_rule.update',
            targetType: 'PointRule',
            targetId: existing.id,
            before: ruleSnapshot(existing),
            after
          }
        })

        return toRuleRow({
          ...existing,
          title: input.title,
          condition: input.condition,
          dailyLimit: input.dailyLimit,
          points: input.points,
          direction: input.direction,
          currentVersion: nextVersion
        })
      })
    } catch (err) {
      this.mapWriteError(err)
    }
  }

  async deleteRule(input: DeleteRuleInput): Promise<string> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockChild(tx, input.childId)

        const existing = await tx.pointRule.findFirst({
          where: { id: input.ruleId, childId: input.childId }
        })
        if (existing === null) {
          throw new NotFoundException({
            code: 'RULE_NOT_FOUND',
            message:
              `规则 ${input.ruleId} 不存在或不属于孩子 ${input.childId} —— ` +
              '拒绝删除（跨孩子一律按不存在回答）。'
          })
        }

        // 已经删过：原样返回，不再写第二条审计（重复点击不是第二次变更）。
        if (existing.status === 'deleted') return existing.id

        const deletedAt = new Date()
        await tx.pointRule.update({
          where: { id: existing.id },
          data: { status: 'deleted', deletedAt }
        })

        await tx.auditLog.create({
          data: {
            childId: input.childId,
            actorUserId: input.operatorUserId,
            actorRole: input.operatorRole,
            action: 'point_rule.delete',
            targetType: 'PointRule',
            targetId: existing.id,
            before: ruleSnapshot(existing),
            after: {
              ...ruleSnapshot(existing),
              status: 'deleted',
              deletedAt: deletedAt.toISOString()
            }
          }
        })

        // ★ 版本行**不删**：删掉会让历史流水的 (ruleId, ruleVersion) 指向空（02 §5.6）。
        return existing.id
      })
    } catch (err) {
      this.mapWriteError(err)
    }
  }

  async addHabitFromRule(input: AddHabitFromRuleInput): Promise<HabitRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockChild(tx, input.childId)

        const rule = await tx.pointRule.findFirst({
          where: { id: input.ruleId, childId: input.childId, status: 'active' }
        })
        if (rule === null) {
          throw new NotFoundException({
            code: 'RULE_NOT_FOUND',
            message:
              `规则 ${input.ruleId} 不存在、不属于孩子 ${input.childId}，或已被删除 —— ` +
              '无法加入今天的习惯。'
          })
        }
        if (rule.direction === 'penalty') {
          // 修 A1：负分规则不能靠 abs 变成"打卡加分"。
          throw new ConflictException({
            code: 'RULE_IS_PENALTY',
            message:
              `规则「${rule.title}」是扣分规则 —— 扣分不应变成孩子主动打卡加分的习惯，拒绝。`
          })
        }

        const duplicate = await tx.habit.findFirst({
          where: {
            childId: input.childId,
            status: 'active',
            OR: [{ sourceRuleId: rule.id }, { title: rule.title }]
          },
          select: { id: true }
        })
        if (duplicate !== null) {
          throw new ConflictException({
            code: 'HABIT_ALREADY_EXISTS',
            message:
              `「${rule.title}」已经在今天的习惯里了（习惯 ${duplicate.id}）—— ` +
              '拒绝重复添加。',
            details: { habitId: duplicate.id, ruleId: rule.id }
          })
        }

        const habit = await tx.habit.create({
          data: {
            childId: input.childId,
            sourceRuleId: rule.id,
            title: rule.title,
            points: rule.points,
            condition: rule.condition,
            dailyLimit: rule.dailyLimit,
            icon: rule.icon,
            color: rule.color
          }
        })

        await tx.auditLog.create({
          data: {
            childId: input.childId,
            actorUserId: input.operatorUserId,
            actorRole: input.operatorRole,
            action: 'habit.create',
            targetType: 'Habit',
            targetId: habit.id,
            before: Prisma.JsonNull,
            after: {
              habitId: habit.id,
              sourceRuleId: rule.id,
              title: habit.title,
              points: habit.points,
              condition: habit.condition,
              dailyLimit: habit.dailyLimit,
              icon: habit.icon,
              color: habit.color
            }
          }
        })

        return {
          id: habit.id,
          title: habit.title,
          points: habit.points,
          condition: habit.condition,
          dailyLimit: habit.dailyLimit,
          icon: habit.icon,
          color: habit.color,
          ruleId: habit.sourceRuleId
        }
      })
    } catch (err) {
      this.mapWriteError(err)
    }
  }

  /**
   * 锁孩子行 —— 既是存在性检查（`status='active'`），也让同一孩子的规则写入排队。
   * ★ 不加锁时，两个"加入今天的习惯"会同时通过重复检查（TOCTOU）。
   */
  private async lockChild(tx: Prisma.TransactionClient, childId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Child"
      WHERE id = ${childId} AND status = 'active'
      FOR UPDATE`
    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'CHILD_NOT_FOUND',
        message: `孩子 ${childId} 不存在或已删除 —— 规则写入无处可落。`
      })
    }
  }

  /** 把库层失败翻成 4xx（其余原样抛出 ⇒ 500，不伪装成业务拒绝）。 */
  private mapWriteError(err: unknown): never {
    if (err instanceof HttpException) throw err

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        throw new ConflictException({
          code: 'RULE_VERSION_CONFLICT',
          message:
            '写入违反唯一约束（同一规则的同一版本只能存在一行）—— ' +
            '可能有人同时修改了这条规则，请刷新后重试。',
          details: err.meta ?? null
        })
      }
      if (err.code === 'P2003') {
        throw new NotFoundException({
          code: 'CHILD_NOT_FOUND',
          message: '写入违反外键：孩子或操作人不存在 —— 拒绝留下一条无法追溯的规则。'
        })
      }
      if (err.code === 'P2025') {
        throw new NotFoundException({
          code: 'RULE_NOT_FOUND',
          message: '要修改的规则不存在或已被删除。'
        })
      }
    }
    throw err
  }
}

/** 审计快照的**结构字段**（不含 createdAt 等派生值）。 */
function ruleSnapshot(row: {
  id: string
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: string
  icon: string
  color: string
  currentVersion: number
  status?: string
  deletedAt?: Date | null
}): Prisma.InputJsonObject {
  return {
    id: row.id,
    title: row.title,
    condition: row.condition,
    dailyLimit: row.dailyLimit,
    points: row.points,
    direction: row.direction,
    icon: row.icon,
    color: row.color,
    currentVersion: row.currentVersion,
    status: row.status ?? 'active',
    deletedAt: row.deletedAt === undefined || row.deletedAt === null
      ? null
      : row.deletedAt.toISOString()
  }
}

function toRuleRow(row: {
  id: string
  title: string
  condition: string
  dailyLimit: number
  points: number
  direction: 'reward' | 'penalty'
  icon: string
  color: string
  currentVersion: number
}): RuleRow {
  return {
    id: row.id,
    title: row.title,
    condition: row.condition,
    dailyLimit: row.dailyLimit,
    points: row.points,
    direction: row.direction,
    icon: row.icon,
    color: row.color,
    currentVersion: row.currentVersion
  }
}


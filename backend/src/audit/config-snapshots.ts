import { Prisma } from '@prisma/client'

/**
 * 「配置类对象」的**审计快照**（W5-F，2026-10-21）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────────────
 *   快照要回答的是「改之前是什么、改之后是什么」，因此它必须**只含事实**
 *   （可回放的值），不含展示串、不含派生 UI 状态。三个写入点会用到同一份形状：
 *   · `habits.prisma.repository.ts` 的软删（`habit.delete`）
 *   · `trash.prisma.repository.ts` 的恢复（`*.restore`）与彻底删除（`*.purge`）
 *   放在各自文件里就会出现"删除时记了 9 个字段、恢复时只记了 4 个"——
 *   两次快照对不上，审计就退化成日志。
 *
 *   只做 **Date → ISO 串** 的转换：`AuditLog.before/after` 是 `jsonb`，
 *   Prisma 的 `InputJsonObject` 不接受 `Date`（会编译不过，运行时也不会替你转）。
 */

export function ruleSnapshot(rule: {
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
  deletedAt: Date | null
}): Prisma.InputJsonObject {
  return {
    id: rule.id,
    title: rule.title,
    condition: rule.condition,
    dailyLimit: rule.dailyLimit,
    points: rule.points,
    direction: rule.direction,
    icon: rule.icon,
    color: rule.color,
    currentVersion: rule.currentVersion,
    status: rule.status,
    deletedAt: rule.deletedAt === null ? null : rule.deletedAt.toISOString()
  }
}

export function wishSnapshot(wish: {
  id: string
  title: string
  cost: number
  emoji: string
  coverStyle: string
  redeemed: boolean
  redeemedAt: Date | null
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
    redeemedAt: wish.redeemedAt === null ? null : wish.redeemedAt.toISOString(),
    status: wish.status,
    deletedAt: wish.deletedAt === null ? null : wish.deletedAt.toISOString()
  }
}

export function habitSnapshot(habit: {
  id: string
  title: string
  condition: string
  points: number
  dailyLimit: number
  icon: string
  color: string
  sourceRuleId: string | null
  status: string
  deletedAt: Date | null
}): Prisma.InputJsonObject {
  return {
    id: habit.id,
    title: habit.title,
    condition: habit.condition,
    points: habit.points,
    dailyLimit: habit.dailyLimit,
    icon: habit.icon,
    color: habit.color,
    sourceRuleId: habit.sourceRuleId,
    status: habit.status,
    deletedAt: habit.deletedAt === null ? null : habit.deletedAt.toISOString()
  }
}

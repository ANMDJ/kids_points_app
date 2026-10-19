import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { appendDraftInTx } from '../ledger/ledger.append'
import {
  buildRecordDraft,
  LedgerDeniedError,
  LedgerShapeError,
  reverseRecordDraft,
  type ReversibleRecord,
  type RuleVersionSnapshot
} from '../ledger/ledger.gate'
import { PrismaService } from '../prisma/prisma.service'
import type { RecordRow } from '../read/read.repository'
import { businessDayOf, resolveBusinessTimeZone, type BusinessDay } from './business-day'
import type { CheckInInput, HabitsPort, ReverseRecordInput } from './habits.repository'

/**
 * 打卡 / 撤销打卡的 **Prisma 适配器**（W4-D，2026-10-19）。
 *
 * ── 一个事务里发生什么（顺序有理由，不要重排）──────────────────────────────
 *   ① `SELECT … FOR UPDATE` 锁住孩子余额行 ⇒ 同一孩子的写入**排队**；
 *   ② 读库钟 ⇒ 求**业务日**（默认 Asia/Shanghai）—— 上限必须按家里墙上的日历算；
 *   ③ 读 habit（同孩子 + `active`）⇒ 跨孩子/已删除一律 404；
 *   ④ 若 habit 来自规则：读规则（`active`）＋ `(ruleId, currentVersion)` 版本行；
 *   ⑤ 数「本业务日**仍有效**的打卡」（排除已冲正、排除冲正记录本身）；
 *   ⑥ 内核 `buildRecordDraft()` 构造草稿（符号/快照/余额由它算，本文件不重算）；
 *   ⑦ `appendDraftInTx()`（锁 + 库钟 + 余额 CAS + 严格递增 `createdAt`）；
 *   ⑧ 同事务写 `AuditLog`。
 *   任何一步失败 ⇒ 全部回滚 ⇒ 不会留下"分加了但审计没有""上限过了但分没加"的中间态。
 *
 * ── 撤销为什么也在这里 ─────────────────────────────────────────────────────
 *   "什么算打卡"的判据只有一份：`category='praise'` + `habitId` 非空 + 非冲正。
 *   撤销读的正是这些字段；放到另一个适配器会立刻出现第二份判据。撤销**不改原行**
 *   （I5：应用角色对 `PointRecord` 无 UPDATE 权限），而是追加一条 `correction` 记录。
 */

/** 规则方向只允许加分 —— 惩罚规则不能"打卡"（修 A1）。 */
const CHECK_IN_DIRECTION = 'reward'

@Injectable()
export class PrismaHabitsRepository implements HabitsPort {
  private readonly timeZone: string

  constructor(private readonly prisma: PrismaService) {
    // 与 `HabitsService` 同一判据；配错在**装配时**就炸（不是第一笔打卡时）。
    this.timeZone = resolveBusinessTimeZone(process.env.KP_TIMEZONE)
  }


  async checkIn(input: CheckInInput): Promise<RecordRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const balance = await this.lockChild(tx, input.childId)
        const day = await this.businessDayNow(tx)

        const habit = await tx.habit.findFirst({
          where: { id: input.habitId, childId: input.childId, status: 'active' },
          select: {
            id: true,
            title: true,
            condition: true,
            points: true,
            dailyLimit: true,
            sourceRuleId: true
          }
        })
        if (habit === null) {
          // ★ 跨孩子与"不存在"给同一个 404：不能泄露"另一家有个这个 id 的习惯"。
          throw new NotFoundException({
            code: 'HABIT_NOT_FOUND',
            message:
              `习惯 ${input.habitId} 不存在、不属于孩子 ${input.childId}，或已被删除 —— ` +
              '拒绝打卡（跨孩子一律按不存在回答）。'
          })
        }

        if (!Number.isInteger(habit.dailyLimit) || habit.dailyLimit < 1) {
          throw new InternalServerErrorException({
            code: 'HABIT_DAILY_LIMIT_INVALID',
            message:
              `习惯 ${habit.id} 的 dailyLimit=${JSON.stringify(habit.dailyLimit)} 不是正整数 —— ` +
              '配置已损坏，拒绝按一个猜出来的上限记账。'
          })
        }
        if (!Number.isInteger(habit.points) || habit.points <= 0) {
          throw new ConflictException({
            code: 'HABIT_POINTS_INVALID',
            message:
              `习惯 ${habit.id} 的 points=${JSON.stringify(habit.points)} 不是正整数 —— ` +
              '打卡是"完成一件好事"，分值必须为正（修 A1：负分不能靠 Math.abs 抹平）。'
          })
        }

        const ruleVersionRow = await this.readHabitRuleVersion(
          tx,
          input.childId,
          habit.sourceRuleId,
          habit.points
        )

        // ⑤ 只数**仍有效**的打卡：被冲正的原记录不算次数（否则撤销后名额仍被占着，
        //    真库用例钉着"撤销后可以再打一次"），冲正记录本身也不算。
        const checkedCount = await tx.pointRecord.count({
          where: {
            childId: input.childId,
            habitId: habit.id,
            category: 'praise',
            source: { not: 'correction' },
            reversesRecordId: null,
            reversedBy: { none: {} },
            createdAt: { gte: day.start, lt: day.end }
          }
        })
        if (checkedCount >= habit.dailyLimit) {
          throw new ConflictException({
            code: 'HABIT_DAILY_LIMIT_REACHED',
            message:
              `习惯「${habit.title}」今天（${day.day}，${day.timeZone}）已经完成 ` +
              `${checkedCount} 次，上限 ${habit.dailyLimit} 次 —— 拒绝第 ${checkedCount + 1} 次。`,
            details: {
              habitId: habit.id,
              checkedCount,
              dailyLimit: habit.dailyLimit,
              day: day.day,
              timeZone: day.timeZone
            }
          })
        }

        // ⑥ 内核构造：符号、快照、balanceAfter、零/负余额判定只在内核里。
        const draft = buildRecordDraft({
          childId: input.childId,
          ruleVersionRow,
          titleSnapshot: ruleVersionRow === null ? habit.title : undefined,
          pointsDelta: habit.points,
          category: 'praise',
          source: input.source,
          operator: { userId: input.operatorUserId, role: input.operatorRole },
          habitId: habit.id,
          idempotencyKey: input.idempotencyKey ?? null,
          currentBalance: balance,
          now: input.now
        })

        const record = await appendDraftInTx(tx, draft)

        await tx.auditLog.create({
          data: {
            childId: input.childId,
            actorUserId: input.operatorUserId,
            actorRole: input.operatorRole,
            action: 'point_record.check_in',
            targetType: 'PointRecord',
            targetId: record.id,
            after: {
              recordId: record.id,
              habitId: habit.id,
              habitTitle: habit.title,
              pointsDelta: record.pointsDelta,
              balanceAfter: record.balanceAfter,
              category: record.category,
              source: record.source,
              ruleId: record.ruleId,
              ruleVersion: record.ruleVersion,
              idempotencyKey: input.idempotencyKey ?? null,
              businessDay: day.day,
              timeZone: day.timeZone
            }
          }
        })

        return record
      })
    } catch (err) {
      this.mapWriteError(err, 'checkIn')
    }
  }

  async reverse(input: ReverseRecordInput): Promise<RecordRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const balance = await this.lockChild(tx, input.childId)

        const original = await tx.pointRecord.findFirst({
          where: { id: input.recordId, childId: input.childId },
          select: {
            id: true,
            childId: true,
            titleSnapshot: true,
            pointsDelta: true,
            source: true,
            ruleId: true,
            ruleVersion: true,
            habitId: true,
            wishId: true,
            reversesRecordId: true,
            category: true
          }
        })
        if (original === null) {
          throw new NotFoundException({
            code: 'RECORD_NOT_FOUND',
            message:
              `流水 ${input.recordId} 不存在或不属于孩子 ${input.childId} —— ` +
              '拒绝撤销（跨孩子一律按不存在回答）。'
          })
        }

        assertIsHabitCheckIn(original)

        const ruleVersionRow = await this.readOriginalRuleVersion(tx, original)

        // 同一事务内读「有没有人已经指向我」—— 与库层唯一约束（undo: 键）一起防并发双冲。
        const reversal = await tx.pointRecord.findFirst({
          where: { childId: input.childId, reversesRecordId: original.id },
          select: { id: true }
        })

        const draft = reverseRecordDraft(original, {
          operator: { userId: input.operatorUserId, role: input.operatorRole },
          currentBalance: balance,
          alreadyReversedIds: reversal === null ? [] : [original.id],
          ruleVersionRow,
          note: input.note,
          now: input.now
        })
        // ★ 撤销必须是**幂等**的：同一原记录只能产生一条冲正（库层唯一约束兜底）。
        //   内核把 idempotencyKey 固定为 null（它是通用构造器），这里补上业务键 ——
        //   不改内核，也不依赖"先查后写"。
        draft.idempotencyKey = `undo:${original.id}`

        const record = await appendDraftInTx(tx, draft)

        await tx.auditLog.create({
          data: {
            childId: input.childId,
            actorUserId: input.operatorUserId,
            actorRole: input.operatorRole,
            action: 'point_record.undo_check_in',
            targetType: 'PointRecord',
            targetId: record.id,
            before: {
              originalRecordId: original.id,
              title: original.titleSnapshot,
              pointsDelta: original.pointsDelta,
              habitId: original.habitId,
              ruleId: original.ruleId,
              ruleVersion: original.ruleVersion
            },
            after: {
              recordId: record.id,
              reversesRecordId: original.id,
              pointsDelta: record.pointsDelta,
              balanceAfter: record.balanceAfter,
              note: record.note
            }
          }
        })

        return record
      })
    } catch (err) {
      this.mapWriteError(err, 'reverse')
    }
  }


  /** 锁孩子余额行；不存在 / 已删除 ⇒ 404（绝不按 0 分兜底）。 */
  private async lockChild(tx: Prisma.TransactionClient, childId: string): Promise<number> {
    const rows = await tx.$queryRaw<{ pointsBalance: number }[]>`
      SELECT "pointsBalance" FROM "Child"
      WHERE "id" = ${childId} AND "status" = 'active'
      FOR UPDATE`
    if (rows.length === 0) {
      throw new NotFoundException({
        code: 'CHILD_NOT_FOUND',
        message: `孩子 ${childId} 不存在或已删除 —— 打卡无处可记。`
      })
    }
    return rows[0].pointsBalance
  }

  /**
   * 库钟 → 业务日。
   * ★ 用 `clock_timestamp()` 而不是应用进程的 `new Date()`：限量查询的窗口与
   *   `PointRecord.createdAt` 必须来自**同一个时钟**，否则进程与数据库差几秒，
   *   跨日瞬间会数错一天。
   */
  private async businessDayNow(tx: Prisma.TransactionClient): Promise<BusinessDay> {
    const [clock] = await tx.$queryRaw<{ ts: Date }[]>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS ts`
    return businessDayOf(clock.ts, this.timeZone)
  }

  /**
   * 习惯来自规则时：规则必须仍 `active`，版本行必须是 `currentVersion`，
   * 且分值与习惯一致。返回 `null` = 习惯与规则无关（"记一笔"式习惯）。
   */
  private async readHabitRuleVersion(
    tx: Prisma.TransactionClient,
    childId: string,
    sourceRuleId: string | null,
    habitPoints: number
  ): Promise<RuleVersionSnapshot | null> {
    if (sourceRuleId === null) return null

    const rule = await tx.pointRule.findFirst({
      where: { id: sourceRuleId, childId, status: 'active' },
      select: { id: true, currentVersion: true }
    })
    if (rule === null) {
      throw new ConflictException({
        code: 'HABIT_RULE_GONE',
        message:
          `习惯引用的规则 ${sourceRuleId} 不存在、不属于孩子 ${childId}，或已被删除 —— ` +
          '拒绝打卡：不能按一条已经消失的规则加分。'
      })
    }

    const version = await tx.pointRuleVersion.findUnique({
      where: { ruleId_version: { ruleId: rule.id, version: rule.currentVersion } },
      select: {
        ruleId: true,
        version: true,
        title: true,
        condition: true,
        dailyLimit: true,
        points: true,
        direction: true
      }
    })
    if (version === null) {
      throw new ConflictException({
        code: 'HABIT_RULE_VERSION_MISSING',
        message:
          `规则 ${rule.id} 的 currentVersion=${rule.currentVersion} 没有对应版本行 —— ` +
          '数据已损坏（I3 要求版本行永久保留），拒绝写一条指向空气的流水。'
      })
    }
    if (version.direction !== CHECK_IN_DIRECTION) {
      throw new ConflictException({
        code: 'HABIT_RULE_DIRECTION_MISMATCH',
        message:
          `习惯引用的规则 ${rule.id}#${version.version} 方向是 ${version.direction} —— ` +
          '打卡只能执行 reward 规则（修 A1：惩罚规则不能靠 Math.abs 变成加分）。'
      })
    }
    if (version.points !== habitPoints) {
      throw new ConflictException({
        code: 'HABIT_RULE_POINTS_MISMATCH',
        message:
          `习惯分值 ${habitPoints} 与规则 ${rule.id}#${version.version} 的 ` +
          `${version.points} 不一致 —— 拒绝用两个互相矛盾的数加分（以哪边为准都是猜）。`
      })
    }
    return version
  }


  /** 原记录带 `ruleId` 时，冲正必须继承**同一版**（修 C10）。 */
  private async readOriginalRuleVersion(
    tx: Prisma.TransactionClient,
    original: ReversibleRecord
  ): Promise<RuleVersionSnapshot | null> {
    if (original.ruleId === null) return null
    if (original.ruleVersion === null) {
      throw new ConflictException({
        code: 'RECORD_RULE_VERSION_MISSING',
        message:
          `原记录 ${original.id} 带 ruleId=${original.ruleId} 却没有 ruleVersion —— ` +
          '数据已损坏，冲正记录无法继承"哪一版规则产生了这笔分"。'
      })
    }
    const version = await tx.pointRuleVersion.findUnique({
      where: { ruleId_version: { ruleId: original.ruleId, version: original.ruleVersion } },
      select: {
        ruleId: true,
        version: true,
        title: true,
        condition: true,
        dailyLimit: true,
        points: true,
        direction: true
      }
    })
    if (version === null) {
      throw new ConflictException({
        code: 'RECORD_RULE_VERSION_MISSING',
        message:
          `原记录 ${original.id} 指向 ${original.ruleId}#${original.ruleVersion}，但版本行不存在 —— ` +
          '拒绝一条解释不清的冲正。'
      })
    }
    return version
  }

  /** 把库层 / 内核的失败翻成 4xx（其余原样抛出 ⇒ 500，不伪装成业务拒绝）。 */
  private mapWriteError(err: unknown, operation: 'checkIn' | 'reverse'): never {
    if (err instanceof HttpException) throw err

    if (err instanceof LedgerDeniedError) {
      // 余额不足 / 已冲正 / 冲正的冲正 / 零变动 —— 都是"规则赢了"，不是服务器炸了。
      throw new ConflictException({ code: err.code, message: err.message })
    }
    if (err instanceof LedgerShapeError) {
      // 形状错误代表数据/装配出了问题（例如快照与版本行不一致）⇒ 500，绝不静默落库。
      throw new InternalServerErrorException({
        code: 'LEDGER_SHAPE_ERROR',
        detail: err.code,
        message: err.message
      })
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        if (JSON.stringify(err.meta ?? {}).includes('idempotencyKey')) {
          if (operation === 'reverse') {
            throw new ConflictException({
              code: 'RECORD_ALREADY_REVERSED',
              message:
                '这条记录已经被撤销过（同一原记录只能产生一条冲正）—— 再撤一次会让余额翻倍。'
            })
          }
          throw new ConflictException({
            code: 'RECORD_DUPLICATE_IDEMPOTENCY_KEY',
            message:
              '这个 Idempotency-Key 在这个孩子上已经产生过一笔流水 —— 重放被数据库唯一约束拦下。' +
              '（若上一次响应丢失，请用同一个 key 重试；幂等层会返回首次结果。）'
          })
        }
        throw new ConflictException({
          code: 'RECORD_UNIQUE_VIOLATION',
          message: `写入违反唯一约束：${JSON.stringify(err.meta ?? {})}`
        })
      }
      if (err.code === 'P2003') {
        throw new ConflictException({
          code: 'RECORD_RULE_VERSION_MISSING',
          message:
            '写入违反外键：流水指向的规则版本行不存在（I3 由数据库复合外键强制）—— 拒绝。'
        })
      }
    }
    throw err
  }
}

/** 打卡只允许来自 `praise` + 具体习惯 + 非冲正记录（见文件头「撤销为什么也在这里」）。 */
function assertIsHabitCheckIn(original: ReversibleRecord & { category: string }): void {
  // 冲正记录交给内核报 `CANNOT_REVERSE_REVERSAL`（语义更准确：不是"不像打卡"，是"不能再冲"）。
  if (original.reversesRecordId !== null) return

  if (original.category !== 'praise' || original.habitId === null || original.wishId !== null) {
    throw new ConflictException({
      code: 'NOT_A_HABIT_CHECK_IN',
      message:
        `流水 ${original.id} 不是习惯打卡（category=${original.category}, ` +
        `habitId=${JSON.stringify(original.habitId)}, wishId=${JSON.stringify(original.wishId)}）—— ` +
        '只有打卡记录可以撤销；心愿兑换/手动调整请走各自的反向流程。'
    })
  }
  if (original.source === 'correction') {
    throw new ConflictException({
      code: 'NOT_A_HABIT_CHECK_IN',
      message: `流水 ${original.id} 来源是 correction —— 冲正记录不能被当作打卡撤销。`
    })
  }
}

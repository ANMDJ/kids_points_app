import { ConflictException, NotFoundException } from '@nestjs/common'
import type { MemberRole, Prisma, RecordCategory, RecordSource } from '@prisma/client'

import { resolveAppendCreatedAt, type PointRecordDraft } from './ledger.gate'

/**
 * 事务内**追加一笔流水**的唯一实现（W4-D，2026-10-19 从 `PrismaLedgerRepository` 抽出）。
 *
 * ── 为什么必须抽出来 ────────────────────────────────────────────────────────
 *   打卡 / 撤销打卡要在**同一个事务**里做三件事：锁孩子 → 判业务前提 → 写流水。
 *   如果它们各自再写一份「读库钟 + 严格递增 + 余额 CAS」，两套顺序逻辑迟早漂移
 *   （I2 就会在某一类写入上悄悄失效）。
 *   抽出后：
 *     · `PrismaLedgerRepository.append()` —— 只关心「这一笔怎么落库」；
 *     · `PrismaHabitsRepository.checkIn()` —— 在同一事务里先判每日上限，再调本函数；
 *     · `PrismaHabitsRepository.reverse()` —— 在同一事务里先判原记录，再调本函数。
 *   **判定仍在内核 `ledger.gate.ts`**，本文件只负责 I/O 事实（顺序、锁、CAS）。
 *
 * ── 调用前提（本文件不重复做）──────────────────────────────────────────────
 *   ① 调用方**已经**在同一事务里 `SELECT … FOR UPDATE` 锁住了孩子行；
 *   ② `draft.balanceAfter` 已由内核按**同一份**当前余额算出；
 *   ③ 业务前提（habit 是否 active、是否超每日上限、原记录是否可冲）已判完。
 *   本函数仍做余额 CAS —— 它防的是「锁之外还有人改余额」这一类装配错误。
 */

/** 追加成功后返回的完整行（与 `read/read.repository.ts` 的 `RecordRow` 结构一致）。 */
export interface AppendedRecordRow {
  id: string
  titleSnapshot: string
  pointsDelta: number
  category: RecordCategory
  source: RecordSource
  operatorRole: MemberRole | null
  note: string
  habitId: string | null
  ruleId: string | null
  ruleVersion: number | null
  wishId: string | null
  reversesRecordId: string | null
  reversedAt: Date | null
  balanceAfter: number
  createdAt: Date
}

/**
 * 锁住孩子的余额行并返回**锁内**余额 —— 写入事务的第一步（W5-B 从
 * `PrismaHabitsRepository.lockChild()` 提出）。
 *
 * `appendDraftInTx()` 会再锁一次（同一事务内重复加锁是安全的），但**它拿不到
 * 「锁之前的余额」**：草稿的 `balanceAfter` 必须由调用方按锁内余额算出来。
 * 所以「先锁 + 读余额」必须是**一个**可复用动作，否则记一笔 / 打卡各写一份 SQL，
 * 一边加了 `status='active'` 判断、另一边忘了，就会在已删除孩子上记账。
 *
 * 不存在 / 已软删 ⇒ 404，**绝不按 0 分兜底**（那会让 B6 以另一种形式回来）。
 */
export async function lockChildBalance(
  tx: Prisma.TransactionClient,
  childId: string
): Promise<number> {
  const rows = await tx.$queryRaw<{ pointsBalance: number }[]>`
    SELECT "pointsBalance" FROM "Child"
    WHERE "id" = ${childId} AND "status" = 'active'
    FOR UPDATE`
  if (rows.length === 0) {
    throw new NotFoundException({
      code: 'CHILD_NOT_FOUND',
      message: `孩子 ${childId} 不存在、已删除或状态异常 —— 这笔分无处可记（拒绝，而不是造一条无主流水）。`
    })
  }
  return rows[0].pointsBalance
}

/**
 * 在一个**已经打开**的事务里追加流水。
 *
 * 顺序（与 W2-B 的 `PrismaLedgerRepository.append()` 逐行一致）：
 *   ① 再确认孩子仍存在（锁已由调用方持有）；
 *   ② 取库钟（`clock_timestamp()`）＋ 该孩子已有最新 `createdAt`；
 *   ③ `resolveAppendCreatedAt()` 决定严格递增的时间戳；
 *   ④ 余额 CAS；
 *   ⑤ `INSERT` 流水（`createdAt` **不用** `draft.createdAt`）。
 */
export async function appendDraftInTx(
  tx: Prisma.TransactionClient,
  draft: PointRecordDraft
): Promise<AppendedRecordRow> {
  const locked = await tx.$queryRaw<{ pointsBalance: number }[]>`
    SELECT "pointsBalance" FROM "Child" WHERE "id" = ${draft.childId} FOR UPDATE`
  if (locked.length === 0) {
    throw new NotFoundException({
      code: 'LEDGER_CHILD_NOT_FOUND',
      message: `孩子 ${draft.childId} 不存在 —— 这笔分无处可记（拒绝，而不是造一条无主流水）。`
    })
  }

  // ★ `AT TIME ZONE 'UTC'` 不能删：`PointRecord.createdAt` 是 naive 列，Prisma 的约定是
  //   "naive 值 = UTC 墙钟"；直接塞 timestamptz 会被 PG 按会话时区换算（+8h）。
  const [clock] = await tx.$queryRaw<{ ts: Date }[]>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS ts`
  const [latest] = await tx.$queryRaw<{ latest: Date | null }[]>`
    SELECT MAX("createdAt") AS latest FROM "PointRecord" WHERE "childId" = ${draft.childId}`
  const createdAt = resolveAppendCreatedAt({
    dbNow: clock.ts,
    latestCreatedAt: latest.latest
  })

  const expectedBefore = draft.balanceAfter - draft.pointsDelta
  const updated = await tx.child.updateMany({
    where: { id: draft.childId, pointsBalance: expectedBefore },
    data: { pointsBalance: draft.balanceAfter }
  })
  if (updated.count !== 1) {
    throw new ConflictException({
      code: 'LEDGER_BALANCE_CHANGED',
      message:
        `余额已被别的写入改过：草稿按 ${expectedBefore} 分算，库里现在是 ` +
        `${locked[0].pointsBalance} 分 ⇒ 拒绝落库（这笔的 balanceAfter 已经不成立了）。` +
        '★ 绝不用"就这样吧"把不匹配的余额写下去 —— 那正是 B6（账本不平）的成因；' +
        '重试请重新读余额、重新构造草稿。'
    })
  }

  return tx.pointRecord.create({
    data: {
      childId: draft.childId,
      ruleId: draft.ruleId,
      ruleVersion: draft.ruleVersion,
      habitId: draft.habitId,
      wishId: draft.wishId,
      titleSnapshot: draft.titleSnapshot,
      conditionSnapshot: draft.conditionSnapshot,
      dailyLimitSnapshot: draft.dailyLimitSnapshot,
      costSnapshot: draft.costSnapshot,
      pointsDelta: draft.pointsDelta,
      category: draft.category,
      source: draft.source,
      note: draft.note,
      operatorUserId: draft.operatorUserId,
      operatorRole: draft.operatorRole,
      balanceAfter: draft.balanceAfter,
      idempotencyKey: draft.idempotencyKey,
      reversesRecordId: draft.reversesRecordId,
      // ★ 顺序由端口负责：这里刻意**不用** `draft.createdAt`（见文件头 ②）。
      createdAt
    },
    select: {
      id: true,
      titleSnapshot: true,
      pointsDelta: true,
      category: true,
      source: true,
      operatorRole: true,
      note: true,
      habitId: true,
      ruleId: true,
      ruleVersion: true,
      wishId: true,
      reversesRecordId: true,
      reversedAt: true,
      balanceAfter: true,
      createdAt: true
    }
  })
}

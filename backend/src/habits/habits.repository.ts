import { Injectable, NotImplementedException } from '@nestjs/common'
import type { MemberRole, RecordSource } from '@prisma/client'

import type { RecordRow } from '../read/read.repository'

/**
 * 习惯打卡 / 撤销打卡的**持久化端口**（W4-D，2026-10-19）。
 *
 * ── 为什么这两件事要放在同一个端口里（而不是 `HabitPort` + `RecordPort`）─────
 *   它们共享同一条不变量链：
 *     ① 都属于**同一个孩子**（`childId` 来自会话，不是请求体）；
 *     ② 都必须在**同一事务**里判前提 → 写流水 → 改余额 → 写审计（I2 / I5）；
 *     ③ 撤销要读的字段（`habitId` / `category` / `reversesRecordId`）恰好是
 *        打卡写下的字段 —— 分成两个端口会出现两份"什么算打卡"的判据。
 *   端口的默认实现是**显式 501**：无库装配下，"打卡还没落地"必须是可执行断言，
 *   绝不允许假装成功（孩子会以为分已经加上了）。
 *
 * ── 判据在哪一层（不要放错）───────────────────────────────────────────────
 *   · **权限**：`PermissionsGuard` + `permission-matrix.ts`（本端口不判角色能做什么）；
 *   · **这一笔账怎么记**：`ledger.gate.ts` 的纯函数（本端口不重算符号/上限/余额）；
 *   · **库层事实**：孩子行存不存在、habit 是不是 active、今天第几次、原记录是不是
 *     已被冲正 —— 只有持库连接的人能回答，故在本端口（Prisma 适配器）里判。
 */

/** Nest 注入令牌（与仓库其它端口一致，用唯一 symbol 防撞名）。 */
export const HABITS_REPOSITORY = Symbol('HABITS_REPOSITORY')

/**
 * 打卡的**写入**入参。
 *
 * ★ `childId` / `operatorUserId` / `operatorRole` / `source` 全部来自**服务端结论**
 *   （会话 + 屏障一 + 权限矩阵），不是请求体。请求体里只有 `habitId`（DTO）。
 */
export interface CheckInInput {
  /** 会话里的孩子上下文（屏障一验过）—— 查询与落库的键的一半。 */
  childId: string
  /** 要打卡的习惯；必须属于 `childId`（跨孩子按 404 回答）。 */
  habitId: string
  /** 会话里的用户 id（`PointRecord.operatorUserId`）。 */
  operatorUserId: string
  /** 会话角色（矩阵验过；端口只用于落库与 `source` 映射）。 */
  operatorRole: MemberRole
  /** `PointRecord.source`：孩子自己打卡 = `child_self`，家长代打卡 = `guardian`。 */
  source: Extract<RecordSource, 'child_self' | 'guardian'>
  /**
   * 客户端幂等键（`Idempotency-Key` 头；已由控制器解析/校验）。
   * 缺省 ⇒ 这笔流水不写幂等键（"点两次就是两笔"是显式产品语义，不是漏洞）。
   */
  idempotencyKey?: string
  /** 服务端时钟（只用于内核构造草稿；落库时间仍由端口决定，见 `ledger.append.ts`）。 */
  now: Date
}

/** 撤销打卡的入参。 */
export interface ReverseRecordInput {
  childId: string
  /** 要撤销的**原打卡记录** id（必须属于 `childId`）。 */
  recordId: string
  operatorUserId: string
  operatorRole: MemberRole
  /** 可选备注；空串按"不写备注"处理（不落一个空字符串冒充用户输入）。 */
  note?: string
  /** 服务端时钟（只用于内核构造草稿）。 */
  now: Date
}

export interface HabitsPort {
  /**
   * 打一次卡：同事务内（孩子行锁）校验习惯 / 每日上限 → 内核构造草稿 →
   * 追加流水 → 改余额 → 写审计。
   *
   * 失败语义（HTTP 状态由适配器抛出）：
   *   · 404 `HABIT_NOT_FOUND`（含跨孩子/已删除）；
   *   · 409 `HABIT_DAILY_LIMIT_REACHED`（附 `checkedCount` / `dailyLimit`）；
   *   · 409 `HABIT_RULE_GONE` / `HABIT_RULE_DIRECTION_MISMATCH` / `HABIT_POINTS_MISMATCH`；
   *   · 409 `LEDGER_DUPLICATE_IDEMPOTENCY_KEY`（库层唯一约束，重放）。
   */
  checkIn(input: CheckInInput): Promise<RecordRow>

  /**
   * 撤销一条**打卡记录**（写一条负数冲正记录，不 UPDATE 原行 —— I5）。
   *
   * 失败语义：
   *   · 404 `RECORD_NOT_FOUND`（含跨孩子）；
   *   · 409 `NOT_A_HABIT_CHECK_IN`（心愿兑换/调整/冲正记录不可撤销）；
   *   · 409 `ALREADY_REVERSED` / `INSUFFICIENT_POINTS`（由内核/库层判）。
   */
  reverse(input: ReverseRecordInput): Promise<RecordRow>
}

/**
 * 无库装配的默认实现：**每个方法都 501**。
 * ★ 不返回假记录、不改内存余额 —— 那会让"没落库"看起来像"打卡成功"。
 */
@Injectable()
export class NotImplementedHabitsRepository implements HabitsPort {
  async checkIn(): Promise<RecordRow> {
    throw new NotImplementedException({
      code: 'HABITS_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '打卡写入尚未接线（无数据库装配）—— 拒绝假装成功：孩子会以为分已经加上了。' +
        '请配置 DATABASE_URL 后重启（判据只有 prisma/database-enabled.ts 一处）。'
    })
  }

  async reverse(): Promise<RecordRow> {
    throw new NotImplementedException({
      code: 'HABITS_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '撤销打卡尚未接线（无数据库装配）—— 拒绝假装成功：账面会与孩子看到的相反。' +
        '请配置 DATABASE_URL 后重启（判据只有 prisma/database-enabled.ts 一处）。'
    })
  }
}

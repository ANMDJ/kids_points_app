import { Injectable, NotImplementedException } from '@nestjs/common'
import type { MemberRole, RecordSource } from '@prisma/client'

import type { RecordRow } from '../read/read.repository'

/**
 * 「记一笔」的**持久化端口**（W5-B，2026-10-20）。
 *
 * ── 为什么单独一个端口，而不是塞进 `HabitsPort` ──────────────────────────────
 *   记一笔**没有习惯**：不读 `Habit`、不数每日上限、不查规则版本。它与打卡共享的
 *   只有账本内核（`ledger.gate`）和追加器（`ledger.append`）—— 那是**代码复用**，
 *   不是同一张表。塞进 `HabitsPort` 会让「习惯」这个词开始同时表示两件事：
 *   `POST /records/check-in` 的 host 实体，以及一个可选的 UI 分组。
 *
 * ── 判据在哪一层（与 W4-D 完全一致，不要挪动）───────────────────────────────
 *   · **能不能写**：`PermissionsGuard` + `permission-matrix.ts`（本端口不判角色）；
 *   · **这一笔怎么记**：`ledger.gate.buildRecordDraft()` 纯函数（符号 / 余额 / 快照）；
 *   · **库层事实**：孩子行是否 active、余额多少、幂等键是否重复 —— 只有持库连接的人能答。
 *
 * 默认实现是**显式 501**：无库装配时，「记一笔还没接线」必须是可执行断言，
 * 绝不允许假装成功 —— 家长会以为分已经记上了。
 */

/** Nest 注入令牌（与仓库其它端口一致，用唯一 symbol 防撞名）。 */
export const RECORDS_REPOSITORY = Symbol('RECORDS_REPOSITORY')

/**
 * 记一笔的**写入**入参。
 *
 * ★ `childId` / `operatorUserId` / `operatorRole` / `source` 全部来自**服务端结论**
 *   （会话 + 屏障一 + 权限矩阵），请求体里只有 `title` / `points` / `note`。
 */
export interface AdjustRecordInput {
  /** 会话里的孩子上下文（屏障一验过）。 */
  childId: string
  /** 事由（完整标题快照，不截断）。 */
  title: string
  /** 带符号分值：负 = 扣分，正 = 加分；0 由 DTO 与内核双重拒绝。 */
  points: number
  /** 可选附注（空串按"没写"处理，不落一个空串冒充用户输入）。 */
  note?: string
  /** 会话里的用户 id（`PointRecord.operatorUserId`）。 */
  operatorUserId: string
  /** 会话角色（矩阵验过；端口只用于落库与 `source` 映射）。 */
  operatorRole: MemberRole
  /** `PointRecord.source`：孩子自己记 = `child_self`，家长代记 = `guardian`。 */
  source: Extract<RecordSource, 'child_self' | 'guardian'>
  /** 客户端幂等键（`Idempotency-Key` 头，已由控制器解析/校验）。 */
  idempotencyKey?: string
  /** 服务端时钟（只用于内核构造草稿；落库时间由 `ledger.append.ts` 决定）。 */
  now: Date
}

export interface RecordsPort {
  /**
   * 记一笔：同一事务内（孩子行锁）构造草稿 → 追加流水 → 改余额 → 写审计。
   *
   * 失败语义（HTTP 状态由适配器抛出）：
   *   · 404 `CHILD_NOT_FOUND`（孩子不存在 / 已软删）；
   *   · 409 `INSUFFICIENT_POINTS`（扣分会把余额扣成负数 —— 修 B6，绝不截断到 0）；
   *   · 409 `RECORD_DUPLICATE_IDEMPOTENCY_KEY`（同一 key 已产生过流水）。
   */
  adjust(input: AdjustRecordInput): Promise<RecordRow>
}

/** 无库装配的默认实现：**501**，不返回假记录、不改内存余额。 */
@Injectable()
export class NotImplementedRecordsRepository implements RecordsPort {
  async adjust(): Promise<RecordRow> {
    throw new NotImplementedException({
      code: 'RECORDS_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '「记一笔」写入尚未接线（无数据库装配）—— 拒绝假装成功：家长会以为分已经记上了。' +
        '请配置 DATABASE_URL 后重启（判据只有 prisma/database-enabled.ts 一处）。'
    })
  }
}

import { Injectable, NotImplementedException } from '@nestjs/common'

import type {
  LedgerChainRow,
  PointRecordDraft,
  ReversibleRecord,
  RuleVersionSnapshot
} from './ledger.gate'

/**
 * 账本读写的**持久化端口**（端口 / 适配器里的「端口」，`01` §4 / `02` §5.7）。
 *
 * ── 为什么单独一层（而不是让调用方直接 `new PrismaService()`）────────────────
 *   ① 账本内核（`ledger.gate.ts`）是**纯函数**，"判定对不对"必须能在**离线**穷举 ——
 *      若内核自己去查库，则"负分规则不许记成加分""余额不足必须拒绝"这些用例
 *      就都得先有真库、真数据，CI 立刻不可移植；
 *   ② **端口 + 内核的分工是"I/O 与判定分离"**：内核负责"这一笔该怎么记"，
 *      端口负责"把它落到哪个表、顺序怎么保证"；
 *   ③ 缺实现时**显式 501**：接线之后这条更精确了 —— **有库**装配走真适配器，
 *      **无库**装配（没有 `DATABASE_URL`）才落到 501 兜底。于是"这台机器上账本写入没落地"
 *      是一个**可执行断言**，而不是注释里的一句话
 *      （与 `MEMBERSHIP_REPOSITORY` / `DEVICE_SESSION_REPOSITORY` 完全同口径）。
 *
 * ── ★ 写路径的事务边界（`01` §4，实现时必须一次做完）────────────────────────
 *   `append()` 在实现里**必须**是**一个** `$transaction`：
 *     写 PointRecord（含 balanceAfter）＋ 更新 Child.pointsBalance
 *     ＋ 写 AuditLog（before/after），若由审批触发还要更新
 *     ApprovalRequest.status / executedRecordId。
 *   **必须留在事务外**：推送通知、埋点、报表、缓存失效 ——
 *   推送服务不可靠，放进事务会让"一条模板消息失败"回滚掉**一笔已经成立的加分**
 *   （孩子明明完成了、账却没了。验收：`02` §9.23）。
 *
 * ── ★ 三个只读方法为什么也在这个端口上（而不是各模块自备查询）──────────────
 *   `readBalance` / `readReversedIds` / `readRuleVersion` 都必须在**同一个事务**里
 *   与 `append()` 一起执行：余额是滚动量、冲正要去重、规则版本是真相之源 ——
 *   任何一个读到"事务外"的副本，都会造出"判定时的世界"与"落库时的世界"不一致。
 *   放在同一端口上，实现才有机会把它们塞进同一个事务。
 *
 * ✅ 目前的真实状态（W2-C）：真适配器 `PrismaLedgerRepository` 已写出**并已接进装配** ——
 *    `LedgerModule.register()` 按 `hasDatabaseUrl()` 分叉（有库 ⇒ 真实现 / 无库 ⇒ 501 兜底）。
 *    I1–I6 真库套件见 `test-db/ledger-db.dbtest.ts`（组 J：走真 DI 取端口读写真库）。
 * ⚠️ 仍为 501 的三条腿：`Approvals` / `Membership` / `DeviceSession` 三个端口。
 */

/** Nest 注入令牌（用 unique symbol 避免字符串撞名）。 */
export const LEDGER_REPOSITORY = Symbol('LEDGER_REPOSITORY')

export interface LedgerPort {
  /** 读当前余额（`Child.pointsBalance`）—— 写入前必须**同事务**读它（修 B6）。 */
  readBalance(childId: string): Promise<number>

  /** 读一条记录（冲正时定位原记录 —— 只读最小字段集）。 */
  readRecord(recordId: string): Promise<ReversibleRecord | null>

  /**
   * 读该孩子**已被冲正**的记录 id 集合（`reversesRecordId` 非空的那些）。
   * ★ 幂等保护：重复冲正会让这笔分翻倍，判定必须基于事务内的最新状态。
   */
  readReversedIds(childId: string): Promise<string[]>

  /** 读 `(ruleId, version)` 的版本行（真相之源）—— 写带规则的流水前必须先取到它。 */
  readRuleVersion(ruleId: string, version: number): Promise<RuleVersionSnapshot | null>

  /**
   * **追加**一条流水（append-only；不许 UPDATE / 不许 DELETE —— I5 由 DB 层 `REVOKE` 保证）。
   *
   * 返回写入后的真实余额：调用方拿它与 `draft.balanceAfter` 比对，
   * 不一致就说明**并发写**发生了（余额被别人改过）⇒ 必须重试或报错，
   * **不许**把不匹配的余额当成"就这样吧"。
   */
  append(draft: PointRecordDraft): Promise<{ recordId: string; balanceAfter: number }>

  /**
   * 读某孩子**全部**流水（按 `(createdAt, id)` 排序）—— I2 尺子
   * （`verifyBalanceChain()`）的输入，也是"账本到底平不平"的唯一依据。
   */
  readChain(childId: string): Promise<LedgerChainRow[]>
}

/**
 * 「**没有数据库**」时的兜底实现：**一律 501**。
 *
 * ── 它现在的位置（W2-C 接线之后）──────────────────────────────────
 *   `LedgerModule.register()` 按 `hasDatabaseUrl()` 分叉：**有** `DATABASE_URL` ⇒
 *   `PrismaLedgerRepository`（真查库）；**没有** ⇒ 本类。所以它不再是"唯一装配"，
 *   而是"这台机器上没有库"时的**响亮兜底**（离线用例、还没配 `.env` 的临时环境）。
 *   ★ 两条分支都必须存在：没有本类，无库环境会退化成"静默不记账"；
 *     没有真实现，生产环境会"看起来装好了却一分没落库"。
 *
 * ── 为什么无库时不是"干脆不提供这个 provider"──────────────────────────────
 *   那样调用方拿到的是"注入失败"（信息量极低），而不是一条点名**哪个操作**、**为什么**的 501。
 *   缺实现是一种**已知状态**，应当具体、可断言地表达出来（组 G 就是这么钉的）。
 *
 * ⚠️ 代价写清楚（不粉饰）：**无库装配下，任何走账本的路径都是 501**。
 */
@Injectable()
export class NotImplementedLedgerRepository implements LedgerPort {
  private fail(operation: string): never {
    throw new NotImplementedException({
      code: 'LEDGER_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        `账本持久化尚未落地：${operation} 没有实现。` +
        '账本**内核**（方向×符号、余额、快照↔版本、冲正、I2 尺子）已落地并有离线用例，' +
        '但"这一笔怎么落进 Postgres"还没有 —— 所以这里**拒绝**而不是假装成功：' +
        '假装成功等于把积分账本变成一句空承诺（fail-closed）。'
    })
  }

  readBalance(childId: string): Promise<number> {
    return Promise.resolve(this.fail(`readBalance(${childId})`))
  }

  readRecord(recordId: string): Promise<ReversibleRecord | null> {
    return Promise.resolve(this.fail(`readRecord(${recordId})`))
  }

  readReversedIds(childId: string): Promise<string[]> {
    return Promise.resolve(this.fail(`readReversedIds(${childId})`))
  }

  readRuleVersion(ruleId: string, version: number): Promise<RuleVersionSnapshot | null> {
    return Promise.resolve(this.fail(`readRuleVersion(${ruleId}#${version})`))
  }

  append(draft: PointRecordDraft): Promise<{ recordId: string; balanceAfter: number }> {
    return Promise.resolve(this.fail(`append(childId=${draft.childId})`))
  }

  readChain(childId: string): Promise<LedgerChainRow[]> {
    return Promise.resolve(this.fail(`readChain(${childId})`))
  }
}

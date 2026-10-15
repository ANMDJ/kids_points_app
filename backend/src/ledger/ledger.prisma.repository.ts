import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type {
  LedgerChainRow,
  PointRecordDraft,
  ReversibleRecord,
  RuleVersionSnapshot
} from './ledger.gate'
import { resolveAppendCreatedAt } from './ledger.gate'
import type { LedgerPort } from './ledger.repository'

/**
 * 账本端口的 **Prisma 适配器**（W2-B，2026-10-15）—— `LedgerPort` 的真实现。
 *
 * ── 它与内核的分工（一句话）───────────────────────────────────────────────
 *   内核（`ledger.gate.ts`）回答"**这一笔该怎么记**"（纯函数、可离线穷举）；
 *   本文件回答"**怎么把它落进 Postgres 才不出错**"：事务边界、顺序、并发。
 *   所有判定仍在内核里 —— 这里**再判一次**是禁止的（两套判定迟早漂移）。
 *
 * ── 三条只有"持库连接的人"才能兑现的承诺 ──────────────────────────────────
 *   ① **读写同一事务**：`append()` 内读余额、读已有最新时间戳、写流水、改余额
 *      全在**一个** `$transaction` 里 —— 否则"判定时的世界"≠"落库时的世界"；
 *   ② **顺序**：`createdAt` **由本端口决定**（库钟 ＋ 严格递增修正，见
 *      `resolveAppendCreatedAt()`），不是照抄内核给的调用方时钟 —— 这是 I2 能在
 *      真库上"可判定"的前提（W2-A 记下的真库陷阱：`now()` 同事务恒定）；
 *   ③ **并发**：`SELECT … FOR UPDATE` 锁住该孩子的余额行 ＋ 余额 **CAS**
 *      （`WHERE pointsBalance = 期望值`）—— 两笔并发扣分不会都成功。
 *
 * ── ✅ 接线状态（W2-B 第二阶段，2026-10-15 已接）──────────────────────────────
 *   `LedgerModule` 已是**动态模块**：`register()` 按 `hasDatabaseUrl()`（`prisma/database-enabled.ts`，
 *   判据只有一处）分叉 —— 有库 ⇒ 本文件（真查库）；无库 ⇒ `NotImplementedLedgerRepository`（**显式 501**）。
 *   `app.module.ts` 里是 `LedgerModule.register()`（不传参 ⇒ 按环境推断；`main.ts` 第一行已加载 dotenv）。
 *   于是"内核已落地却没人落库"这件事**结束了**：有 `DATABASE_URL` 的运行环境走的就是本文件。
 *
 *   两条用例分别守在两端（缺一不可）：
 *     · 离线 `test/ledger-wiring.test.ts` —— 装配**声明**对不对（有库时用替身 Prisma 证明
 *       "端口走的是注入的客户端"，而不是"工厂里自己 new 一个"）；
 *     · 真库 `test-db/ledger-db.dbtest.ts` 组 J —— 走真 `register()` 建图、从 DI 取端口，
 *       **读写的是真库**（换一条连接复核，防止"只是返回对象好看"）。
 *
 *   ★ 另：`AuditLog` / `ApprovalRequest` 的写入**不在本文件**（`append()` 的入参
 *     只有一份流水草稿）—— 那属于 W2-D「审批的同事务写入路径」；届时应把事务
 *     边界上移到"知道自己在办哪件事"的那一层，而不是让本文件去猜。
 */
@Injectable()
export class PrismaLedgerRepository implements LedgerPort {
  constructor(private readonly prisma: PrismaService) {}

  /** `Child.pointsBalance` —— 查不到孩子是**装配/数据问题**（404），不是"余额 0"。 */
  async readBalance(childId: string): Promise<number> {
    const child = await this.prisma.child.findUnique({
      where: { id: childId },
      select: { pointsBalance: true }
    })
    if (child === null) {
      throw new NotFoundException({
        code: 'LEDGER_CHILD_NOT_FOUND',
        message:
          `孩子 ${childId} 不存在 —— 账本没有可挂靠的对象。` +
          '★ 绝不返回 0 兜底：那会让"这个孩子没有账本"看起来像"这个孩子有 0 分"。'
      })
    }
    // 负数余额由内核的 `resolveBalanceAfter()` 拒（INVALID_CURRENT_BALANCE）——
    // 判定只留一处，这里原样返回。
    return child.pointsBalance
  }

  /** 读一条记录（冲正时定位原记录）；只有冲正判定需要的字段。 */
  async readRecord(recordId: string): Promise<ReversibleRecord | null> {
    return this.prisma.pointRecord.findUnique({
      where: { id: recordId },
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
        reversesRecordId: true
      }
    })
  }

  /**
   * 该孩子**已被冲正**的记录 id 集合（`reversesRecordId` 非空的反查）。
   *
   * ★ 判据是"**有没有别人指向我**"，而不是原记录上某个标志位：
   *   应用角色对 `PointRecord` **没有 UPDATE 权限**（I5 / `900_ledger_revoke.sql`），
   *   所以"我被冲正了"这件事**只能**从新记录上读出来。
   *   （schema 里的 `PointRecord.reversedAt` 因此**永远为 null** —— 真库套件把它变成
   *   一条可执行断言，见 `test-db/ledger-db.dbtest.ts` 组 F。）
   */
  async readReversedIds(childId: string): Promise<string[]> {
    const rows = await this.prisma.pointRecord.findMany({
      where: { childId, reversesRecordId: { not: null } },
      select: { reversesRecordId: true }
    })
    return rows
      .map((row) => row.reversesRecordId)
      .filter((id): id is string => id !== null)
  }

  /** 读 `(ruleId, version)` 版本行（真相之源）；没有 ⇒ `null`（"没有这版"是正常分支）。 */
  async readRuleVersion(ruleId: string, version: number): Promise<RuleVersionSnapshot | null> {
    return this.prisma.pointRuleVersion.findUnique({
      where: { ruleId_version: { ruleId, version } },
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
  }


  /**
   * **追加**一条流水 —— 本适配器唯一的事务要点都在这里。
   *
   * 一个 `$transaction` 内按序做四件事（顺序有理由，不是随手排的）：
   *   ① `SELECT … FOR UPDATE` 锁住该孩子的余额行 ⇒ 同一孩子的写入**排队**；
   *   ② 取库钟（`clock_timestamp()`）＋ 取该孩子已有最新 `createdAt` ⇒ 决定本笔时间戳；
   *   ③ 余额 **CAS**（`WHERE pointsBalance = 写入前余额`）⇒ 陈旧草稿当场 409；
   *   ④ `INSERT` 流水（`createdAt` 用 ② 的值，**不用** `draft.createdAt`）。
   *
   * 任何一步失败 ⇒ 整个事务回滚 ⇒ **不会留下"余额改了但流水没写"的中间态**。
   */
  async append(draft: PointRecordDraft): Promise<{ recordId: string; balanceAfter: number }> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ pointsBalance: number }[]>`
          SELECT "pointsBalance" FROM "Child" WHERE "id" = ${draft.childId} FOR UPDATE`
        if (locked.length === 0) {
          throw new NotFoundException({
            code: 'LEDGER_CHILD_NOT_FOUND',
            message: `孩子 ${draft.childId} 不存在 —— 这笔分无处可记（拒绝，而不是造一条无主流水）。`
          })
        }

        // ★ 为什么必须 `AT TIME ZONE 'UTC'`（真库套件抓到的真 bug，别删）：
        //   `PointRecord.createdAt` 是 **timestamp without time zone**，Prisma 的约定是
        //   "naive 值 = UTC 墙钟"（它自己写 Date 时就是这么写的）。
        //   而 `clock_timestamp()` 返回 **timestamp with time zone** ⇒ 直接塞进 naive 列会
        //   被 PG 按**会话时区**转换（本机是 Asia/Shanghai）⇒ 落库值整体偏移 +8h，
        //   被读回来就是"8 小时后的未来流水"。离线用例不可能发现这件事（它只看语义），
        //   所以这条断言留在真库套件里（组 A：「偏离真实时间」）。
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

        const record = await tx.pointRecord.create({
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
            // ★ 顺序由端口负责：这里刻意**不用** `draft.createdAt`（见文件头 ②）
            createdAt
          },
          select: { id: true, balanceAfter: true }
        })

        // CAS 已保证库里的余额就是 `draft.balanceAfter` ⇒ 返回的即"写入后的真实余额"，
        // 无需再查一次（查一次也只是把同一事实读回来）。
        return { recordId: record.id, balanceAfter: record.balanceAfter }
      })
    } catch (err) {
      this.mapWriteError(err, draft)
    }
  }

  /**
   * 读整条链（按 `(createdAt, id)`）—— `verifyBalanceChain()`（I2 尺子）的输入。
   * ★ 排序用**库里的** `createdAt`（不是内存里的对象），与尺子的排序口径一致。
   */
  async readChain(childId: string): Promise<LedgerChainRow[]> {
    return this.prisma.pointRecord.findMany({
      where: { childId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, childId: true, pointsDelta: true, balanceAfter: true, createdAt: true }
    })
  }

  /**
   * 把库层的**约束失败**翻成有语义的 4xx —— 这些不是"服务器炸了"，而是**规则赢了**：
   *   · `P2002`（唯一约束）：`@@unique([childId, idempotencyKey])` ⇒ 重放被库拦下；
   *   · `P2003`（外键）：`PointRecord(ruleId, ruleVersion) → PointRuleVersion` 的复合外键
   *     ⇒ **I3 在库层生效**（不存在指向空版本的记录），这是"数据库替我兜住了"的证据。
   * 其余异常原样抛出（真炸了就该 500，不伪装成 409）。
   */
  private mapWriteError(err: unknown, draft: PointRecordDraft): never {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        if (JSON.stringify(err.meta ?? {}).includes('idempotencyKey')) {
          throw new ConflictException({
            code: 'LEDGER_DUPLICATE_IDEMPOTENCY_KEY',
            message:
              `幂等键 ${JSON.stringify(draft.idempotencyKey)} 在孩子 ${draft.childId} 上已经用过 —— ` +
              '同一个请求来了两次（重放）。★ 这是**库层**唯一约束拦下的，' +
              '不是靠应用先查后写（那在并发下必然漏）。'
          })
        }
        throw new ConflictException({
          code: 'LEDGER_UNIQUE_VIOLATION',
          message: `写入违反唯一约束：${JSON.stringify(err.meta ?? {})}`
        })
      }
      if (err.code === 'P2003') {
        throw new ConflictException({
          code: 'LEDGER_RULE_VERSION_MISSING',
          message:
            `写入违反外键：这条流水指向的规则版本行不存在` +
            `（ruleId=${JSON.stringify(draft.ruleId)}, ruleVersion=${JSON.stringify(draft.ruleVersion)}）。` +
            '★ I3 由数据库的**复合外键**强制 —— 拒绝是正确结果，' +
            '放行会让历史记录指向空气（"哪一版规则产生了这笔分"永久无法回答）。'
        })
      }
    }
    throw err
  }
}

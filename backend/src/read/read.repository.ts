import { Injectable, NotImplementedException } from '@nestjs/common'
import type {
  MemberRole,
  RecordCategory,
  RecordSource,
  RuleDirection,
  WishCoverStyle
} from '@prisma/client'

import type { RecordCursor } from './read.cursor'

/**
 * 只读查询的**持久化端口**（W4-A，2026-10-18）。
 *
 * ── 为什么先做只读（而不是直接把双端写方法换成 HTTP）────────────────────────
 *   `12-w3c-handoff.md` 的 W4 顺序写着「双端 AppStore 的写方法逐个换成 HTTP」，
 *   但双端**一启动就要读**：没有 `GET /home`，AppStore 只能继续用内存种子；
 *   没有种子时首页是空态，连「孩子有几个习惯」都答不出来。
 *   而规则 / 习惯 / 心愿的写端点尚未建（W4–W6）——若从写开始，客户端会先接上
 *   一批「能改内存、改不了库」的假接法。故本阶段先落**读路径**：
 *     · `GET /home`    —— 首页 / 规则页 / 心愿页 / 我的页共用的一份快照；
 *     · `GET /records` —— 记录页（分类筛选 + 分页）。
 *   ★ 这两个端点**不写任何东西**，因此不需要 `Idempotency-Key`。
 *
 * ── 为什么是端口（而不是 controller 直接 `prisma.*`）───────────────────────
 *   与 `LedgerPort` / `ApprovalsPort` 同一条理由：离线的 `npm test` 不许连库。
 *   无 `DATABASE_URL` 时绑定本文件末尾的 501 实现 ——
 *   「只读查询未落地」因此是**可执行断言**，而不是注释里的一句话。
 *
 * ── 一条刻意的「不判」：本层不判权限 ────────────────────────────────────────
 *   谁能看这个孩子由三道屏障（`DeviceSessionGuard → MembershipGuard → PermissionsGuard`）
 *   在 HTTP 层回答；这里只按 `childId` 读。若在本层再写一遍角色判断，
 *   就出现了第二份权限事实源（`02` §2 明令禁止）。
 */

/** Nest 注入令牌（unique symbol：不与会话 / 成员 / 账本的令牌撞名）。 */
export const READ_REPOSITORY = Symbol('READ_REPOSITORY')

export interface ChildSummaryRow {
  id: string
  name: string
  pointsBalance: number
}

export interface HabitRow {
  id: string
  title: string
  points: number
  condition: string
  dailyLimit: number
  icon: string
  color: string
  ruleId: string | null
}

export interface RuleRow {
  id: string
  title: string
  condition: string
  dailyLimit: number
  /** ★ 库里**恒为正**，奖惩由 `direction` 表达（03 A1）。映射成带符号的 DTO 在 service。 */
  points: number
  direction: RuleDirection
  icon: string
  color: string
  currentVersion: number
}

export interface WishRow {
  id: string
  title: string
  cost: number
  emoji: string
  coverStyle: WishCoverStyle
  redeemed: boolean
}

/**
 * 首页快照的**行形状**。
 *
 * ★ `goodHabitCount` / `rewardCount` 是**聚合结果**（PRD FR-07 / D2）：
 *   它们不落库 —— `Child` 表上根本没有这两个字段，正因为落库是 A5
 *   （手动加分被算成一次奖励兑换）的成因。
 */
export interface HomeSnapshotRow {
  child: ChildSummaryRow
  goodHabitCount: number
  rewardCount: number
  habits: HabitRow[]
  rules: RuleRow[]
  wishes: WishRow[]
}

export interface RecordRow {
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
  /** 原记录被冲正的时间（未冲正 ⇒ null）—— 让客户端不必依赖「冲正行也在同一页」。 */
  reversedAt: Date | null
  balanceAfter: number
  createdAt: Date
}

export interface ListRecordsInput {
  childId: string
  /** `undefined` = 全部（记录页「全部」标签）。 */
  category?: RecordCategory
  /** 1–200，由 DTO 校验；端口必须**如实**限制返回条数。 */
  limit: number
  /**
   * 键集游标：只返回**严格早于**这一行 `(createdAt, id)` 的记录。
   * `undefined` = 第一页。由 service 解析 `nextCursor` 得到，端口不碰编码格式。
   */
  before?: RecordCursor
}

export interface RecordPageRow {
  rows: RecordRow[]
  /** 是否还有下一页 —— 由适配器用 `limit + 1` 判定，**不靠**「本页正好满」猜。 */
  hasMore: boolean
}

export interface ReadPort {
  /**
   * 读一份首页快照。
   *
   * ★ 孩子不存在 / 已软删 ⇒ 返回 `null`（**不是**空快照）。
   *   若返回空快照，客户端会把「这个孩子不在库里」显示成「今天没有习惯」——
   *   这正是本仓库反复要避免的「把失败装成正常」。
   */
  loadHome(childId: string): Promise<HomeSnapshotRow | null>

  /**
   * 读一页流水。
   *
   * ★ 与 `loadHome` 同一条口径：孩子不存在 / 已软删 ⇒ `null`（**不是**空页）。
   *   若返回空页，`/records` 会对一个已删除的孩子回答「还没有任何记录」，
   *   而 `/home` 对同一个孩子回答 404 —— 两个端点互相矛盾。
   */
  listRecords(input: ListRecordsInput): Promise<RecordPageRow | null>
}

/**
 * 无库装配的默认实现：**响亮 501**，绝不返回「空首页」。
 *
 * 为什么空首页是最糟的默认值：断网 / 未接库时，家长会看到「0 分、0 个习惯」，
 * 以为孩子的数据丢了 —— 而真实原因是「查询还没实现」。UI 的 501 文案
 * 至少能让人知道该找开发，而不是去找孩子删掉的数据。
 */
@Injectable()
export class NotImplementedReadRepository implements ReadPort {
  async loadHome(_childId: string): Promise<HomeSnapshotRow | null> {
    throw new NotImplementedException({
      code: 'READ_MODEL_NOT_IMPLEMENTED',
      message:
        '首页只读查询尚未接库（无 DATABASE_URL 的装配）。' +
        '★ 绝不返回空快照：那会把「查询未实现」显示成「孩子没有数据」。'
    })
  }

  async listRecords(_input: ListRecordsInput): Promise<RecordPageRow | null> {
    throw new NotImplementedException({
      code: 'READ_MODEL_NOT_IMPLEMENTED',
      message:
        '流水只读查询尚未接库（无 DATABASE_URL 的装配）。' +
        '★ 绝不返回空列表：那会把「查询未实现」显示成「还没有任何记录」。'
    })
  }
}

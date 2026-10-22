import { encodeRecordCursor } from './read.cursor'
import type {
  HomeSnapshotRow,
  RecordPageRow,
  RecordRow,
  RuleRow
} from './read.repository'

/**
 * 只读端点的**响应契约**（W4-A，2026-10-18）。
 *
 * 这里是后端 → 双端的**唯一形状定义**。两条纪律：
 *   ① **只放结构字段**，不放展示串（`subtitle` / `limitText` / `amountText`）。
 *      03 E17/E19 的教训：展示串一旦从服务端下发，就会变成第二份事实源，
 *      双端各写一遍派生函数的旧病会以「服务端版本」的名义回来。
 *   ② **枚举值保持库内拼写**（`child_self` / `A` / `guardian`），不做「顺手驼峰化」。
 *      客户端模型已有自己的联合类型；由客户端 mapper 负责一次转换，
 *      比在服务端生成一份「给 Flutter 看的驼峰 + 给 Taro 看的下划线」更可控。
 *
 * 时间一律是 **ISO-8601 字符串**（`Date.toISOString()`）：JSON 没有日期类型，
 * 数字时间戳又会被两端按各自的时区解释。ISO 串在两端都能 `DateTime.parse` / `new Date()`。
 */

export interface ChildSummaryDto {
  id: string
  name: string
  pointsBalance: number
}

export interface HabitDto {
  id: string
  title: string
  points: number
  condition: string
  dailyLimit: number
  /** 图标**名字**（与后端 `Habit.icon`、双端 `IconName` 同构）—— 修 D9。 */
  icon: string
  color: string
  /** 派生来源规则 id（手工习惯 ⇒ null）。 */
  ruleId: string | null
}

export interface RuleDto {
  id: string
  title: string
  condition: string
  dailyLimit: number
  /**
   * **带符号**的分值：奖励为正、扣分为负。
   *
   * 库里恒为正（`PointRule.direction` 表达奖惩，03 A1）；客户端 `PointRule.points`
   * 是带符号的 —— 若原样下发，扣分规则会显示成 `+5`。故在**这一处**完成转换，
   * 并保留 `direction` 供 UI 区分「扣分」与「0 分」。
   */
  points: number
  direction: 'reward' | 'penalty'
  icon: string
  color: string
  currentVersion: number
}

export interface WishDto {
  id: string
  title: string
  cost: number
  emoji: string
  /** 稳定枚举 `A`–`D`（03 E16：不再用数组下标）。 */
  coverStyle: 'A' | 'B' | 'C' | 'D'
  redeemed: boolean
}

export interface HomeResponse {
  child: ChildSummaryDto
  /** 累计好习惯次数 —— 按需 COUNT，已排除被冲正的表扬流水。 */
  goodHabitCount: number
  /** 累计兑换次数 —— 只由「已兑换的心愿」数出（A5）。 */
  rewardCount: number
  habits: HabitDto[]
  rules: RuleDto[]
  wishes: WishDto[]
}

export interface RecordDto {
  id: string
  /** 当时标题的**完整快照**（不截断；截断只在渲染层）—— 修 B8。 */
  title: string
  /** 正数加分、负数扣分。 */
  points: number
  createdAt: string
  category: 'praise' | 'exchange' | 'adjust'
  source: 'child_self' | 'guardian' | 'agent' | 'approval' | 'system' | 'correction'
  operatorRole: 'guardian' | 'child' | 'viewer' | null
  note: string
  habitId: string | null
  ruleId: string | null
  ruleVersion: number | null
  wishId: string | null
  reversesRecordId: string | null
  /** 原记录被冲正的时间；未冲正 ⇒ null。 */
  reversedAt: string | null
  balanceAfter: number
}

/**
 * 三个写端点（打卡 / 撤销 / 记一笔）的**统一响应**（W5-B 从 `habits.service` 搬来）。
 *
 * 为什么放在 mapper 而不是各业务模块：客户端只有一个 `WrittenRecordDto`，
 * 它要求「写回包里的 record 与 `GET /records` 的行同构」。只要有一个端点自己
 * 声明一份形状，`mapRecord()` 的严格解析就会在**那一条路径**上开始报 malformed ——
 * 所以形状只能有一处定义。
 */
export interface WrittenRecordResponse {
  record: RecordDto
  /**
   * 本次真正写下的那条流水 id（撤销时是**冲正记录**，不是原记录）。
   * ★ 幂等层用它填 `IdempotencyRecord.recordId`（`IdempotencyService.recordIdOf`），
   *   方便事后回答"这个 key 究竟产生了哪一笔"。
   */
  executedRecordId: string
}

export interface RecordsResponse {
  records: RecordDto[]
  /** 本次实际请求的上限（客户端可据此判断是否要「加载更多」）。 */
  limit: number
  hasMore: boolean
  /**
   * 下一页游标；`hasMore=false` 时为 `null`。
   *
   * ★ 客户端必须**原样回传**（`?cursor=...`）：这是 `(createdAt, id)` 的编码，
   *   自己拼日期会因精度 / 时区写法不同而失效（服务端回 400，不会静默回到第一页）。
   */
  nextCursor: string | null
}

/** 规则分值：库内恒正 + `direction` ⇒ 客户端带符号。 */
export function signedRulePoints(rule: Pick<RuleRow, 'points' | 'direction'>): number {
  return rule.direction === 'penalty' ? -Math.abs(rule.points) : Math.abs(rule.points)
}

export function toHomeResponse(row: HomeSnapshotRow): HomeResponse {
  return {
    child: row.child,
    goodHabitCount: row.goodHabitCount,
    rewardCount: row.rewardCount,
    habits: row.habits.map((habit) => ({
      id: habit.id,
      title: habit.title,
      points: habit.points,
      condition: habit.condition,
      dailyLimit: habit.dailyLimit,
      icon: habit.icon,
      color: habit.color,
      ruleId: habit.ruleId
    })),
    rules: row.rules.map((rule) => ({
      id: rule.id,
      title: rule.title,
      condition: rule.condition,
      dailyLimit: rule.dailyLimit,
      points: signedRulePoints(rule),
      direction: rule.direction,
      icon: rule.icon,
      color: rule.color,
      currentVersion: rule.currentVersion
    })),
    wishes: row.wishes.map((wish) => ({
      id: wish.id,
      title: wish.title,
      cost: wish.cost,
      emoji: wish.emoji,
      coverStyle: wish.coverStyle,
      redeemed: wish.redeemed
    }))
  }
}

export function toRecordDto(row: RecordRow): RecordDto {
  return {
    id: row.id,
    title: row.titleSnapshot,
    points: row.pointsDelta,
    createdAt: row.createdAt.toISOString(),
    category: row.category,
    source: row.source,
    operatorRole: row.operatorRole,
    note: row.note,
    habitId: row.habitId,
    ruleId: row.ruleId,
    ruleVersion: row.ruleVersion,
    wishId: row.wishId,
    reversesRecordId: row.reversesRecordId,
    reversedAt: row.reversedAt === null ? null : row.reversedAt.toISOString(),
    balanceAfter: row.balanceAfter
  }
}

export function toRecordsResponse(page: RecordPageRow, limit: number): RecordsResponse {
  // 游标指向**本页最后一行**（不是多取的那一行）：下一页从它之后开始，
  // 因此两页之间不会重叠。`hasMore=false` 时给 null —— 客户端据此停掉「加载更多」。
  const last = page.rows[page.rows.length - 1]
  const nextCursor =
    page.hasMore && last !== undefined
      ? encodeRecordCursor({ createdAt: last.createdAt, id: last.id })
      : null

  return {
    records: page.rows.map(toRecordDto),
    limit,
    hasMore: page.hasMore,
    nextCursor
  }
}

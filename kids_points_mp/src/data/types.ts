import type { IconName } from '../components/Icon/icons'

/** 积分记录的来源分类，对应记录页顶部的筛选标签。 */
export type RecordCategory = 'praise' | 'exchange' | 'adjust'

/** 成员角色。对应后端 ChildMember.role（见 docs/design/02）。 */
export type MemberRole = 'guardian' | 'child'

/**
 * 积分记录的**操作来源**。
 *
 * 修复 A4：原先所有流水都硬编码成“家长记录”，孩子自己打卡也写“家长记录”，
 * 流水在撒谎、责任链断裂。改为记录真实来源，subtitle 由其派生（见 E19）。
 */
export type RecordSource =
  | 'child_self'
  | 'guardian'
  | 'agent'
  | 'approval'
  | 'system'
  | 'correction'


/**
 * 一个可以打卡的习惯（首页“今天的习惯”）。
 *
 * **修 A2 / A3 / E17**：原先 `limitText` / `doneText` / `checked` 都是**可写字段** ——
 * “每天最多 2 次”因此只是给人看的字符串（系统无法判断今天还能打几次）；
 * `checked: boolean` 与“每天最多 N 次”**直接矛盾**（打完 1 次就再也打不了第 2 次，
 * 规则承诺的次数永远不可达）；`doneText` 更是 seed 里手写的 `'今日已完成 1 次'`，
 * 与真实完成次数毫无关系。
 *
 * 现在只保留结构字段 `condition` ＋ `dailyLimit`（与 `backend/prisma/schema.prisma`
 * 的 `Habit.condition` / `Habit.dailyLimit` 同构）；
 * 展示串与“是否已完成”一律由 [habitView] 从**当天流水**派生。
 */
export interface Habit {
  id: string
  /** 习惯名称，例如“番茄钟写作业” */
  title: string
  /** 完成一次获得的积分 */
  points: number
  /** 达成条件，例如“专注 25 分钟” */
  condition: string
  /** 每天可完成的次数上限（1–5 的整数，可运算、可校验）—— 修 A2 */
  dailyLimit: number
  icon: IconName
  color: string
}

/**
 * 心愿插画的配色方案 —— **稳定枚举**，与后端 `enum WishCoverStyle` 一一对应
 * （`backend/prisma/schema.prisma`）。
 *
 * 修 E16：原先用 `backgroundIndex: number`（值＝`wishes.length % 4`）表达配色，
 * 于是配色由**插入时的列表长度**决定 —— 删除中间某个心愿后，
 * 后续新增的心愿会与既有心愿撞色，既有心愿的配色也可能跳变。
 */
export type WishCoverStyle = 'A' | 'B' | 'C' | 'D'

/** 配色枚举的全部取值，以及补空档时的优先顺序。 */
export const wishCoverStyles: WishCoverStyle[] = ['A', 'B', 'C', 'D']

/**
 * id → 稳定哈希（跨端同源：Flutter 侧 `wishCoverHash` 必须用同一算式）。
 * 取模前的 `% 1000003` 只为避免大数，与配色语义无关。
 */
export function wishCoverHash(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 1000003
  }
  return hash
}

/**
 * 挑一个配色 —— **与列表长度无关**，所以删项不会让既有心愿变色。
 *
 * ① 还有空档：按 A → D 补第一个空档（新增不与既有撞色）；
 * ② 四个都占满：由 `id` 哈希稳定取值（可能撞色，但**永不漂移** —— 同一个 id 永远同一个色）。
 */
export function pickCoverStyle(
  taken: WishCoverStyle[],
  id: string
): WishCoverStyle {
  const used = new Set(taken)
  const free = wishCoverStyles.find((style) => !used.has(style))
  if (free) return free
  return wishCoverStyles[wishCoverHash(id) % wishCoverStyles.length]
}

/** 心愿单里可以兑换的奖励。 */
export interface Wish {
  id: string
  title: string
  /** 兑换所需积分 */
  cost: number
  /** 插画用的 emoji（无图片资源时也能保持可爱风格） */
  emoji: string
  /** 插画底色方案（**稳定枚举**，不再用数组下标）—— 修 E16 */
  coverStyle: WishCoverStyle
  /** 是否已兑换 */
  redeemed: boolean
}

/**
 * 一条积分流水（账本条目）。
 *
 * **不可变原则**：流水一经写入不得修改或删除，撤销用**冲正**（`reversesRecordId`）。
 * 详见 docs/design/02 §5 与 docs/design/03 的 B6 / B7。
 */
export interface PointRecord {
  id: string
  /** 当时标题的**完整快照**（不截断；截断只发生在渲染层）—— 修 B8 */
  title: string
  /** 派生自 source + time + note，禁止手工拼接 —— 修 A4 / E19 */
  subtitle: string
  /** 正数为加分，负数为扣分 */
  points: number
  /** 时间戳 */
  time: number
  category: RecordCategory
  icon: IconName
  color: string

  // ───────────────────────── 账本可追溯性（A4 / B6 / B7 / B8）
  /** 操作来源，决定 subtitle 文案与统计口径 —— 修 A4 */
  source: RecordSource
  /** **真实操作人角色**（`system` / `correction` 时为 null）—— 修 A4 */
  operatorRole: MemberRole | null
  /** 补充说明，作为 subtitle 的**附加段**而非替换来源 —— 修 E19 */
  note: string
  /** 回指习惯（用唯一 id 匹配，修掉按 title 匹配导致的同名误删）—— 修 B7 */
  habitId: string | null
  /** 回指的积分规则 id（W0 起配合 ruleVersion 定位 PointRuleVersion） */
  ruleId: string | null
  /** 回指的心愿 id（心愿删除后仍能解释这笔扣分）—— 修 B8 */
  wishId: string | null
  /** 冲正：指向被冲正的记录 id —— 修 B7 */
  reversesRecordId: string | null
  /** **记完之后的余额**，账本对账基准 —— 修 B6 */
  balanceAfter: number
}

/** 操作上下文：谁在操作。W2 起由服务端 ChildMember 提供。 */
export interface ActorContext {
  role: MemberRole
  userId?: string
}


/**
 * 积分规则：家长约定“做到什么 → 得多少分”。
 *
 * **修 E15**：原先只有一个 `detail: string` —— 结构化信息（条件 / 频次）被塞进
 * 面向人的展示串，再靠 `detail.split(' · ')` **反解析**回来：多一段就丢一段
 * （`'连续 3 天 · 每天 1 次 · 需要家长确认'` 的第三段消失），没有分隔符就静默落到
 * 默认值 `'每天 1 次'`（与家长意图无关）。
 *
 * 现在 `condition` / `dailyLimit` 是结构字段，[ruleDetail] 只负责拼展示串。
 */
export interface PointRule {
  id: string
  title: string
  /** 达成条件，例如“专注 25 分钟” */
  condition: string
  /** 每天可完成的次数上限（1–5 的整数）—— 修 A2 */
  dailyLimit: number
  /** 分值，可为负数（扣分规则） */
  points: number
  icon: IconName
  color: string
}

/** 孩子档案，对应“我的”页顶部信息与战绩。 */
export interface ChildProfile {
  name: string
  childId: string
  /** 累计达成的好习惯次数 */
  goodHabitCount: number
  /** 累计奖励（兑换）次数 */
  rewardCount: number
}

/** 一个可选的图标 + 配色（规则图标选择器）。 */
export interface IconOption {
  icon: IconName
  color: string
}

// ------------------------------------------------------------------ 文案工具

export const recordCategoryLabels: Record<RecordCategory, string> = {
  praise: '表扬',
  exchange: '兑换',
  adjust: '调整'
}

/** 操作来源的展示文案（修 A4）。 */
export const recordSourceLabels: Record<RecordSource, string> = {
  child_self: '自己完成',
  guardian: '家长记录',
  agent: '积分小助手',
  approval: '家长审批通过',
  system: '系统',
  correction: '撤销'
}

/**
 * 由**结构化字段**派生 `subtitle` —— 修 A4 / E19。
 *
 * 禁止在写入处手工拼接文案：那正是 A4“流水撒谎”的成因
 * （无论谁操作都写死“家长记录”）。所有写入方必须经由本函数。
 */
export function recordSubtitle(input: {
  time: number
  source: RecordSource
  category?: RecordCategory
  note?: string
}): string {
  const head =
    input.category === 'exchange'
      ? '兑换奖励'
      : recordSourceLabels[input.source]
  const parts: string[] = [clockText(input.time), head]
  const note = (input.note ?? '').trim()
  if (note !== '') parts.push(note)
  return parts.join(' · ')
}

// ------------------------------------------- 结构字段 → 派生值（修 A2 / A3 / E15 / E17）
// 与 `backend/prisma/schema.prisma` 的结构字段一一对应（见 docs/design/03 §A2 / §A3 / §E15）。

/** 每日次数上限的允许区间 —— 与后端模板校验（`backend/prisma/seed/templates.data.ts`）同口径。 */
export const dailyLimitMin = 1
export const dailyLimitMax = 5

/** 频次是否合法：`dailyLimit` 必须是 1–5 的整数。 */
export function isDailyLimitValid(dailyLimit: number): boolean {
  return (
    Number.isInteger(dailyLimit) &&
    dailyLimit >= dailyLimitMin &&
    dailyLimit <= dailyLimitMax
  )
}

/** 频次的展示串 —— 修 E17：由 `dailyLimit` 派生，禁止任何地方手工写死。 */
export function limitTextOf(dailyLimit: number): string {
  return dailyLimit === 1 ? '每天 1 次' : `每天最多 ${dailyLimit} 次`
}

/** 今日完成次数的展示串 —— 修 E17。 */
export function doneTextOf(checkedCountToday: number): string {
  return `今日已完成 ${checkedCountToday} 次`
}

/** 两个时间戳是否同一天（本地时区）。 */
export function isSameDay(time: number, other: number): boolean {
  const a = new Date(time)
  const b = new Date(other)
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * 今天这个习惯已经完成几次 —— 修 A3。
 *
 * 由**当天流水**统计，不存字段：布尔量 `checked` 根本无法表达“每天最多 2 次”。
 * 必须排除四类记录，缺一条派生态就会撒谎：
 *   1. 非本习惯（按 `habitId` 唯一匹配，不是 title）；
 *   2. 非表扬类（兑换 / 调整流水不算完成习惯）；
 *   3. `source === 'correction'` —— 冲正记录本身不是一次完成；
 *   4. **已被冲正的原记录** —— 撤销后它仍留在账上（账本不可变），但不应再计入今日完成。
 * 第 4 条是 `03` §A3 公式里漏掉的（原文只写了“source≠correction”）：
 * 漏掉它 → **撤销打卡后界面仍显示“已打卡”**，撤销看起来没生效。
 */
export function checkedCountToday(
  records: PointRecord[],
  habitId: string,
  now: number = Date.now()
): number {
  const reversedIds = new Set(
    records
      .filter((record) => record.reversesRecordId !== null)
      .map((record) => record.reversesRecordId)
  )
  return records.filter(
    (record) =>
      record.habitId === habitId &&
      record.category === 'praise' &&
      record.source !== 'correction' &&
      !reversedIds.has(record.id) &&
      isSameDay(record.time, now)
  ).length
}

/**
 * 习惯的**派生视图**：首页渲染与打卡判定都消费它。
 *
 * 它是 E17 的落点 —— 页面拿不到任何“可被写入的展示串”，
 * 想改文案只能改派生函数（一处改、两端同步）。
 */
export interface HabitView extends Habit {
  /** 今天已完成次数（由当天流水数出）*/
  checkedCountToday: number
  /** 由 `dailyLimit` 派生的频次串 */
  limitText: string
  /** 由 `checkedCountToday` 派生的完成串 */
  doneText: string
  /** 是否已达今日上限（`checkedCountToday >= dailyLimit`）—— 修 A3 */
  checked: boolean
}

/** 由结构字段 ＋ 当天流水派生习惯视图 —— 修 A2 / A3 / E17。 */
export function habitView(
  habit: Habit,
  records: PointRecord[],
  now: number = Date.now()
): HabitView {
  const count = checkedCountToday(records, habit.id, now)
  return {
    ...habit,
    checkedCountToday: count,
    limitText: limitTextOf(habit.dailyLimit),
    doneText: doneTextOf(count),
    checked: count >= habit.dailyLimit
  }
}

/** 规则的展示串 —— 修 E15：由结构字段拼出，不再存在自由的 `detail` 字符串。 */
export function ruleDetail(rule: PointRule): string {
  return `${rule.condition} · ${limitTextOf(rule.dailyLimit)}`
}


export function isGain(points: number): boolean {
  return points >= 0
}

export function amountText(points: number): string {
  return points >= 0 ? `+${points}` : `${points}`
}

/** HH:mm */
export function clockText(time: number): string {
  const date = new Date(time)
  const hh = `${date.getHours()}`.padStart(2, '0')
  const mm = `${date.getMinutes()}`.padStart(2, '0')
  return `${hh}:${mm}`
}

/** 把时间转成“今天 / 昨天 / 前天 / M 月 d 日”。 */
export function dayLabel(time: number): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const date = new Date(time)
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diff = Math.round((today - day) / 86400000)
  switch (diff) {
    case 0:
      return '今天'
    case 1:
      return '昨天'
    case 2:
      return '前天'
    default:
      return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  }
}

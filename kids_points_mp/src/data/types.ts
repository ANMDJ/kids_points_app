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


/** 一个可以打卡的习惯（首页“今天的习惯”）。 */
export interface Habit {
  id: string
  /** 习惯名称，例如“番茄钟写作业” */
  title: string
  /** 完成一次获得的积分 */
  points: number
  /** 达成条件，例如“专注 25 分钟” */
  condition: string
  /** 频次限制，例如“每天最多 2 次” */
  limitText: string
  /** 今日完成后的文案，例如“今日已完成 1 次” */
  doneText: string
  icon: IconName
  color: string
  /** 今天是否已打卡（当前为内存态，同一会话内保持） */
  checked: boolean
}

/** 心愿单里可以兑换的奖励。 */
export interface Wish {
  id: string
  title: string
  /** 兑换所需积分 */
  cost: number
  /** 插画用的 emoji（无图片资源时也能保持可爱风格） */
  emoji: string
  /** 插画底色方案索引，见 WishCard 的 wishGradients */
  backgroundIndex: number
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


/** 积分规则：家长约定“做到什么 → 得多少分”。 */
export interface PointRule {
  id: string
  title: string
  /** 例如“专注 25 分钟 · 每天最多 2 次” */
  detail: string
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

import type {
  HabitDto,
  HomeDto,
  RecordsPageDto,
  RecordDto,
  RuleDto
} from './read_dto'
import { ReadApiException } from './read_api_errors'
import type { IconName } from '../components/Icon/icons'
import type {
  Habit,
  MemberRole,
  PointRecord,
  PointRule,
  RecordCategory,
  RecordSource,
  Wish,
  WishCoverStyle
} from './types'
import {
  recordSubtitle,
  wishCoverStyles
} from './types'

/**
 * 服务端字段 → 现有 UI 模型（字段改名只在这**一次**转换里发生）。
 *
 * 映射层同时负责**枚举校验**：服务端出现 `direction = "bonus"` 这类未知值时，
 * 宁可整次读取失败并明确报错，也不把它硬塞进 UI 模型、再让页面画出错误语义。
 * 与 Flutter `lib/data/read_mapper.dart` 同口径。
 */

export interface HomeSnapshot {
  childName: string
  childId: string
  pointsBalance: number
  goodHabitCount: number
  rewardCount: number
  habits: Habit[]
  rules: PointRule[]
  wishes: Wish[]
}

export interface RecordsPage {
  records: PointRecord[]
  hasMore: boolean
  nextCursor: string | null
  limit: number
}

export function mapHome(dto: HomeDto): HomeSnapshot {
  return {
    childName: dto.childName,
    childId: dto.childId,
    pointsBalance: dto.pointsBalance,
    goodHabitCount: dto.goodHabitCount,
    rewardCount: dto.rewardCount,
    habits: dto.habits.map((item, index) => mapHabit(item, `habits[${index}]`)),
    rules: dto.rules.map((item, index) => mapRule(item, `rules[${index}]`)),
    wishes: dto.wishes.map((item, index) => ({
      id: item.id,
      title: item.title,
      cost: item.cost,
      emoji: item.emoji,
      coverStyle: asEnum(
        item.coverStyle,
        wishCoverStyles,
        `wishes[${index}].coverStyle`
      ) as WishCoverStyle,
      redeemed: item.redeemed,
      status: 'active',
      deletedAt: null
    }))
  }
}

/**
 * 单条习惯 DTO → UI 模型（`GET /home` 与 `POST /point-rules/:id/habits` 共用）。
 *
 * 图标名不做白名单校验：未知图标由 Icon 组件渲染兜底图标，
 * 不能因为换了一个图标名就让整页读取失败。
 */
export function mapHabit(dto: HabitDto, path = 'habit'): Habit {
  return {
    id: dto.id,
    title: dto.title,
    points: dto.points,
    condition: dto.condition,
    dailyLimit: dto.dailyLimit,
    icon: dto.icon as IconName,
    color: requireHexColor(dto.color, `${path}.color`),
    ruleId: dto.ruleId,
    status: 'active',
    deletedAt: null
  }
}

/**
 * 单条规则 DTO → UI 模型（`GET /home` 与写端点回包共用）。
 *
 * `direction` 只用来**校验**：DTO 的 `points` 已经带符号，这里不再取反。
 */
export function mapRule(dto: RuleDto, path = 'rule'): PointRule {
  asEnum(dto.direction, ['reward', 'penalty'] as const, `${path}.direction`)
  return {
    id: dto.id,
    title: dto.title,
    condition: dto.condition,
    dailyLimit: dto.dailyLimit,
    points: dto.points,
    icon: dto.icon as IconName,
    color: requireHexColor(dto.color, `${path}.color`),
    currentVersion: dto.currentVersion,
    status: 'active',
    deletedAt: null
  }
}

export function mapRecordsPage(dto: RecordsPageDto): RecordsPage {
  return {
    records: dto.records.map((item, index) =>
      mapRecord(item, `records[${index}]`)
    ),
    hasMore: dto.hasMore,
    nextCursor: dto.nextCursor,
    limit: dto.limit
  }
}

/**
 * 单条线格式流水 → 本地模型。写端点返回的记录与 `GET /records` 同构，
 * 因此复用同一函数（避免“读取一条口径、写入另一条口径”）。
 */
export function mapRecord(dto: RecordDto, path = 'record'): PointRecord {
  const category = asEnum(
    dto.category,
    ['praise', 'exchange', 'adjust'] as const,
    `${path}.category`
  )
  const source = asEnum(
    dto.source,
    [
      'child_self',
      'guardian',
      'agent',
      'approval',
      'system',
      'correction'
    ] as const,
    `${path}.source`
  )
  const operatorRole =
    dto.operatorRole === null
      ? null
      : asEnum(
          dto.operatorRole,
          ['guardian', 'child', 'viewer'] as const,
          `${path}.operatorRole`
        )

  const icon: IconName =
    category === 'exchange'
      ? 'gift'
      : category === 'adjust'
        ? dto.points < 0
          ? 'minus'
          : 'plus'
        : source === 'child_self'
          ? 'check'
          : 'starFill'
  const color =
    category === 'exchange'
      ? '#f5a24b'
      : category === 'adjust'
        ? dto.points < 0
          ? '#e26a5a'
          : '#7fbf55'
        : source === 'child_self'
          ? '#7fbf55'
          : '#f2c14e'

  return {
    id: dto.id,
    title: dto.title,
    subtitle: recordSubtitle({
      time: dto.createdAt,
      source,
      category,
      note: dto.note
    }),
    points: dto.points,
    time: dto.createdAt,
    category,
    icon,
    color,
    source,
    operatorRole: operatorRole as MemberRole | null,
    note: dto.note,
    habitId: dto.habitId,
    ruleId: dto.ruleId,
    ruleVersion: dto.ruleVersion,
    wishId: dto.wishId,
    reversesRecordId: dto.reversesRecordId,
    balanceAfter: dto.balanceAfter
  }
}

function asEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  path: string
): T {
  const match = allowed.find((item) => item === value)
  if (match === undefined) {
    throw ReadApiException.malformed(
      path,
      `未知枚举值 "${value}"，允许：${allowed.join(' / ')}`
    )
  }
  return match
}

function requireHexColor(value: string, path: string): string {
  const trimmed = value.trim()
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
    throw ReadApiException.malformed(path, `不是 #RGB / #RRGGBB 颜色：${value}`)
  }
  return trimmed
}

import { ReadApiException } from './read_api_errors'

/**
 * 后端只读端点的**线格式**（wire DTO）—— 只负责「像不像」，不负责「画成什么」。
 *
 * 与 UI 模型（`Habit` / `PointRule` / `Wish` / `PointRecord`）刻意分开：
 * 前者跟 `backend/src/read/read.mapper.ts` 的 JSON 一一对应，后者是本地渲染用的。
 * 中间那层映射在 `read_mapper.ts` —— 服务端字段改名时只改这里和映射，UI 不动。
 *
 * 所有读取都**严格**：缺字段 / 类型不对 ⇒ `ReadApiException.malformed`，
 * 不做 `?? 0` / `?? ''` 那种「猜一个默认值」（那会让契约漂移静默通过）。
 */

export class HomeDto {
  constructor(
    readonly childId: string,
    readonly childName: string,
    readonly pointsBalance: number,
    readonly goodHabitCount: number,
    readonly rewardCount: number,
    readonly habits: HabitDto[],
    readonly rules: RuleDto[],
    readonly wishes: WishDto[]
  ) {}

  static fromJson(raw: unknown): HomeDto {
    const json = readObject(raw, '$')
    const child = readObject(json.child, 'child')
    return new HomeDto(
      readString(child, 'id', 'child.id'),
      readString(child, 'name', 'child.name'),
      readInt(child, 'pointsBalance', 'child.pointsBalance'),
      readInt(json, 'goodHabitCount', 'goodHabitCount'),
      readInt(json, 'rewardCount', 'rewardCount'),
      readList(json, 'habits', 'habits').map((item, index) =>
        HabitDto.fromJson(item, `habits[${index}]`)
      ),
      readList(json, 'rules', 'rules').map((item, index) =>
        RuleDto.fromJson(item, `rules[${index}]`)
      ),
      readList(json, 'wishes', 'wishes').map((item, index) =>
        WishDto.fromJson(item, `wishes[${index}]`)
      )
    )
  }
}

export class HabitDto {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly points: number,
    readonly icon: string,
    readonly color: string,
    readonly condition: string,
    readonly dailyLimit: number,
    readonly ruleId: string | null
  ) {}

  static fromJson(raw: unknown, path: string): HabitDto {
    const json = readObject(raw, path)
    return new HabitDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'title', `${path}.title`),
      readInt(json, 'points', `${path}.points`),
      readString(json, 'icon', `${path}.icon`),
      readString(json, 'color', `${path}.color`),
      readString(json, 'condition', `${path}.condition`),
      readInt(json, 'dailyLimit', `${path}.dailyLimit`),
      readOptionalString(json, 'ruleId', `${path}.ruleId`)
    )
  }
}

export class RuleDto {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly points: number,
    readonly direction: string,
    readonly icon: string,
    readonly color: string,
    readonly condition: string,
    readonly dailyLimit: number,
    readonly currentVersion: number
  ) {}

  static fromJson(raw: unknown, path: string): RuleDto {
    const json = readObject(raw, path)
    return new RuleDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'title', `${path}.title`),
      readInt(json, 'points', `${path}.points`),
      readString(json, 'direction', `${path}.direction`),
      readString(json, 'icon', `${path}.icon`),
      readString(json, 'color', `${path}.color`),
      readString(json, 'condition', `${path}.condition`),
      readInt(json, 'dailyLimit', `${path}.dailyLimit`),
      readInt(json, 'currentVersion', `${path}.currentVersion`)
    )
  }
}

export class WishDto {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly cost: number,
    readonly emoji: string,
    readonly coverStyle: string,
    readonly redeemed: boolean
  ) {}

  static fromJson(raw: unknown, path: string): WishDto {
    const json = readObject(raw, path)
    return new WishDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'title', `${path}.title`),
      readInt(json, 'cost', `${path}.cost`),
      readString(json, 'emoji', `${path}.emoji`),
      readString(json, 'coverStyle', `${path}.coverStyle`),
      readBool(json, 'redeemed', `${path}.redeemed`)
    )
  }
}

export class RecordDto {
  constructor(
    readonly id: string,
    readonly title: string,
    readonly points: number,
    readonly category: string,
    readonly source: string,
    readonly operatorRole: string | null,
    readonly note: string,
    readonly habitId: string | null,
    readonly ruleId: string | null,
    readonly ruleVersion: number | null,
    readonly wishId: string | null,
    readonly reversesRecordId: string | null,
    readonly reversedAt: number | null,
    readonly balanceAfter: number,
    readonly createdAt: number
  ) {}

  static fromJson(raw: unknown, path: string): RecordDto {
    const json = readObject(raw, path)
    return new RecordDto(
      readString(json, 'id', `${path}.id`),
      readString(json, 'title', `${path}.title`),
      readInt(json, 'points', `${path}.points`),
      readString(json, 'category', `${path}.category`),
      readString(json, 'source', `${path}.source`),
      readOptionalString(json, 'operatorRole', `${path}.operatorRole`),
      readString(json, 'note', `${path}.note`),
      readOptionalString(json, 'habitId', `${path}.habitId`),
      readOptionalString(json, 'ruleId', `${path}.ruleId`),
      readOptionalInt(json, 'ruleVersion', `${path}.ruleVersion`),
      readOptionalString(json, 'wishId', `${path}.wishId`),
      readOptionalString(json, 'reversesRecordId', `${path}.reversesRecordId`),
      readOptionalDate(json, 'reversedAt', `${path}.reversedAt`),
      readInt(json, 'balanceAfter', `${path}.balanceAfter`),
      readDate(json, 'createdAt', `${path}.createdAt`)
    )
  }
}

export class RecordsPageDto {
  constructor(
    readonly records: RecordDto[],
    readonly limit: number,
    readonly hasMore: boolean,
    readonly nextCursor: string | null
  ) {}

  static fromJson(raw: unknown): RecordsPageDto {
    const json = readObject(raw, '$')
    const records = readList(json, 'records', 'records').map((item, index) =>
      RecordDto.fromJson(item, `records[${index}]`)
    )
    const hasMore = readBool(json, 'hasMore', 'hasMore')
    const nextCursor = readOptionalString(json, 'nextCursor', 'nextCursor')

    // 两个字段必须自洽：否则客户端要么提前停，要么对着 null 死循环。
    if (hasMore && (nextCursor === null || nextCursor === '')) {
      throw ReadApiException.malformed(
        'nextCursor',
        'hasMore=true 但没有游标，客户端无法取下一页'
      )
    }
    if (!hasMore && nextCursor !== null) {
      throw ReadApiException.malformed(
        'nextCursor',
        'hasMore=false 却给了游标'
      )
    }

    return new RecordsPageDto(
      records,
      readInt(json, 'limit', 'limit'),
      hasMore,
      nextCursor
    )
  }
}


// ───────────────────────────── 严格读取助手 ─────────────────────────────

export function readObject(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  throw ReadApiException.malformed(path, `期望对象，实际 ${typeName(value)}`)
}

export function readList(
  json: Record<string, unknown>,
  key: string,
  path: string
): unknown[] {
  const value = json[key]
  if (Array.isArray(value)) return value
  throw ReadApiException.malformed(path, `期望数组，实际 ${typeName(value)}`)
}

export function readString(
  json: Record<string, unknown>,
  key: string,
  path: string
): string {
  const value = json[key]
  if (typeof value === 'string') return value
  throw ReadApiException.malformed(
    path,
    `期望字符串，实际 ${typeName(value)}`
  )
}

export function readOptionalString(
  json: Record<string, unknown>,
  key: string,
  path: string
): string | null {
  const value = json[key]
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  throw ReadApiException.malformed(
    path,
    `期望字符串或 null，实际 ${typeName(value)}`
  )
}

export function readInt(
  json: Record<string, unknown>,
  key: string,
  path: string
): number {
  const value = json[key]
  // JSON 里大整数可能被解成 5.0；只接受**无损**整数，避免悄悄取整。
  if (typeof value === 'number' && Number.isInteger(value)) return value
  throw ReadApiException.malformed(path, `期望整数，实际 ${typeName(value)}`)
}

export function readOptionalInt(
  json: Record<string, unknown>,
  key: string,
  path: string
): number | null {
  if (json[key] === undefined || json[key] === null) return null
  return readInt(json, key, path)
}

export function readBool(
  json: Record<string, unknown>,
  key: string,
  path: string
): boolean {
  const value = json[key]
  if (typeof value === 'boolean') return value
  throw ReadApiException.malformed(
    path,
    `期望布尔值，实际 ${typeName(value)}`
  )
}

/** ISO-8601 → epoch 毫秒；交给 `Date` 渲染成本地时间。 */
export function readDate(
  json: Record<string, unknown>,
  key: string,
  path: string
): number {
  const raw = readString(json, key, path)
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) {
    throw ReadApiException.malformed(path, `不是 ISO-8601 时间：${raw}`)
  }
  return parsed
}

export function readOptionalDate(
  json: Record<string, unknown>,
  key: string,
  path: string
): number | null {
  if (json[key] === undefined || json[key] === null) return null
  return readDate(json, key, path)
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 业务日（business day）—— 「今天的打卡上限」到底按哪一天算（W4-D，2026-10-19）。
 *
 * ── 为什么不能直接 `new Date().toISOString().slice(0,10)` ─────────────────────
 *   那得到的是 **UTC 日**。孩子的"今天"是家里墙上的日历：北京时间 00:30 打卡，
 *   UTC 还停在昨天 ⇒ 会占用**昨天**的名额，而昨天的第 N 次打卡又会挤进今天。
 *   每日上限是家长看得见的承诺，边界必须与家长所在时区一致。
 *
 * ── 为什么是"自算偏移"，不用 Temporal / date-fns ─────────────────────────────
 *   ① 仓库现有依赖里没有日期库（不为一个边界引入新依赖）；
 *   ② Node 18+ 的 `Intl` 已带完整 tzdata，`formatToParts` 足以回答
 *      "这一瞬间在该时区是几点"；再把墙钟时间反解成 UTC 瞬间即可；
 *   ③ DST：用**两次迭代**收敛（第一次用猜的瞬间取偏移，第二次用该偏移修正）。
 *      对 1 小时 DST 跳变足够；中国无 DST，`Asia/Shanghai` 恒为 +08:00。
 *
 * ── 返回什么 ─────────────────────────────────────────────────────────────────
 *   `[start, end)` —— 左闭右开，正好能写成 Prisma 的
 *   `createdAt: { gte: start, lt: end }`。`day` 只用于日志/错误文案，**不参与查询**。
 */

/** 默认时区：产品面向中国家庭（`docs/design/01-overview.md` 的部署前提）。 */
export const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Shanghai'

const DAY_MS = 24 * 60 * 60 * 1000

export interface BusinessDay {
  /** `YYYY-MM-DD`（该时区的日历日）—— 仅用于文案/日志。 */
  day: string
  /** 当天 00:00:00.000（该时区）对应的 UTC 瞬间。 */
  start: Date
  /** 次日 00:00:00.000（该时区）对应的 UTC 瞬间；查询用 `lt`。 */
  end: Date
  timeZone: string
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      // ★ `hourCycle: 'h23'`：某些 ICU 版本在 `hour12: false` 下会把午夜给成 "24"，
      //   随后 `Date.UTC(..., 24, ...)` 会静默跨到次日 —— 每日上限就整体错一天。
      hourCycle: 'h23'
    })
  } catch {
    throw new RangeError(
      `未知时区 ${JSON.stringify(timeZone)} —— KP_TIMEZONE 必须是 IANA 名称（例如 Asia/Shanghai）。`
    )
  }
}

function wallClockOf(instant: Date, formatter: Intl.DateTimeFormat): WallClock {
  const parts = formatter.formatToParts(instant)
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value
    if (value === undefined) throw new RangeError(`时区格式化缺少 ${type} 字段（环境 ICU 异常）。`)
    return Number(value)
  }
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second')
  }
}

/** 该瞬间的"墙钟时间"按 UTC 读出来的毫秒数（用于求偏移）。 */
function wallClockAsUtcMs(instant: Date, formatter: Intl.DateTimeFormat): number {
  const wall = wallClockOf(instant, formatter)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
}

/** 把"该时区的某日 00:00"反解成 UTC 瞬间（两次迭代，见文件头 ③）。 */
function startOfDayUtc(
  year: number,
  monthIndex: number,
  day: number,
  formatter: Intl.DateTimeFormat
): Date {
  const wallMidnight = Date.UTC(year, monthIndex, day)
  let candidate = new Date(wallMidnight)
  for (let i = 0; i < 2; i += 1) {
    const offset = wallClockAsUtcMs(candidate, formatter) - candidate.getTime()
    candidate = new Date(wallMidnight - offset)
  }
  return candidate
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 求 `instant` 落在 `timeZone` 的哪个业务日。
 *
 * @throws RangeError 时间非法 / 时区名非法 —— **绝不静默退回 UTC**：
 *   时区配错会让每日上限按错误的日子算，那比 500 更难发现。
 */
export function businessDayOf(
  instant: Date,
  timeZone: string = DEFAULT_BUSINESS_TIME_ZONE
): BusinessDay {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new RangeError('businessDayOf() 需要一个有效 Date —— 不能用“现在大致是”兜底。')
  }
  const formatter = formatterFor(timeZone)
  const wall = wallClockOf(instant, formatter)
  const start = startOfDayUtc(wall.year, wall.month - 1, wall.day, formatter)
  const end = startOfDayUtc(wall.year, wall.month - 1, wall.day + 1, formatter)

  // 自检：`[start, end)` 必须真的包含传入瞬间，且长度是 23/24/25 小时。
  // 这条断言防的是上面两次迭代在极端 DST 边界上收敛到错的一天（宁可 500，不可错算）。
  if (instant.getTime() < start.getTime() || instant.getTime() >= end.getTime()) {
    throw new RangeError(
      `业务日自检失败：${instant.toISOString()} 不在 ${timeZone} 的 ` +
        `[${start.toISOString()}, ${end.toISOString()}) 内 —— 拒绝按错误的日子算每日上限。`
    )
  }
  const span = end.getTime() - start.getTime()
  if (span < DAY_MS - 60 * 60 * 1000 || span > DAY_MS + 60 * 60 * 1000) {
    throw new RangeError(
      `业务日长度异常：${timeZone} 的 ${wall.year}-${pad2(wall.month)}-${pad2(wall.day)} ` +
        `跨度为 ${span / 3600000} 小时（合法范围 23–25）—— 拒绝继续。`
    )
  }

  return {
    day: `${wall.year}-${pad2(wall.month)}-${pad2(wall.day)}`,
    start,
    end,
    timeZone
  }
}

/**
 * 读取并校验时区配置。模块装配时调用一次 ⇒ 配错**启动就炸**，而不是等第一笔打卡。
 */
export function resolveBusinessTimeZone(
  raw: string | undefined,
  fallback: string = DEFAULT_BUSINESS_TIME_ZONE
): string {
  const timeZone = raw === undefined || raw.trim() === '' ? fallback : raw.trim()
  formatterFor(timeZone) // 只验合法性；失败抛 RangeError
  return timeZone
}

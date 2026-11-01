/**
 * 固定规则验证码 —— 「日期 ＋ 星期」拼成的 6 位数（W9-C，2026-10-29）。
 *
 * ── 规则（只有一个，不做配置项）──────────────────────────────────────────────
 *   `MMDD` ＋ `WW`，共 6 位；`WW` 是 **ISO 星期**（周一 `01` … 周日 `07`）。
 *     2026-10-29（周四） ⇒ `1029` ＋ `04` ⇒ **`102904`**
 *   ★ 为什么星期不用 1 位：`MMDD` + 1 位只有 5 位，凑不出"6 位验证码"这个
 *     输入框的长度；两位还顺手消掉了「周日是 0 还是 7」的歧义（这里写死 7）。
 *   ★ 为什么顺序是 日期在前：家长念出来是"十零二九零四"，与日历上的
 *     「10 月 29 日 星期四」同一顺序；反过来（星期在前）念着别扭，一眼核对不了。
 *
 * ── 「哪一天」按 **Asia/Shanghai** 的墙钟算（不是 UTC 日）──────────────────────
 *   孩子的"今天"是家里墙上的日历。北京时间 00:30 输入时 UTC 还停在昨天，
 *   按 UTC 算会给出**昨天**的码，而家长看的是今天的日历 ⇒ 必错。
 *   这里复用 `businessDayOf()`（`habits/business-day.ts`，W4-D 已为"每日打卡上限"
 *   解过同一个问题）——**同一套墙钟口径只能有一个实现**，否则两处会在跨零点
 *   那天给出互相矛盾的答案。
 *
 * ── 容差：**前后各 1 天**（`DATE_CODE_TOLERANCE_DAYS`）────────────────────────
 *   每个码在「它的那一天」±1 天都接受。为什么需要：
 *     · 服务器与家长手机的时钟本来就会有几十秒差；23:59 输入次日码、
 *       00:00 刚过提交昨天的码，都是**正常操作**而不是攻击；
 *     · 没有容差时，跨零点那一刻家长会看到一个"刚算出来的码是错的"，
 *       而他没有任何办法自己判断问题出在时间上。
 *   代价（写清，不许被读成"更安全"）：每个码的有效窗口从 24 小时变成 48 小时。
 *   这几乎不改变威胁模型 —— 见下面这条更重要的诚实标注。
 *
 * ── ★ 它是什么、不是什么（这条必须跟着代码一起传播）──────────────────────────
 *   · **是**：一道「别让孩子随手点进家长界面」的**软门锁**，且校验发生在
 *     **服务端**（服务器时钟），所以改手机系统时间绕不过去；
 *   · **不是**认证凭据：`MMDD + 星期` 是**公开可推导**的（任何拿到日历的人
 *     30 秒就能算出来，包括认识字的孩子）。因此它**绝不能**用于登录、绑定设备、
 *     或任何"证明你是这个家的人"的场景 —— 那些场景需要服务端随机的、一次性的、
 *     有 TTL 的凭据（见 `docs/design/40-login-and-session-design.md` §11）。
 *     若将来有人拿它去签发 token，本注释就是那条不该被跨过的线。
 */

import { businessDayOf, DEFAULT_BUSINESS_TIME_ZONE, type BusinessDay } from '../habits/business-day'

/** 验证码的字符集：恰好 6 位数字。前端本地预检与后端 DTO 必须同一口径。 */
export const DATE_CODE_PATTERN = /^\d{6}$/

/** 每个码在它自己那一天的**前后各几天**都接受。0 ⇒ 只有当天（跨零点会误伤）。 */
export const DATE_CODE_TOLERANCE_DAYS = 1

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 命中的那一天相对"服务器今天"的偏移：
 *   `-1` 昨天的码 / `0` 今天的码 / `1` 明天的码（时钟偏快）——未命中时 `null`。
 *
 * 客户端用它给出**具体**提示（"这是昨天的码"），而不是一句"验证码错误"
 * —— 后者会让家长反复重算同一个值。
 */
export type DateCodeDayOffset = -1 | 0 | 1

export interface DateCodeVerdict {
  /** 输入的 6 位数是否命中**服务器今天 ± 容差**内的某一天。 */
  valid: boolean
  /** 服务器当天的日历日（`YYYY-MM-DD`，Asia/Shanghai）—— 客户端据此显示"今天是几号"。 */
  serverDate: string
  /** 服务器当天的 ISO 星期（1–7）。 */
  weekDay: number
  /** 命中哪一天；`valid=false` 时为 `null`。 */
  dayOffset: DateCodeDayOffset | null
  /** 该输入**彻底**失效的时刻（UTC ISO）；`valid=false` 时为 `null`。 */
  acceptedUntil: string | null
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

interface CalendarParts {
  year: number
  month: string
  date: string
}

function calendarPartsOf(day: BusinessDay): CalendarParts {
  const [year, month, date] = day.day.split('-')
  if (year === undefined || month === undefined || date === undefined) {
    throw new RangeError(
      `业务日格式异常：${JSON.stringify(day.day)}（应为 YYYY-MM-DD，来自 businessDayOf）。`
    )
  }
  return { year: Number(year), month, date }
}

/**
 * 该业务日的 ISO 星期（周一 1 … 周日 7）。
 *
 * ★ 用 `Date.UTC(y, m-1, d).getUTCDay()` 而不是 `day.start.getDay()`：
 *   `day.start` 是**该地日历日 00:00 对应的 UTC 瞬间**（`Asia/Shanghai` 下是前一天
 *   16:00Z），直接对它取 `getDay()` 会读到**前一天**的星期 —— 且只在东八区这种
 *   正偏移时区错，本机跑 UTC 的 CI 永远是绿的。
 */
export function isoWeekDayOf(day: BusinessDay): number {
  const { year, month, date } = calendarPartsOf(day)
  const jsDay = new Date(Date.UTC(year, Number(month) - 1, Number(date))).getUTCDay()
  return jsDay === 0 ? 7 : jsDay
}

/** 该业务日的 6 位验证码：`MMDD` ＋ 两位 ISO 星期。 */
export function dateVerificationCodeOf(day: BusinessDay): string {
  const { month, date } = calendarPartsOf(day)
  return `${month}${date}${pad2(isoWeekDayOf(day))}`
}

/**
 * 校验一个 6 位码。
 *
 * @param now 判定用的"现在" —— **必须由调用方（服务端）给出**，绝不读客户端时间。
 * @throws RangeError `now` 非法 / 时区名非法（来自 `businessDayOf`）：
 *   宁可 500，也不按错误的日子判定（那会让"正确的码"被判错，且无从解释）。
 */
export function verifyDateVerificationCode(
  input: string,
  now: Date,
  timeZone: string = DEFAULT_BUSINESS_TIME_ZONE
): DateCodeVerdict {
  const today = businessDayOf(now, timeZone)
  const base = { serverDate: today.day, weekDay: isoWeekDayOf(today) }
  const code = input.trim()

  if (!DATE_CODE_PATTERN.test(code)) {
    // 形状问题在 DTO 那层就是 400；这里仍然兜一次，避免纯函数被误用时报"通过"。
    return { ...base, valid: false, dayOffset: null, acceptedUntil: null }
  }

  // 顺序：今天 → 昨天 → 明天。今天命中是最常见的情形，先判，少算两次。
  const offsets: readonly DateCodeDayOffset[] = [0, -1, 1]
  for (const offset of offsets) {
    const day =
      offset === 0
        ? today
        : businessDayOf(new Date(today.start.getTime() + offset * DAY_MS), timeZone)
    if (dateVerificationCodeOf(day) !== code) continue

    // 窗口是 [day.start - 1 天, day.end + 1 天)，故失效时刻 = day.end + 1 天。
    return {
      ...base,
      valid: true,
      dayOffset: offset,
      acceptedUntil: new Date(day.end.getTime() + DATE_CODE_TOLERANCE_DAYS * DAY_MS).toISOString()
    }
  }

  return { ...base, valid: false, dayOffset: null, acceptedUntil: null }
}

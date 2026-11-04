/**
 * 网站「邀请码获取」的**运营参数**与**脱敏展示**（W12，2026-11-02）
 *
 * ── 为什么限额必须可配置，而且是纯函数 ──────────────────────────────────────
 *   「每天最多 50 个」是**产品承诺**，不是安全阈值：上线后要不要放宽到 100、
 *   收紧到 20，取决于真实申请量。写死在代码里，每次调整都要发版；
 *   放环境变量后改 `.env` + 重启即可（`REGISTRATION_INVITE_DAILY_LIMIT`）。
 *   纯函数让它可被单测直接钉住「填错时回退到 50」而不是 500。
 *
 * ── 两个「不猜」 ────────────────────────────────────────────────────────────
 *   ① 非法值（`abc` / 0 / 负数）⇒ **回退默认值**，不是启动失败：
 *      它只是一条发放额度，配错不该让整个 API 起不来。
 *   ② 超过硬上限 ⇒ **夹到上限**，不是原样接受：`100000` 会等于没有限额，
 *      而这张表/这个页面都没有承载 10 万次/天请求的理由。
 *
 * ── 为什么脱敏放在这里 ──────────────────────────────────────────────────────
 *   页面要回显「这张码绑的是哪个手机号/邮箱」，但它不需要看到完整值；
 *   服务端给脱敏后的串，页面就不可能把完整手机号写进日志/截图。
 */

/** 默认每日发放上限（产品口径：先按 50 个/天）。 */
export const DEFAULT_REGISTRATION_INVITE_DAILY_LIMIT = 50

/** 硬上限：超过它的配置会被夹住，防止「等于没有限额」。 */
export const MAX_REGISTRATION_INVITE_DAILY_LIMIT = 1000

/**
 * 同一个来源 IP 每业务日最多发几张（W12 边界，2026-11-04）。
 *
 * ── 为什么默认 5 而不是 1 ────────────────────────────────────────────────────
 *   同一个公网 IP 后面坐着**一个家庭 / 一所学校 / 一个运营商 NAT**。
 *   限成 1 会让「一家人给两个亲戚申请」直接失败，而限流要挡的是
 *   「一个脚本刷完 50 个名额」，不是「同一屋檐下的第二个人」。
 *
 * ── 为什么是硬上限 20 ────────────────────────────────────────────────────────
 *   配成 1000 等于没有这一层（与 `MAX_REGISTRATION_INVITE_DAILY_LIMIT` 同一条理由）。
 */
export const DEFAULT_REGISTRATION_INVITE_IP_DAILY_LIMIT = 5
export const MAX_REGISTRATION_INVITE_IP_DAILY_LIMIT = 20

/** 默认有效期（天）：给用户留出「今天拿到、过两天再注册」的余量。 */
export const DEFAULT_REGISTRATION_INVITE_TTL_DAYS = 7

/** 有效期硬上限：与家庭邀请码的 `MAX_INVITE_TTL_DAYS` 同一口径（30 天）。 */
export const MAX_REGISTRATION_INVITE_TTL_DAYS = 30

export interface RegistrationInviteConfig {
  /** 每个业务日最多发放多少张（1..1000）。 */
  dailyLimit: number
  /** 每张码的有效期（1..30 天）。 */
  ttlDays: number
  /** 同一个来源 IP 每业务日最多几张（1..20，W12 边界）。 */
  ipDailyLimit: number
}

/**
 * 读环境变量：`REGISTRATION_INVITE_DAILY_LIMIT` / `REGISTRATION_INVITE_TTL_DAYS`。
 *
 * ★ 每次调用都重新读 `process.env`（而不是模块顶层缓存）：测试可以按用例
 *   改环境，运维改完 `.env` 重启即生效 —— 两处都不会验到「上一次的值」。
 */
export function resolveRegistrationInviteConfig(
  env: NodeJS.ProcessEnv = process.env
): RegistrationInviteConfig {
  return {
    dailyLimit: readBoundedInt(
      env.REGISTRATION_INVITE_DAILY_LIMIT,
      DEFAULT_REGISTRATION_INVITE_DAILY_LIMIT,
      1,
      MAX_REGISTRATION_INVITE_DAILY_LIMIT
    ),
    ttlDays: readBoundedInt(
      env.REGISTRATION_INVITE_TTL_DAYS,
      DEFAULT_REGISTRATION_INVITE_TTL_DAYS,
      1,
      MAX_REGISTRATION_INVITE_TTL_DAYS
    ),
    ipDailyLimit: readBoundedInt(
      env.REGISTRATION_INVITE_IP_DAILY_LIMIT,
      DEFAULT_REGISTRATION_INVITE_IP_DAILY_LIMIT,
      1,
      MAX_REGISTRATION_INVITE_IP_DAILY_LIMIT
    )
  }
}

/** 缺省 / 空串 / 非整数 ⇒ 回退；合法但越界 ⇒ 夹住。 */
function readBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(parsed)) return fallback
  if (parsed < min) return fallback
  return Math.min(parsed, max)
}

/**
 * 手机号脱敏：`13800138000` → `138****8000`。
 *
 * 形状不认识时返回**固定占位**，不回显原文 —— 这个函数唯一的用途就是
 * 「不要让人看到完整号码」，兜底不能破这条。
 */
export function maskPhone(phone: string): string {
  const value = phone.trim()
  if (!/^\d{11}$/.test(value)) return '手机号已填写'
  return `${value.slice(0, 3)}****${value.slice(-4)}`
}

/**
 * 邮箱脱敏：`dad@example.com` → `d***@example.com`。
 *
 * 本地部分只有 1 个字符时用 `*@domain`（`d***@` 会暗示还有一个字符被藏起来）。
 */
export function maskEmail(email: string): string {
  const value = email.trim()
  const at = value.indexOf('@')
  if (at <= 0 || at === value.length - 1) return '邮箱已填写'
  const local = value.slice(0, at)
  const domain = value.slice(at)
  return local.length === 1 ? `*${domain}` : `${local[0]}***${domain}`
}

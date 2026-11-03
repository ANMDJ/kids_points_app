/**
 * 孩子模式的**规则内核**（W14，2026-11-03 / `docs/design/51-kid-mode-window.md`）。
 *
 * 回答四件事，全部是纯函数：
 *   ① 一次能给孩子用多久（1–30 分钟，默认 15）；
 *   ② 到期时刻怎么算（`now + N 分钟`，绝对时刻）；
 *   ③ 现在是「关 / 进行中 / 已到期锁住」哪一种；
 *   ④ 还剩多少秒（界面每帧现算，不存本地倒计时）。
 *
 * ── 与 `parent-mode.policy.ts` 的分工 ───────────────────────────────────────
 *   · 家长模式：**升级**窗口（child ⇒ guardian，5 分钟，PIN 换来）；
 *   · 孩子模式：**降级**窗口（guardian ⇒ child，≤30 分钟，家长主动交出手机）。
 *   两者共用同一套边界纪律，但方向相反 —— 所以分成两个文件，避免"一个 TTL 两个方向"。
 *
 * ── 三个刻意的口径（每一条都有用例钉着，见 `test/kid-mode-policy.test.ts`）──
 *   ① **上限只有这一处**：`KID_MODE_MAX_MINUTES = 30`。UI 的步进、DTO 的 `@Max`
 *      和这里的 `clampKidModeMinutes()` 都指向它；三份手抄必然漂移（`password_rules`
 *      已经交过学费），`tools/kid-mode-check.mjs` 会逐字比对三端副本。
 *   ② **到期 ≠ 自动回家长模式**（A 方案，2026-11-03 采纳）：
 *      `kidModeUntil === now` 起就算**已到期**，而状态是 `'locked'`（要 PIN 才能解），
 *      **不是** `'off'`。否则孩子只要等到点，手机就自己变回家长权限 ——
 *      那比不做管控更糟：它给了"有管控"的错觉。
 *   ③ **`locked` 不是"没有孩子模式"**：列里留着过去的时间戳，就是"曾经开过、
 *      还没被家长用 PIN 收回"的证据。清空它的唯一路径是 `DELETE /auth/kid-mode`
 *      （验 PIN）—— 见 `auth.prisma.repository.ts#exitKidMode`。
 *
 * ── 为什么状态由时间戳派生，而不是再加一列布尔 ─────────────────────────────
 *   时钟只在服务端：加一列 `kidModeLocked` 就必须有人在"到期那一刻"去写它 ——
 *   而我们没有定时任务，进程也可能正好没跑。派生没有任何写入窗口，
 *   也就没有"到期了但没人置位"的失败模式（与 `effectiveRole()` 同一条纪律）。
 */

/** 孩子模式一次最短 1 分钟。 */
export const KID_MODE_MIN_MINUTES = 1

/**
 * 孩子模式一次最长 30 分钟（产品裁定，2026-11-03）。
 *
 * ★ 三端副本必须逐字一致：本文件 / `lib/models/kid_mode.dart` /
 *   `kids_points_mp/src/data/parent_mode.ts`；`tools/kid-mode-check.mjs` 守着。
 */
export const KID_MODE_MAX_MINUTES = 30

/** 面板默认选中 15 分钟（**不是**上限：默认即上限会让"少用一会儿"变成额外操作）。 */
export const KID_MODE_DEFAULT_MINUTES = 15

/** 这个数字能不能作为一次孩子模式时长（整数、1–30）。 */
export function isKidModeDurationValid(raw: number): boolean {
  return Number.isInteger(raw) && raw >= KID_MODE_MIN_MINUTES && raw <= KID_MODE_MAX_MINUTES
}

/**
 * 把任意数字夹进 `[1, 30]` 的整数（**服务端的最后一道夹子**）。
 *
 * ★ 为什么 DTO 已经有 `@Min/@Max` 还要它：DTO 只在 HTTP 入口生效，而本函数是
 *   内核的契约 —— 任何未来的调用方（脚本、迁移、其他端点）都不可能开出一个
 *   "45 分钟"的孩子模式。只靠 UI 夹等于没夹。
 * ★ `NaN` / `Infinity` 一律落到默认值 15（而不是 30）：解析失败的请求不该
 *   自动拿到最大权限窗口。
 */
export function clampKidModeMinutes(raw: number): number {
  if (!Number.isFinite(raw)) return KID_MODE_DEFAULT_MINUTES
  const floored = Math.trunc(raw)
  if (floored < KID_MODE_MIN_MINUTES) return KID_MODE_MIN_MINUTES
  if (floored > KID_MODE_MAX_MINUTES) return KID_MODE_MAX_MINUTES
  return floored
}

/** 一次孩子模式的到期**绝对时刻**（`now + N 分钟`）。 */
export function kidModeExpiresAt(now: Date, minutes: number): Date {
  return new Date(now.getTime() + clampKidModeMinutes(minutes) * 60_000)
}

/**
 * 孩子模式的三态。
 *
 *   `'off'`    —— 这一列是 null（从没开过，或已被 PIN 收回）；
 *   `'active'` —— 窗口内：角色**降级**为 child；
 *   `'locked'` —— 已到期：角色**仍然是** child，直到家长输入 PIN 收回（口径 ②）。
 */
export type KidModeState = 'off' | 'active' | 'locked'

/**
 * 由时间戳现算三态；`until === now` 视为**已到期**（与 `session.gate.ts`
 * 的 `expiresAt === now` 即过期完全一致 —— 边界只允许有一处定义）。
 */
export function kidModeStateOf(kidModeUntil: Date | null, now: Date): KidModeState {
  if (kidModeUntil === null) return 'off'
  return kidModeUntil.getTime() > now.getTime() ? 'active' : 'locked'
}

/**
 * 孩子模式还剩多少秒（**向上取整**，不小于 0；`locked` / `off` 都是 0）。
 *
 * 与 `parent-mode.policy.ts#remainingSeconds()` 同一个取整口径：
 * 客户端用它显示「剩余 12:34」，向下取整会让倒计时跳一秒。
 */
export function kidModeRemainingSeconds(kidModeUntil: Date | null, now: Date): number {
  if (kidModeUntil === null) return 0
  const ms = kidModeUntil.getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / 1000)
}

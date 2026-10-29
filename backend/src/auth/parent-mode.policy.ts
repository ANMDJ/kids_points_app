/**
 * 家长模式的**规则内核**（W8-C，2026-10-27 / `docs/design/02` §7、§9.18）。
 *
 * 回答三件事，全部是纯函数：
 *   ① 家长模式的 TTL 有多长（5 分钟，`02` §7）；
 *   ② 连错几次锁多久（5 次 ⇒ 15 分钟，`§9.18`）；
 *   ③ 一次失败之后 `pinFailedCount` / `pinLockedUntil` 该变成什么。
 *
 * ── 为什么单独一个文件（而不是散在 service 里）────────────────────────────────
 *   这些数字是**验收口径**：`02` §7 写"5 分钟"，`§9.18` 写"连错 5 次锁 15 分钟"。
 *   把它们埋进 service 的 if 里，就得靠读实现来核对规格；写成导出的常量 + 纯函数，
 *   用例可以逐条穷举（`test/parent-mode-policy.test.ts`），改数字时也有**一处**可改。
 *   与 `session.gate.ts` / `membership.gate.ts` 同一条纪律：
 *   **判定归纯函数，落库归适配器，翻成 HTTP 归服务/控制器。**
 *
 * ── 三个刻意的口径（每一条都有用例钉着）──────────────────────────────────────
 *   ① **TTL 边界**：`expiresAt === now` 即视为**已过期** —— 与 `session.gate.ts`
 *      的 `isSessionActive()` 完全一致。两处若一个用 `>` 一个用 `>=`，
 *      就会出现"刚切进家长模式就立刻回落"的一秒窗口。
 *   ② **格式错误不算一次失败**：`isPinFormatValid()` 为假时（3 位 / 7 位 / 带字母）
 *      是打字失误，不是猜测。把它计进 `pinFailedCount` 会让家长手滑三次就被锁 15 分钟。
 *      只有"格式合法但值不对"才计一次。
 *   ③ **锁定是**成员级**的**：计数落在 `ChildMember`（`06` §3 D3），
 *      所以换台设备继续猜也绕不过 —— 这让"锁 15 分钟"真的成立。
 */

/** 家长模式有效期：5 分钟（`02` §7）。 */
export const PARENT_MODE_TTL_MS = 5 * 60 * 1000

/** 连错多少次锁定（`§9.18`）。 */
export const PIN_MAX_FAILURES = 5

/** 锁定时长：15 分钟（`§9.18`）。 */
export const PIN_LOCK_MS = 15 * 60 * 1000

/** 一次成功的家长操作应该把 TTL 推到什么时刻（`02` §7「每次 guardian 操作刷新」）。 */
export function parentModeExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PARENT_MODE_TTL_MS)
}

/**
 * 这台设备的 guardian 权限**从哪来**：
 *   · `pin`     —— 用 PIN 换来的 5 分钟（`02` §7 的家长模式）；
 *   · `session` —— 会话登录本身就是 `guardian`（用邀请码加入的家长设备，
 *                  会话按设备登录口径发 30 天，见 `invites/invite-code.ts`）。
 *
 * ★ 为什么不落库：`DeviceSession` 只存 `activeRole` / `expiresAt`，来源完全由
 *   「到期时刻离现在有多远」决定 —— PIN 提升恰好是 TTL，登录会话是 30 天。
 *   多存一列 `elevatedAt` 只会多出一个能与 `expiresAt` 打架的字段。
 * ★ 阈值就取 TTL 本身，**不**留时钟余量：`remainingSeconds()` 向上取整，PIN 路径
 *   读回来永远 ≤300（写库时是 now+TTL，读的时候只会更短）；任何 >300 的剩余时间
 *   只可能来自登录会话。客户端据此做交叉校验（`pin ⇒ ≤300` / `session ⇒ >300`），
 *   所以这里的口径必须与 `PARENT_MODE_TTL_MS` 严格一致，不能各写一个数。
 */
export type ParentModeSource = 'pin' | 'session'

export function parentModeSourceOf(expiresAt: Date, now: Date): ParentModeSource {
  return expiresAt.getTime() - now.getTime() > PARENT_MODE_TTL_MS ? 'session' : 'pin'
}

/**
 * 剩下的秒数（**向上取整**，不小于 0）。
 *
 * 为什么向上取整：客户端用它显示"还剩 4:59"。向下取整会让 4 分 59.7 秒显示成 4:59，
 * 而 4 分 0.3 秒显示成 4:00 —— 用户看到"04:00"时其实只剩 3 分 60 秒，倒计时会跳。
 */
export function remainingSeconds(expiresAt: Date, now: Date): number {
  const ms = expiresAt.getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / 1000)
}

/** 是否处于锁定中（`pinLockedUntil === now` 视为**已解锁** —— 与 TTL 相反的边界，理由见下）。 */
export function isPinLocked(lockedUntil: Date | null, now: Date): boolean {
  if (lockedUntil === null) return false
  // ★ 这里用 `>` 而不是 `>=`：锁定的语义是"到这一刻**之后**才可以再试"。
  //   与 TTL 的 `expiresAt === now` 即过期看似矛盾，其实是同一句话的两种视角：
  //   TTL 是"有效期到此刻为止"（含端点失效），锁定是"锁到此刻为止"（到点即解）。
  return lockedUntil.getTime() > now.getTime()
}

/** 锁还剩多少秒（向上取整，不小于 0）—— 用于 `Retry-After` 与客户端文案。 */
export function lockRemainingSeconds(lockedUntil: Date | null, now: Date): number {
  if (lockedUntil === null) return 0
  return remainingSeconds(lockedUntil, now)
}

/** 还允许试几次（给客户端的"还剩 N 次"；已锁定时为 0）。 */
export function remainingAttempts(failedCount: number): number {
  return Math.max(0, PIN_MAX_FAILURES - Math.max(0, failedCount))
}

export interface PinFailureOutcome {
  /** 写回 `ChildMember.pinFailedCount` 的值。 */
  failedCount: number
  /** 写回 `ChildMember.pinLockedUntil`；未达阈值 ⇒ `null`（**显式清空**，见下）。 */
  lockedUntil: Date | null
  /** 这一次失败是否**刚刚**触发了锁定（用于区分 403 与 429）。 */
  justLocked: boolean
}

/**
 * 一次"格式合法但值不对"的尝试之后，成员位上的两个计数该变成什么。
 *
 * ★ 未达阈值时 `lockedUntil` 明确返回 `null`：调用方会写回这一列。
 *   若返回 `undefined`/"保持不变"，上一轮锁定残留的时间戳会与新的计数并存 ——
 *   出现"failedCount=1 但 lockedUntil 是明天"这种自相矛盾的行。
 *
 * ★ 达阈值后**计数清零**：锁定期间不允许尝试，解锁后从 0 重新数。
 *   若保留 5，则解锁后第一次输入错误就又锁 15 分钟（"永久锁死"的变形）。
 */
export function nextPinFailureState(failedCount: number, now: Date): PinFailureOutcome {
  const next = Math.max(0, failedCount) + 1
  if (next >= PIN_MAX_FAILURES) {
    return {
      failedCount: 0,
      lockedUntil: new Date(now.getTime() + PIN_LOCK_MS),
      justLocked: true
    }
  }
  return { failedCount: next, lockedUntil: null, justLocked: false }
}

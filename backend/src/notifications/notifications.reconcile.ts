import { Injectable, NotImplementedException } from '@nestjs/common'

/**
 * 通知与推送任务的对账（W6-D，2026-10-24）—— **只读**、只告警、**不自动补发**。
 *
 * ── 它对账的那条缝隙 ──────────────────────────────────────────────────────
 *   W6-C 把 `Notification` 与 `PushRetryJob` 放进了审批的同一个事务，正常情况下
 *   两表**一一对应**。但 `notifications.outbox.ts` §去重 里承认过一个极小的竞态窗口：
 *   「先查 `dedupeKey`」与「写入」之间，另一个事务可能插入同一键；此时
 *   `skipDuplicates` 保证队列不重复，却可能让站内通知多出一条而没有对应任务。
 *   另外，人工 SQL / 迁移脚本 / 未来的新写入点都可能只写一侧。
 *
 *   本文件回答四个问题：
 *     ① 有站内通知、没有推送任务的有几条？
 *     ② 有推送任务、没有站内通知的有几条？
 *     ③ 同一「收件人 + 类型 + approvalId」多写了几条通知（W6-C 的去重窗口）？
 *     ④ 队列现在各状态多少条、最老的 `pending` 等了多久？
 *
 * ── 为什么只告警、不自动补发 ────────────────────────────────────────────────
 *   「自动补一条推送」听起来很贴心，实际是**再打扰用户一次**：缺口可能是
 *   「通知写了、任务被人工删了」，也可能是「任务写得对、通知是脏数据」。
 *   没有人工判断就补发，等于把一次数据异常变成一次手机弹窗。运维手册里的处置是：
 *   先按 `payload.approvalId` 对照审批行，确认缺的是哪一侧，再人工决定是否补。
 *
 * ── 为什么不在请求路径里查 ─────────────────────────────────────────────────
 *   对账要扫两张表并解 JSON，代价与大表规模成正比；把它放进 `GET /notifications`
 *   会让「看消息」变慢。它是后台任务（`NotificationsReconcileWorker`），
 *   默认 5 分钟一轮，只写日志。
 */
export const NOTIFICATIONS_RECONCILE_PORT = Symbol('NOTIFICATIONS_RECONCILE_PORT')
export const NOTIFICATIONS_RECONCILE_CONFIG = Symbol('NOTIFICATIONS_RECONCILE_CONFIG')

export const NOTIFICATIONS_RECONCILE_ENABLED_ENV = 'NOTIFICATIONS_RECONCILE_ENABLED'
export const NOTIFICATIONS_RECONCILE_INTERVAL_ENV = 'NOTIFICATIONS_RECONCILE_INTERVAL_MS'

export const DEFAULT_NOTIFICATIONS_RECONCILE_INTERVAL_MS = 5 * 60_000
export const MIN_NOTIFICATIONS_RECONCILE_INTERVAL_MS = 60_000
export const MAX_NOTIFICATIONS_RECONCILE_INTERVAL_MS = 60 * 60_000

/**
 * 参与对账的站内通知类型 —— 与 outbox 实际写的三种**逐字一致**。
 *
 * ★ 刻意只列这三种：`Notification` 表也承载未来其它业务的通知（例如
 *   `reward.redeemed`），它们本来就没有推送任务，把它们算成「缺口」会让
 *   告警永远为真 —— 一个永远为真的告警等于没有告警。
 */
export const RECONCILED_NOTIFICATION_TYPES = [
  'approval.submitted',
  'approval.approved',
  'approval.rejected'
] as const

export interface NotificationsReconcileConfig {
  /** `false` ⇒ worker 不启动。默认 `true`。 */
  enabled: boolean
  intervalMs: number
}

/**
 * 对账结论。
 *
 * `oldestPendingAgeMs` 为 `null` 表示队列里**一条 pending 都没有** ——
 * 与「最老的等了 0ms」是两件事，不要合并成一个数字。
 */
export interface NotificationsReconcileSnapshot {
  /** 有站内通知、但找不到对应推送任务（按键：收件人 + approvalId + 事件语义）。 */
  notificationsWithoutJob: number
  /** 有推送任务、但找不到对应站内通知。 */
  jobsWithoutNotification: number
  /**
   * **多出来的**站内通知条数（同一「收件人 + 类型 + approvalId」出现 n>1 次时计 n−1）。
   *
   * ★ 为什么必须有这一项：W6-C 的去重是「先查再写 + skipDuplicates」，
   *   并发窗口下可能多写一条站内通知，而推送任务只有一条 —— 这种漂移
   *   在「配对存在性」看来**是完全健康的**（两边都找得到对面）。
   *   没有这一项，交接单里「由 W6-D 对账发现」那句话就是空头承诺。
   * ★ 推送任务侧不需要对应计数：`dedupeKey` 唯一，重复入队不可能落库。
   */
  duplicateNotifications: number
  pending: number
  sending: number
  sent: number
  dead: number
  expired: number
  /** 最老一条 `pending` 的等待时长（毫秒）；没有 pending ⇒ `null`。 */
  oldestPendingAgeMs: number | null
  /** 本次对账时刻（由调用方传入，用例可固定时钟）。 */
  checkedAt: Date
}

/** 对账端口的**最小**形状：一次快照，不提供任何写方法（想补发请走人工）。 */
export interface NotificationsReconcilePort {
  snapshot(now: Date): Promise<NotificationsReconcileSnapshot>
}

/**
 * 漂移判定：两处「找不到对面」任一非零即为漂移。
 *
 * ★ 状态分布（`dead` / `expired`）**不算漂移**：它们是队列正常工作后的终态。
 *   把它们算成错误，会让「没有配网关」这个已知状态在每次对账时都报警。
 */
export function hasReconcileDrift(snapshot: NotificationsReconcileSnapshot): boolean {
  return (
    snapshot.notificationsWithoutJob > 0 ||
    snapshot.jobsWithoutNotification > 0 ||
    snapshot.duplicateNotifications > 0
  )
}

/** 一行日志（字段名英文，便于 grep；与 `PushRetryMetrics.toLogLine()` 同一手法）。 */
export function describeReconcile(snapshot: NotificationsReconcileSnapshot): string {
  return (
    `notifications_without_job=${snapshot.notificationsWithoutJob} ` +
    `jobs_without_notification=${snapshot.jobsWithoutNotification} ` +
    `duplicate_notifications=${snapshot.duplicateNotifications} ` +
    `pending=${snapshot.pending} sending=${snapshot.sending} sent=${snapshot.sent} ` +
    `dead=${snapshot.dead} expired=${snapshot.expired} ` +
    `oldest_pending_age_ms=${snapshot.oldestPendingAgeMs ?? 'none'}`
  )
}

/**
 * 日志级别也是纯函数 —— 否则「有漂移时到底告警了没有」只能靠打桩 Logger 来测。
 *
 * ★ 无漂移走 `debug`：默认 5 分钟一轮，一天 288 条 `log` 会把真正有用的行淹掉。
 */
export function reconcileLogLevel(
  snapshot: NotificationsReconcileSnapshot
): 'warn' | 'debug' {
  return hasReconcileDrift(snapshot) ? 'warn' : 'debug'
}

/** 环境配置 —— 纯函数，不读 `process.env`、不碰时钟（与 `push-retry.config.ts` 同款）。 */
export function readNotificationsReconcileConfig(
  env: NodeJS.ProcessEnv
): NotificationsReconcileConfig {
  return {
    enabled: readEnabled(env[NOTIFICATIONS_RECONCILE_ENABLED_ENV]),
    intervalMs: readInt(env[NOTIFICATIONS_RECONCILE_INTERVAL_ENV], {
      fallback: DEFAULT_NOTIFICATIONS_RECONCILE_INTERVAL_MS,
      min: MIN_NOTIFICATIONS_RECONCILE_INTERVAL_MS,
      max: MAX_NOTIFICATIONS_RECONCILE_INTERVAL_MS
    })
  }
}

/**
 * 关闭开关：只有明确写成 `0` / `false` / `off` / `no` 才关。
 *
 * ★ 与 `push-retry.config.ts` 同一方向：拼错一个值不该让兜底任务静默消失。
 */
function readEnabled(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return true
  const value = raw.trim().toLowerCase()
  return !['0', 'false', 'off', 'no', 'disabled'].includes(value)
}

/** 整数 + 夹取。空串 / 非数字 ⇒ 默认；小数 ⇒ 向下取整后再夹。 */
function readInt(
  raw: string | undefined,
  bounds: { fallback: number; min: number; max: number }
): number {
  if (typeof raw !== 'string' || raw.trim() === '') return bounds.fallback
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed)) return bounds.fallback
  const floored = Math.floor(parsed)
  return Math.min(Math.max(floored, bounds.min), bounds.max)
}

/**
 * 无库装配：对账无表可读 ⇒ 501。
 *
 * ★ **不返回全零快照**：全零会被 worker 当成「一切正常」，而事实上我们
 *   根本没查过任何一行。这与 `NotImplementedNotificationsRepository` 的
 *   「不返回空列表冒充没有通知」是同一条纪律。
 */
@Injectable()
export class NotImplementedNotificationsReconcile implements NotificationsReconcilePort {
  async snapshot(_now: Date): Promise<NotificationsReconcileSnapshot> {
    throw new NotImplementedException({
      code: 'NOTIFICATIONS_RECONCILE_NOT_IMPLEMENTED',
      message: '通知对账需要数据库连接（DATABASE_URL 未设置）'
    })
  }
}

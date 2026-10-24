import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'

import {
  NOTIFICATIONS_RECONCILE_CONFIG,
  NOTIFICATIONS_RECONCILE_PORT,
  describeReconcile,
  reconcileLogLevel,
  type NotificationsReconcileConfig,
  type NotificationsReconcilePort,
  type NotificationsReconcileSnapshot
} from './notifications.reconcile'

/**
 * 通知 / 推送任务的对账 worker（W6-D，2026-10-24）。
 *
 * ── 每一轮只做一件事 ──────────────────────────────────────────────────────
 *   读一次快照（两处「找不到对面」+ 状态分布 + 最老 pending 年龄），
 *   然后写日志：有漂移 ⇒ `warn`，没有 ⇒ `debug`。**不写库、不发推送、不补数据。**
 *
 * ── 为什么用 `debug` 打「一切正常」────────────────────────────────────────
 *   默认 5 分钟一轮、一天 288 条 `log` 会把真正有用的行淹掉。漂移才是 `warn`。
 *
 * ── 计时器纪律（与 `PushRetryWorker` / `ApprovalsExpiryService` 相同）───────
 *   构造函数里**不**启动计时器；只有 `main.ts` 调 `start()`，且 `unref()`。
 *   否则 `npm test` 实例化模块后会留下一个永不结束的计时器。
 *
 * ── 重入保护 ──────────────────────────────────────────────────────────────
 *   `safeTick()` 用 `running` 挡住「上一轮还没跑完又到点」；对账是只读的，
 *   即使真的重叠也不会写坏数据，但会把同一条 warn 打两遍。
 */
@Injectable()
export class NotificationsReconcileWorker implements OnApplicationShutdown {
  private readonly log = new Logger(NotificationsReconcileWorker.name)
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    @Inject(NOTIFICATIONS_RECONCILE_PORT) private readonly port: NotificationsReconcilePort,
    @Inject(NOTIFICATIONS_RECONCILE_CONFIG) private readonly config: NotificationsReconcileConfig
  ) {}

  /** 启动周期对账（幂等：重复调用不会多一个计时器）。 */
  start(): void {
    if (this.timer !== null) return
    if (!this.config.enabled) {
      this.log.warn('NOTIFICATIONS_RECONCILE_ENABLED=0 —— 通知对账 worker 不启动（缺口不会告警）')
      return
    }
    this.timer = setInterval(() => {
      void this.safeTick()
    }, this.config.intervalMs)
    this.timer.unref()
    this.log.log(`通知对账 worker 已启动（每 ${this.config.intervalMs}ms 一轮，只告警不补发）`)
    // 启动即跑一轮：部署前积累的缺口不必等第一个间隔。
    void this.safeTick()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
    this.log.log('通知对账 worker 已停止')
  }

  onApplicationShutdown(): void {
    this.stop()
  }

  /**
   * 一轮对账。`now` 可注入 —— 用例不必等 5 分钟，也不必依赖真实时钟。
   *
   * ★ 异常向上抛：`safeTick` 会把它变成一条 error 日志；用例能直接断言失败。
   */
  async tick(now: Date = new Date()): Promise<NotificationsReconcileSnapshot> {
    const snapshot = await this.port.snapshot(now)
    const line = describeReconcile(snapshot)

    if (reconcileLogLevel(snapshot) === 'warn') {
      this.log.warn(
        `通知 / 推送对账发现缺口：${line} —— 只告警，不自动补发；` +
          '请按 approvalId 对照两侧后人工处置（见 32-w6d-handoff.md §4）'
      )
    } else {
      this.log.debug(`通知 / 推送对账无缺口：${line}`)
    }
    return snapshot
  }

  /** 计时器回调：吞掉异常并保证不重入。 */
  private async safeTick(): Promise<void> {
    if (this.running) {
      this.log.debug('上一轮对账还没跑完，跳过本轮')
      return
    }
    this.running = true
    try {
      await this.tick(new Date())
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log.error(`通知对账失败（下一轮继续）：${detail}`)
    } finally {
      this.running = false
    }
  }
}

import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { APPROVALS_REPOSITORY, type ApprovalsPort } from './approvals.repository'

/**
 * 审批 TTL 后台扫描（`02` §4.3 的 72h 过期）。
 *
 * ── 为什么还需要它（已经有惰性过期了）──────────────────────────────────────
 *   惰性过期只在「有人读 / 决 / 撤回这条审批」时发生。一条**没人再碰**的 `pending`
 *   会永远停在 `pending`：列表里看起来还能批，家长点下去才 409。
 *   后台扫描让「到期」成为**时间**的函数，而不是「有没有人访问」的函数。
 *
 * ── 为什么不在模块构造时自动跑 ───────────────────────────────────────────
 *   测试会 `Test.createTestingModule({ imports: [AppModule] })` —— 若在
 *   `OnModuleInit` 里起 `setInterval`，每个用例文件都会留下一个计时器（Node
 *   进程不退出、测试串行变慢）。所以**只有 `main.ts` 显式 `start()`**；
 *   真库用例则直接调 `scanOnce()` 验证行为（不需要等 60 秒）。
 *
 * ★ 无库装配（`npm test` / 未配 `DATABASE_URL`）：`start()` 直接 no-op。
 *   这不是\"假装扫过了\"——`ApprovalsPort.expireDue` 在无库时仍是 501，
 *   而我们**不启动**一个必然 501 的计时器（那只会刷日志）。
 */
@Injectable()
export class ApprovalsExpiryService implements OnApplicationShutdown {
  private static readonly logger = new Logger(ApprovalsExpiryService.name)
  /** 默认 60s；可用 `APPROVAL_EXPIRY_SCAN_INTERVAL_MS` 调整（测试/本地演示可调小）。 */
  private static readonly DEFAULT_INTERVAL_MS = 60_000

  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(@Inject(APPROVALS_REPOSITORY) private readonly port: ApprovalsPort) {}

  /**
   * 扫描一次（可注入时钟，便于用例如实断言「到期」而不是等真实时间）。
   * 返回本次真正置为 `expired` 的行数。
   */
  async scanOnce(now: Date = new Date(), limit = 100): Promise<number> {
    return this.port.expireDue(now, limit)
  }

  /** 启动周期扫描（只应由 `main.ts` 调用；重复调用无副作用）。 */
  start(): void {
    if (this.timer !== undefined) return
    if (!hasDatabaseUrl()) {
      ApprovalsExpiryService.logger.warn('未配置 DATABASE_URL —— 审批过期扫描未启动（无库装配）。')
      return
    }

    const configured = Number(process.env.APPROVAL_EXPIRY_SCAN_INTERVAL_MS ?? '')
    const intervalMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : ApprovalsExpiryService.DEFAULT_INTERVAL_MS

    // 启动时先扫一次：进程停机期间到期的审批不该再等一个完整周期。
    void this.tick()
    this.timer = setInterval(() => void this.tick(), intervalMs)
    // ★ `unref()`：计时器不阻止进程退出（尤其重要：`npm test` 之外的脚本也可能建图）。
    this.timer.unref()
    ApprovalsExpiryService.logger.log(`审批过期扫描已启动（每 ${intervalMs}ms 一次）。`)
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 防重入：上一轮还没跑完（库慢/锁等待）时跳过本轮，而不是堆积。 */
  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const expired = await this.scanOnce()
      if (expired > 0) {
        ApprovalsExpiryService.logger.log(`审批过期扫描：${expired} 条 pending → expired。`)
      }
    } catch (err) {
      // ★ 后台任务**不许静默吞错**：打印后等下一轮，进程继续服务。
      ApprovalsExpiryService.logger.error(
        `审批过期扫描失败：${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      this.running = false
    }
  }
}

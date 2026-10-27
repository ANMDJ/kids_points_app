import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'

import { DELETION_REPOSITORY, type DeletionPort, type ExecutedDeletion } from './deletion.repository'

export const DELETION_WORKER_CONFIG = Symbol('DELETION_WORKER_CONFIG')

/** worker 的装配参数（用例直接构造，不读环境变量）。 */
export interface DeletionWorkerConfig {
  enabled: boolean
  intervalMs: number
  batchSize: number
}

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_BATCH_SIZE = 20

/** 从环境变量解析（只做**有界**解析：乱填不许变成热循环或一次吞掉全表）。 */
export function resolveDeletionWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): DeletionWorkerConfig {
  const enabled = (env.FAMILY_DELETION_WORKER_ENABLED ?? 'true').trim().toLowerCase() !== 'false'

  const rawInterval = Number(env.FAMILY_DELETION_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
  const intervalMs =
    Number.isFinite(rawInterval) && rawInterval >= 1_000 ? rawInterval : DEFAULT_INTERVAL_MS

  const rawBatch = Number(env.FAMILY_DELETION_BATCH ?? DEFAULT_BATCH_SIZE)
  const batchSize =
    Number.isInteger(rawBatch) && rawBatch >= 1 && rawBatch <= 200 ? rawBatch : DEFAULT_BATCH_SIZE

  return { enabled, intervalMs, batchSize }
}

/**
 * 家庭数据删除的**执行 worker**（W7-D，2026-10-27）。
 *
 * ── 为什么是 worker 而不是「申请时就 setTimeout」─────────────────────────────
 *   冷却期承诺 7 天后执行。进程可能在这 7 天里重启十次；`setTimeout` 会全部丢失，
 *   而家长不会收到任何提示 —— 数据就永远留在那儿，界面还写着「将于 X 日删除」。
 *   因此到期时刻落库（`scheduledFor`），worker 定期扫描**到期**行。
 *
 * ── 单飞（single-flight）───────────────────────────────────────────────────
 *   一轮还没跑完时又到点（或启动时立刻 tick + 第一次 interval 恰好撞上），
 *   第二次直接复用第一次的 Promise。理由与 `PushRetryWorker` 相同：
 *   并发扫描没有额外收益，却会让「同一个请求」被两轮同时尝试领走。
 *   （数据库侧还有 `FOR UPDATE SKIP LOCKED` 兜底 —— 两层都不省。）
 *
 * ── 失败不崩进程 ────────────────────────────────────────────────────────────
 *   `safeTick()` 吞掉异常并 `logger.error`：一次数据库抖动不该让整个 Nest 进程退出。
 *   但**吞掉不等于忽略** —— `tick()` 本身会抛，用例可以直接断言错误传播；
 *   定时器回调走 `safeTick()`，两者不冲突。
 *
 * ★ 关闭：`FAMILY_DELETION_WORKER_ENABLED=false`。生产默认开启；
 *   离线用例不会走到这里（无库装配的端口一律 501）。
 */
@Injectable()
export class FamilyDeletionWorker implements OnApplicationShutdown {
  private readonly logger = new Logger(FamilyDeletionWorker.name)
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<ExecutedDeletion[]> | null = null

  constructor(
    @Inject(DELETION_REPOSITORY) private readonly port: DeletionPort,
    @Inject(DELETION_WORKER_CONFIG) private readonly config: DeletionWorkerConfig
  ) {}

  /** 幂等启动：重复调用不会叠出第二个定时器（`main.ts` 是唯一调用点）。 */
  start(): void {
    if (!this.config.enabled) {
      this.logger.log('家庭数据删除 worker 已禁用（FAMILY_DELETION_WORKER_ENABLED=false）')
      return
    }
    if (this.timer !== null) return

    this.timer = setInterval(() => {
      void this.safeTick()
    }, this.config.intervalMs)
    // 定时器不应单独把进程按住不退出（与其它 worker 同一口径）。
    this.timer.unref?.()
    // 启动即扫一轮：重启后到期但是「上一进程没来得及执行」的请求不该再等一个周期。
    void this.safeTick()
  }

  /**
   * 跑一轮。返回这一轮**真正执行**的删除（供日志 / 用例断言）。
   * ★ 传 `now` 而不是内部读时钟：让「到期」可被用例精确驱动。
   */
  tick(now: Date = new Date()): Promise<ExecutedDeletion[]> {
    if (this.inFlight !== null) return this.inFlight

    const run = this.port.executeDue({ now, limit: this.config.batchSize })
    this.inFlight = run
    return run.finally(() => {
      this.inFlight = null
    })
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    // 等在途的一轮结束：删除是事务性的，中途掐断只会回滚（安全），
    // 但等待能让日志与测试看到真实结果，而不是「关了就不知道跑到哪」。
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined)
    }
  }

  private async safeTick(): Promise<void> {
    try {
      const executed = await this.tick()
      if (executed.length > 0) {
        this.logger.log(
          `家庭数据删除：本轮执行 ${executed.length} 个请求（${executed
            .map((item) => item.childId)
            .join(', ')}）`
        )
      }
    } catch (error) {
      this.logger.error(
        `家庭数据删除 worker 本轮失败（下一轮会重试，请求仍为 pending）：${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}

import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common'

import { Public } from '../identity/public.decorator'
import { HEALTH_PROBE, type HealthProbe } from './health.probe'

/**
 * `GET /health` ＋ `GET /health/ready` —— 存活探针与就绪探针（P0-5，2026-11-03）。
 *
 * ── 为什么是两条而不是一条 ──────────────────────────────────────────────────
 *   这是 `43` §0 P0-5 验收判据里那句「两者分开，别让库慢把进程判死」的落地：
 *
 *   | 端点 | 查库 | 失败意味着 | 谁可以用它做「重启」判据 |
 *   |---|---|---|---|
 *   | `GET /health` | **否** | 进程/事件循环卡死、端口没监听 | ✅ 可以（重启不会更糟） |
 *   | `GET /health/ready` | 是 `SELECT 1` | 库不可用 / 未配置 | ❌ **不行**（重启 API 救不了库） |
 *
 *   compose 的 `healthcheck` 只打 `/health`：库抖动 30 秒不该让 API 容器
 *   被反复重启，而重启期间连「只读降级」都做不到。`/health/ready` 留给
 *   外部监控 / 人工排障 —— 它回 503 时该看的是 pg18，不是 kids-api。
 *
 * ── 为什么两条都是 `@Public()` ───────────────────────────────────────────────
 *   全局 `AuthGuard` 默认拦住一切（`app.module.ts` 里的设计说明）。探针的
 *   调用方是 docker / 监控系统，它们**没有** 设备头也没有 token。这两条端点
 *   不返回任何用户数据、不接受任何入参、不改变任何状态 —— 与 `GET /app/version`
 *   同一判据（见 `app-version.controller.ts` 文件头）。
 *
 * ── 响应为什么是固定形状 ────────────────────────────────────────────────────
 *   监控脚本要能 `jq -e '.status == "ok"'`。所以成功是 `200 + {status:"ok"}`，
 *   失败是 `503 + {status:"degraded"}`（HTTP 码给机器，`status` 给人看）。
 *   `detail` 已经过 `redactProbeDetail()` 脱敏 —— 这条端点是匿名可读的，
 *   任何带 `user:pass@` 的原文都会变成公网泄漏。
 */

/** `GET /health` 的响应（**不含**任何配置 / 数据库信息）。 */
export interface LivenessView {
  status: 'ok'
  /** 固定 `kids-api`：同一台机上还有 pg18 / Caddy，日志里要能分辨是谁。 */
  service: string
  /** 进程启动至今的秒数。吊死前最后一次抓取能看出「它刚重启过」。 */
  uptimeSeconds: number
}

/** `GET /health/ready` 的响应（失败时同形状 + 503）。 */
export interface ReadinessView {
  status: 'ok' | 'degraded'
  checks: {
    database: {
      status: 'up' | 'down' | 'unconfigured'
      latencyMs: number
      detail?: string
    }
  }
}

/** 控制器级硬超时（毫秒）。DI 令牌，测试可以调成 10ms 验证超时分支。 */
export const HEALTH_READY_TIMEOUT_MS = Symbol('HEALTH_READY_TIMEOUT_MS')

/** 默认 2 秒：比 compose `healthcheck` 的 timeout 短，监控不会先超时。 */
export const DEFAULT_HEALTH_READY_TIMEOUT_MS = 2_000

@Controller('health')
export class HealthController {
  constructor(
    @Inject(HEALTH_PROBE) private readonly probe: HealthProbe,
    @Inject(HEALTH_READY_TIMEOUT_MS) private readonly readyTimeoutMs: number
  ) {}

  /**
   * 存活探针：**不碰数据库**，只证明「这个进程还能处理 HTTP」。
   *
   * ★ 刻意不返回版本号 / 迁移状态：那些东西会随配置变化，而存活探针的
   *   语义必须是不变的（`200` = 活着）。版本在 `GET /app/version`。
   */
  @Get()
  @Public()
  live(): LivenessView {
    return {
      status: 'ok',
      service: 'kids-api',
      uptimeSeconds: Math.floor(process.uptime())
    }
  }

  /**
   * 就绪探针：`SELECT 1` + 硬超时。
   *
   * ★ 失败用 503（Service Unavailable）而不是 500：500 会让「网关把 5xx
   *   计入错误率并告警」，而「库没就绪」是预期内的状态（重启中、备份恢复中）。
   *   503 也是 Caddy / k8s 认的「暂时别把流量发进来」。
   */
  @Get('ready')
  @Public()
  async ready(): Promise<ReadinessView> {
    const result = await this._probeWithTimeout()

    const database: ReadinessView['checks']['database'] = {
      status: result.unconfigured === true ? 'unconfigured' : result.ok ? 'up' : 'down',
      latencyMs: result.latencyMs
    }
    if (result.detail !== undefined) database.detail = result.detail

    const body: ReadinessView = {
      status: database.status === 'up' ? 'ok' : 'degraded',
      checks: { database }
    }
    if (body.status !== 'ok') {
      // ★ 传对象而不是字符串：Nest 会把对象**原样**作为响应体（不套
      //   `{statusCode, message}`），监控才能用同一份 JSON 形状判断两条路径。
      throw new ServiceUnavailableException(body)
    }
    return body
  }

  /** `Promise.race` 的薄封装：探针实现换了也不会漏掉超时。 */
  private async _probeWithTimeout(): Promise<Awaited<ReturnType<HealthProbe['probeDatabase']>>> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`数据库探针超过 ${this.readyTimeoutMs}ms 未返回（库可能已挂起）`)
        )
      }, this.readyTimeoutMs)
    })
    try {
      return await Promise.race([this.probe.probeDatabase(), timeout])
    } catch (error) {
      return {
        ok: false,
        latencyMs: this.readyTimeoutMs,
        detail: error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

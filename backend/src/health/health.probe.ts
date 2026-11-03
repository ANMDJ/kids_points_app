import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'

/**
 * 存活 / 就绪探针的**数据库端口**（P0-5，2026-11-03）。
 *
 * ── 为什么单独一个文件、而不是把 `$queryRaw` 写在控制器里 ─────────────────────
 *   控制器要能被**无库装配**（`DATABASE_URL` 未设置时后端仍要起得来，
 *   否则「配置错了」会表现成「进程反复重启」，运维看不出是配置问题）。
 *   把「怎么问库」抽成一个端口，模块就能按环境换实现，测试也能塞假探针 ——
 *   与控制台里那批 `NotImplemented*Repository` 同一纪律。
 *
 * ── 探针**必须**有超时 ──────────────────────────────────────────────────────
 *   库挂掉时 `$queryRaw` 可能一直等（TCP 半开、PG 在 fsync）。没有超时的话
 *   `/health/ready` 本身会挂住，外部监控看到的是「超时」而不是「数据库不可用」，
 *   而这两件事的处理方式完全不同（前者要查网络，后者要查 PG）。
 */

/** 数据库探针的结果（`detail` 只给运维看，**必须**已经脱敏）。 */
export interface DatabaseProbeResult {
  /** `true` ⇒ 库能应答；`false` ⇒ 探针判死（超时 / 连接失败 / 未配置）。 */
  ok: boolean
  /** 这一问花了多久（毫秒）。超时也照实写，方便看「是慢还是挂」。 */
  latencyMs: number
  /** 失败原因（人话，已脱敏）。成功时为 `undefined`。 */
  detail?: string
  /**
   * 状态机里的第三个值：**没配库**（`DATABASE_URL` 为空）。
   *
   * 与 `ok: false` 分开，是因为它**不是故障**而是装配模式（无库时所有
   * 业务端点本来就是 501）。就绪探针仍然回 503（这个进程不能接业务流量），
   * 但 `docker ps` / 监控能一眼区分「配置成无库」与「库挂了」。
   */
  unconfigured?: boolean
}

/** 控制器只认这个接口；实现可以是真的 Prisma，也可以是测试里的假探针。 */
export interface HealthProbe {
  probeDatabase(): Promise<DatabaseProbeResult>
}

/** DI 令牌（符号，避免与任何字符串 provider 撞名）。 */
export const HEALTH_PROBE = Symbol('HEALTH_PROBE')

/**
 * 真正的探针：`SELECT 1`。
 *
 * ── 为什么不是 `SELECT count(*) FROM "Child"` ───────────────────────────────
 *   就绪探针要回答「这个进程现在能不能服务」，不是「数据对不对」。
 *   一次 `SELECT 1` 走完「拿到连接 + PG 能执行」就够；扫业务表会在库变慢时
 *   把探针本身变成压力源。
 */
@Injectable()
export class PrismaHealthProbe implements HealthProbe {
  constructor(private readonly prisma: PrismaService) {}

  async probeDatabase(): Promise<DatabaseProbeResult> {
    const startedAt = Date.now()
    try {
      await this.prisma.$queryRaw`SELECT 1`
      return { ok: true, latencyMs: Date.now() - startedAt }
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        detail: redactProbeDetail(error instanceof Error ? error.message : String(error))
      }
    }
  }
}

/**
 * 无库装配下的探针：**明确回答「没配库」**，不去连一个不存在的地址。
 *
 * ★ 不返回 `ok: true`：那会让就绪探针在一个「所有业务端点都 501」的进程上
 *   报绿 —— 外部监控从此再也发现不了「线上跑的是无库镜像」。
 */
@Injectable()
export class NoDatabaseHealthProbe implements HealthProbe {
  async probeDatabase(): Promise<DatabaseProbeResult> {
    return {
      ok: false,
      latencyMs: 0,
      unconfigured: true,
      detail: 'DATABASE_URL 未设置：这个进程是无库装配，业务端点会回 501。'
    }
  }
}

/**
 * 故障细节脱敏 —— `/health/ready` 是**匿名**端点。
 *
 * ── 要挡的是什么 ────────────────────────────────────────────────────────────
 *   Prisma / pg 的报错会把连接串原样带出来：
 *   `postgresql://kids:secret@pg18:5432/kids_points`。探针一旦匿名可读，
 *   这里就是一个「把数据库密码贴在公网」的洞（比不探活还糟）。
 *   所以：URL 里的 `user:pass@` 整段抹掉，只留库名之后的部分。
 *
 * ── 为什么不是「干脆不回 detail」─────────────────────────────────────────────
 *   运维看到 503 却没有任何原因，只能进容器翻日志；而这条端点的价值正是
 *   「一眼看出是超时、拒绝连接还是鉴权失败」。
 */
export function redactProbeDetail(raw: string): string {
  return raw
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/\bpassword\s*=\s*\S+/gi, 'password=***')
}

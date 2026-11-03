/**
 * health.test.ts —— 存活 / 就绪探针（P0-5，2026-11-03；真起 Nest ＋ 真发 HTTP）
 *
 * ── 这一批用例在钉什么（每条都能失败）──────────────────────────────────────────
 *   ① `GET /health` **不查库**：探针被调用次数必须是 0。这条不钉住，日后有人
 *      为了"顺便看看库"把它接上 `SELECT 1`，库一慢 compose 就会把 API 容器
 *      判死并重启 —— 而重启救不了库，只会让「只读降级」也消失。
 *   ② 就绪探针的三态必须可区分：`up` / `down` / `unconfigured`。
 *      把 `unconfigured` 混进 `down`，运维就看不出「线上跑的是无库镜像」。
 *   ③ 失败回 **503 + 同一份 JSON 形状**（不是 500、不是 `{statusCode,message}`）：
 *      监控脚本要能用同一个 `jq` 表达式读两条路径。
 *   ④ 探针挂住时**必须有硬超时**（这里用 20ms 验证），否则 `/health/ready`
 *      自己会挂住，外部看到的是"超时"而不是"数据库不可用"。
 *   ⑤ `detail` **脱敏**：这条端点是匿名可读的，Prisma 报错里带着
 *      `postgresql://user:pass@host/db` 就等于把数据库密码贴到公网。
 *
 * ── 诚实标注 ────────────────────────────────────────────────────────────────
 *   · 这里用的是**假探针**（真 `SELECT 1` 需要活的 PostgreSQL，归 `test-db/`）；
 *     本文件证明的是「控制器/模块的判据与形状」，不是 Prisma 的行为；
 *   · 世界分叉（有库 ⇒ PrismaHealthProbe）只做**静态**断言（看模块元数据），
 *     不真的实例化 PrismaService —— 那会在没有 `DATABASE_URL` 的 CI 上抛错。
 */
import assert from 'node:assert/strict'
import { before, after, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import { HealthModule } from '../src/health/health.module'
import {
  HEALTH_PROBE,
  NoDatabaseHealthProbe,
  PrismaHealthProbe,
  redactProbeDetail,
  type DatabaseProbeResult,
  type HealthProbe
} from '../src/health/health.probe'

interface HttpResult {
  status: number
  body: Record<string, unknown>
  text: string
}

async function get(baseUrl: string, path: string): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`)
  const text = await res.text()
  let body: Record<string, unknown> = {}
  if (text !== '') {
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      body = { _raw: text }
    }
  }
  return { status: res.status, body, text }
}

/** 可数的假探针：`calls` 用来钉「存活探针没有碰库」。 */
function makeProbe(
  result: DatabaseProbeResult | (() => Promise<DatabaseProbeResult>)
): HealthProbe & { calls: number } {
  const probe = {
    calls: 0,
    async probeDatabase(): Promise<DatabaseProbeResult> {
      probe.calls += 1
      return typeof result === 'function' ? await result() : result
    }
  }
  return probe
}

interface Harness {
  app: INestApplication
  url: string
}

async function startApp(probe: HealthProbe | null, readyTimeoutMs = 1_000): Promise<Harness> {
  const builder = Test.createTestingModule({
    // ★ 传 `{}` 而不是 `process.env`：这一批用例要的是**无库装配**分支，
    //   否则 `HealthModule.register()` 会导入 PrismaModule 并实例化 PrismaService
    //   （它的构造函数在 `DATABASE_URL` 缺失时故意抛错）。
    imports: [HealthModule.register({}, { readyTimeoutMs })]
  })
  if (probe !== null) builder.overrideProvider(HEALTH_PROBE).useValue(probe)
  const moduleRef = await builder.compile()

  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1')
  return { app, url }
}

describe('GET /health —— 存活探针', () => {
  let harness!: Harness
  let probe!: ReturnType<typeof makeProbe>

  before(async () => {
    probe = makeProbe(async () => {
      throw new Error('存活探针不该查库')
    })
    harness = await startApp(probe)
  })

  after(async () => {
    await harness.app.close()
  })

  it('★ 200 + 固定形状，且**一次都不碰数据库**', async () => {
    const res = await get(harness.url, '/health')

    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'ok')
    assert.equal(res.body.service, 'kids-api')
    assert.equal(typeof res.body.uptimeSeconds, 'number')
    assert.ok((res.body.uptimeSeconds as number) >= 0)
    assert.equal(probe.calls, 0, '存活探针查库 ⇒ 库一慢就会被重启')
  })

  it('不泄漏任何配置 / 版本信息（存活探针的语义必须不变）', async () => {
    const res = await get(harness.url, '/health')

    assert.deepEqual(Object.keys(res.body).sort(), ['service', 'status', 'uptimeSeconds'])
  })
})

describe('GET /health/ready —— 就绪探针', () => {
  it('库能应答 ⇒ 200 up（latencyMs 原样带出）', async () => {
    const probe = makeProbe({ ok: true, latencyMs: 3 })
    const harness = await startApp(probe)
    try {
      const res = await get(harness.url, '/health/ready')

      assert.equal(res.status, 200)
      assert.equal(res.body.status, 'ok')
      const database = (res.body.checks as { database: Record<string, unknown> }).database
      assert.equal(database.status, 'up')
      assert.equal(database.latencyMs, 3)
      assert.equal(probe.calls, 1)
    } finally {
      await harness.app.close()
    }
  })

  it('★ 库挂了 ⇒ 503 degraded，原因可见（运维要能一眼分辨超时/拒绝/鉴权）', async () => {
    const probe = makeProbe({
      ok: false,
      latencyMs: 5,
      detail: 'connect ECONNREFUSED 127.0.0.1:5432'
    })
    const harness = await startApp(probe)
    try {
      const res = await get(harness.url, '/health/ready')

      assert.equal(res.status, 503)
      assert.equal(res.body.status, 'degraded')
      const database = (res.body.checks as { database: Record<string, unknown> }).database
      assert.equal(database.status, 'down')
      assert.equal(database.latencyMs, 5)
      assert.match(String(database.detail), /ECONNREFUSED/)
      // ★ 形状必须是同一份 `ReadinessView`，不是 Nest 的 {statusCode,message}
      assert.equal(res.body.statusCode, undefined)
    } finally {
      await harness.app.close()
    }
  })

  it('★ 探针挂住 ⇒ 硬超时回 503（20ms 版本，别让用例真的等 2 秒）', async () => {
    const probe = makeProbe(() => new Promise<DatabaseProbeResult>(() => {}))
    const harness = await startApp(probe, 20)
    try {
      const res = await get(harness.url, '/health/ready')

      assert.equal(res.status, 503)
      assert.equal(res.body.status, 'degraded')
      const database = (res.body.checks as { database: Record<string, unknown> }).database
      assert.equal(database.status, 'down')
      assert.match(String(database.detail), /未返回/)
      assert.equal(database.latencyMs, 20)
    } finally {
      await harness.app.close()
    }
  })

  it('★ 没配 DATABASE_URL ⇒ 503 unconfigured（不是 down，也不是 ok）', async () => {
    const harness = await startApp(null)
    try {
      const res = await get(harness.url, '/health/ready')

      assert.equal(res.status, 503)
      assert.equal(res.body.status, 'degraded')
      const database = (res.body.checks as { database: Record<string, unknown> }).database
      assert.equal(database.status, 'unconfigured')
      assert.match(String(database.detail), /DATABASE_URL/)
    } finally {
      await harness.app.close()
    }
  })
})

describe('世界分叉与脱敏', () => {
  it('HealthModule.register：有库 ⇒ PrismaHealthProbe；无库 ⇒ NoDatabaseHealthProbe', () => {
    const withDb = HealthModule.register({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db'
    })
    const withoutDb = HealthModule.register({})

    const classes = (mod: typeof withDb): unknown[] =>
      (mod.providers ?? []).map((provider) =>
        typeof provider === 'object' && provider !== null && 'useClass' in provider
          ? (provider as { useClass: unknown }).useClass
          : null
      )

    assert.ok(classes(withDb).includes(PrismaHealthProbe))
    assert.ok(classes(withoutDb).includes(NoDatabaseHealthProbe))
    assert.ok(!classes(withoutDb).includes(PrismaHealthProbe))
    // 无库时不许导入 PrismaModule（构造 PrismaService 时会抛错）
    assert.deepEqual(withoutDb.imports ?? [], [])
  })

  it('★ redactProbeDetail 抹掉 URL 里的账号密码（端点匿名可读）', () => {
    const raw = "Can't reach postgresql://kids:s3cret@pg18:5432/kids_points for user kids"
    const safe = redactProbeDetail(raw)

    assert.ok(!safe.includes('s3cret'))
    assert.match(safe, /postgresql:\/\/\*\*\*@pg18:5432\/kids_points/)
    assert.equal(redactProbeDetail('password=hunter2 host=pg18'), 'password=*** host=pg18')
  })
})

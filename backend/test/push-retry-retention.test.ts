/**
 * push-retry-retention.test.ts —— 推送队列保留清理（W6-D，2026-10-24）
 *
 * ── 这个文件在守什么 ──────────────────────────────────────────────────────
 *   ① **只删终态**：`pending` / `sending` 永远不会出现在端口的入参里
 *      （删掉一条还没送的推送 = 把一次提醒从队列里抹掉）；
 *   ② **三档保留期各算各的**：`sent` / `expired` 默认 7 天、`dead` 默认 30 天
 *      —— 后者是故障证据，不能和「已送达」用同一个窗口；
 *   ③ **分批 + 上限**：一批没删满就停；删满则再要一批，最多 `MAX_ROUNDS` 批，
 *      剩余留给下一轮（不在一次 DELETE 里锁表）；
 *   ④ **部分失败也继续**：一个状态失败不影响另外两个，但本轮**最终仍抛错**
 *      —— 不把「没删干净」伪装成成功；
 *   ⑤ **无库装配 501**：绝不返回 0（0 会被读成「清理完成」）。
 *
 * ★ 真 SQL 的删除范围（含 `updatedAt` 比较、`LIMIT`、状态枚举转换）由
 *   `test-db/push-retry-retention-db.dbtest.ts` 守 —— 离线替身只能验证
 *   「调用形状对」，验证不了「删的是不是那几行」。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { PrismaService } from '../src/prisma/prisma.service'
import {
  DEFAULT_PUSH_RETRY_RETENTION_BATCH,
  DEFAULT_PUSH_RETRY_RETENTION_DEAD_MS,
  DEFAULT_PUSH_RETRY_RETENTION_EXPIRED_MS,
  DEFAULT_PUSH_RETRY_RETENTION_INTERVAL_MS,
  DEFAULT_PUSH_RETRY_RETENTION_SENT_MS,
  MAX_PUSH_RETRY_RETENTION_AGE_MS,
  MAX_PUSH_RETRY_RETENTION_BATCH,
  MAX_PUSH_RETRY_RETENTION_INTERVAL_MS,
  MIN_PUSH_RETRY_RETENTION_AGE_MS,
  MIN_PUSH_RETRY_RETENTION_BATCH,
  MIN_PUSH_RETRY_RETENTION_INTERVAL_MS,
  NotImplementedPushRetryRetention,
  PUSH_RETRY_RETENTION_BATCH_ENV,
  PUSH_RETRY_RETENTION_DEAD_ENV,
  PUSH_RETRY_RETENTION_ENABLED_ENV,
  PUSH_RETRY_RETENTION_EXPIRED_ENV,
  PUSH_RETRY_RETENTION_INTERVAL_ENV,
  PUSH_RETRY_RETENTION_MAX_ROUNDS,
  PUSH_RETRY_RETENTION_SENT_ENV,
  PUSH_RETRY_RETENTION_STATUSES,
  describeRetention,
  readPushRetryRetentionConfig,
  retentionCutoffs,
  type DeleteSettledPushRetryInput,
  type PushRetryRetentionConfig,
  type PushRetryRetentionPort,
  type PushRetryRetentionStatus
} from '../src/notifications/push-retry.retention'
import { PrismaPushRetryRetention } from '../src/notifications/push-retry.retention.prisma.repository'
import { PushRetryRetentionWorker } from '../src/notifications/push-retry.retention.worker'

const NOW = new Date('2026-10-25T04:00:00.000Z')
const DAY = 24 * 60 * 60_000

const CONFIG: PushRetryRetentionConfig = {
  enabled: true,
  intervalMs: 60 * 60_000,
  sentMs: 7 * DAY,
  expiredMs: 7 * DAY,
  deadMs: 30 * DAY,
  batchSize: 100
}

describe('A. 配置读取（纯函数，非法值夹取而不是静默作废）', () => {
  it('A1 缺省：开启、每小时一轮、已送达/过期 7 天、死亡 30 天、每批 500', () => {
    assert.deepEqual(readPushRetryRetentionConfig({}), {
      enabled: true,
      intervalMs: DEFAULT_PUSH_RETRY_RETENTION_INTERVAL_MS,
      sentMs: DEFAULT_PUSH_RETRY_RETENTION_SENT_MS,
      expiredMs: DEFAULT_PUSH_RETRY_RETENTION_EXPIRED_MS,
      deadMs: DEFAULT_PUSH_RETRY_RETENTION_DEAD_MS,
      batchSize: DEFAULT_PUSH_RETRY_RETENTION_BATCH
    })
    // 数字写死一份，防止「常量自己改自己」时用例跟着一起错。
    assert.equal(DEFAULT_PUSH_RETRY_RETENTION_INTERVAL_MS, 3_600_000)
    assert.equal(DEFAULT_PUSH_RETRY_RETENTION_SENT_MS, 604_800_000)
    assert.equal(DEFAULT_PUSH_RETRY_RETENTION_EXPIRED_MS, 604_800_000)
    assert.equal(DEFAULT_PUSH_RETRY_RETENTION_DEAD_MS, 2_592_000_000)
    assert.equal(DEFAULT_PUSH_RETRY_RETENTION_BATCH, 500)
  })

  it('A2 间隔夹到 [60s, 24h]', () => {
    assert.equal(
      readPushRetryRetentionConfig({ [PUSH_RETRY_RETENTION_INTERVAL_ENV]: '1' }).intervalMs,
      MIN_PUSH_RETRY_RETENTION_INTERVAL_MS
    )
    assert.equal(
      readPushRetryRetentionConfig({
        [PUSH_RETRY_RETENTION_INTERVAL_ENV]: String(365 * DAY)
      }).intervalMs,
      MAX_PUSH_RETRY_RETENTION_INTERVAL_MS
    )
  })

  it('A3 三档保留期各自夹到 [60s, 365 天]', () => {
    const tooSmall = readPushRetryRetentionConfig({
      [PUSH_RETRY_RETENTION_SENT_ENV]: '0',
      [PUSH_RETRY_RETENTION_EXPIRED_ENV]: '-5',
      [PUSH_RETRY_RETENTION_DEAD_ENV]: '999'
    })
    assert.equal(tooSmall.sentMs, MIN_PUSH_RETRY_RETENTION_AGE_MS)
    assert.equal(tooSmall.expiredMs, MIN_PUSH_RETRY_RETENTION_AGE_MS)
    assert.equal(tooSmall.deadMs, MIN_PUSH_RETRY_RETENTION_AGE_MS)

    const tooLarge = readPushRetryRetentionConfig({
      [PUSH_RETRY_RETENTION_SENT_ENV]: String(400 * DAY),
      [PUSH_RETRY_RETENTION_EXPIRED_ENV]: String(400 * DAY),
      [PUSH_RETRY_RETENTION_DEAD_ENV]: String(400 * DAY)
    })
    assert.equal(tooLarge.sentMs, MAX_PUSH_RETRY_RETENTION_AGE_MS)
    assert.equal(tooLarge.expiredMs, MAX_PUSH_RETRY_RETENTION_AGE_MS)
    assert.equal(tooLarge.deadMs, MAX_PUSH_RETRY_RETENTION_AGE_MS)
  })

  it('A4 批量夹到 [1, 5000]；非数字回落 500', () => {
    assert.equal(
      readPushRetryRetentionConfig({ [PUSH_RETRY_RETENTION_BATCH_ENV]: '0' }).batchSize,
      MIN_PUSH_RETRY_RETENTION_BATCH
    )
    assert.equal(
      readPushRetryRetentionConfig({ [PUSH_RETRY_RETENTION_BATCH_ENV]: '999999' }).batchSize,
      MAX_PUSH_RETRY_RETENTION_BATCH
    )
    for (const raw of ['', '   ', 'abc', 'NaN']) {
      assert.equal(
        readPushRetryRetentionConfig({ [PUSH_RETRY_RETENTION_BATCH_ENV]: raw }).batchSize,
        DEFAULT_PUSH_RETRY_RETENTION_BATCH,
        `raw=${JSON.stringify(raw)}`
      )
    }
  })

  it('A5 开关拼错仍保持开启（拼错不该让清理静默消失）', () => {
    for (const raw of ['0', 'false', 'off', 'no', 'DISABLED']) {
      assert.equal(
        readPushRetryRetentionConfig({ [PUSH_RETRY_RETENTION_ENABLED_ENV]: raw }).enabled,
        false
      )
    }
    for (const raw of ['1', 'true', 'on', 'yes', 'ofl', '']) {
      assert.equal(
        readPushRetryRetentionConfig({ [PUSH_RETRY_RETENTION_ENABLED_ENV]: raw }).enabled,
        true,
        `raw=${JSON.stringify(raw)}`
      )
    }
  })
})

describe('B. 截止线（纯函数，逐毫秒可校验）', () => {
  it('B1 now 减去三档保留期', () => {
    const cutoffs = retentionCutoffs(NOW, CONFIG)

    assert.equal(cutoffs.sentBefore.getTime(), NOW.getTime() - 7 * DAY)
    assert.equal(cutoffs.expiredBefore.getTime(), NOW.getTime() - 7 * DAY)
    assert.equal(cutoffs.deadBefore.getTime(), NOW.getTime() - 30 * DAY)
  })

  it('B2 三档独立：改一档不影响另外两档', () => {
    const cutoffs = retentionCutoffs(NOW, { ...CONFIG, deadMs: 90 * DAY })

    assert.equal(cutoffs.sentBefore.getTime(), NOW.getTime() - 7 * DAY)
    assert.equal(cutoffs.expiredBefore.getTime(), NOW.getTime() - 7 * DAY)
    assert.equal(cutoffs.deadBefore.getTime(), NOW.getTime() - 90 * DAY)
  })

  it('B3 只有三个终态可删 —— pending / sending 不在名单里', () => {
    assert.deepEqual([...PUSH_RETRY_RETENTION_STATUSES], ['sent', 'expired', 'dead'])
  })

  it('B4 日志行逐字段可读', () => {
    assert.equal(
      describeRetention({ sent: 1, expired: 2, dead: 3, total: 6 }),
      'sent=1 expired=2 dead=3 total=6'
    )
  })
})


interface FakePort extends PushRetryRetentionPort {
  readonly calls: DeleteSettledPushRetryInput[]
  readonly remaining: Record<PushRetryRetentionStatus, number>
  readonly failures: Set<PushRetryRetentionStatus>
  /** `true` ⇒ 每次都返回 `limit`，用来验证「批数上限」。 */
  alwaysFull: boolean
}

function makePort(
  remaining: Partial<Record<PushRetryRetentionStatus, number>> = {}
): FakePort {
  const calls: DeleteSettledPushRetryInput[] = []
  const state: FakePort = {
    calls,
    remaining: { sent: 0, expired: 0, dead: 0, ...remaining },
    failures: new Set(),
    alwaysFull: false,
    async deleteSettled(input: DeleteSettledPushRetryInput) {
      calls.push(input)
      if (state.failures.has(input.status)) throw new Error(`boom-${input.status}`)
      if (state.alwaysFull) return input.limit
      const take = Math.min(state.remaining[input.status], input.limit)
      state.remaining[input.status] -= take
      return take
    }
  }
  return state
}

function makeWorker(
  port: PushRetryRetentionPort,
  config: PushRetryRetentionConfig = CONFIG
): PushRetryRetentionWorker {
  return new PushRetryRetentionWorker(port, config)
}

/**
 * 轮询等待（只给「start() 会自己跑一轮」这类 fire-and-forget 断言用）。
 *
 * ★ 不用固定 `setImmediate`：`tick` 内部对三个状态各有若干次 `await`，
 *   等待点数量会随实现变化；钉死「等一个宏任务」会变成一条脆断言
 *   （实测：单状态的对账用例能过，三状态的清理用例等不到）。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时（1000ms）')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('C. worker 的 tick（分批、上限、互不牵连）', () => {
  it('C1 三个终态各要一批，截止时刻与批量来自配置', async () => {
    const port = makePort({ sent: 3, dead: 1 })
    const worker = makeWorker(port)

    const result = await worker.tick(NOW)

    assert.deepEqual(result, { sent: 3, expired: 0, dead: 1, total: 4 })
    assert.deepEqual(
      port.calls.map((call) => call.status),
      ['sent', 'expired', 'dead']
    )
    assert.deepEqual(
      port.calls.map((call) => call.before.getTime()),
      [NOW.getTime() - 7 * DAY, NOW.getTime() - 7 * DAY, NOW.getTime() - 30 * DAY]
    )
    assert.deepEqual(
      port.calls.map((call) => call.limit),
      [100, 100, 100]
    )
  })

  it('C2 一批没删满就停；删满则继续要下一批', async () => {
    const port = makePort({ sent: 5 })
    const worker = makeWorker(port, { ...CONFIG, batchSize: 2 })

    const result = await worker.tick(NOW)

    assert.equal(result.sent, 5)
    const sentCalls = port.calls.filter((call) => call.status === 'sent')
    // 2 + 2 + 1：第三批没满 ⇒ 该状态结束。
    assert.equal(sentCalls.length, 3)
    // expired / dead 各要一批（返回 0 < 2 即停）。
    assert.equal(port.calls.length, 5)
  })

  it('C3 一直删满 ⇒ 每个状态最多 MAX_ROUNDS 批，剩余留给下一轮', async () => {
    const port = makePort()
    port.alwaysFull = true
    const worker = makeWorker(port, { ...CONFIG, batchSize: 10 })

    const result = await worker.tick(NOW)

    for (const status of PUSH_RETRY_RETENTION_STATUSES) {
      assert.equal(
        port.calls.filter((call) => call.status === status).length,
        PUSH_RETRY_RETENTION_MAX_ROUNDS,
        `status=${status}`
      )
    }
    assert.equal(result.total, 3 * PUSH_RETRY_RETENTION_MAX_ROUNDS * 10)
  })

  it('C4 任何情况下都不会请求 pending / sending', async () => {
    const port = makePort({ sent: 1 })
    const worker = makeWorker(port)

    await worker.tick(NOW)

    const requested = new Set(port.calls.map((call) => String(call.status)))
    assert.equal(requested.has('pending'), false)
    assert.equal(requested.has('sending'), false)
  })

  it('C5 一个状态失败 ⇒ 其它状态照删，但本轮最终抛错（不伪装成功）', async () => {
    const port = makePort({ sent: 2, dead: 4 })
    port.failures.add('expired')
    const worker = makeWorker(port)

    await assert.rejects(
      () => worker.tick(NOW),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /expired/)
        assert.match(error.message, /boom-expired/)
        return true
      }
    )
    // dead 在 expired 之后仍被处理。
    assert.equal(port.calls.some((call) => call.status === 'dead'), true)
  })

  it('C6 部分失败时仍按 sent→expired→dead 顺序跑完', async () => {
    const port = makePort({ sent: 1, expired: 1, dead: 1 })
    port.failures.add('sent')
    const worker = makeWorker(port)

    await assert.rejects(() => worker.tick(NOW))

    assert.deepEqual(
      port.calls.map((call) => call.status),
      ['sent', 'expired', 'dead']
    )
  })
})

describe('D. 生命周期', () => {
  it('D1 关闭 ⇒ start() 不启动、也不调端口；stop() 幂等', async () => {
    const port = makePort()
    const worker = makeWorker(port, { ...CONFIG, enabled: false })

    worker.start()
    await new Promise((resolve) => setImmediate(resolve))
    worker.stop()
    worker.stop()

    assert.equal(port.calls.length, 0)
  })

  it('D2 开启 ⇒ start() 立刻跑一轮', async () => {
    const port = makePort()
    const worker = makeWorker(port)

    worker.start()
    await waitFor(() => port.calls.length >= 3)
    worker.stop()

    assert.equal(port.calls.length, 3)
  })
})


describe('E. Prisma 适配器的运行期防线', () => {
  /**
   * 只实现 `$executeRaw`；把收到的 `Sql` 原样留下，用于断言参数化形状。
   * ★ 这里验证不了「删了哪几行」—— 那是真库套件的事。
   */
  function makePrismaSpy(): {
    prisma: PrismaService
    queries: Array<{ values: unknown[]; sql: string }>
  } {
    const queries: Array<{ values: unknown[]; sql: string }> = []
    const prisma = {
      $executeRaw: async (query: { sql: string; values: unknown[] }) => {
        queries.push(query)
        return 0
      }
    } as unknown as PrismaService
    return { prisma, queries }
  }

  it('E1 合法状态 ⇒ 一次参数化 DELETE，状态/截止时刻/上限都在参数里', async () => {
    const { prisma, queries } = makePrismaSpy()
    const repository = new PrismaPushRetryRetention(prisma)
    const before = new Date('2026-09-01T00:00:00.000Z')

    const deleted = await repository.deleteSettled({ status: 'dead', before, limit: 250 })

    assert.equal(deleted, 0)
    assert.equal(queries.length, 1)
    assert.match(queries[0].sql, /DELETE FROM "PushRetryJob"/)
    assert.match(queries[0].sql, /"status" = \?::"PushRetryStatus"/)
    assert.deepEqual(queries[0].values, ['dead', before, 250])
  })

  it('E2 批量下限 1：limit=0 / 负数不会变成「删全部」', async () => {
    const { prisma, queries } = makePrismaSpy()
    const repository = new PrismaPushRetryRetention(prisma)

    await repository.deleteSettled({ status: 'sent', before: NOW, limit: 0 })
    await repository.deleteSettled({ status: 'sent', before: NOW, limit: -5 })

    assert.deepEqual(
      queries.map((query) => query.values[2]),
      [1, 1]
    )
  })

  it('E3 非终态（运行期绕过类型）⇒ 抛错，且不发出任何 SQL', async () => {
    const { prisma, queries } = makePrismaSpy()
    const repository = new PrismaPushRetryRetention(prisma)

    for (const status of ['pending', 'sending', 'SENT', '']) {
      await assert.rejects(
        () =>
          repository.deleteSettled({
            status: status as unknown as PushRetryRetentionStatus,
            before: NOW,
            limit: 10
          }),
        /只允许终态/,
        `status=${JSON.stringify(status)}`
      )
    }
    assert.equal(queries.length, 0)
  })
})

describe('F. 无库装配（501，不返回 0）', () => {
  it('F1 deleteSettled ⇒ 501，且错误体说明原因', async () => {
    const port = new NotImplementedPushRetryRetention()

    await assert.rejects(
      () => port.deleteSettled({ status: 'sent', before: NOW, limit: 10 }),
      (error: unknown) => {
        const http = error as { getStatus?: () => number; getResponse?: () => unknown }
        assert.equal(http.getStatus?.(), 501)
        assert.match(JSON.stringify(http.getResponse?.()), /DATABASE_URL/)
        return true
      }
    )
  })
})


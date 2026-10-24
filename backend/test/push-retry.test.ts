/**
 * push-retry.test.ts —— 推送失败重试队列（W6-B，2026-10-24）
 *
 * ── 这个文件在守什么 ──────────────────────────────────────────────────────
 *   ① **退避序列可逐字复现**：30s → 1m → 2m → 4m → 8m → 16m，封顶 30m；
 *   ② **两类失败两种命运**：`provider_error` 消耗次数、用满即 `dead`；
 *      `no_device_token` / `provider_not_configured` 不消耗次数、固定 5 分钟，
 *      到 TTL 才 `expired`（把这两类混进指数退避，会在 30 分钟内把
 *      「还没配网关」的通知全部判死）；
 *   ③ **入队永不打断业务**：`PushRetryAdapter` 吞掉入队异常，但**保留**原始
 *      适配器异常 —— 否则一次数据库抖动会把已经提交的批准变成 500；
 *   ④ **worker 的落库动作是对的**：送达 ⇒ `markSent`；还有下一次 ⇒ `markRetry`；
 *      用满 ⇒ `markDead`；越过 TTL ⇒ `markExpired`；坏 payload ⇒ `dead`；
 *   ⑤ **去重键里没有时间**：否则每次重算 `occurredAt` 都会得到一条新行。
 *
 * ★ 时间全部注入（`tick(now)`）：真等一遍退避要 30 分钟，用例做不到也不该做。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PUSH_RETRY_BASE_DELAY_MS,
  PUSH_RETRY_DEFAULT_TTL_MS,
  PUSH_RETRY_MAX_ATTEMPTS,
  PUSH_RETRY_MAX_DELAY_MS,
  PUSH_RETRY_STRUCTURAL_DELAY_MS,
  backoffDelayMs,
  classifyPushFailure,
  describePushFailure,
  describePushThrow,
  isRetryExhausted,
  structuralDelayMs
} from '../src/notifications/push-retry.policy'
import { PushRetryAdapter } from '../src/notifications/push-retry.adapter'
import {
  DEFAULT_PUSH_RETRY_BATCH,
  DEFAULT_PUSH_RETRY_CLAIM_TIMEOUT_MS,
  DEFAULT_PUSH_RETRY_INTERVAL_MS,
  MAX_PUSH_RETRY_BATCH,
  MIN_PUSH_RETRY_BATCH,
  MIN_PUSH_RETRY_INTERVAL_MS,
  MAX_PUSH_RETRY_CLAIM_TIMEOUT_MS,
  MIN_PUSH_RETRY_CLAIM_TIMEOUT_MS,
  MAX_PUSH_RETRY_INTERVAL_MS,
  MAX_PUSH_RETRY_TTL_MS,
  MIN_PUSH_RETRY_TTL_MS,
  PUSH_RETRY_BATCH_ENV,
  PUSH_RETRY_CLAIM_TIMEOUT_ENV,
  PUSH_RETRY_ENABLED_ENV,
  PUSH_RETRY_INTERVAL_ENV,
  PUSH_RETRY_MAX_ATTEMPTS_ENV,
  PUSH_RETRY_TTL_ENV,
  readPushRetryConfig,
  type PushRetryConfig
} from '../src/notifications/push-retry.config'
import { PushRetryMetrics } from '../src/notifications/push-retry.metrics'
import type { PushRetryPort } from '../src/notifications/push-retry.repository'
import {
  buildPushRetryDedupeKey,
  isPushRetryStatus,
  parsePushMessage,
  type ClaimDuePushRetryInput,
  type EnqueuePushRetryInput,
  type EnqueuePushRetryResult,
  type MarkPushRetryInput,
  type PushRetryRow
} from '../src/notifications/push-retry.types'
import {
  PUSH_RETRY_EXPIRED_MESSAGE,
  PUSH_RETRY_INVALID_PAYLOAD_MESSAGE,
  PushRetryWorker,
  describeTick,
  withTimeout
} from '../src/notifications/push-retry.worker'
import type {
  ApprovalStatusChangedPush,
  PushMessage,
  PushPort,
  PushResult
} from '../src/notifications/push.port'

/** 固定在某个时刻：所有 `nextAttemptAt` 的断言都以它为基准。 */
const NOW = new Date('2026-10-24T12:00:00.000Z')

/** 默认配置（用例只覆盖关心的旋钮）。 */
const CONFIG: PushRetryConfig = {
  enabled: true,
  intervalMs: DEFAULT_PUSH_RETRY_INTERVAL_MS,
  batchSize: DEFAULT_PUSH_RETRY_BATCH,
  ttlMs: PUSH_RETRY_DEFAULT_TTL_MS,
  claimTimeoutMs: DEFAULT_PUSH_RETRY_CLAIM_TIMEOUT_MS,
  maxAttempts: PUSH_RETRY_MAX_ATTEMPTS
}

/** 一条形状完整的消息；用例只按需覆盖字段。 */
function makeMessage(
  overrides: Partial<ApprovalStatusChangedPush> = {}
): ApprovalStatusChangedPush {
  return {
    type: 'approval.status_changed',
    approvalId: 'ap-1',
    childId: 'child-1',
    recipientUserId: 'u-dad',
    action: 'redeem',
    status: 'approved',
    decidedByUserId: 'u-mom',
    occurredAt: '2026-10-24T11:59:00.000Z',
    ...overrides
  }
}

/** 队列里的一行（默认：一条刚入队、从未试过的 `pending`）。 */
function makeRow(overrides: Partial<PushRetryRow> = {}): PushRetryRow {
  return {
    id: 'job-1',
    event: 'approval.status_changed',
    dedupeKey: 'approval.status_changed:ap-1:u-dad:approved',
    message: makeMessage(),
    recipientUserId: 'u-dad',
    childId: 'child-1',
    status: 'sending',
    attempts: 0,
    maxAttempts: PUSH_RETRY_MAX_ATTEMPTS,
    nextAttemptAt: NOW,
    expiresAt: new Date(NOW.getTime() + PUSH_RETRY_DEFAULT_TTL_MS),
    claimedAt: NOW,
    lastError: null,
    providerMessageId: null,
    sentAt: null,
    createdAt: NOW,
    ...overrides
  }
}


/** 记录型推送替身：按 `behaviour` 决定「送达 / 未送达 / 抛错」。 */
function makeDelivery(
  behaviour: PushResult | Error | ((message: PushMessage) => PushResult) = {
    delivered: true,
    providerMessageId: 'pm-1'
  }
): PushPort & { messages: PushMessage[] } {
  const messages: PushMessage[] = []
  return {
    messages,
    async send(message: PushMessage): Promise<PushResult> {
      messages.push(message)
      if (behaviour instanceof Error) throw behaviour
      if (typeof behaviour === 'function') return behaviour(message)
      return behaviour
    }
  }
}

interface PushRetryRecords {
  enqueued: EnqueuePushRetryInput[]
  claims: ClaimDuePushRetryInput[]
  sent: Array<{ id: string; providerMessageId: string | null; now: Date }>
  retried: MarkPushRetryInput[]
  dead: Array<{ id: string; lastError: string; now: Date }>
  expired: Array<{ id: string; lastError: string; now: Date }>
  sweeps: Array<{ now: Date; lastError: string }>
}

/**
 * 记录型仓储替身。
 *
 * ★ 它**不**模拟 SQL：`claimDue` 的 `SKIP LOCKED` 只有在真 PG 上才说得清，
 *   那部分由 `test-db/push-retry-db.dbtest.ts` 证。这里只记录 worker 传了什么、
 *   以及收到什么标记 —— 也就是「结算规则」。
 */
function makeRepo(
  options: {
    due?: PushRetryRow[]
    overdue?: number
    enqueueOutcome?: EnqueuePushRetryResult
    enqueueError?: Error
  } = {}
): PushRetryPort & { records: PushRetryRecords } {
  const records: PushRetryRecords = {
    enqueued: [],
    claims: [],
    sent: [],
    retried: [],
    dead: [],
    expired: [],
    sweeps: []
  }
  return {
    records,
    async enqueue(input: EnqueuePushRetryInput): Promise<EnqueuePushRetryResult> {
      records.enqueued.push(input)
      if (options.enqueueError !== undefined) throw options.enqueueError
      return options.enqueueOutcome ?? 'queued'
    },
    async claimDue(input: ClaimDuePushRetryInput): Promise<PushRetryRow[]> {
      records.claims.push(input)
      return options.due ?? []
    },
    async markSent(id: string, providerMessageId: string | null, now: Date): Promise<void> {
      records.sent.push({ id, providerMessageId, now })
    },
    async markRetry(input: MarkPushRetryInput): Promise<void> {
      records.retried.push(input)
    },
    async markDead(id: string, lastError: string, now: Date): Promise<void> {
      records.dead.push({ id, lastError, now })
    },
    async markExpired(id: string, lastError: string, now: Date): Promise<boolean> {
      records.expired.push({ id, lastError, now })
      return true
    },
    async expireOverdue(now: Date, lastError: string): Promise<number> {
      records.sweeps.push({ now, lastError })
      return options.overdue ?? 0
    }
  }
}

/** 组装一个 worker（配置与指标都新建，用例之间不共享状态）。 */
function makeWorker(
  repository: PushRetryPort,
  delivery: PushPort,
  config: PushRetryConfig = CONFIG
): { worker: PushRetryWorker; metrics: PushRetryMetrics } {
  const metrics = new PushRetryMetrics()
  return { worker: new PushRetryWorker(repository, delivery, config, metrics), metrics }

describe('A. 退避与分类（policy）', () => {
  it('A1 退避序列逐字固定：30s / 1m / 2m / 4m / 8m / 16m', () => {
    // ★ 这是一张**契约表**，不是「算一遍 2^n」。改这里之前先想清楚：
    //   它决定了「网关抖动多久后恢复还来得及」。
    const expected = [30_000, 60_000, 120_000, 240_000, 480_000, 960_000]
    assert.deepEqual(
      expected.map((_v, index) => backoffDelayMs(index + 1)),
      expected
    )
  })

  it('A2 退避封顶 30 分钟，且非法次数按第 1 次算', () => {
    assert.equal(backoffDelayMs(7), PUSH_RETRY_MAX_DELAY_MS)
    assert.equal(backoffDelayMs(1000), PUSH_RETRY_MAX_DELAY_MS)
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(backoffDelayMs(bad), PUSH_RETRY_BASE_DELAY_MS, `bad=${String(bad)}`)
    }
  })

  it('A3 结构性失败固定 5 分钟，与 attempts 无关', () => {
    assert.equal(structuralDelayMs(), 300_000)
    assert.equal(PUSH_RETRY_STRUCTURAL_DELAY_MS, 300_000)
  })

  it('A4 只有 provider_error 是 transient；另两种是 structural', () => {
    assert.equal(classifyPushFailure('provider_error'), 'transient')
    assert.equal(classifyPushFailure('no_device_token'), 'structural')
    assert.equal(classifyPushFailure('provider_not_configured'), 'structural')
  })

  it('A5 用满次数才 dead：第 6 次失败即不再排期', () => {
    assert.equal(isRetryExhausted(5, 6), false)
    assert.equal(isRetryExhausted(6, 6), true)
    assert.equal(isRetryExhausted(7, 6), true)
    assert.equal(PUSH_RETRY_MAX_ATTEMPTS, 6)
  })

  it('A6 lastError 的措辞稳定（运维按前缀 grep）', () => {
    assert.equal(describePushFailure({ delivered: false, reason: 'no_device_token' }), 'no_device_token')
    assert.equal(
      describePushFailure({ delivered: false, reason: 'provider_error', detail: ' 网关 500 ' }),
      'provider_error: 网关 500'
    )
    assert.equal(
      describePushFailure({ delivered: false, reason: 'provider_error', detail: '   ' }),
      'provider_error'
    )
    assert.equal(describePushThrow(new Error('ECONNREFUSED')), 'provider_error: ECONNREFUSED')
    assert.equal(describePushThrow('boom'), 'provider_error: boom')
    assert.equal(describePushThrow(new Error('   ')), 'provider_error: 未知错误')
  })
})

describe('B. 配置读取（纯函数，不读 process.env）', () => {
  it('B1 空环境 ⇒ 全部默认值，且默认开启', () => {
    assert.deepEqual(readPushRetryConfig({}), CONFIG)
  })

  it('B2 显式值被采纳', () => {
    const config = readPushRetryConfig({
      [PUSH_RETRY_ENABLED_ENV]: '0',
      [PUSH_RETRY_INTERVAL_ENV]: '45000',
      [PUSH_RETRY_BATCH_ENV]: '5',
      [PUSH_RETRY_TTL_ENV]: '3600000',
      [PUSH_RETRY_CLAIM_TIMEOUT_ENV]: '20000',
      [PUSH_RETRY_MAX_ATTEMPTS_ENV]: '3'
    })
    assert.deepEqual(config, {
      enabled: false,
      intervalMs: 45_000,
      batchSize: 5,
      ttlMs: 3_600_000,
      claimTimeoutMs: 20_000,
      maxAttempts: 3
    })
  })

  it('B3 非法数字 ⇒ 默认；越界 ⇒ 夹到边界（不让一个错值把服务拦住）', () => {
    assert.equal(readPushRetryConfig({ [PUSH_RETRY_INTERVAL_ENV]: 'abc' }).intervalMs, DEFAULT_PUSH_RETRY_INTERVAL_MS)
    assert.equal(readPushRetryConfig({ [PUSH_RETRY_INTERVAL_ENV]: '' }).intervalMs, DEFAULT_PUSH_RETRY_INTERVAL_MS)
    assert.equal(readPushRetryConfig({ [PUSH_RETRY_INTERVAL_ENV]: '0' }).intervalMs, MIN_PUSH_RETRY_INTERVAL_MS)
    assert.equal(
      readPushRetryConfig({ [PUSH_RETRY_INTERVAL_ENV]: '999999' }).intervalMs,
      MAX_PUSH_RETRY_INTERVAL_MS
    )
    assert.equal(readPushRetryConfig({ [PUSH_RETRY_BATCH_ENV]: '-5' }).batchSize, MIN_PUSH_RETRY_BATCH)
    assert.equal(readPushRetryConfig({ [PUSH_RETRY_BATCH_ENV]: '9999' }).batchSize, MAX_PUSH_RETRY_BATCH)
    assert.equal(readPushRetryConfig({ [PUSH_RETRY_BATCH_ENV]: '7.9' }).batchSize, 7)
    assert.equal(readPushRetryConfig({ [PUSH_RETRY_TTL_ENV]: '1' }).ttlMs, MIN_PUSH_RETRY_TTL_MS)
    assert.equal(readPushRetryConfig({ [PUSH_RETRY_TTL_ENV]: '99999999999' }).ttlMs, MAX_PUSH_RETRY_TTL_MS)
    assert.equal(
      readPushRetryConfig({ [PUSH_RETRY_CLAIM_TIMEOUT_ENV]: '1' }).claimTimeoutMs,
      MIN_PUSH_RETRY_CLAIM_TIMEOUT_MS
    )
    assert.equal(
      readPushRetryConfig({ [PUSH_RETRY_CLAIM_TIMEOUT_ENV]: '99999999' }).claimTimeoutMs,
      MAX_PUSH_RETRY_CLAIM_TIMEOUT_MS
    )
  })

  it('B4 关闭开关只认 0/false/off/no/disabled；拼错 ⇒ 保持开启', () => {
    for (const raw of ['0', 'false', 'FALSE', ' off ', 'no', 'disabled']) {
      assert.equal(readPushRetryConfig({ [PUSH_RETRY_ENABLED_ENV]: raw }).enabled, false, raw)
    }
    // ★ 方向很重要：关掉它是**静默**的，所以只有明确写出的关闭才生效。
    for (const raw of ['1', 'true', 'yes', 'on', '', ' flase ']) {
      assert.equal(readPushRetryConfig({ [PUSH_RETRY_ENABLED_ENV]: raw }).enabled, true, raw)
    }
  })
})

}


describe('C. 去重键与 payload 校验（types）', () => {
  it('C1 status_changed 的键含收件人与状态，但**不含时间**', () => {
    const approved = buildPushRetryDedupeKey(makeMessage())
    assert.equal(approved, 'approval.status_changed:ap-1:u-dad:approved')

    // 同一事实换个时刻 ⇒ 同一个键（否则唯一约束永远不生效）。
    const later = buildPushRetryDedupeKey(
      makeMessage({ occurredAt: '2026-12-31T23:59:59.000Z' })
    )
    assert.equal(later, approved)

    // 换收件人 / 换状态 ⇒ 不同的事实，必须是不同的键。
    assert.notEqual(buildPushRetryDedupeKey(makeMessage({ recipientUserId: 'u-mom' })), approved)
    assert.notEqual(buildPushRetryDedupeKey(makeMessage({ status: 'rejected' })), approved)
  })

  it('C2 submitted 的键按收件人分叉：一次提交、多位家长各一条', () => {
    const base = {
      type: 'approval.submitted' as const,
      approvalId: 'ap-2',
      childId: 'child-1',
      submittedByUserId: 'u-kid',
      action: 'redeem' as const,
      occurredAt: '2026-10-24T11:00:00.000Z'
    }
    assert.equal(
      buildPushRetryDedupeKey({ ...base, recipientUserId: 'u-dad' }),
      'approval.submitted:ap-2:u-dad'
    )
    assert.notEqual(
      buildPushRetryDedupeKey({ ...base, recipientUserId: 'u-dad' }),
      buildPushRetryDedupeKey({ ...base, recipientUserId: 'u-mom' })
    )
  })

  it('C3 parsePushMessage 接受两种合法消息，拒绝坏数据（不 `as` 断言）', () => {
    const message = makeMessage()
    assert.deepEqual(parsePushMessage(JSON.parse(JSON.stringify(message))), message)

    const submitted = {
      type: 'approval.submitted',
      approvalId: 'ap-2',
      childId: 'child-1',
      recipientUserId: 'u-dad',
      submittedByUserId: 'u-kid',
      action: 'redeem',
      occurredAt: '2026-10-24T11:00:00.000Z'
    }
    assert.deepEqual(parsePushMessage(submitted), submitted)

    // 逐条：缺字段 / 错类型 / 未知 type / 非对象 都必须返回 null（⇒ worker 标 dead）。
    for (const bad of [
      null,
      undefined,
      'approval.status_changed',
      [],
      {},
      { ...message, type: 'approval.unknown' },
      { ...message, approvalId: '' },
      { ...message, occurredAt: 123 },
      { ...message, status: 'pending' },
      { ...message, decidedByUserId: 42 },
      { ...submitted, submittedByUserId: '  ' }
    ]) {
      assert.equal(parsePushMessage(bad), null, JSON.stringify(bad))
    }
  })

  it('C4 状态守卫：只认五种状态，别把错字当合法值', () => {
    for (const status of ['pending', 'sending', 'sent', 'dead', 'expired']) {
      assert.equal(isPushRetryStatus(status), true, status)
    }
    for (const bad of ['PENDING', 'failed', '', null, 1, undefined]) {
      assert.equal(isPushRetryStatus(bad), false, String(bad))
    }
  })
})

describe('D. 入队装饰器（PushRetryAdapter）', () => {
  it('D1 送达 ⇒ 不入队、返回值原样透传', async () => {
    const repository = makeRepo()
    const metrics = new PushRetryMetrics()
    const adapter = new PushRetryAdapter(
      makeDelivery({ delivered: true, providerMessageId: 'pm-9' }),
      repository,
      CONFIG,
      metrics
    )

    const result = await adapter.send(makeMessage())
    assert.deepEqual(result, { delivered: true, providerMessageId: 'pm-9' })
    assert.equal(repository.records.enqueued.length, 0)
    assert.equal(metrics.snapshot().enqueued, 0)
  })

  it('D2 未送达 ⇒ 入队一次（带 lastError / TTL / maxAttempts），仍返回原结果', async () => {
    const repository = makeRepo()
    const metrics = new PushRetryMetrics()
    const failure: PushResult = {
      delivered: false,
      reason: 'provider_error',
      detail: '网关 502'
    }
    const adapter = new PushRetryAdapter(makeDelivery(failure), repository, CONFIG, metrics)

    assert.deepEqual(await adapter.send(makeMessage()), failure)

    assert.equal(repository.records.enqueued.length, 1)
    const input = repository.records.enqueued[0]
    assert.equal(input.dedupeKey, 'approval.status_changed:ap-1:u-dad:approved')
    assert.equal(input.lastError, 'provider_error: 网关 502')
    assert.equal(input.maxAttempts, CONFIG.maxAttempts)
    assert.equal(input.expiresAt.getTime() - input.now.getTime(), CONFIG.ttlMs)
    assert.equal(metrics.snapshot().enqueued, 1)
  })

  it('D3 适配器抛错 ⇒ 先入队、**再把原异常抛出去**（不能把失败变成成功）', async () => {
    const repository = makeRepo()
    const metrics = new PushRetryMetrics()
    const boom = new Error('ECONNRESET')
    const adapter = new PushRetryAdapter(makeDelivery(boom), repository, CONFIG, metrics)

    await assert.rejects(() => adapter.send(makeMessage()), /ECONNRESET/)
    assert.equal(repository.records.enqueued.length, 1)
    assert.equal(repository.records.enqueued[0].lastError, 'provider_error: ECONNRESET')
  })

  it('D4 入队本身失败 ⇒ 吞掉并计数，业务请求不受影响（原始结果照旧返回）', async () => {
    const repository = makeRepo({ enqueueError: new Error('连接池耗尽') })
    const metrics = new PushRetryMetrics()
    const failure: PushResult = { delivered: false, reason: 'no_device_token' }
    const adapter = new PushRetryAdapter(makeDelivery(failure), repository, CONFIG, metrics)

    assert.deepEqual(await adapter.send(makeMessage()), failure)
    const snapshot = metrics.snapshot()
    assert.equal(snapshot.enqueued, 0)
    assert.equal(snapshot.enqueueFailures, 1)
  })

  it('D5 撞唯一约束（duplicate）是正常结果：单独计数，不当失败', async () => {
    const repository = makeRepo({ enqueueOutcome: 'duplicate' })
    const metrics = new PushRetryMetrics()
    const adapter = new PushRetryAdapter(
      makeDelivery({ delivered: false, reason: 'provider_error' }),
      repository,
      CONFIG,
      metrics
    )

    await adapter.send(makeMessage())
    const snapshot = metrics.snapshot()
    assert.equal(snapshot.duplicates, 1)
    assert.equal(snapshot.enqueued, 0)
    assert.equal(snapshot.enqueueFailures, 0)
  })

describe('E. worker 的结算规则（tick）', () => {
  it('E1 空队列：先清扫过期、再领取；不产生任何标记', async () => {
    const repository = makeRepo({ overdue: 0 })
    const delivery = makeDelivery()
    const { worker } = makeWorker(repository, delivery)

    const result = await worker.tick(NOW)

    assert.deepEqual(result, { expired: 0, claimed: 0, sent: 0, retried: 0, dead: 0 })
    assert.equal(repository.records.sweeps.length, 1)
    assert.deepEqual(repository.records.sweeps[0], {
      now: NOW,
      lastError: PUSH_RETRY_EXPIRED_MESSAGE
    })
    assert.equal(repository.records.claims.length, 1)
    assert.equal(delivery.messages.length, 0)
    assert.equal(repository.records.sent.length + repository.records.retried.length, 0)
  })

  it('E2 领取参数来自配置（批量 + 回收窗口），不是硬编码', async () => {
    const repository = makeRepo()
    const { worker } = makeWorker(repository, makeDelivery(), {
      ...CONFIG,
      batchSize: 7,
      claimTimeoutMs: 12_345
    })

    await worker.tick(NOW)

    assert.equal(repository.records.claims[0].limit, 7)
    assert.equal(repository.records.claims[0].claimTimeoutMs, 12_345)
    assert.equal(repository.records.claims[0].now.getTime(), NOW.getTime())
  })

  it('E3 送达 ⇒ markSent（带 providerMessageId），计数为 sent', async () => {
    const repository = makeRepo({ due: [makeRow()] })
    const delivery = makeDelivery({ delivered: true, providerMessageId: 'pm-42' })
    const { worker, metrics } = makeWorker(repository, delivery)

    const result = await worker.tick(NOW)

    assert.equal(result.claimed, 1)
    assert.equal(result.sent, 1)
    assert.deepEqual(repository.records.sent[0], {
      id: 'job-1',
      providerMessageId: 'pm-42',
      now: NOW
    })
    assert.equal(repository.records.retried.length, 0)
    assert.equal(metrics.snapshot().sent, 1)
    // 消息原样送回端口：worker 不重新生成内容。
    assert.deepEqual(delivery.messages[0], makeMessage())
  })

  it('E4 渠道故障 ⇒ attempts+1 并按退避排下一次（30s）', async () => {
    const repository = makeRepo({ due: [makeRow({ attempts: 0 })] })
    const { worker, metrics } = makeWorker(
      repository,
      makeDelivery({ delivered: false, reason: 'provider_error', detail: '网关 500' })
    )

    const result = await worker.tick(NOW)

    assert.equal(result.retried, 1)
    assert.equal(result.dead, 0)
    assert.equal(repository.records.retried.length, 1)
    const retry = repository.records.retried[0]
    assert.equal(retry.id, 'job-1')
    assert.equal(retry.attempts, 1)
    assert.equal(retry.lastError, 'provider_error: 网关 500')
    assert.equal(retry.nextAttemptAt.getTime(), NOW.getTime() + 30_000)
    assert.equal(metrics.snapshot().transientFailures, 1)
  })

  it('E5 渠道故障用满次数 ⇒ dead（不再排期）', async () => {
    const repository = makeRepo({
      due: [makeRow({ attempts: PUSH_RETRY_MAX_ATTEMPTS - 1 })]
    })
    const { worker, metrics } = makeWorker(
      repository,
      makeDelivery({ delivered: false, reason: 'provider_error' })
    )

    const result = await worker.tick(NOW)

    assert.equal(result.dead, 1)
    assert.equal(result.retried, 0)
    assert.equal(repository.records.retried.length, 0)
    assert.deepEqual(repository.records.dead[0], {
      id: 'job-1',
      lastError: 'provider_error',
      now: NOW
    })
    assert.equal(metrics.snapshot().dead, 1)
  })


  it('E6 没设备 token ⇒ **不消耗** attempts，固定 5 分钟后再试', async () => {
    const repository = makeRepo({ due: [makeRow({ attempts: 0 })] })
    const { worker, metrics } = makeWorker(
      repository,
      makeDelivery({ delivered: false, reason: 'no_device_token' })
    )

    const result = await worker.tick(NOW)

    assert.equal(result.retried, 1)
    const retry = repository.records.retried[0]
    assert.equal(retry.attempts, 0, '结构性失败不能消耗次数')
    assert.equal(retry.lastError, 'no_device_token')
    assert.equal(retry.nextAttemptAt.getTime(), NOW.getTime() + 300_000)
    assert.equal(metrics.snapshot().structuralFailures, 1)
  })

  it('E7 结构性失败 + 下一次已越过 TTL ⇒ 直接 expired（不排一个到不了的期）', async () => {
    const repository = makeRepo({
      due: [makeRow({ attempts: 0, expiresAt: new Date(NOW.getTime() + 60_000) })]
    })
    const { worker, metrics } = makeWorker(
      repository,
      makeDelivery({ delivered: false, reason: 'provider_not_configured' })
    )

    const result = await worker.tick(NOW)

    assert.equal(result.expired, 1)
    assert.equal(result.retried, 0)
    assert.equal(repository.records.retried.length, 0)
    assert.deepEqual(repository.records.expired[0], {
      id: 'job-1',
      lastError: 'provider_not_configured',
      now: NOW
    })
    assert.equal(metrics.snapshot().expired, 1)
  })

  it('E8 坏 payload ⇒ dead（**不**送进适配器）', async () => {
    const repository = makeRepo({ due: [makeRow({ message: null })] })
    const delivery = makeDelivery()
    const { worker, metrics } = makeWorker(repository, delivery)

    const result = await worker.tick(NOW)

    assert.equal(result.dead, 1)
    assert.equal(delivery.messages.length, 0, '坏数据绝不能变成「发送成功」')
    assert.deepEqual(repository.records.dead[0], {
      id: 'job-1',
      lastError: PUSH_RETRY_INVALID_PAYLOAD_MESSAGE,
      now: NOW
    })
    assert.equal(metrics.snapshot().structuralFailures, 1)
  })

  it('E9 已过 TTL 的行 ⇒ markExpired（不发送）', async () => {
    const repository = makeRepo({
      due: [makeRow({ expiresAt: new Date(NOW.getTime() - 1) })]
    })
    const delivery = makeDelivery()
    const { worker } = makeWorker(repository, delivery)

    const result = await worker.tick(NOW)

    assert.equal(result.expired, 1)
    assert.equal(delivery.messages.length, 0)
    assert.equal(repository.records.expired[0].lastError, PUSH_RETRY_EXPIRED_MESSAGE)
  })

  it('E10 清扫掉的过期条数计入本轮 expired（与逐条结算相加）', async () => {
    const repository = makeRepo({
      overdue: 2,
      due: [makeRow({ expiresAt: new Date(NOW.getTime() - 1) })]
    })
    const { worker } = makeWorker(repository, makeDelivery())

    const result = await worker.tick(NOW)

    assert.equal(result.expired, 3)
    assert.equal(result.claimed, 1)
  })

  it('E11 适配器抛错 ⇒ 按渠道故障处理（不把异常甩给计时器）', async () => {
    const repository = makeRepo({ due: [makeRow({ attempts: 1 })] })
    const { worker } = makeWorker(repository, makeDelivery(new Error('socket hang up')))

    const result = await worker.tick(NOW)

    assert.equal(result.retried, 1)
    assert.equal(repository.records.retried[0].attempts, 2)
    assert.equal(repository.records.retried[0].lastError, 'provider_error: socket hang up')
  })


  it('E12 单行结算失败**不**拖垮整轮：其余行照常结算', async () => {
    const base = makeRepo({
      due: [
        makeRow({ id: 'job-bad', dedupeKey: 'k-bad' }),
        makeRow({ id: 'job-ok', dedupeKey: 'k-ok' })
      ]
    })
    const repository: PushRetryPort = {
      ...base,
      async markSent(id, providerMessageId, now) {
        if (id === 'job-bad') throw new Error('数据库抖动')
        await base.markSent(id, providerMessageId, now)
      }
    }
    const { worker } = makeWorker(
      repository,
      makeDelivery({ delivered: true, providerMessageId: 'pm-1' })
    )

    const result = await worker.tick(NOW)

    assert.equal(result.claimed, 2)
    assert.equal(result.sent, 1, '坏的那行不计数，它会在 claimTimeout 之后被重新领取')
    assert.equal(base.records.sent.length, 1)
    assert.equal(base.records.sent[0].id, 'job-ok')
  })

  it('E13 describeTick 的措辞固定（日志与用例共用）', () => {
    assert.equal(
      describeTick({ expired: 1, claimed: 2, sent: 3, retried: 4, dead: 5 }),
      'claimed=2 sent=3 retried=4 dead=5 expired=1'
    )
  })
})

describe('F. 指标与告警（PushRetryMetrics）', () => {
  it('F1 连续失败到阈值时只响一次；送达后归零', () => {
    const metrics = new PushRetryMetrics()
    metrics.recordRetried('provider_error: a', 'transient')
    metrics.recordRetried('provider_error: b', 'transient')
    assert.equal(metrics.consumeAlarm(), false, '两次还没到阈值')
    metrics.recordRetried('provider_error: c', 'transient')
    assert.equal(metrics.consumeAlarm(), true, '第三次刚好跨过')
    assert.equal(metrics.consumeAlarm(), false, '同一次故障不应每轮都响')
    metrics.recordDead('provider_error: d', 'transient')
    assert.equal(metrics.consumeAlarm(), false, '超过阈值后不再重复响')

    metrics.recordSent()
    assert.equal(metrics.snapshot().consecutiveFailures, 0)
    // `lastError` 是**历史**（最近一次失败原因），不随成功清空；判断「现在还坏吗」
    // 看的是 `consecutiveFailures`，不是它。
    assert.equal(metrics.snapshot().lastError, 'provider_error: d')

    // 恢复之后可以再响一次（否则一次故障之后永远不再告警）。
    metrics.recordRetried('provider_error: e', 'transient')
    metrics.recordRetried('provider_error: f', 'transient')
    metrics.recordDead('provider_error: g', 'transient')
    assert.equal(metrics.consumeAlarm(), true, '成功之后应重新武装')
  })

  it('F2 分类计数与快照字段齐全（跨实例口径请查表，见类注释）', () => {
    const metrics = new PushRetryMetrics()
    metrics.recordEnqueued()
    metrics.recordDuplicate()
    metrics.recordEnqueueFailure()
    metrics.recordClaimed(3)
    metrics.recordRetried('no_device_token', 'structural')
    metrics.recordDead('provider_error', 'transient')
    metrics.recordExpired(2)
    metrics.recordSent()

    const snapshot = metrics.snapshot()
    assert.equal(snapshot.enqueued, 1)
    assert.equal(snapshot.duplicates, 1)
    assert.equal(snapshot.enqueueFailures, 1)
    assert.equal(snapshot.claimed, 3)
    assert.equal(snapshot.retried, 1)
    assert.equal(snapshot.dead, 1)
    assert.equal(snapshot.expired, 2)
    assert.equal(snapshot.sent, 1)
    assert.equal(snapshot.transientFailures, 1)
    assert.equal(snapshot.structuralFailures, 1)

    const line = metrics.toLogLine()
    for (const key of ['enqueued=', 'dup=', 'claimed=', 'sent=', 'retried=', 'dead=', 'expired=']) {
      assert.ok(line.includes(key), `toLogLine 缺少 ${key}：${line}`)
    }
  })
})

describe('G. 超时兜底（withTimeout）', () => {
  it('G1 正常返回 ⇒ 原值透传', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 1_000), 'ok')
  })

  it('G2 超过上限 ⇒ 拒绝（「太慢」必须算失败，否则 worker 会被永久卡住）', async () => {
    await assert.rejects(
      () => withTimeout(new Promise<string>(() => {}), 10),
      /推送适配器 10ms 未返回/
    )
  })
})

})

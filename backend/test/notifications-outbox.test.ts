/**
 * notifications-outbox.test.ts —— 审批通知的**事务内 outbox**（W6-C，2026-10-24）
 *
 * ── 这个文件在守什么 ──────────────────────────────────────────────────────
 *   ① `approval.submitted` 的收件人是 active guardian 的**集合**，排除提交人，且去重；
 *   ② `Notification` 与 `PushRetryJob` 用**同一批** entry 写，不会一边有一条、一边没有；
 *   ③ 去重键已存在 ⇒ 连站内通知也不重复写（重放不产生第二条）；
 *   ④ 写入失败**向上抛**（审批事务回滚）—— 不静默丢掉提醒；
 *   ⑤ 无库装配 ⇒ 501，不假装写入成功。
 *
 * ★ 这里只测「事务内写什么」，不测「外部推送」：发送永远在 `PushRetryWorker`，
 *   由 `push-retry.test.ts` 负责。真 SQL / 唯一约束由
 *   `test-db/approvals-outbox-db.dbtest.ts` 负责。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { HttpException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import {
  NotImplementedNotificationsOutbox,
  PrismaNotificationsOutbox
} from '../src/notifications/notifications.outbox'
import type { PushRetryConfig } from '../src/notifications/push-retry.config'
import { PushRetryMetrics } from '../src/notifications/push-retry.metrics'

const NOW = new Date('2026-10-24T02:00:00.000Z')
const CONFIG: PushRetryConfig = {
  enabled: true,
  intervalMs: 15_000,
  batchSize: 20,
  ttlMs: 24 * 60 * 60 * 1000,
  claimTimeoutMs: 60_000,
  maxAttempts: 6
}

interface JobWrite {
  event: string
  dedupeKey: string
  payload: unknown
  recipientUserId: string
  childId: string
  status: string
  attempts: number
  maxAttempts: number
  nextAttemptAt: Date
  expiresAt: Date
}

interface FakeTxState {
  guardians: Array<{ userId: string }>
  existingKeys: string[]
  notifications: Prisma.NotificationCreateManyInput[]
  jobs: JobWrite[]
  /** 让 `notification.createMany` 抛错，证明「outbox 失败 ⇒ 审批事务回滚」。 */
  notificationError: Error | null
}

/** 只实现 outbox 真正用到的那几个方法；`as unknown as` 替掉 Prisma 的全部表面。 */
function makeTx(state: FakeTxState): Prisma.TransactionClient {
  const jobKeys = new Set(state.existingKeys)
  const tx = {
    childMember: {
      async findMany(): Promise<Array<{ userId: string }>> {
        return state.guardians
      }
    },
    pushRetryJob: {
      async findMany(input: { where: { dedupeKey: { in: string[] } } }) {
        return input.where.dedupeKey.in
          .filter((key) => jobKeys.has(key))
          .map((dedupeKey) => ({ dedupeKey }))
      },
      async createMany(input: {
        data: JobWrite[]
        skipDuplicates?: boolean
      }): Promise<{ count: number }> {
        let count = 0
        for (const row of input.data) {
          if (input.skipDuplicates === true && jobKeys.has(row.dedupeKey)) continue
          jobKeys.add(row.dedupeKey)
          state.jobs.push(row)
          count += 1
        }
        return { count }
      }
    },
    notification: {
      async createMany(input: {
        data: Prisma.NotificationCreateManyInput[]
      }): Promise<{ count: number }> {
        if (state.notificationError !== null) throw state.notificationError
        state.notifications.push(...input.data)
        return { count: input.data.length }
      }
    }
  }
  return tx as unknown as Prisma.TransactionClient
}

function makeState(overrides: Partial<FakeTxState> = {}): FakeTxState {
  return {
    guardians: [],
    existingKeys: [],
    notifications: [],
    jobs: [],
    notificationError: null,
    ...overrides
  }
}

function makeOutbox(metrics = new PushRetryMetrics()): {
  outbox: PrismaNotificationsOutbox
  metrics: PushRetryMetrics
} {
  return { outbox: new PrismaNotificationsOutbox(CONFIG, metrics), metrics }
}

const SUBMITTED = {
  approvalId: 'ap-1',
  childId: 'child-1',
  requesterUserId: 'u-kid',
  action: 'redeem' as const
}

const STATUS_CHANGED = {
  approvalId: 'ap-1',
  childId: 'child-1',
  recipientUserId: 'u-kid',
  action: 'redeem' as const,
  status: 'approved' as const,
  decidedByUserId: 'u-dad'
}


describe('outbox：approval.submitted 的收件人', () => {
  it('active guardian 去重 + 排除提交人 + 丢掉空 id；同批写通知与队列', async () => {
    const state = makeState({
      guardians: [
        { userId: 'u-dad' },
        { userId: 'u-mom' },
        { userId: 'u-dad' },
        { userId: '  ' },
        { userId: 'u-kid' }
      ]
    })
    const { outbox, metrics } = makeOutbox()

    const result = await outbox.enqueueApprovalSubmitted(makeTx(state), SUBMITTED, NOW)

    assert.deepEqual(result, { notifications: 2, jobs: 2, duplicates: 0 })
    assert.deepEqual(
      state.notifications.map((row) => row.recipientUserId),
      ['u-dad', 'u-mom'],
      '收件人不是「去重后的 active guardian（排除提交人）」'
    )
    assert.equal(state.jobs.length, 2)

    const notification = state.notifications[0]
    assert.equal(notification.childId, 'child-1')
    assert.equal(notification.recipientUserId, 'u-dad')
    assert.equal(notification.type, 'approval.submitted')
    assert.equal(notification.title, '新的兑换申请待确认')
    assert.deepEqual(notification.payload, {
      approvalId: 'ap-1',
      action: 'redeem',
      submittedByUserId: 'u-kid'
    })
    assert.equal(
      (notification.payload as { amount?: unknown }).amount,
      undefined,
      '金额进了通知 —— 第三方通道会留存内容'
    )

    const job = state.jobs[0]
    assert.equal(job.event, 'approval.submitted')
    assert.equal(job.dedupeKey, 'approval.submitted:ap-1:u-dad')
    assert.equal(job.recipientUserId, 'u-dad')
    assert.equal(job.childId, 'child-1')
    assert.equal(job.status, 'pending')
    assert.equal(job.attempts, 0)
    assert.equal(job.maxAttempts, CONFIG.maxAttempts)
    assert.deepEqual(job.nextAttemptAt, NOW, '新行必须立刻可领，不该白等一个轮询周期')
    assert.deepEqual(job.expiresAt, new Date(NOW.getTime() + CONFIG.ttlMs))
    assert.deepEqual(job.payload, {
      type: 'approval.submitted',
      approvalId: 'ap-1',
      childId: 'child-1',
      recipientUserId: 'u-dad',
      action: 'redeem',
      submittedByUserId: 'u-kid',
      occurredAt: NOW.toISOString()
    })

    assert.equal(metrics.snapshot().enqueued, 2)
    assert.equal(metrics.snapshot().duplicates, 0)
  })

  it('没有可通知的家长 ⇒ 零写入（审批仍可提交，只是没人需要提醒）', async () => {
    const state = makeState({ guardians: [{ userId: 'u-kid' }] })
    const { outbox, metrics } = makeOutbox()

    const result = await outbox.enqueueApprovalSubmitted(makeTx(state), SUBMITTED, NOW)

    assert.deepEqual(result, { notifications: 0, jobs: 0, duplicates: 0 })
    assert.equal(state.notifications.length, 0)
    assert.equal(state.jobs.length, 0)
    assert.equal(metrics.snapshot().enqueued, 0)
  })

  it('去重键已存在 ⇒ 该收件人既不写通知也不入队，且计入 duplicates', async () => {
    const state = makeState({
      guardians: [{ userId: 'u-dad' }, { userId: 'u-mom' }],
      existingKeys: ['approval.submitted:ap-1:u-mom']
    })
    const { outbox, metrics } = makeOutbox()

    const result = await outbox.enqueueApprovalSubmitted(makeTx(state), SUBMITTED, NOW)

    assert.deepEqual(result, { notifications: 1, jobs: 1, duplicates: 1 })
    assert.deepEqual(
      state.notifications.map((row) => row.recipientUserId),
      ['u-dad'],
      '重复的那位仍被写了站内通知 —— 重放会让家长看到两条'
    )
    assert.deepEqual(
      state.jobs.map((job) => job.recipientUserId),
      ['u-dad']
    )
    assert.equal(metrics.snapshot().duplicates, 1)
  })

  it('全部重复 ⇒ 一次 createMany 都不发（不留「只有站内、没有队列」的孤儿）', async () => {
    const state = makeState({
      guardians: [{ userId: 'u-dad' }],
      existingKeys: ['approval.submitted:ap-1:u-dad']
    })
    const { outbox, metrics } = makeOutbox()

    const result = await outbox.enqueueApprovalSubmitted(makeTx(state), SUBMITTED, NOW)

    assert.deepEqual(result, { notifications: 0, jobs: 0, duplicates: 1 })
    assert.equal(state.notifications.length, 0)
    assert.equal(state.jobs.length, 0)
    assert.equal(metrics.snapshot().enqueued, 0)
    assert.equal(metrics.snapshot().duplicates, 1)
  })
})

describe('outbox：approval.status_changed 的收件人', () => {
  it('批准 ⇒ 收件人是申请人，通知类型 / payload / 去重键一起正确', async () => {
    const state = makeState()
    const { outbox, metrics } = makeOutbox()

    const result = await outbox.enqueueApprovalStatusChanged(makeTx(state), STATUS_CHANGED, NOW)

    assert.deepEqual(result, { notifications: 1, jobs: 1, duplicates: 0 })
    const notification = state.notifications[0]
    assert.equal(notification.recipientUserId, 'u-kid')
    assert.equal(notification.type, 'approval.approved')
    assert.equal(notification.title, '兑换申请已通过')
    assert.deepEqual(notification.payload, {
      approvalId: 'ap-1',
      status: 'approved',
      action: 'redeem',
      decidedByUserId: 'u-dad'
    })

    const job = state.jobs[0]
    assert.equal(job.event, 'approval.status_changed')
    assert.equal(job.dedupeKey, 'approval.status_changed:ap-1:u-kid:approved')
    assert.equal(
      (job.payload as { occurredAt?: unknown }).occurredAt,
      NOW.toISOString(),
      'occurredAt 不是本次事务的 now —— 消息时间会漂'
    )
    assert.equal(metrics.snapshot().enqueued, 1)
  })

  it('拒绝 ⇒ type=approval.rejected，去重键带 rejected（与批准不互相覆盖）', async () => {
    const state = makeState()
    const { outbox } = makeOutbox()

    await outbox.enqueueApprovalStatusChanged(
      makeTx(state),
      { ...STATUS_CHANGED, status: 'rejected' },
      NOW
    )

    assert.equal(state.notifications[0].type, 'approval.rejected')
    assert.equal(
      state.jobs[0].dedupeKey,
      'approval.status_changed:ap-1:u-kid:rejected'
    )
  })
})

describe('outbox：失败边界', () => {
  it('通知写入失败 ⇒ 抛错（审批事务整体回滚），并计入 enqueueFailures', async () => {
    const state = makeState({ notificationError: new Error('连接池耗尽') })
    const { outbox, metrics } = makeOutbox()

    await assert.rejects(
      outbox.enqueueApprovalStatusChanged(makeTx(state), STATUS_CHANGED, NOW),
      /连接池耗尽/
    )
    assert.equal(
      metrics.snapshot().enqueueFailures,
      1,
      'outbox 失败被吞掉了 —— 审批会留下「批了但没人知道」'
    )
  })

  it('无库装配 ⇒ 两个方法都 501，不返回「写入成功」', async () => {
    const outbox = new NotImplementedNotificationsOutbox()
    const tx = makeTx(makeState())

    for (const promise of [
      outbox.enqueueApprovalStatusChanged(tx, STATUS_CHANGED, NOW),
      outbox.enqueueApprovalSubmitted(tx, SUBMITTED, NOW)
    ]) {
      try {
        await promise
        assert.fail('无库装配不该假装写入成功')
      } catch (error) {
        assert.ok(error instanceof HttpException)
        assert.equal(error.getStatus(), 501)
        assert.equal(
          (error.getResponse() as { code?: unknown }).code,
          'NOTIFICATIONS_OUTBOX_NOT_IMPLEMENTED'
        )
      }
    }
  })
})

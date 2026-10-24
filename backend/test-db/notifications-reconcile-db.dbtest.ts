/**
 * notifications-reconcile-db.dbtest.ts —— 对账 SQL 的**真库证据**（W6-D，2026-10-24）
 *
 * ── 离线用例答不了的问题 ────────────────────────────────────────────────────
 *   `test/notifications-reconcile.test.ts` 只证明「拿到快照之后怎么告警」；
 *   快照里的数字对不对，取决于两段 `NOT EXISTS` 与一段 `GROUP BY` ——
 *   那是 SQL，替身一行都没跑过。本文件补的正是：
 *
 *   ① **配对键真的生效**：`recipientUserId + payload->>'approvalId' + 事件语义`
 *      齐全时三个漂移计数都是 0（含 `approval.approved` ⇔ `status_changed + approved`）；
 *   ② **少一半的两侧各自计数**，不是合成一个「不一致总数」（否则不知道该补通知还是补任务）；
 *   ③ **收件人不同不能互相作证**：同一 approvalId 的「发给家长的 submitted」
 *      不能替「发给孩子的 status_changed」作证 —— 省略收件人条件会让对账恒为 0；
 *   ④ **状态不符算两边各缺一条**：`approval.approved` 通知配上 `rejected` 任务；
 *   ⑤ **重复的站内通知按 n−1 计**：配对存在性完全看不出来（W6-C 的唯一残留窗口）；
 *   ⑥ **非审批类通知不参与**；状态分布与最老 `pending` 时长与真库一致。
 *
 * ── 为什么用「前后快照取差」而不是绝对值 ────────────────────────────────────
 *   这套件与其它真库套件共享一个库，且**不做清理**（见下）。表里本来就有
 *   别的套件写的行，绝对值断言只能证明「环境碰巧干净」，证明不了 SQL。
 *
 * ── ★ 与其它真库套件同一条纪律：不做 DELETE 清理 ──────────────────────────
 *   每轮用新前缀（`dbtest-<run>-nr-…`），跑完「那些行还在」本身就是证据。
 *
 * ── 入口 ──────────────────────────────────────────────────────────────────
 *   `npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { Prisma, PushRetryStatus } from '@prisma/client'

import { PrismaNotificationsReconcile } from '../src/notifications/notifications.reconcile.prisma.repository'
import type { NotificationsReconcileSnapshot } from '../src/notifications/notifications.reconcile'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 —— 「新事实」，与历史数据互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  child: `dbtest-${RUN}-nr-child`,
  dad: `dbtest-${RUN}-nr-dad`,
  kid: `dbtest-${RUN}-nr-kid`
} as const

let prisma: PrismaService
let port: PrismaNotificationsReconcile
let seq = 0

interface DriftCounts {
  notificationsWithoutJob: number
  jobsWithoutNotification: number
  duplicateNotifications: number
}

/** 漂移计数三元组 —— 绝大多数用例只关心这三项。 */
function driftOf(snapshot: NotificationsReconcileSnapshot): DriftCounts {
  return {
    notificationsWithoutJob: snapshot.notificationsWithoutJob,
    jobsWithoutNotification: snapshot.jobsWithoutNotification,
    duplicateNotifications: snapshot.duplicateNotifications
  }
}

function delta(before: NotificationsReconcileSnapshot, after: NotificationsReconcileSnapshot): DriftCounts {
  const a = driftOf(before)
  const b = driftOf(after)
  return {
    notificationsWithoutJob: b.notificationsWithoutJob - a.notificationsWithoutJob,
    jobsWithoutNotification: b.jobsWithoutNotification - a.jobsWithoutNotification,
    duplicateNotifications: b.duplicateNotifications - a.duplicateNotifications
  }
}

async function snapshot(): Promise<NotificationsReconcileSnapshot> {
  return port.snapshot(new Date())
}

function approvalIdOf(label: string): string {
  return `dbtest-${RUN}-nr-ap-${label}`
}

interface NotificationSeed {
  type: string
  recipientUserId: string
  /** 省略 ⇒ `payload` 为空对象（脏数据：审批提醒本应必带 approvalId）。 */
  approvalId?: string
}

async function addNotification(input: NotificationSeed): Promise<string> {
  const row = await prisma.notification.create({
    data: {
      childId: ID.child,
      recipientUserId: input.recipientUserId,
      recipientRole: input.recipientUserId === ID.kid ? 'child' : 'guardian',
      type: input.type,
      title: '对账套件',
      body: '对账套件',
      payload: (input.approvalId === undefined
        ? {}
        : { approvalId: input.approvalId }) as Prisma.InputJsonObject
    },
    select: { id: true }
  })
  return row.id
}

interface JobSeed {
  event: string
  recipientUserId: string
  approvalId: string
  /** 写进 `payload.status`（`status_changed` 的语义位）。 */
  payloadStatus?: string
  rowStatus?: PushRetryStatus
  createdAt?: Date
}

async function addJob(input: JobSeed): Promise<string> {
  seq += 1
  const payload: Record<string, string> = {
    type: input.event,
    approvalId: input.approvalId,
    recipientUserId: input.recipientUserId,
    childId: ID.child
  }
  if (input.payloadStatus !== undefined) payload.status = input.payloadStatus

  const row = await prisma.pushRetryJob.create({
    data: {
      event: input.event,
      dedupeKey: `dbtest-${RUN}-nr-key-${seq}`,
      payload: payload as Prisma.InputJsonObject,
      recipientUserId: input.recipientUserId,
      childId: ID.child,
      status: input.rowStatus ?? 'pending',
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt })
    },
    select: { id: true }
  })
  return row.id
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  port = new PrismaNotificationsReconcile(prisma)

  await prisma.child.create({ data: { id: ID.child, name: `对账套件 ${RUN}` } })
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: 'DB 对账家长' },
      { id: ID.kid, displayName: 'DB 对账孩子' }
    ]
  })
})

after(async () => {
  await prisma.$disconnect()
})

describe('组 A：配对齐 ⇒ 三个漂移计数都不动', () => {
  it('A1 submitted 通知 + submitted 任务（同一收件人、同一 approvalId）', async () => {
    const before = await snapshot()
    const approvalId = approvalIdOf('a1')
    await addNotification({ type: 'approval.submitted', recipientUserId: ID.dad, approvalId })
    await addJob({
      event: 'approval.submitted',
      recipientUserId: ID.dad,
      approvalId,
      payloadStatus: 'pending'
    })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 0,
      jobsWithoutNotification: 0,
      duplicateNotifications: 0
    })
  })

  it('A2 approved 通知 ⇔ status_changed 任务且 payload.status=approved', async () => {
    const before = await snapshot()
    const approvalId = approvalIdOf('a2')
    await addNotification({ type: 'approval.approved', recipientUserId: ID.kid, approvalId })
    await addJob({
      event: 'approval.status_changed',
      recipientUserId: ID.kid,
      approvalId,
      payloadStatus: 'approved'
    })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 0,
      jobsWithoutNotification: 0,
      duplicateNotifications: 0
    })
  })
})

describe('组 B：只缺一边 ⇒ 各自被数出来（不合并成「不一致总数」）', () => {
  it('B1 只有站内通知 ⇒ notificationsWithoutJob +1，另一个计数不动', async () => {
    const before = await snapshot()
    await addNotification({
      type: 'approval.submitted',
      recipientUserId: ID.dad,
      approvalId: approvalIdOf('b1')
    })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 1,
      jobsWithoutNotification: 0,
      duplicateNotifications: 0
    })
  })

  it('B2 只有推送任务 ⇒ jobsWithoutNotification +1', async () => {
    const before = await snapshot()
    await addJob({
      event: 'approval.status_changed',
      recipientUserId: ID.kid,
      approvalId: approvalIdOf('b2'),
      payloadStatus: 'rejected'
    })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 0,
      jobsWithoutNotification: 1,
      duplicateNotifications: 0
    })
  })
})

describe('组 C：收件人对不上 ⇒ 两边都不能拿对面作证', () => {
  it('C1 通知发给家长、任务发给别人（同一 approvalId）⇒ 两个计数各 +1', async () => {
    // ★ 若 NOT EXISTS 里省掉 `recipientUserId`，这条用例会得到 0/0：
    //   「发给家长的 submitted」替「发给孩子的 submitted」作了证。
    const before = await snapshot()
    const approvalId = approvalIdOf('c1')
    await addNotification({ type: 'approval.submitted', recipientUserId: ID.dad, approvalId })
    await addJob({
      event: 'approval.submitted',
      recipientUserId: ID.kid,
      approvalId,
      payloadStatus: 'pending'
    })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 1,
      jobsWithoutNotification: 1,
      duplicateNotifications: 0
    })
  })
})

describe('组 D：状态不符 ⇒ 两边各缺一条（不能只比 approvalId）', () => {
  it('D1 approved 通知 + rejected 任务 ⇒ 1/1', async () => {
    const before = await snapshot()
    const approvalId = approvalIdOf('d1')
    await addNotification({ type: 'approval.approved', recipientUserId: ID.kid, approvalId })
    await addJob({
      event: 'approval.status_changed',
      recipientUserId: ID.kid,
      approvalId,
      payloadStatus: 'rejected'
    })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 1,
      jobsWithoutNotification: 1,
      duplicateNotifications: 0
    })
  })
})

describe('组 E：不参与对账的行', () => {
  it('E1 非审批类通知（reward.redeemed）没有任务也不算漂移', async () => {
    // ★ W6-C 只给三种审批提醒建了 outbox；把别的通知也纳入对账，
    //   会立刻造出一批永远配不上的「漂移」。
    const before = await snapshot()
    await addNotification({ type: 'reward.redeemed', recipientUserId: ID.kid })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 0,
      jobsWithoutNotification: 0,
      duplicateNotifications: 0
    })
  })

  it('E2 其它事件的任务（reward.redeemed）不参与对账', async () => {
    const before = await snapshot()
    await addJob({
      event: 'reward.redeemed',
      recipientUserId: ID.kid,
      approvalId: approvalIdOf('e2'),
      payloadStatus: 'approved'
    })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 0,
      jobsWithoutNotification: 0,
      duplicateNotifications: 0
    })
  })
})

describe('组 F：重复的站内通知（W6-C 的唯一残留窗口）', () => {
  it('F1 同一键两条通知 + 一条任务 ⇒ duplicateNotifications +1，配对计数仍为 0', async () => {
    const before = await snapshot()
    const approvalId = approvalIdOf('f1')
    await addNotification({ type: 'approval.submitted', recipientUserId: ID.dad, approvalId })
    await addNotification({ type: 'approval.submitted', recipientUserId: ID.dad, approvalId })
    await addJob({
      event: 'approval.submitted',
      recipientUserId: ID.dad,
      approvalId,
      payloadStatus: 'pending'
    })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 0,
      jobsWithoutNotification: 0,
      duplicateNotifications: 1
    })
  })

  it('F2 同一 approvalId 的 approved / rejected 各一条 ⇒ 不算重复（类型不同是正常的）', async () => {
    const before = await snapshot()
    const approvalId = approvalIdOf('f2')
    await addNotification({ type: 'approval.approved', recipientUserId: ID.kid, approvalId })
    await addNotification({ type: 'approval.rejected', recipientUserId: ID.kid, approvalId })
    await addJob({
      event: 'approval.status_changed',
      recipientUserId: ID.kid,
      approvalId,
      payloadStatus: 'approved'
    })
    await addJob({
      event: 'approval.status_changed',
      recipientUserId: ID.kid,
      approvalId,
      payloadStatus: 'rejected'
    })

    assert.deepEqual(delta(before, await snapshot()), {
      notificationsWithoutJob: 0,
      jobsWithoutNotification: 0,
      duplicateNotifications: 0
    })
  })
})

describe('组 G：状态分布与最老 pending 时长', () => {
  it('G1 五种状态的增量与真库一致；最老 pending 取 createdAt', async () => {
    const before = await snapshot()
    const ninetyMinutesAgo = new Date(Date.now() - 90 * 60_000)
    const approvalId = approvalIdOf('g1')

    await addJob({
      event: 'approval.status_changed',
      recipientUserId: ID.kid,
      approvalId,
      payloadStatus: 'approved',
      createdAt: ninetyMinutesAgo
    })
    for (const rowStatus of ['sending', 'sent', 'dead', 'expired'] as const) {
      await addJob({
        event: 'approval.status_changed',
        recipientUserId: ID.kid,
        approvalId,
        payloadStatus: 'approved',
        rowStatus
      })
    }

    const after = await snapshot()
    assert.deepEqual(
      {
        pending: after.pending - before.pending,
        sending: after.sending - before.sending,
        sent: after.sent - before.sent,
        dead: after.dead - before.dead,
        expired: after.expired - before.expired
      },
      { pending: 1, sending: 1, sent: 1, dead: 1, expired: 1 }
    )
    // 库里可能还有别的套件留下的 pending（更新），所以只断言「不小于」。
    assert.ok(
      (after.oldestPendingAgeMs ?? 0) >= 90 * 60_000,
      `最老 pending 应至少 90 分钟：${String(after.oldestPendingAgeMs)}`
    )
    assert.equal(after.checkedAt instanceof Date, true)
  })
})

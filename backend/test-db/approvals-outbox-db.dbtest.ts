/**
 * approvals-outbox-db.dbtest.ts —— 审批通知 outbox 的**真库证据**（W6-C，2026-10-24）
 *
 * ── 离线用例答不了的三件事 ────────────────────────────────────────────────
 *   ① `ChildMember` 的 active guardian 在 Postgres 上到底查出了谁；
 *   ② `Notification` 与 `PushRetryJob` 是否真的**同一事务**写入（提交后两表都在）；
 *   ③ outbox 抛错时，审批行是否真的**没有留下**（不是只测了一个内存返回值）。
 *
 * ★ 这是一份「会写实验数据」的套件：用全新 `dbtest-<run>` 前缀，跑完不清理
 *   （与 `approvals-execution-db` / `notifications-db` 同一纪律）。
 *   入口：`npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AppModule } from '../src/app.module'
import { applyGlobalPipes } from '../src/app.setup'
import { PrismaApprovalsRepository } from '../src/approvals/approvals.prisma.repository'
import type { NotificationsOutboxPort } from '../src/notifications/notifications.outbox'
import { PrismaService } from '../src/prisma/prisma.service'
import { grantConsentFor } from './support/consent-fixture'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-outbox-dad`,
  mom: `dbtest-${RUN}-outbox-mom`,
  kid: `dbtest-${RUN}-outbox-kid`,
  child: `dbtest-${RUN}-outbox-child`,
  devDad: `dbtest-${RUN}-outbox-dev-dad`,
  devMom: `dbtest-${RUN}-outbox-dev-mom`,
  devKid: `dbtest-${RUN}-outbox-dev-kid`,
  wish: `dbtest-${RUN}-outbox-wish`
} as const

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.child },
  mom: { 'x-kp-device-id': ID.devMom, 'x-kp-child-id': ID.child },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.child }
} as const

let prisma: PrismaService
let app: INestApplication
let url = ''

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function send(
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(init.body ?? {})
  })
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)
  await prisma.child.create({ data: { id: ID.child, name: `审批 outbox 套件 ${RUN}` } })
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: 'DB outbox 家长 A' },
      { id: ID.mom, displayName: 'DB outbox 家长 B' },
      { id: ID.kid, displayName: 'DB outbox 孩子' }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.child, userId: ID.dad, role: 'guardian' },
      { childId: ID.child, userId: ID.mom, role: 'guardian' },
      { childId: ID.child, userId: ID.kid, role: 'child' }
    ]
  })
  // ★ W7-A 起写端点都过 ConsentGuard：同意按**孩子**记，一位家长授权即可（outbox 测两位家长的红点）。
  await grantConsentFor(prisma, [[ID.child, ID.dad]])
  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.child, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devMom, childId: ID.child, userId: ID.mom, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.child, userId: ID.kid, activeRole: 'child', expiresAt: future }
    ]
  })
  await prisma.wish.create({
    data: { id: ID.wish, childId: ID.child, title: 'outbox 心愿', cost: 10, emoji: '🎁' }
  })
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()
})

after(async () => {
  await app.close()
  await prisma.$disconnect()
})

describe('组 A：提交审批 ⇒ Notification + PushRetryJob 同事务落库，收件人是另一位家长', () => {
  it('孩子提交 add_wish：两位 guardian 各一条站内通知、各一条待推送任务；提交人不在收件人里', async () => {
    const res = await send('/approvals', {
      headers: H.kid,
      body: { action: 'add_wish', title: `outbox 新心愿 ${RUN}`, cost: 12, emoji: '🧸' }
    })
    assert.equal(res.status, 202, `提交审批失败：${JSON.stringify(res.body)}`)
    const approvalId = res.body.id as string
    assert.ok(approvalId)

    const notifications = await prisma.notification.findMany({
      where: { childId: ID.child, type: 'approval.submitted' }
    })
    assert.equal(notifications.length, 2, '两位 active guardian 应各收到一条')
    assert.deepEqual(
      notifications.map((row) => row.recipientUserId).sort(),
      [ID.dad, ID.mom].sort(),
      '提交人（孩子）不应收到「待确认」通知'
    )
    for (const row of notifications) {
      assert.equal((row.payload as { approvalId?: string }).approvalId, approvalId)
      assert.equal(row.childId, ID.child)
    }

    const jobs = await prisma.pushRetryJob.findMany({
      where: { childId: ID.child, event: 'approval.submitted' }
    })
    assert.equal(jobs.length, 2, '每条站内通知必须有且只有一条推送任务')
    assert.deepEqual(
      jobs.map((row) => row.dedupeKey).sort(),
      [`approval.submitted:${approvalId}:${ID.dad}`, `approval.submitted:${approvalId}:${ID.mom}`].sort()
    )
    for (const job of jobs) {
      assert.equal(job.status, 'pending')
      assert.equal(job.attempts, 0)
      assert.equal((job.payload as { type?: string }).type, 'approval.submitted')
    }
  })

  it('家长批准 ⇒ 申请人收到 approval.approved，且恰有一条任务（去重键带 approvalId）', async () => {
    const created = await send('/approvals', {
      headers: H.kid,
      body: { action: 'add_wish', title: `outbox 待批心愿 ${RUN}`, cost: 15, emoji: '🎈' }
    })
    assert.equal(created.status, 202, `提交审批失败：${JSON.stringify(created.body)}`)
    const approvalId = created.body.id as string

    const decided = await send(`/approvals/${approvalId}/decide`, {
      headers: H.dad,
      body: { decision: 'approved' }
    })
    assert.equal(decided.status, 200, `批准失败：${JSON.stringify(decided.body)}`)

    const notifications = await prisma.notification.findMany({
      where: { childId: ID.child, type: 'approval.approved' }
    })
    assert.equal(notifications.length, 1, '结论通知只发申请人，且只发一次')
    assert.equal(notifications[0].recipientUserId, ID.kid)
    assert.equal((notifications[0].payload as { approvalId?: string }).approvalId, approvalId)

    const jobs = await prisma.pushRetryJob.findMany({
      where: { childId: ID.child, event: 'approval.status_changed' }
    })
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].dedupeKey, `approval.status_changed:${approvalId}:${ID.kid}:approved`)
    assert.equal(jobs[0].recipientUserId, ID.kid)
    assert.equal((jobs[0].payload as { status?: string }).status, 'approved')
  })
})

describe('组 B：outbox 抛错 ⇒ 审批事务整体回滚（不留一条「批准了但没人知道」）', () => {
  it('端口直接抛错时，ApprovalRequest 一行都不落库', async () => {
    const exploding: NotificationsOutboxPort = {
      async enqueueApprovalStatusChanged() {
        throw new Error('outbox 爆炸（用例注入）')
      },
      async enqueueApprovalSubmitted() {
        throw new Error('outbox 爆炸（用例注入）')
      }
    }
    const repository = new PrismaApprovalsRepository(prisma, exploding)
    const title = `outbox 回滚心愿 ${RUN}`
    const before = await prisma.approvalRequest.count({
      where: { childId: ID.child, requesterUserId: ID.kid }
    })

    await assert.rejects(
      () =>
        repository.createPending({
          childId: ID.child,
          action: 'add_wish',
          requesterUserId: ID.kid,
          requesterRole: 'child',
          title,
          cost: 9,
          emoji: '💥'
        }),
      /outbox 爆炸/
    )

    const after = await prisma.approvalRequest.count({
      where: { childId: ID.child, requesterUserId: ID.kid }
    })
    assert.equal(after, before, '审批行必须随 outbox 失败一起回滚')
  })
})


/**
 * push-retry-db.dbtest.ts —— 推送重试队列的**真库**不变量套件（W6-B，2026-10-24）
 *
 * ── 与离线用例的分工（缺哪份都算没验完）────────────────────────────────────
 *   · `test/push-retry.test.ts` —— 纯离线：退避序列 / 失败分类 / 去重键 / payload
 *     校验 / 装饰器口径 / worker 的**结算规则**。端口是替身 ⇒ SQL 一行都没跑。
 *   · **本文件** —— 真 `PrismaPushRetryRepository` + 真 Postgres，补的正是替身
 *     永远证明不了的四件事：
 *
 *   ① **`dedupeKey` 唯一约束真的在兜底**：第二次入队回 `'duplicate'`，且原行的
 *      `attempts` / `nextAttemptAt` / `lastError` **一个字节都没变**（否则「重新入队」
 *      会把退避进度重置回原点）；
 *   ② **领取是原子的、可并发的**：两个 `claimDue` 同时跑，并集不重叠
 *      （`FOR UPDATE SKIP LOCKED`）—— 替身连这句 SQL 都没执行过；
 *   ③ **`sending` 会被回收**：进程崩溃留下的行在 `claimTimeoutMs` 之后能再次领到，
 *      而刚领走的行不会被另一个 worker 抢走；
 *   ④ **坏 payload 落到 `message: null`**：手工写坏 `payload` 之后，真库路径
 *      交给 worker 的一定是「无法发送」，不是「发送了一条空消息」。
 *
 * ── ★ 与其它真库套件同一条纪律：不做 DELETE 清理 ──────────────────────────
 *   每轮用新前缀（`dbtest-<run>-pr-…`），跑完「那些行还在」本身就是证据。
 *
 * ── 入口 ──────────────────────────────────────────────────────────────────
 *   `npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { PushMessage } from '../src/notifications/push.port'
import { PrismaPushRetryRepository } from '../src/notifications/push-retry.prisma.repository'
import type {
  EnqueuePushRetryInput,
  EnqueuePushRetryResult,
  PushRetryRow
} from '../src/notifications/push-retry.types'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 —— 「新事实」，与历史数据互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

/** 套件基准时刻（往未来偏一天，避免与历史行的 `expiresAt` 语义混淆）。 */
const NOW = new Date(Date.now() + 60 * 1000)

let prisma: PrismaService
let repository: PrismaPushRetryRepository

function keyOf(label: string): string {
  return `dbtest-${RUN}-pr-${label}`
}

/** 一条形状完整的消息；`approvalId` 带 `RUN`，避免跨轮误认。 */
function messageOf(label: string): PushMessage {
  return {
    type: 'approval.status_changed',
    approvalId: keyOf(label),
    childId: keyOf(`${label}-child`),
    recipientUserId: keyOf(`${label}-recipient`),
    action: 'redeem',
    status: 'approved',
    decidedByUserId: keyOf(`${label}-decider`),
    occurredAt: NOW.toISOString()
  }
}

function inputOf(
  label: string,
  overrides: Partial<EnqueuePushRetryInput> = {}
): EnqueuePushRetryInput {
  const message = overrides.message ?? messageOf(label)
  return {
    message,
    dedupeKey: overrides.dedupeKey ?? keyOf(label),
    now: overrides.now ?? NOW,
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 24 * 60 * 60_000),
    maxAttempts: overrides.maxAttempts ?? 6,
    ...(overrides.lastError === undefined ? {} : { lastError: overrides.lastError })
  }
}

/** 入队并断言 `queued`（`duplicate` 会让后面的断言读到别人的行）。 */
async function enqueue(label: string, overrides: Partial<EnqueuePushRetryInput> = {}) {
  const outcome: EnqueuePushRetryResult = await repository.enqueue(inputOf(label, overrides))
  assert.equal(outcome, 'queued', `${label} 应当是首次入队`)
  const row = await rowOf(keyOf(label))
  assert.notEqual(row, null, `${label} 入队后读不到行`)
  return row!
}

/** 直接读库 —— 断言的是**列上的事实**，不是端口回给我们的说法。 */
async function rowOf(dedupeKey: string) {
  return prisma.pushRetryJob.findUnique({ where: { dedupeKey } })
}

/** 领取并断言拿到期望的去重键集合（顺序按 `nextAttemptAt`）。 */
async function claim(limit: number, claimTimeoutMs = 60_000): Promise<PushRetryRow[]> {
  return repository.claimDue({ now: NOW, limit, claimTimeoutMs })
}

/**
 * 把「此刻所有可领的行」一次性领走。
 *
 * 本套件不做 DELETE（见文件头），库里必然留着**历史轮次**的行：`pending` 到点的、
 * 以及崩溃留下的过期 `sending`。它们排在前面，`LIMIT 1` 的断言就变成了
 * 「今天先跑过谁」的抽奖。
 *
 * `claimDue` 会把被领行的 `claimedAt` 刷成 `now`，于是 60s 内它们都不可再领；
 * 先 drain 再造就意味着**本轮新造的行是唯一可领的行**，断言才是确定的。
 * ★ 这不是清理数据，而是把不可控的历史状态压成可控的起始条件。
 */
async function drain(): Promise<void> {
  await repository.claimDue({ now: NOW, limit: 100_000, claimTimeoutMs: 60_000 })
}

/** 把某一行的 `nextAttemptAt` 往过去挪，用来钉住领取顺序。 */
async function ageOut(label: string, minutesAgo: number): Promise<void> {
  await prisma.pushRetryJob.update({
    where: { dedupeKey: keyOf(label) },
    data: { nextAttemptAt: new Date(NOW.getTime() - minutesAgo * 60_000) }
  })
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  repository = new PrismaPushRetryRepository(prisma)
})

after(async () => {
  await prisma.$disconnect()
})

// ══ 组 A：入队（幂等 + 无外键）═══════════════════════════════════════════════
describe('组 A：入队', () => {
  it('A1 首次入队 ⇒ pending / attempts=0 / claimedAt=null / payload 可回读', async () => {
    const row = await enqueue('a1', { lastError: 'provider_error: 网关 500' })
    assert.equal(row.status, 'pending')
    assert.equal(row.attempts, 0)
    assert.equal(row.maxAttempts, 6)
    assert.equal(row.claimedAt, null)
    assert.equal(row.providerMessageId, null)
    assert.equal(row.sentAt, null)
    assert.equal(row.lastError, 'provider_error: 网关 500')
    assert.equal(row.event, 'approval.status_changed')
    assert.equal(row.nextAttemptAt.getTime(), NOW.getTime(), '入队即「立刻可试」')
    assert.deepEqual(row.payload, messageOf('a1'))
  })

  it('★ A2 同 dedupeKey 再入队 ⇒ duplicate，且**原行不被改写**（退避进度不重置）', async () => {
    const row = await enqueue('a2', { lastError: 'provider_error: 第一次' })
    const movedOn = new Date(NOW.getTime() + 8 * 60_000)
    await prisma.pushRetryJob.update({
      where: { id: row.id },
      data: { attempts: 4, nextAttemptAt: movedOn, status: 'pending' }
    })

    const outcome = await repository.enqueue({
      // 换个 lastError / 新的 now：若实现「先删后写」或「upsert 刷新」，这里会露馅。
      ...inputOf('a2', { lastError: 'provider_error: 第二次' }),
      now: new Date(NOW.getTime() + 30 * 60_000)
    })
    assert.equal(outcome, 'duplicate')

    const after = await rowOf(keyOf('a2'))
    assert.equal(after?.id, row.id, '重复入队造出了第二行')
    assert.equal(after?.attempts, 4, '重复入队把 attempts 重置了')
    assert.equal(after?.nextAttemptAt.getTime(), movedOn.getTime(), '重复入队把退避排期改早了')
    assert.equal(after?.lastError, 'provider_error: 第一次', '重复入队覆盖了原始失败原因')
  })

  it('★ A3 没有 User / Child 外键：收件人 / 孩子不存在也能写入（投递事实独立于业务表）', async () => {
    const row = await enqueue('a3')
    assert.equal(row.recipientUserId, keyOf('a3-recipient'))
    assert.equal(row.childId, keyOf('a3-child'))
    // 反证：真的没有外键 —— 上面这两个 id 在 User / Child 表里都不存在，写入却没报错。
    assert.equal(await prisma.user.count({ where: { id: row.recipientUserId } }), 0)
    assert.equal(await prisma.child.count({ where: { id: row.childId } }), 0)
  })

  it('A4 坏 payload ⇒ 领取时 `message` 为 null（交给 worker 标 dead，不假装能发）', async () => {
    await drain()
    const row = await enqueue('a4')
    await prisma.$executeRaw`
      UPDATE "PushRetryJob" SET "payload" = '{"type":"approval.bogus"}'::jsonb WHERE "id" = ${row.id}
    `

    const claimed = await claim(100)
    const target = claimed.find((entry) => entry.id === row.id)
    assert.notEqual(target, undefined, '坏 payload 的行应当仍可被领取（才能被结算掉）')
    assert.equal(target?.message, null)
  })
})


// ══ 组 B：领取（唯一真正难的 SQL）═══════════════════════════════════════════
describe('组 B：领取', () => {
  it('B1 只领「到点且未过期」的行：未来行 / 过期行都不进发送路径', async () => {
    await drain()
    const due = await enqueue('b1-due')
    const future = await enqueue('b1-future')
    await prisma.pushRetryJob.update({
      where: { id: future.id },
      data: { nextAttemptAt: new Date(NOW.getTime() + 10 * 60_000) }
    })
    const expiring = await enqueue('b1-expiring', {
      expiresAt: new Date(NOW.getTime() - 1)
    })

    const claimed = await claim(100)
    const ids = new Set(claimed.map((row) => row.id))
    assert.equal(ids.has(due.id), true)
    assert.equal(ids.has(future.id), false, '未到 nextAttemptAt 的行被领走了')
    assert.equal(ids.has(expiring.id), false, '已过 expiresAt 的行应当留给 expireOverdue')
  })

  it('B2 按 `nextAttemptAt` 升序 + `limit` 生效（先发拖得最久的）', async () => {
    await drain()
    const oldest = await enqueue('b2-oldest')
    const middle = await enqueue('b2-middle')
    const newest = await enqueue('b2-newest')
    await ageOut('b2-oldest', 3)
    await ageOut('b2-middle', 2)

    // ★ `RETURNING` 的行序在 Postgres 里未定义 —— 适配器按 nextAttemptAt 再排一次，
    //   这条断言同时钉住「限额选谁」与「返回顺序」两件事。
    const first = await claim(1)
    assert.equal(first.length, 1)
    assert.equal(first[0].id, oldest.id, '最久没发的应当排在最前')

    const rest = await claim(2)
    assert.deepEqual(
      rest.map((row) => row.id),
      [middle.id, newest.id],
      '第二老、第三老的顺序不对'
    )
  })

  it('B3 领取即标 `sending` 并写下 claimedAt（「领到」与「标记」是同一个事实）', async () => {
    await drain()
    const row = await enqueue('b3')
    const claimed = (await claim(100)).find((entry) => entry.id === row.id)
    assert.notEqual(claimed, undefined)
    assert.equal(claimed?.status, 'sending')
    assert.equal(claimed?.claimedAt?.getTime(), NOW.getTime())

    const stored = await prisma.pushRetryJob.findUnique({ where: { id: row.id } })
    assert.equal(stored?.status, 'sending')
    assert.equal(stored?.claimedAt?.getTime(), NOW.getTime())
  })

  it('★ B4 两个 worker 并发领取 ⇒ 结果不重叠（`FOR UPDATE SKIP LOCKED`）', async () => {
    await drain()
    const created = []
    for (const label of ['b4-a', 'b4-b', 'b4-c', 'b4-d']) {
      created.push(await enqueue(label))
    }

    const [left, right] = await Promise.all([claim(2), claim(2)])
    const leftIds = left.map((row) => row.id)
    const rightIds = right.map((row) => row.id)

    const overlap = leftIds.filter((id) => rightIds.includes(id))
    assert.deepEqual(overlap, [], `同一条被两个 worker 领走了：${overlap.join(',')}`)
    const union = new Set([...leftIds, ...rightIds])
    for (const row of created) {
      assert.equal(union.has(row.id), true, `四条都该被领到（否则 SKIP LOCKED 丢件）`)
    }
  })

  it('★ B5 `sending` 回收：超过 claimTimeout 的能重领，刚领走的不能', async () => {
    await drain()
    const stale = await enqueue('b5-stale')
    const fresh = await enqueue('b5-fresh')
    await prisma.pushRetryJob.update({
      where: { id: stale.id },
      data: { status: 'sending', claimedAt: new Date(NOW.getTime() - 2 * 60_000) }
    })
    await prisma.pushRetryJob.update({
      where: { id: fresh.id },
      data: { status: 'sending', claimedAt: new Date(NOW.getTime() - 10_000) }
    })

    const claimed = await claim(100, 60_000)
    const ids = new Set(claimed.map((row) => row.id))
    assert.equal(ids.has(stale.id), true, '崩溃留下的 sending 行没有被回收 ⇒ 永远不发')
    assert.equal(ids.has(fresh.id), false, '刚领走 10s 的行被抢走了 ⇒ 会重复发送')

    const reclaimed = await prisma.pushRetryJob.findUnique({ where: { id: stale.id } })
    assert.equal(reclaimed?.status, 'sending')
    assert.equal(reclaimed?.claimedAt?.getTime(), NOW.getTime(), 'claimedAt 没有刷新')
  })
})


// ══ 组 C：结算（sent / pending / dead / expired 四种落点）════════════════════
describe('组 C：结算', () => {
  it('C1 `markRetry` ⇒ 回 pending、顺延 nextAttemptAt、清 claimedAt；到点前不会重领', async () => {
    await drain()
    const row = await enqueue('c1')
    await claim(100)

    const nextAttemptAt = new Date(NOW.getTime() + 30_000)
    await repository.markRetry({
      id: row.id,
      attempts: 1,
      nextAttemptAt,
      lastError: 'provider_error: 网关 500'
    })

    const stored = await prisma.pushRetryJob.findUnique({ where: { id: row.id } })
    assert.equal(stored?.status, 'pending')
    assert.equal(stored?.attempts, 1)
    assert.equal(stored?.nextAttemptAt.getTime(), nextAttemptAt.getTime())
    assert.equal(stored?.lastError, 'provider_error: 网关 500')
    assert.equal(stored?.claimedAt, null, '终态/待重试都该清 claimedAt，否则会被误判成「正在发」')

    const tooEarly = await repository.claimDue({
      now: new Date(nextAttemptAt.getTime() - 1),
      limit: 100,
      claimTimeoutMs: 60_000
    })
    assert.equal(
      tooEarly.some((entry) => entry.id === row.id),
      false,
      '还没到 nextAttemptAt 就被领走了'
    )

    const onTime = await repository.claimDue({
      now: nextAttemptAt,
      limit: 100,
      claimTimeoutMs: 60_000
    })
    assert.equal(onTime.some((entry) => entry.id === row.id), true)
  })

  it('C2 `markSent` ⇒ sent + sentAt + providerMessageId，之后不再被领', async () => {
    await drain()
    const row = await enqueue('c2')
    await claim(100)
    await repository.markSent(row.id, 'pm-db-1', NOW)

    const stored = await prisma.pushRetryJob.findUnique({ where: { id: row.id } })
    assert.equal(stored?.status, 'sent')
    assert.equal(stored?.providerMessageId, 'pm-db-1')
    assert.equal(stored?.sentAt?.getTime(), NOW.getTime())
    assert.equal(stored?.claimedAt, null)
    assert.equal(stored?.lastError, null, '送达后留着旧失败原因会让排查误判')

    const claimed = await claim(100)
    assert.equal(claimed.some((entry) => entry.id === row.id), false)
  })

  it('C3 `markDead` ⇒ dead，且不会被任何后续轮次领走', async () => {
    await drain()
    const row = await enqueue('c3')
    await claim(100)
    await repository.markDead(row.id, 'provider_error: 用满 6 次', NOW)

    const stored = await prisma.pushRetryJob.findUnique({ where: { id: row.id } })
    assert.equal(stored?.status, 'dead')
    assert.equal(stored?.lastError, 'provider_error: 用满 6 次')
    assert.equal(stored?.claimedAt, null)

    const claimed = await claim(100)
    assert.equal(claimed.some((entry) => entry.id === row.id), false)
  })

  it('C4 `markExpired` 是条件更新：只对 pending / sending 生效（终态不被改写）', async () => {
    await drain()
    const pending = await enqueue('c4-pending')
    assert.equal(await repository.markExpired(pending.id, 'expired: 超过 TTL', NOW), true)

    const sent = await enqueue('c4-sent')
    await claim(100)
    await repository.markSent(sent.id, 'pm-db-2', NOW)
    assert.equal(
      await repository.markExpired(sent.id, 'expired: 超过 TTL', NOW),
      false,
      '已送达的行被改成了 expired —— 这是把成功记录抹掉'
    )

    const stored = await prisma.pushRetryJob.findUnique({ where: { id: sent.id } })
    assert.equal(stored?.status, 'sent')
  })

  it('C5 `expireOverdue` 批量清扫 pending + sending；sent / dead 不受影响', async () => {
    const past = new Date(NOW.getTime() - 1)
    const pending = await enqueue('c5-pending', { expiresAt: past })
    const sending = await enqueue('c5-sending', { expiresAt: past })
    await prisma.pushRetryJob.update({
      where: { id: sending.id },
      data: { status: 'sending', claimedAt: NOW }
    })
    const sent = await enqueue('c5-sent', { expiresAt: past })
    await prisma.pushRetryJob.update({
      where: { id: sent.id },
      data: { status: 'sent', sentAt: NOW, claimedAt: null }
    })

    const count = await repository.expireOverdue(NOW, 'expired: 超过 TTL')
    // ★ 不清断言精确条数：同一次运行里前面的用例也会留下过期行。
    //   断言的是「这两条被清了、那条送达的没被碰」。
    assert.ok(count >= 2, `期望至少清扫 2 条，实际 ${count}`)

    for (const id of [pending.id, sending.id]) {
      const stored = await prisma.pushRetryJob.findUnique({ where: { id } })
      assert.equal(stored?.status, 'expired', `id=${id} 没被清扫`)
      assert.equal(stored?.lastError, 'expired: 超过 TTL')
      assert.equal(stored?.claimedAt, null)
    }

    const stored = await prisma.pushRetryJob.findUnique({ where: { id: sent.id } })
    assert.equal(stored?.status, 'sent', '清除过期时把已送达的记录一起改了')
  })
})

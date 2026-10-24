/**
 * push-retry-retention-db.dbtest.ts —— 保留清理 SQL 的**真库证据**（W6-D，2026-10-24）
 *
 * ── 离线用例答不了的问题 ────────────────────────────────────────────────────
 *   `test/push-retry-retention.test.ts` 里的端口是替身：它证明「worker 会不会
 *   按区间调三次」，证明不了真正执行的那条 `DELETE`：
 *
 *   ① **删除范围只有终态**：`pending` / `sending` 一行都不能少（删掉它们等于
 *      把还没发出去的推送扔掉）；`sent` / `expired` / `dead` 才可删；
 *   ② **截止线是严格 `<`**：`updatedAt` 恰好等于截止线的行**不能**被删
 *      （差一毫秒就删，会在反复重跑时出现「边界行随机消失」）；
 *   ③ **`LIMIT` 真的在 SQL 里**：`limit: 2` 只删 2 行 —— `deleteMany` 没有
 *      limit，这条唯一能证明「没有写回成无上限 DELETE」的用例必须在真库上跑；
 *   ④ **状态是真的枚举强转**：`${status}::"PushRetryStatus"` 拼错会抛错而不是静默删 0 行；
 *   ⑤ **`updatedAt` 才是终态时刻**：`createdAt` 很老但 `updatedAt` 很新的行不该被删。
 *
 * ── 为什么所有时间都钉在上世纪 ─────────────────────────────────────────────
 *   这套件与其它真库套件共享一个库，且不同文件可能并发跑。若用「相对现在」
 *   的截止线，就会顺手删掉 `push-retry-db` 刚写下的行 —— 那是别人的证据。
 *   这里把截止线全部压在 2019 年，**只可能**命中本套件自己造的行。
 *
 * ── 入口 ──────────────────────────────────────────────────────────────────
 *   `npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { PushRetryStatus } from '@prisma/client'

import { PrismaPushRetryRetention } from '../src/notifications/push-retry.retention.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 —— 「新事实」，与历史数据互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

/** 所有时间都落在这个远古窗口里（见文件头「为什么」）。 */
const BASE = Date.UTC(2019, 0, 1)
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

let prisma: PrismaService
let port: PrismaPushRetryRetention
let seq = 0

interface JobSeed {
  status: PushRetryStatus
  /** 终态时刻（清理依据）。 */
  updatedAt: Date
  createdAt?: Date
}

async function addJob(input: JobSeed): Promise<string> {
  seq += 1
  const row = await prisma.pushRetryJob.create({
    data: {
      event: 'approval.status_changed',
      dedupeKey: `dbtest-${RUN}-rr-key-${seq}`,
      payload: {
        type: 'approval.status_changed',
        approvalId: `dbtest-${RUN}-rr-ap-${seq}`,
        recipientUserId: `dbtest-${RUN}-rr-user`,
        childId: `dbtest-${RUN}-rr-child`,
        status: 'approved'
      },
      recipientUserId: `dbtest-${RUN}-rr-user`,
      childId: `dbtest-${RUN}-rr-child`,
      status: input.status,
      expiresAt: new Date(BASE + 365 * DAY),
      createdAt: input.createdAt ?? input.updatedAt,
      updatedAt: input.updatedAt
    },
    select: { id: true }
  })
  return row.id
}

async function exists(id: string): Promise<boolean> {
  const row = await prisma.pushRetryJob.findUnique({ where: { id }, select: { id: true } })
  return row !== null
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  port = new PrismaPushRetryRetention(prisma)
})

after(async () => {
  await prisma.$disconnect()
})

describe('组 A：删除范围只有终态', () => {
  it('A1 清 sent ⇒ 老的 sent 删掉，新的 sent 与 pending / sending 一行不动', async () => {
    const cutoff = new Date(BASE + 12 * HOUR)
    const oldSent = await addJob({ status: 'sent', updatedAt: new Date(BASE) })
    const freshSent = await addJob({ status: 'sent', updatedAt: new Date(BASE + DAY) })
    const oldPending = await addJob({ status: 'pending', updatedAt: new Date(BASE) })
    const oldSending = await addJob({ status: 'sending', updatedAt: new Date(BASE) })

    const deleted = await port.deleteSettled({ status: 'sent', before: cutoff, limit: 500 })
    assert.ok(deleted >= 1, `应至少删掉本套件造的那条老 sent，实际 ${deleted}`)

    assert.equal(await exists(oldSent), false, '超过保留期的 sent 应被删')
    assert.equal(await exists(freshSent), true, '还在保留期内的 sent 不能被删')
    assert.equal(await exists(oldPending), true, '★ pending 是「还没发出去」—— 删了等于丢消息')
    assert.equal(await exists(oldSending), true, '★ sending 可能正被 worker 持有 —— 删了会重复发送')
  })

  it('A2 清 dead 与 expired 各自只命中自己的状态', async () => {
    const cutoff = new Date(BASE + 12 * HOUR)
    const dead = await addJob({ status: 'dead', updatedAt: new Date(BASE) })
    const expired = await addJob({ status: 'expired', updatedAt: new Date(BASE) })
    const sent = await addJob({ status: 'sent', updatedAt: new Date(BASE) })

    assert.ok((await port.deleteSettled({ status: 'dead', before: cutoff, limit: 500 })) >= 1)
    assert.equal(await exists(dead), false)
    assert.equal(await exists(expired), true, '按 dead 清理不能顺带删 expired')

    assert.ok((await port.deleteSettled({ status: 'expired', before: cutoff, limit: 500 })) >= 1)
    assert.equal(await exists(expired), false)
    assert.equal(await exists(sent), true, '按 expired 清理不能顺带删 sent')
  })
})

describe('组 B：截止线是严格 `<`', () => {
  it('B1 updatedAt 恰好等于截止线的行保留，早 1ms 的删掉，晚 1ms 的保留', async () => {
    const cutoff = new Date(BASE + 6 * HOUR)
    const beforeLine = await addJob({ status: 'expired', updatedAt: new Date(cutoff.getTime() - 1) })
    const onLine = await addJob({ status: 'expired', updatedAt: cutoff })
    const afterLine = await addJob({ status: 'expired', updatedAt: new Date(cutoff.getTime() + 1) })

    const deleted = await port.deleteSettled({ status: 'expired', before: cutoff, limit: 500 })
    assert.ok(deleted >= 1)

    assert.equal(await exists(beforeLine), false, '早于截止线应删')
    assert.equal(
      await exists(onLine),
      true,
      '★ 边界行必须保留：用 <= 会让每次重跑都可能删掉一条「刚刚到期」的行'
    )
    assert.equal(await exists(afterLine), true)
  })
})

describe('组 C：LIMIT 真的在 SQL 里', () => {
  it('C1 limit: 2 只删 2 行；随后放大 limit 才把本套件剩下的清完', async () => {
    const cutoff = new Date(BASE + 3 * DAY)
    const ids = [
      await addJob({ status: 'dead', updatedAt: new Date(BASE + 2 * DAY) }),
      await addJob({ status: 'dead', updatedAt: new Date(BASE + 2 * DAY + 1) }),
      await addJob({ status: 'dead', updatedAt: new Date(BASE + 2 * DAY + 2) })
    ]

    // ★ 这条断言就是「没有退化成 deleteMany」的证据：无上限 DELETE 会删光。
    const first = await port.deleteSettled({ status: 'dead', before: cutoff, limit: 2 })
    assert.equal(first, 2, `limit: 2 必须只删 2 行，实际 ${first}`)

    // 库里可能还有更早的运行留下的行（同样在远古窗口），所以不断言「删的是哪两条」，
    // 只断言：本套件的三条最终都能被清掉（可重复调用、不会卡在中间状态）。
    await port.deleteSettled({ status: 'dead', before: cutoff, limit: 500 })
    for (const id of ids) {
      assert.equal(await exists(id), false, `id=${id} 在小批量 + 大批量两轮后应已被删`)
    }
  })
})

describe('组 D：`updatedAt` 是终态时刻（不是 createdAt）', () => {
  it('D1 createdAt 很老但 updatedAt 很新 ⇒ 不删', async () => {
    const cutoff = new Date(BASE + 12 * HOUR)
    const id = await addJob({
      status: 'sent',
      createdAt: new Date(BASE),
      updatedAt: new Date(BASE + 5 * DAY)
    })

    await port.deleteSettled({ status: 'sent', before: cutoff, limit: 500 })
    assert.equal(
      await exists(id),
      true,
      '★ 用 createdAt 判断会把「刚重试成功的老任务」立刻删掉 —— 必须看 updatedAt'
    )
  })
})

describe('组 E：运行期状态白名单（真库前就拦住）', () => {
  it('E1 pending / sending 直接抛错，且库里一行未动', async () => {
    const pending = await addJob({ status: 'pending', updatedAt: new Date(BASE) })
    const sending = await addJob({ status: 'sending', updatedAt: new Date(BASE) })

    for (const status of ['pending', 'sending'] as const) {
      await assert.rejects(
        () =>
          port.deleteSettled({
            // ★ 故意绕过 TS：模拟 JS 调用方 / `as` 强转
            status: status as unknown as 'sent',
            before: new Date(BASE + 12 * HOUR),
            limit: 500
          }),
        /只允许终态/
      )
    }
    assert.equal(await exists(pending), true)
    assert.equal(await exists(sending), true)
  })
})

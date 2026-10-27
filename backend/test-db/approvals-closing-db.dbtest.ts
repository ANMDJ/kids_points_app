/**
 * approvals-closing-db.dbtest.ts —— W3-C 收尾的真库证据
 *
 * 本文件回答的是「执行器 / autoReason / TTL 扫描 / 幂等键」**在真库上真的会发生**：
 *   ① `request_points_bonus` 批准 ⇒ `+amount` 流水 ＋ 余额；
 *   ② `add_wish` 批准 ⇒ 真的创建 `Wish`（且不产生流水）；
 *   ③ `request_redeem` 与 `redeem` 同一执行路径；
 *   ④ 五种 `autoReason` 全部可复现：`WISH_DELETED` / `INSUFFICIENT_POINTS`（既有文件）
 *      ＋ 本文件的 `RULE_DELETED` / `HABIT_GONE` / `MEMBER_REMOVED`；
 *   ⑤ `expireDue()` 后台扫描真的把到期行置 `expired` 并写审计；
 *   ⑥ `Idempotency-Key` 的 HTTP 重放：同一请求第二次**不再执行**，响应原样返回；
 *      同键不同请求 409。
 *
 * ★ 与 `approvals-execution-db.dbtest.ts` 分开：账本表 DELETE 被 REVOKE（I5），
 *   本文件也**不清理**，靠每轮全新前缀保证「链从 0 开始」。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AppModule } from '../src/app.module'
import { applyGlobalPipes } from '../src/app.setup'
import { ApprovalsExpiryService } from '../src/approvals/approvals-expiry.service'
import { buildRecordDraft, verifyBalanceChain } from '../src/ledger/ledger.gate'
import { PrismaLedgerRepository } from '../src/ledger/ledger.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'
import { grantConsentFor } from './support/consent-fixture'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-close-dad`,
  kid: `dbtest-${RUN}-close-kid`,
  child: `dbtest-${RUN}-close-child`,
  devDad: `dbtest-${RUN}-close-dev-dad`,
  devKid: `dbtest-${RUN}-close-dev-kid`,
  wishRedeem: `dbtest-${RUN}-close-wish-redeem`,
  wishExpire: `dbtest-${RUN}-close-wish-expire`,
  rule: `dbtest-${RUN}-close-rule`,
  habit: `dbtest-${RUN}-close-habit`
} as const

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.child },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.child }
} as const

const START_BALANCE = 100

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

let prisma: PrismaService
let ledger: PrismaLedgerRepository
let app: INestApplication
let url = ''

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
  await prisma.child.create({ data: { id: ID.child, name: `W3-C 套件 ${RUN}` } })
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: 'W3-C 家长' },
      { id: ID.kid, displayName: 'W3-C 孩子' }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.child, userId: ID.dad, role: 'guardian' },
      { childId: ID.child, userId: ID.kid, role: 'child' }
    ]
  })
  // ★ W7-A 起写端点都过 ConsentGuard：夹具显式给「有效同意」（测到期收口，不是闸门）。
  await grantConsentFor(prisma, [[ID.child, ID.dad]])
  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.child, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.child, userId: ID.kid, activeRole: 'child', expiresAt: future }
    ]
  })
  await prisma.wish.createMany({
    data: [
      { id: ID.wishRedeem, childId: ID.child, title: '拼装玩具', cost: 20, emoji: '🧩' },
      { id: ID.wishExpire, childId: ID.child, title: '过期测试', cost: 10, emoji: '⏳' }
    ]
  })
  await prisma.pointRule.create({
    data: {
      id: ID.rule,
      childId: ID.child,
      title: '阅读 30 分钟',
      condition: '读完一章',
      dailyLimit: 1,
      points: 5,
      direction: 'reward',
      icon: 'book',
      color: '#123456'
    }
  })
  await prisma.habit.create({
    data: {
      id: ID.habit,
      childId: ID.child,
      title: '整理书桌',
      points: 5,
      condition: '睡前整理',
      dailyLimit: 1,
      icon: 'desk',
      color: '#654321'
    }
  })

  ledger = new PrismaLedgerRepository(prisma)
  const draft = buildRecordDraft({
    childId: ID.child,
    ruleVersionRow: null,
    titleSnapshot: '初始积分',
    pointsDelta: START_BALANCE,
    category: 'adjust',
    source: 'guardian',
    operator: { userId: ID.dad, role: 'guardian' },
    currentBalance: await ledger.readBalance(ID.child),
    now: new Date()
  })
  await ledger.append(draft)

  assert.equal((await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance, START_BALANCE)
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

async function pointsBalance(): Promise<number> {
  return (await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance
}

async function recordCount(approvalId: string): Promise<number> {
  return prisma.pointRecord.count({
    where: { childId: ID.child, idempotencyKey: `approval:${approvalId}` }
  })
}

// ══ 组 A：`request_points_bonus` —— 批准后才加分（不是申请时）══════════════════
describe('组 A：request_points_bonus 执行器', () => {
  it('★ 孩子申请 → 家长批准 ⇒ payload 快照 ＋ `+10` 流水 ＋ 余额 110', async () => {
    const created = await send('/approvals', {
      body: { action: 'request_points_bonus', amount: 10, reason: '周末大扫除' },
      headers: H.kid
    })
    assert.equal(created.status, 202, `加分申请拿到 ${created.status}：400 说明 amount 形状被拒`)
    const id = String(created.body.id)

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.deepEqual(row.payload, {
      amount: 10,
      reason: '周末大扫除',
      ruleId: null,
      ruleTitleSnapshot: null,
      habitId: null,
      habitTitleSnapshot: null
    })
    assert.equal(await pointsBalance(), START_BALANCE, '**申请**阶段就加分了 —— 审批变得毫无意义')

    const decided = await send(`/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(decided.status, 200)
    assert.equal(decided.body.status, 'approved')
    assert.equal(await pointsBalance(), START_BALANCE + 10)

    const record = await prisma.pointRecord.findFirstOrThrow({
      where: { childId: ID.child, idempotencyKey: `approval:${id}` }
    })
    assert.equal(record.pointsDelta, 10)
    assert.equal(record.balanceAfter, START_BALANCE + 10)
    assert.equal(record.category, 'adjust')
    assert.equal(record.source, 'approval')
    assert.equal(record.titleSnapshot, '周末大扫除')
    assert.equal(record.operatorUserId, ID.dad)
    assert.equal(record.operatorRole, 'guardian')
    assert.equal(record.habitId, null)

    const after = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal(after.executedRecordId, record.id)
    assert.equal(after.autoReason, null)
  })

  it('两条金额边界：0 / 51 ⇒ 400（DTO 就拦下，不落 pending）', async () => {
    const before = await prisma.approvalRequest.count({ where: { childId: ID.child } })
    for (const amount of [0, 51]) {
      const r = await send('/approvals', {
        body: { action: 'request_points_bonus', amount },
        headers: H.kid
      })
      assert.equal(r.status, 400, `amount=${amount} 拿到 ${r.status}`)
      assert.equal(r.body.statusCode, 400)
    }
    assert.equal(await prisma.approvalRequest.count({ where: { childId: ID.child } }), before)
  })

  it('★ 兑换动作带 amount（不属于它）⇒ 400 `APPROVAL_PARAM_NOT_APPLICABLE`（不静默忽略）', async () => {
    const r = await send('/approvals', {
      body: { action: 'redeem', targetId: ID.wishRedeem, amount: 5 },
      headers: H.kid
    })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'APPROVAL_PARAM_NOT_APPLICABLE')
  })
})


// ══ 组 B：`autoReason` —— RULE_DELETED / HABIT_GONE / MEMBER_REMOVED ═══════════
describe('组 B：autoReason 的三种“前提消失”', () => {
  it('★ 规则在批准前被软删 ⇒ `invalidated: RULE_DELETED`（不写流水）', async () => {
    const created = await send('/approvals', {
      body: { action: 'request_points_bonus', amount: 5, ruleId: ID.rule },
      headers: H.kid
    })
    assert.equal(created.status, 202)
    const id = String(created.body.id)

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal((row.payload as Record<string, unknown>).ruleTitleSnapshot, '阅读 30 分钟')

    await prisma.pointRule.update({
      where: { id: ID.rule },
      data: { status: 'deleted', deletedAt: new Date() }
    })

    const before = await pointsBalance()
    const r = await send(`/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'APPROVAL_INVALIDATED')
    assert.equal(r.body.autoReason, 'RULE_DELETED')

    const after = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal(after.status, 'invalidated')
    assert.equal(after.autoReason, 'RULE_DELETED')
    assert.equal(await pointsBalance(), before)
    assert.equal(await recordCount(id), 0, '前提消失却写了流水')
  })

  it('★ 习惯在批准前被软删 ⇒ `invalidated: HABIT_GONE`（不写流水）', async () => {
    const created = await send('/approvals', {
      body: { action: 'request_points_bonus', amount: 5, habitId: ID.habit },
      headers: H.kid
    })
    assert.equal(created.status, 202)
    const id = String(created.body.id)

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal((row.payload as Record<string, unknown>).habitTitleSnapshot, '整理书桌')

    await prisma.habit.update({
      where: { id: ID.habit },
      data: { status: 'deleted', deletedAt: new Date() }
    })

    const before = await pointsBalance()
    const r = await send(`/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.autoReason, 'HABIT_GONE')
    assert.equal(await pointsBalance(), before)
    assert.equal(await recordCount(id), 0)
  })

  it('★ 申请人在批准前被移出家庭 ⇒ `invalidated: MEMBER_REMOVED`（不再给离开的人发分）', async () => {
    const created = await send('/approvals', {
      body: { action: 'request_points_bonus', amount: 5, reason: '离开前的申请' },
      headers: H.kid
    })
    assert.equal(created.status, 202)
    const id = String(created.body.id)

    await prisma.childMember.update({
      where: { childId_userId: { childId: ID.child, userId: ID.kid } },
      data: { status: 'removed', removedAt: new Date() }
    })
    try {
      const before = await pointsBalance()
      const r = await send(`/approvals/${id}/decide`, {
        body: { decision: 'approved' },
        headers: H.dad
      })
      assert.equal(r.status, 409)
      assert.equal(r.body.autoReason, 'MEMBER_REMOVED')
      assert.equal(await pointsBalance(), before)
      assert.equal(await recordCount(id), 0)
    } finally {
      // 后面的用例仍需要孩子能发请求（屏障一查的是 active 成员位）。
      await prisma.childMember.update({
        where: { childId_userId: { childId: ID.child, userId: ID.kid } },
        data: { status: 'active', removedAt: null }
      })
    }
  })
})


// ══ 组 C：`add_wish` / `request_redeem` 执行器 ═════════════════════════════════
describe('组 C：add_wish 与 request_redeem', () => {
  it('★ `add_wish` 批准 ⇒ 真的创建 `Wish`；`executedRecordId=null`（不产生流水）', async () => {
    const beforeCount = await prisma.wish.count({ where: { childId: ID.child } })
    const beforeBalance = await pointsBalance()

    const created = await send('/approvals', {
      body: { action: 'add_wish', title: '新玩具', cost: 40, emoji: '🧸' },
      headers: H.kid
    })
    assert.equal(created.status, 202, `add_wish 申请拿到 ${created.status}`)
    const id = String(created.body.id)

    const pending = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.deepEqual(pending.payload, { title: '新玩具', cost: 40, emoji: '🧸' })
    assert.equal(await prisma.wish.count({ where: { childId: ID.child } }), beforeCount, '申请阶段就建了心愿')

    const r = await send(`/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'approved')
    assert.equal(r.body.executedRecordId, null)

    assert.equal(await prisma.wish.count({ where: { childId: ID.child } }), beforeCount + 1)
    const wish = await prisma.wish.findFirstOrThrow({
      where: { childId: ID.child, title: '新玩具' }
    })
    assert.equal(wish.cost, 40)
    assert.equal(wish.emoji, '🧸')
    assert.equal(wish.status, 'active')
    assert.equal(await pointsBalance(), beforeBalance, '建心愿不该动积分')
    assert.equal(await recordCount(id), 0)
  })

  it('★ `request_redeem` 与 `redeem` 同一执行路径：批准后扣分 + 心愿已兑换', async () => {
    const created = await send('/approvals', {
      body: { action: 'request_redeem', targetId: ID.wishRedeem },
      headers: H.kid
    })
    assert.equal(created.status, 202)
    const id = String(created.body.id)

    const r = await send(`/approvals/${id}/decide`, {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(r.status, 200)
    assert.equal(await pointsBalance(), START_BALANCE + 10 - 20)

    const record = await prisma.pointRecord.findFirstOrThrow({
      where: { childId: ID.child, idempotencyKey: `approval:${id}` }
    })
    assert.equal(record.pointsDelta, -20)
    assert.equal(record.costSnapshot, 20)
    assert.equal((await prisma.wish.findUniqueOrThrow({ where: { id: ID.wishRedeem } })).redeemed, true)
  })
})

// ══ 组 D：TTL 后台扫描 ════════════════════════════════════════════════════════
describe('组 D：expireDue() 扫描', () => {
  it('★ 到期 pending ⇒ 扫描后 `expired` ＋ 审计一条；再扫一次不重复计数', async () => {
    const created = await send('/approvals', {
      body: { action: 'redeem', targetId: ID.wishExpire },
      headers: H.kid
    })
    assert.equal(created.status, 202)
    const id = String(created.body.id)
    await prisma.approvalRequest.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) }
    })

    const scanner = app.get(ApprovalsExpiryService)
    const first = await scanner.scanOnce(new Date())
    assert.ok(first >= 1, '扫描没有处理任何到期行')

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal(row.status, 'expired')
    assert.equal(
      await prisma.auditLog.count({ where: { targetId: id, action: 'approval.expired' } }),
      1
    )
    assert.equal(await recordCount(id), 0)

    const second = await scanner.scanOnce(new Date())
    assert.equal(second, 0, '同一行被第二次扫描重复计数 —— 条件 UPDATE 没起作用')
  })
})


// ══ 组 E：`Idempotency-Key` 的 HTTP 重放 ══════════════════════════════════════
describe('组 E：Idempotency-Key', () => {
  const withKey = (key: string): Record<string, string> => ({
    ...H.kid,
    'idempotency-key': key
  })

  it('★ 同一键 + 同一请求 ⇒ 第二次返回同一个审批 id，库里只有一条 pending', async () => {
    const body = { action: 'request_points_bonus', amount: 5, reason: '幂等加分' }
    const first = await send('/approvals', { body, headers: withKey(`idem-${RUN}-create`) })
    const second = await send('/approvals', { body, headers: withKey(`idem-${RUN}-create`) })

    assert.equal(first.status, 202)
    assert.equal(second.status, 202)
    assert.equal(second.body.id, first.body.id, '重放新建了第二条审批')

    const id = String(first.body.id)
    assert.equal(await prisma.approvalRequest.count({ where: { id } }), 1)
    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { childId_key: { childId: ID.child, key: `idem-${RUN}-create` } }
    })
    assert.equal(record.responseStatus, 202)
    assert.equal(record.userId, ID.kid)
    assert.equal(record.actionType, 'request_points_bonus')
  })

  it('★ 同一键 + 同一 decide ⇒ 第二次仍 200，流水只写一笔', async () => {
    // 上一条留下的 pending：用它来批。
    const pending = await prisma.approvalRequest.findFirstOrThrow({
      where: {
        childId: ID.child,
        requesterUserId: ID.kid,
        status: 'pending',
        actionType: 'request_points_bonus'
      },
      orderBy: { createdAt: 'desc' }
    })

    const body = { decision: 'approved' }
    const first = await send(`/approvals/${pending.id}/decide`, {
      body,
      headers: { ...H.dad, 'idempotency-key': `idem-${RUN}-decide` }
    })
    const second = await send(`/approvals/${pending.id}/decide`, {
      body,
      headers: { ...H.dad, 'idempotency-key': `idem-${RUN}-decide` }
    })

    assert.equal(first.status, 200)
    assert.equal(second.status, 200, '网络重试拿到 409 —— 客户端会以为批准失败')
    assert.equal(second.body.status, 'approved')
    assert.equal(await recordCount(pending.id), 1, '重放批准写了第二笔流水')
    assert.equal(await pointsBalance(), START_BALANCE + 10 - 20 + 5)

    const record = await prisma.idempotencyRecord.findUniqueOrThrow({
      where: { childId_key: { childId: ID.child, key: `idem-${RUN}-decide` } }
    })
    assert.equal(record.responseStatus, 200)
    assert.ok(record.recordId !== null, '幂等记录没有记下本次执行产出的流水')
  })

  it('★ 同一个键用于**不同请求** ⇒ 409 `IDEMPOTENCY_KEY_REUSED`', async () => {
    const key = `idem-${RUN}-reuse`
    const first = await send('/approvals', {
      body: { action: 'redeem', targetId: ID.wishExpire },
      headers: withKey(key)
    })
    assert.equal(first.status, 202)

    const second = await send('/approvals', {
      body: { action: 'request_points_bonus', amount: 5 },
      headers: withKey(key)
    })
    assert.equal(second.status, 409)
    assert.equal(second.body.code, 'IDEMPOTENCY_KEY_REUSED')
  })
})

// ══ 组 F：整条链仍然可对账 ═══════════════════════════════════════════════════
describe('组 F：I2', () => {
  it('★ `Σ流水 == Child.pointsBalance`，且链上没有断裂', async () => {
    const rows = await ledger.readChain(ID.child)
    assert.deepEqual(verifyBalanceChain(rows), [], 'W3-C 的写入把 I2 弄断了')
    assert.equal(rows.length, 4, '应有 4 笔：初始 100、加分 +10、兑换 -20、幂等加分 +5')
    assert.equal(await pointsBalance(), START_BALANCE + 10 - 20 + 5)
  })
})

after(async () => {
  // 与 approvals-execution-db 同一取舍：账本 DELETE 被 REVOKE（I5），本文件不清理。
  if (app !== undefined) await app.close()
  if (prisma !== undefined) await prisma.$disconnect()
})

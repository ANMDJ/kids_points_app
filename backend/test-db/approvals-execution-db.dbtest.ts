/**
 * approvals-execution-db.dbtest.ts —— 审批 → 账本/余额/审计 **同一事务**的真库证据（W3-A）
 *
 * ── 为什么单独一个文件（而不是塞进 approvals-db.dbtest.ts）──────────────────
 *   这里被测的行为**就是写 `PointRecord`**；而账本表 `DELETE` 被 REVOKE（I5）
 *   ＋ `Child` 上的外键是 `onDelete: Restrict` ⇒ 夹具**删不掉**。
 *   `approvals-db.dbtest.ts` 承诺的是“业务行清干净、账本零记录”，两者不能住在同一个
 *   文件里假装干净。本文件与 `ledger-db.dbtest.ts` 采用同一取舍：**永久留下实验数据**，
 *   靠每次运行的全新 id 保证“链从 0 开始”。
 *
 * ── 它回答的四个问题（离线用例答不了）──────────────────────────────────────
 *   ① 批准兑换后：`ApprovalRequest.approved` ＋ `PointRecord` ＋ `Child.pointsBalance`
 *      ＋ `AuditLog` **要么全有、要么全无**（同一 `$transaction`）；
 *   ② 双击「同意」：只写**一笔**流水、只扣**一次**分（`idempotencyKey = approval:<id>`
 *      ＋ `FOR UPDATE` ＋ `WHERE status='pending'`）；
 *   ③ 余额不足 / 心愿被删：请求落成 `invalidated`（带 `autoReason`），
 *      **不产生任何流水**（负余额在库里不应该存在）；
 *   ④ 自批与“他人批准”走**同一条执行路径**，但审计动作不同（`approval.self_approved`）。
 *
 * 入口：`npm run test:db`；只许对着开发/实验库跑（脚本硬拒绝 `NODE_ENV=production`）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AppModule } from '../src/app.module'
import { applyGlobalPipes } from '../src/app.setup'
import { APPROVALS_REPOSITORY } from '../src/approvals/approvals.repository'
import { PrismaApprovalsRepository } from '../src/approvals/approvals.prisma.repository'
import { buildRecordDraft, verifyBalanceChain } from '../src/ledger/ledger.gate'
import { PrismaLedgerRepository } from '../src/ledger/ledger.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行唯一前缀 —— 账本行删不掉，所以每轮必须是**全新的孩子**。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-exec-dad`,
  kid: `dbtest-${RUN}-exec-kid`,
  child: `dbtest-${RUN}-exec-child`,
  devDad: `dbtest-${RUN}-exec-dev-dad`,
  devKid: `dbtest-${RUN}-exec-dev-kid`,
  devDad2: `dbtest-${RUN}-exec-dev-dad-2`,
  wishMain: `dbtest-${RUN}-exec-wish-main`,
  wishInsuff: `dbtest-${RUN}-exec-wish-insuff`,
  wishDel: `dbtest-${RUN}-exec-wish-del`,
  wishSelf: `dbtest-${RUN}-exec-wish-self`,
  wishExpire: `dbtest-${RUN}-exec-wish-expire`,
  wishReject: `dbtest-${RUN}-exec-wish-reject`,
  wishRace: `dbtest-${RUN}-exec-wish-race`
} as const

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.child },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.child },
  // 第二台家长设备：并发双批准用（同一用户、不同设备 ⇒ 仍是一个 guardian）。
  dad2: { 'x-kp-device-id': ID.devDad2, 'x-kp-child-id': ID.child }
} as const

/** 起始余额：走**真账本**写进去，而不是直接改 `Child.pointsBalance`。 */
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
  await prisma.child.create({ data: { id: ID.child, name: `审批执行套件 ${RUN}` } })
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: 'DB 执行套件家长' },
      { id: ID.kid, displayName: 'DB 执行套件孩子' }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.child, userId: ID.dad, role: 'guardian' },
      { childId: ID.child, userId: ID.kid, role: 'child' }
    ]
  })
  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.child, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.child, userId: ID.kid, activeRole: 'child', expiresAt: future },
      { deviceId: ID.devDad2, childId: ID.child, userId: ID.dad, activeRole: 'guardian', expiresAt: future }
    ]
  })
  await prisma.wish.createMany({
    data: [
      { id: ID.wishMain, childId: ID.child, title: '乐高积木', cost: 30, emoji: '🧱' },
      { id: ID.wishInsuff, childId: ID.child, title: '遥控车', cost: 200, emoji: '🚗' },
      { id: ID.wishDel, childId: ID.child, title: '贴纸', cost: 20, emoji: '✨' },
      { id: ID.wishSelf, childId: ID.child, title: '画笔', cost: 25, emoji: '🎨' },
      { id: ID.wishExpire, childId: ID.child, title: '漫画书', cost: 15, emoji: '📚' },
      { id: ID.wishReject, childId: ID.child, title: '拼图', cost: 10, emoji: '🧩' },
      { id: ID.wishRace, childId: ID.child, title: '风筝', cost: 20, emoji: '🪁' }
    ]
  })

  // 起始 100 分走真账本（`adjust` / `guardian`）—— 否则“余额 == Σ流水”这个前提
  // 从一开始就是假的，本文件想证明的 I2 也就没有意义了。
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

  assert.equal(await prisma.child.count({ where: { id: ID.child } }), 1)
  assert.equal(await prisma.wish.count({ where: { childId: ID.child } }), 7)
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

// ══ 组 A：批准兑换 —— 四件事必须在**同一个事务**里发生 ═══════════════════════════
describe('组 A：批准兑换（他人批准）', () => {
  let mainApprovalId = ''

  it('装配：审批端口真的是 `PrismaApprovalsRepository`（否则下面全是在跟替身说话）', () => {
    assert.ok(
      app.get<object>(APPROVALS_REPOSITORY) instanceof PrismaApprovalsRepository,
      '审批端口不是 Prisma 适配器 —— 本文件每一条“扣了分”的断言都会变成假绿'
    )
  })

  it('★ 孩子申请 → 家长批准 ⇒ `approved` ＋ 流水 ＋ 余额 70 ＋ 审计（四者同一事务）', async () => {
    const created = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishMain }, headers: H.kid })
    assert.equal(created.status, 202)
    mainApprovalId = String(created.body.id)

    const r = await send(`/approvals/${mainApprovalId}/decide`, {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(r.status, 200, `批准拿到 ${r.status}：若是 409，先看库里的余额是不是已不够（起始应为 100）`)
    assert.equal(r.body.status, 'approved')
    assert.equal(r.body.decidedByUserId, ID.dad)
    assert.equal(r.body.selfApproved, false, '家长批孩子的请求不该被标成自批')
    assert.equal(r.body.auditAction, null, '他人批准不是 self_approved —— 审计动作在库里区分')

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: mainApprovalId } })
    assert.equal(row.status, 'approved')
    assert.ok(row.decidedAt !== null, '批准了却没有 decidedAt —— 之后无法回答“什么时候批的”')
    assert.equal(row.autoReason, null)

    // 幂等键是“这条审批只可能有一笔流水”的硬保证。
    const record = await prisma.pointRecord.findFirstOrThrow({
      where: { childId: ID.child, idempotencyKey: `approval:${mainApprovalId}` }
    })
    assert.equal(record.pointsDelta, -30, '扣的不是申请时的快照价（30）—— 改价后孩子会被多扣/少扣')
    assert.equal(record.balanceAfter, START_BALANCE - 30)
    assert.equal(record.category, 'exchange')
    assert.equal(record.source, 'approval')
    assert.equal(record.wishId, ID.wishMain)
    assert.equal(record.costSnapshot, 30)
    assert.equal(record.operatorUserId, ID.dad, '流水里的操作人不是批准人 —— 修 A4 要求可追溯')
    assert.equal(record.operatorRole, 'guardian')
    assert.equal(row.executedRecordId, record.id, '审批行没指向它生成的流水 —— 两边对不上账')

    const child = await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })
    assert.equal(child.pointsBalance, START_BALANCE - 30, '余额没扣 —— 流水与余额分成两个事务了')

    const wish = await prisma.wish.findUniqueOrThrow({ where: { id: ID.wishMain } })
    assert.equal(wish.redeemed, true, '扣了分但心愿还能再兑换 —— 同一事务没写完')
    assert.ok(wish.redeemedAt !== null)

    assert.equal(
      await prisma.auditLog.count({ where: { targetId: mainApprovalId, action: 'approval.approved' } }),
      1,
      '批准没有留审计 —— “谁批的”只存在于内存里'
    )
  })

  it('★ 双击「同意」⇒ 409 `ALREADY_DECIDED`，流水仍只有 1 笔、余额只扣 1 次', async () => {
    const r = await send(`/approvals/${mainApprovalId}/decide`, {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'ALREADY_DECIDED')

    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.child, idempotencyKey: `approval:${mainApprovalId}` } }),
      1,
      '同一审批产生了第二笔流水 —— 双击“同意”会把孩子的分扣两次（02 §4.4 / §9.10）'
    )
    assert.equal(
      (await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance,
      START_BALANCE - 30
    )
  })

  it('★ 余额不足 ⇒ `invalidated: INSUFFICIENT_POINTS`，**不写流水、不扣分**', async () => {
    const created = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishInsuff }, headers: H.kid })
    assert.equal(created.status, 202)
    const id = String(created.body.id)

    const r = await send(`/approvals/${id}/decide`, { body: { decision: 'approved' }, headers: H.dad })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'APPROVAL_INVALIDATED')
    assert.equal(r.body.autoReason, 'INSUFFICIENT_POINTS')

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal(row.status, 'invalidated')
    assert.equal(row.autoReason, 'INSUFFICIENT_POINTS')
    assert.equal(row.executedRecordId, null)

    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.child, idempotencyKey: `approval:${id}` } }),
      0,
      '余额不足却写了流水 —— 账本会出现负余额'
    )
    assert.equal((await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance, START_BALANCE - 30)
    assert.equal((await prisma.wish.findUniqueOrThrow({ where: { id: ID.wishInsuff } })).redeemed, false)
  })

  it('★ 心愿在批准前被删 ⇒ `invalidated: WISH_DELETED`（审查批准那一刻的前提）', async () => {
    const created = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishDel }, headers: H.kid })
    assert.equal(created.status, 202)
    const id = String(created.body.id)

    await prisma.wish.update({ where: { id: ID.wishDel }, data: { status: 'deleted', deletedAt: new Date() } })

    const r = await send(`/approvals/${id}/decide`, { body: { decision: 'approved' }, headers: H.dad })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'APPROVAL_INVALIDATED')
    assert.equal(r.body.autoReason, 'WISH_DELETED')
    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.child, idempotencyKey: `approval:${id}` } }),
      0
    )
    assert.equal((await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance, START_BALANCE - 30)
  })
})

// ══ 组 B：自批 / 拒绝 / 过期 / 并发 ═════════════════════════════════════════════
describe('组 B：自批与其它终态', () => {
  it('★ 显式自批（guardian `autoApprove:true`）⇒ 201 ＋ 同一执行路径，但审计动作是 `approval.self_approved`', async () => {
    const r = await send('/approvals', {
      body: { action: 'redeem', targetId: ID.wishSelf, autoApprove: true },
      headers: H.dad
    })
    assert.equal(r.status, 201, `自批拿到 ${r.status}：若是 202，说明 autoApprove 没被当成显式勾选`)
    assert.equal(r.body.status, 'approved')
    assert.equal(r.body.selfApproved, true, '批准人 == 申请人却没被标成自批 —— 审计无法区分（硬约束 6）')
    assert.equal(r.body.auditAction, 'approval.self_approved')

    const id = String(r.body.id)
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal(row.requesterUserId, ID.dad)
    assert.equal(row.decidedByUserId, ID.dad)
    assert.equal(row.status, 'approved')
    assert.ok(row.executedRecordId !== null, '自批没有记下执行的流水 id')

    const record = await prisma.pointRecord.findFirstOrThrow({
      where: { childId: ID.child, idempotencyKey: `approval:${id}` }
    })
    assert.equal(record.pointsDelta, -25, '自批的扣分口径必须与“他人批准”一致（快照价）')
    assert.equal(record.operatorUserId, ID.dad)
    assert.equal(row.executedRecordId, record.id)

    assert.equal(
      (await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance,
      START_BALANCE - 30 - 25,
      '自批没扣分 —— 自批与审批必须是同一条执行路径（硬约束 5）'
    )
    assert.equal((await prisma.wish.findUniqueOrThrow({ where: { id: ID.wishSelf } })).redeemed, true)

    assert.equal(
      await prisma.auditLog.count({ where: { targetId: id, action: 'approval.self_approved' } }),
      1,
      '自批没有写成 approval.self_approved —— 审计里它和“家长批孩子”就分不开了'
    )
    assert.equal(
      await prisma.auditLog.count({ where: { targetId: id, action: 'approval.approved' } }),
      0,
      '同一件事被记了两种审计动作 —— 统计会重复计数'
    )
  })

  it('拒绝 ⇒ 200 `rejected`：心愿不置为已兑换、余额不变、无流水', async () => {
    const created = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishReject }, headers: H.kid })
    assert.equal(created.status, 202)
    const id = String(created.body.id)
    const before = (await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance

    const r = await send(`/approvals/${id}/decide`, { body: { decision: 'rejected' }, headers: H.dad })
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'rejected')
    assert.equal(r.body.selfApproved, false)

    assert.equal((await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance, before)
    assert.equal((await prisma.wish.findUniqueOrThrow({ where: { id: ID.wishReject } })).redeemed, false)
    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.child, idempotencyKey: `approval:${id}` } }),
      0
    )
  })

  it('★ TTL 到期 ⇒ 409 `APPROVAL_EXPIRED`，库里留 `expired`，且**不执行**', async () => {
    const created = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishExpire }, headers: H.kid })
    assert.equal(created.status, 202)
    const id = String(created.body.id)
    const before = (await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance

    await prisma.approvalRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } })

    const r = await send(`/approvals/${id}/decide`, { body: { decision: 'approved' }, headers: H.dad })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'APPROVAL_EXPIRED')

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal(row.status, 'expired', '409 之后行仍是 pending —— 惰性过期的历史被回滚了')
    assert.equal(row.decidedByUserId, null, '过期不是“人做出的决定”，不该记批准人')
    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.child, idempotencyKey: `approval:${id}` } }),
      0
    )
    assert.equal((await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance, before)
    assert.equal(
      await prisma.auditLog.count({ where: { targetId: id, action: 'approval.expired' } }),
      1
    )
  })

  it('★ 两台家长设备**同时**批准同一条 ⇒ 恰好一个 200、一个 409，只扣一次分', async () => {
    const created = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishRace }, headers: H.kid })
    assert.equal(created.status, 202)
    const id = String(created.body.id)
    const before = (await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance

    const [a, b] = await Promise.all([
      send(`/approvals/${id}/decide`, { body: { decision: 'approved' }, headers: H.dad }),
      send(`/approvals/${id}/decide`, { body: { decision: 'approved' }, headers: H.dad2 })
    ])
    const statuses = [a.status, b.status].sort((x, y) => x - y)
    assert.deepEqual(
      statuses,
      [200, 409],
      `并发批准得到 ${statuses.join('/')}：若两个 200，说明行锁/乐观锁没生效；若两个 409，说明赢家也被挡了`
    )
    const loser = a.status === 409 ? a : b
    assert.equal(loser.body.code, 'ALREADY_DECIDED')

    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.child, idempotencyKey: `approval:${id}` } }),
      1,
      '并发批准写了两笔流水 —— 孩子被扣了两次（幂等键/行锁失效）'
    )
    assert.equal(
      (await prisma.child.findUniqueOrThrow({ where: { id: ID.child } })).pointsBalance,
      before - 20
    )
    assert.equal(
      await prisma.auditLog.count({ where: { targetId: id, action: 'approval.approved' } }),
      1,
      '并发下审计写了两条 —— 同一条审批只能有一次“批准”'
    )
  })
})

// ══ 组 C：账本自洽 —— 所有执行路径合起来仍然是一条可对账的链 ═══════════════════
describe('组 C：跑完这一圈之后，账本仍然自洽（I2）', () => {
  it('★ `Σ流水 == Child.pointsBalance`，且链上没有断裂', async () => {
    const rows = await ledger.readChain(ID.child)
    assert.deepEqual(verifyBalanceChain(rows), [], 'I2 断了 —— 审批写入了无法对账的余额')
    assert.equal(rows.length, 4, '应当有 4 笔：初始 100、批准 -30、自批 -25、并发批准 -20')

    const balance = await ledger.readBalance(ID.child)
    assert.equal(balance, START_BALANCE - 30 - 25 - 20)
    assert.equal(rows[rows.length - 1].balanceAfter, balance, '链尾 balanceAfter 与余额不一致（B6 那种“账不平”）')
  })
})

after(async () => {
  // ★ 本文件**故意不清理**：PointRecord 的 DELETE 被 REVOKE（I5）、Child 外键 Restrict。
  //   每次运行用新的 `RUN` 前缀，因此残留不会影响下一次的“链从 0 开始”。
  if (app !== undefined) await app.close()
  if (prisma !== undefined) await prisma.$disconnect()
})

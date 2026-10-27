/**
 * deletion-db.dbtest.ts —— 家庭数据删除 **真库 × 真 HTTP × 真 worker** 套件
 * （W7-D，2026-10-27）
 *
 * ── 它与另外三份用例的分工 ─────────────────────────────────────────────────
 *   · `test/deletion-policy.test.ts` —— 纯规则（7 天、向上取整、摘要形状、redact）；
 *   · `test/deletion-http.test.ts` —— 真 HTTP，但端口是替身（屏障 / 二次确认 / 501）；
 *   · `test/deletion-wiring.test.ts` —— 装配与守卫元数据（无 ConsentGuard）；
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `FamilyDeletionWorker.tick()`：
 *       申请 → 撤销 → 再申请 → 到期执行，然后逐表断言**哪些字被抹掉、哪些数没动**。
 *
 * ── 四条只有真库能回答的问题 ────────────────────────────────────────────────
 *   ① 执行真的把**这个孩子**的九类数据改名了吗？别人的孩子有没有被误伤？
 *   ② 账本的不变量还在吗：`pointsDelta` / `balanceAfter` / `balance` 一字未动，
 *      而 `titleSnapshot` 已经抹掉？（同时验证 900 脚本的**列级**授权：
 *      文本列可写、语义列仍被 REVOKE）
 *   ③ 幂等与部分唯一索引：重复申请后 pending 行数仍为 1；
 *   ④ 撤回同意的家庭能不能删？—— 本套件的同意行**故意是 withdrawn**：
 *      删除三条路由都不经 `ConsentGuard`（04 §5），所以整条链必须走得通。
 *
 * ── ★ 数据不清理 ────────────────────────────────────────────────────────────
 *   账本行 DELETE 被 REVOKE（I5），且 `FamilyDeletionRequest` 是删除证据；
 *   每次运行用全新 `dbtest-<run>` 前缀，因此「从零开始」成立，也不会误删别人的行。
 *
 * 入口：`npm run test:db`（缺 `DATABASE_URL` 直接红；`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AppModule } from '../src/app.module'
import { applyGlobalPipes } from '../src/app.setup'
import { FamilyDeletionWorker } from '../src/deletion/deletion.worker'
import { PrismaService } from '../src/prisma/prisma.service'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-del-dad`,
  mom: `dbtest-${RUN}-del-mom`,
  kid: `dbtest-${RUN}-del-kid`,
  main: `dbtest-${RUN}-del-main`,
  other: `dbtest-${RUN}-del-other`,
  devDad: `dbtest-${RUN}-del-dev-dad`,
  devMom: `dbtest-${RUN}-del-dev-mom`,
  devKid: `dbtest-${RUN}-del-dev-kid`,
  rule: `dbtest-${RUN}-del-rule`,
  habit: `dbtest-${RUN}-del-habit`,
  wish: `dbtest-${RUN}-del-wish`,
  record: `dbtest-${RUN}-del-rec`,
  approval: `dbtest-${RUN}-del-approval`,
  notification: `dbtest-${RUN}-del-notification`,
  consent: `dbtest-${RUN}-del-consent`,
  otherRule: `dbtest-${RUN}-del-other-rule`,
  otherRecord: `dbtest-${RUN}-del-other-rec`
} as const

const SECRET = {
  dadPin: `dbtest-${RUN}-del-pinhash-dad`,
  momPin: `dbtest-${RUN}-del-pinhash-mom`,
  ipHash: `dbtest-${RUN}-del-iphash`,
  userAgentHash: `dbtest-${RUN}-del-uahash`
} as const

const REDACTED = '[已删除]'

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.main },
  mom: { 'x-kp-device-id': ID.devMom, 'x-kp-child-id': ID.main },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.main }
} as const

let prisma: PrismaService
let app: INestApplication
let url = ''

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
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
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: `删除套件 爸爸 ${RUN}` },
      { id: ID.mom, displayName: `删除套件 妈妈 ${RUN}` },
      { id: ID.kid, displayName: `删除套件 孩子 ${RUN}` }
    ]
  })

  await prisma.child.createMany({
    data: [
      {
        id: ID.main,
        name: `删除套件主孩子 ${RUN}`,
        pointsBalance: 5,
        ageBand: 'primary_low',
        focusAreas: ['study'],
        onboardedAt: new Date('2026-10-01T00:00:00.000Z')
      },
      { id: ID.other, name: `删除套件另一个孩子 ${RUN}`, pointsBalance: 9 }
    ]
  })

  await prisma.childMember.createMany({
    data: [
      { childId: ID.main, userId: ID.dad, role: 'guardian', pinHash: SECRET.dadPin },
      { childId: ID.main, userId: ID.mom, role: 'guardian', pinHash: SECRET.momPin },
      { childId: ID.main, userId: ID.kid, role: 'child' },
      { childId: ID.other, userId: ID.dad, role: 'guardian' }
    ]
  })

  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.main, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devMom, childId: ID.main, userId: ID.mom, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.main, userId: ID.kid, activeRole: 'child', expiresAt: future }
    ]
  })

  // ★ 故意撤回同意：删除权不依赖「同意生效中」（04 §5 / 02 §9.20）。
  await prisma.guardianConsent.create({
    data: {
      id: ID.consent,
      childId: ID.main,
      grantedByUserId: ID.dad,
      consentVersion: '2026-10-draft',
      status: 'withdrawn',
      grantedAt: new Date('2026-10-01T00:00:00.000Z'),
      withdrawnAt: new Date('2026-10-05T00:00:00.000Z'),
      ipHash: SECRET.ipHash,
      userAgentHash: SECRET.userAgentHash
    }
  })

  await prisma.pointRule.createMany({
    data: [
      {
        id: ID.rule,
        childId: ID.main,
        title: '完成作业',
        condition: '当天作业全部完成',
        dailyLimit: 2,
        points: 3,
        direction: 'reward',
        icon: 'book',
        color: '#81C784',
        currentVersion: 1
      },
      {
        id: ID.otherRule,
        childId: ID.other,
        title: '别人家的规则',
        condition: '不应被抹掉',
        dailyLimit: 1,
        points: 7,
        direction: 'reward',
        icon: 'star',
        color: '#000000'
      }
    ]
  })

  await prisma.pointRuleVersion.create({
    data: {
      ruleId: ID.rule,
      version: 1,
      title: '完成作业',
      condition: '当天作业全部完成',
      dailyLimit: 2,
      points: 3,
      direction: 'reward',
      changedByUserId: ID.dad,
      changeNote: '初始版本'
    }
  })

  await prisma.habit.create({
    data: {
      id: ID.habit,
      childId: ID.main,
      sourceRuleId: ID.rule,
      title: '番茄钟写作业',
      points: 1,
      condition: '专注 25 分钟',
      dailyLimit: 2,
      icon: 'timer',
      color: '#FFB74D'
    }
  })

  await prisma.wish.create({
    data: {
      id: ID.wish,
      childId: ID.main,
      title: '看一场电影',
      cost: 50,
      emoji: '🎬',
      coverStyle: 'B'
    }
  })

  await prisma.pointRecord.createMany({
    data: [
      {
        id: ID.record,
        childId: ID.main,
        ruleId: ID.rule,
        ruleVersion: 1,
        habitId: ID.habit,
        titleSnapshot: '完成作业',
        conditionSnapshot: '当天作业全部完成',
        dailyLimitSnapshot: 2,
        pointsDelta: 5,
        category: 'praise',
        source: 'guardian',
        note: '主动完成，值得表扬',
        operatorUserId: ID.dad,
        operatorRole: 'guardian',
        balanceAfter: 5
      },
      {
        id: ID.otherRecord,
        childId: ID.other,
        titleSnapshot: '别人家的流水',
        pointsDelta: 7,
        category: 'praise',
        source: 'guardian',
        balanceAfter: 7
      }
    ]
  })

  await prisma.approvalRequest.create({
    data: {
      id: ID.approval,
      childId: ID.main,
      requesterUserId: ID.kid,
      requesterRole: 'child',
      actionType: 'redeem',
      // 描述性文本 + 数值快照：执行后只抹前者（后者是账本对账依据）。
      payload: { wishId: ID.wish, costSnapshot: 50, note: '想看电影' },
      status: 'approved',
      decidedByUserId: ID.dad,
      decidedAt: new Date('2026-10-21T00:30:00.000Z'),
      decisionNote: '同意，周末去',
      expiresAt: new Date('2026-10-24T01:00:00.000Z'),
      createdAt: new Date('2026-10-21T00:00:00.000Z')
    }
  })

  await prisma.notification.create({
    data: {
      id: ID.notification,
      childId: ID.main,
      recipientUserId: ID.kid,
      recipientRole: 'child',
      type: 'approval.approved',
      title: '审批通过：看一场电影',
      body: '爸爸同意了你的兑换申请'
    }
  })
}

/** 一条 pending 请求的 id（由 HTTP 申请后查库取得）。 */
async function pendingRequestId(): Promise<string> {
  const rows = await prisma.familyDeletionRequest.findMany({
    where: { childId: ID.main, status: 'pending' },
    select: { id: true }
  })
  assert.equal(rows.length, 1, `pending 请求数应为 1，实际 ${rows.length}`)
  return rows[0]!.id
}

/** 与 `scripts/verify-db.mjs` 同一判据（Prisma 的 meta.code 也可能是 42501）。 */
function isPermissionDenied(error: unknown): boolean {
  const detail = error as { code?: unknown; meta?: { code?: unknown } } | null
  const text = `${String(detail?.code ?? '')} ${String(detail?.meta?.code ?? '')} ${String(error)}`
  return text.includes('42501') || text.includes('permission denied') || text.includes('权限不够')
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()

  // ★ 不传 `hasDatabase`：本文件要验的正是生产那条路（由 DATABASE_URL 推断）。
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

// ══ 组 A：申请 → 幂等 → 撤销 → 再申请 ═══════════════════════════════════════
describe('组 A：申请 / 幂等 / 撤销（真库 + 真 HTTP；同意已撤回也能走）', () => {
  it('初始状态 = none', async () => {
    const res = await call('/family-deletion', { headers: H.dad })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'none')
    assert.equal(res.body.canCancel, false)
    assert.equal(res.body.requestedAt, null)
  })

  it('二次确认是强制：confirmed=false ⇒ 400，且库里没有请求行', async () => {
    const res = await call('/family-deletion', {
      method: 'POST',
      body: { confirmed: false },
      headers: H.dad
    })
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'FAMILY_DELETION_NOT_CONFIRMED')
    assert.equal(await prisma.familyDeletionRequest.count({ where: { childId: ID.main } }), 0)
  })

  it('孩子本人 ⇒ 403 FORBIDDEN（矩阵 child = DENY）', async () => {
    const res = await call('/family-deletion', { headers: H.kid })
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
  })

  it('guardian 申请 ⇒ 200 pending，scheduledFor = 7 天后，并写一条 requested 审计', async () => {
    const res = await call('/family-deletion', {
      method: 'POST',
      body: { confirmed: true },
      headers: H.dad
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'pending')
    assert.equal(res.body.daysRemaining, 7)
    assert.equal(res.body.canCancel, true)

    const scheduledFor = new Date(String(res.body.scheduledFor))
    const requestedAt = new Date(String(res.body.requestedAt))
    assert.equal(scheduledFor.getTime() - requestedAt.getTime(), 7 * 24 * 60 * 60 * 1000)

    const audits = await prisma.auditLog.count({
      where: { childId: ID.main, action: 'family.deletion_requested' }
    })
    assert.equal(audits, 1)
  })

  it('★ 重复申请是幂等的：仍是同一条请求、仍只有 1 行 pending、审计不重复', async () => {
    const first = await call('/family-deletion', { headers: H.dad })
    const again = await call('/family-deletion', {
      method: 'POST',
      body: { confirmed: true },
      headers: H.mom
    })
    assert.equal(again.status, 200)
    assert.equal(again.body.requestedAt, first.body.requestedAt, '重复申请换了一条请求')

    assert.equal(
      await prisma.familyDeletionRequest.count({ where: { childId: ID.main, status: 'pending' } }),
      1
    )
    assert.equal(
      await prisma.auditLog.count({ where: { childId: ID.main, action: 'family.deletion_requested' } }),
      1
    )
  })

  it('撤销 ⇒ 200 cancelled；再次撤销 ⇒ 409 FAMILY_DELETION_NOT_PENDING', async () => {
    const res = await call('/family-deletion/cancel', { method: 'POST', headers: H.dad })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'cancelled')
    assert.equal(res.body.canCancel, false)

    const again = await call('/family-deletion/cancel', { method: 'POST', headers: H.dad })
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'FAMILY_DELETION_NOT_PENDING')

    assert.equal(
      await prisma.auditLog.count({ where: { childId: ID.main, action: 'family.deletion_cancelled' } }),
      1
    )
  })

  it('撤销后可以重新申请（旧行保留为 cancelled 的历史）', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const res = await call('/family-deletion', {
      method: 'POST',
      body: { confirmed: true },
      headers: H.dad
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'pending')
    assert.equal(
      await prisma.familyDeletionRequest.count({ where: { childId: ID.main, status: 'cancelled' } }),
      1
    )
    await pendingRequestId()
  })
})

// ══ 组 B：冷却期到期 → worker 执行 → 逐表断言 ═══════════════════════════════
describe('组 B：到期执行 —— 描述性文本被抹、账本数值一字未动、别人的孩子不受影响', () => {
  let summary: Record<string, unknown>

  before(async () => {
    // 把冷却期提前到「刚刚过期」：真实等待 7 天不可行，但状态机的判据就是这一列。
    await prisma.familyDeletionRequest.updateMany({
      where: { childId: ID.main, status: 'pending' },
      data: { scheduledFor: new Date(Date.now() - 1_000) }
    })

    const worker = app.get(FamilyDeletionWorker)
    const executed = await worker.tick(new Date())
    assert.equal(executed.length, 1, `应执行 1 条，实际 ${executed.length}`)
    assert.equal(executed[0]?.childId, ID.main)
    summary = executed[0]?.summary as unknown as Record<string, unknown>
  })

  it('孩子：昵称抹掉、年龄段 / 兴趣清空、status=deleted，余额保留', async () => {
    const child = await prisma.child.findUniqueOrThrow({ where: { id: ID.main } })
    assert.equal(child.name, REDACTED)
    assert.equal(child.ageBand, null)
    assert.deepEqual(child.focusAreas, [])
    assert.equal(child.status, 'deleted')
    assert.notEqual(child.deletedAt, null)
    assert.equal(child.pointsBalance, 5)
  })

  it('★ 账本：titleSnapshot / conditionSnapshot / note 抹掉，pointsDelta / balanceAfter 不动', async () => {
    const record = await prisma.pointRecord.findUniqueOrThrow({ where: { id: ID.record } })
    assert.equal(record.titleSnapshot, REDACTED)
    assert.equal(record.conditionSnapshot, REDACTED)
    assert.equal(record.note, '')
    assert.equal(record.pointsDelta, 5)
    assert.equal(record.balanceAfter, 5)
  })

  it('规则 / 版本 / 习惯 / 心愿：标题与条件抹掉；版本分数与版本号不动', async () => {
    const rule = await prisma.pointRule.findUniqueOrThrow({ where: { id: ID.rule } })
    assert.equal(rule.title, REDACTED)
    assert.equal(rule.condition, REDACTED)
    assert.equal(rule.points, 3)

    const version = await prisma.pointRuleVersion.findUniqueOrThrow({
      where: { ruleId_version: { ruleId: ID.rule, version: 1 } }
    })
    assert.equal(version.title, REDACTED)
    assert.equal(version.condition, REDACTED)
    assert.equal(version.changeNote, null)
    assert.equal(version.points, 3)

    const habit = await prisma.habit.findUniqueOrThrow({ where: { id: ID.habit } })
    assert.equal(habit.title, REDACTED)
    assert.equal(habit.points, 1)

    const wish = await prisma.wish.findUniqueOrThrow({ where: { id: ID.wish } })
    assert.equal(wish.title, REDACTED)
    assert.equal(wish.cost, 50)
  })

  it('审批：payload 只抹文本（id / 金额保留），decisionNote 置空', async () => {
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: ID.approval } })
    assert.deepEqual(approval.payload, { wishId: ID.wish, costSnapshot: 50, note: REDACTED })
    assert.equal(approval.decisionNote, null)
    assert.equal(approval.status, 'approved')
  })

  it('通知：标题抹掉、正文清空（类型 / 收件人保留）', async () => {
    const notification = await prisma.notification.findUniqueOrThrow({
      where: { id: ID.notification }
    })
    assert.equal(notification.title, REDACTED)
    assert.equal(notification.body, '')
    assert.equal(notification.type, 'approval.approved')
  })

  it('同意记录：IP / UA 哈希清空，状态与版本保留（它仍是「曾撤回」的证据）', async () => {
    const consent = await prisma.guardianConsent.findUniqueOrThrow({ where: { id: ID.consent } })
    assert.equal(consent.ipHash, null)
    assert.equal(consent.userAgentHash, null)
    assert.equal(consent.status, 'withdrawn')
    assert.equal(consent.consentVersion, '2026-10-draft')
  })

  it('成员位：PIN 全部清空；除申请人外置 removed；申请人保留 active 以便读收据', async () => {
    const dad = await prisma.childMember.findUniqueOrThrow({
      where: { childId_userId: { childId: ID.main, userId: ID.dad } }
    })
    const mom = await prisma.childMember.findUniqueOrThrow({
      where: { childId_userId: { childId: ID.main, userId: ID.mom } }
    })
    const kid = await prisma.childMember.findUniqueOrThrow({
      where: { childId_userId: { childId: ID.main, userId: ID.kid } }
    })

    assert.equal(dad.pinHash, null)
    assert.equal(dad.status, 'active')
    assert.equal(mom.pinHash, null)
    assert.equal(mom.status, 'removed')
    assert.equal(kid.pinHash, null)
    assert.equal(kid.status, 'removed')
    assert.notEqual(mom.removedAt, null)
  })

  it('★ 别人的孩子一行都没动（租户隔离）', async () => {
    const other = await prisma.child.findUniqueOrThrow({ where: { id: ID.other } })
    assert.equal(other.name, `删除套件另一个孩子 ${RUN}`)
    assert.equal(other.status, 'active')

    const rule = await prisma.pointRule.findUniqueOrThrow({ where: { id: ID.otherRule } })
    assert.equal(rule.title, '别人家的规则')
    const record = await prisma.pointRecord.findUniqueOrThrow({ where: { id: ID.otherRecord } })
    assert.equal(record.titleSnapshot, '别人家的流水')
  })

  it('摘要：九类行数如实、保留条数与余额如实、冷却期 7 天', async () => {
    const redacted = summary.redacted as Record<string, number>
    assert.equal(redacted.child, 1)
    assert.equal(redacted.members, 3)
    assert.equal(redacted.rules, 1)
    assert.equal(redacted.ruleVersions, 1)
    assert.equal(redacted.habits, 1)
    assert.equal(redacted.wishes, 1)
    assert.equal(redacted.records, 1)
    assert.equal(redacted.approvals, 1)
    assert.equal(redacted.consents, 1)
    assert.equal(redacted.notifications, 1)
    assert.deepEqual(summary.kept, { records: 1, pointsBalance: 5 })
    assert.equal(summary.coolingDays, 7)
  })
})

// ══ 组 C：执行后的收据与不可逆；列级授权证明 ═════════════════════════════════
describe('组 C：执行后 —— 收据可读、不可重复、不可撤销；文本列可抹而语义列仍被 REVOKE', () => {
  it('GET /family-deletion ⇒ executed + 摘要（申请人仍是 active 成员，读得到收据）', async () => {
    const res = await call('/family-deletion', { headers: H.dad })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'executed')
    assert.equal(res.body.canCancel, false)
    assert.equal(res.body.daysRemaining, null)
    assert.notEqual(res.body.executedAt, null)
    const summary = res.body.summary as Record<string, unknown>
    assert.deepEqual(summary.kept, { records: 1, pointsBalance: 5 })
  })

  it('worker 再跑一轮 ⇒ 0 条（executed 不再是 pending）', async () => {
    const worker = app.get(FamilyDeletionWorker)
    assert.deepEqual(await worker.tick(new Date()), [])
  })

  it('再申请 / 再撤销 ⇒ 409 FAMILY_DELETION_ALREADY_EXECUTED', async () => {
    const again = await call('/family-deletion', {
      method: 'POST',
      body: { confirmed: true },
      headers: H.dad
    })
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'FAMILY_DELETION_ALREADY_EXECUTED')

    const cancel = await call('/family-deletion/cancel', { method: 'POST', headers: H.dad })
    assert.equal(cancel.status, 409)
    assert.equal(cancel.body.code, 'FAMILY_DELETION_ALREADY_EXECUTED')
  })

  it('同一账号在删除后导不出数据（孩子已 deleted ⇒ 404，不返回空文档）', async () => {
    const res = await call('/export', { headers: H.dad })
    assert.equal(res.status, 404)
  })

  it('审计：requested / cancelled / executed 都在（删除本身可追溯）', async () => {
    const actions = await prisma.auditLog.findMany({
      where: { childId: ID.main },
      select: { action: true }
    })
    const names = actions.map((row) => row.action)
    assert.equal(names.filter((n) => n === 'family.deletion_requested').length, 2)
    assert.equal(names.filter((n) => n === 'family.deletion_cancelled').length, 1)
    assert.equal(names.filter((n) => n === 'family.deletion_executed').length, 1)
  })

  it('★ 列级授权：文本列可写（匿名字段），语义列仍被 REVOKE（I5 未被破坏）', async () => {
    // 允许：这三列在 900 脚本里单独 GRANT UPDATE（匿名化唯一需要的能力）。
    const textOk = await prisma.pointRecord.updateMany({
      where: { id: '__no_such__' },
      data: { note: 'x', titleSnapshot: REDACTED }
    })
    assert.equal(textOk.count, 0)

    // 拒绝：分数不可改 —— 表级 UPDATE 仍被 REVOKE。
    await assert.rejects(
      () =>
        prisma.pointRecord.updateMany({
          where: { id: '__no_such__' },
          data: { pointsDelta: 0 }
        }),
      isPermissionDenied
    )

    await assert.rejects(
      () => prisma.pointRecord.deleteMany({ where: { id: '__no_such__' } }),
      isPermissionDenied
    )
  })
})

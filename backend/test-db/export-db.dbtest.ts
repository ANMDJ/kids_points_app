/**
 * export-db.dbtest.ts —— 家庭数据导出 **真库 × 真 HTTP** 套件（W7-C，2026-10-27）
 *
 * ── 它与另外两份用例的分工（缺哪份都算没验完）────────────────────────────────
 *   · `test/export-http.test.ts` —— 真 HTTP，但导出端口是**替身**：证明三道屏障、
 *       拒绝、响应头、404；证明不了 SQL 在 Postgres 上究竟读出了什么。
 *   · `test/export-wiring.test.ts` —— 证明适配器「把哪些键交给 Prisma」
 *       （一个事务、最小列白名单、`take`、账本正序）；证明不了关系过滤真的生效。
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `fetch`：断言最终文件里
 *       有没有那个孩子的每一段数据、有没有**别人家**的行、有没有**凭据**。
 *
 * ── 夹具刻意制造的四种「会导错」的情形 ──────────────────────────────────────
 *   ① 软删的规则 / 习惯 / 心愿：**必须出现在导出里**（流水引用了它们，
 *      藏起来会让文件里的 `ruleId` 指向不存在的行）；这与 `/home` 的口径**相反**。
 *   ② 第二个孩子也有规则 / 流水 / 审批 / 审计：一条都不许串进第一个孩子的文件。
 *   ③ 监护人已撤回同意：`/export` 仍必须 200（数据可携带权，04 §5），
 *      而同一身份写 `PATCH /child` 必须 403 `CONSENT_REQUIRED` —— 两件事同时成立才算对。
 *   ④ 库里躺着登录凭据与口令材料（`openId` / `pinHash` / `ipHash` / `idempotencyKey`）：
 *      导出文件的**原始文本**里不许出现其中任何一个。
 *
 * ── ★ 数据不清理（与 read / identity / ledger 套件同一纪律）──────────────────
 *   账本行 `DELETE` 被 REVOKE（I5）且外键多为 `Restrict` ⇒ 本套件写下的行删不掉。
 *   每次运行用全新 `dbtest-<run>` 前缀，「从零开始」这个前提成立，也不会误删别人的行。
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
import { EXPORT_REPOSITORY } from '../src/export/export.repository'
import { PrismaExportRepository } from '../src/export/export.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-exp-dad`,
  kid: `dbtest-${RUN}-exp-kid`,
  stranger: `dbtest-${RUN}-exp-stranger`,
  main: `dbtest-${RUN}-exp-main`,
  other: `dbtest-${RUN}-exp-other`,
  gone: `dbtest-${RUN}-exp-gone`,
  devDad: `dbtest-${RUN}-exp-dev-dad`,
  devKid: `dbtest-${RUN}-exp-dev-kid`,
  devStranger: `dbtest-${RUN}-exp-dev-stranger`,
  devGone: `dbtest-${RUN}-exp-dev-gone`,
  rule: `dbtest-${RUN}-exp-rule`,
  deletedRule: `dbtest-${RUN}-exp-rule-deleted`,
  habit: `dbtest-${RUN}-exp-habit`,
  deletedHabit: `dbtest-${RUN}-exp-habit-deleted`,
  wish: `dbtest-${RUN}-exp-wish`,
  deletedWish: `dbtest-${RUN}-exp-wish-deleted`,
  otherRule: `dbtest-${RUN}-exp-rule-other`,
  recPraise: `dbtest-${RUN}-exp-rec-1`,
  recExchange: `dbtest-${RUN}-exp-rec-2`,
  recOther: `dbtest-${RUN}-exp-rec-other`,
  approval: `dbtest-${RUN}-exp-approval`,
  otherApproval: `dbtest-${RUN}-exp-approval-other`,
  audit: `dbtest-${RUN}-exp-audit`,
  otherAudit: `dbtest-${RUN}-exp-audit-other`,
  consent: `dbtest-${RUN}-exp-consent`
} as const

/** 特意写进库、又**绝不允许**出现在导出文本里的凭据材料。 */
const SECRET = {
  openId: `dbtest-${RUN}-openid-SECRET`,
  pinHash: `dbtest-${RUN}-pinhash-SECRET`,
  ipHash: `dbtest-${RUN}-iphash-SECRET`,
  idempotencyKey: `dbtest-${RUN}-idem-SECRET`
} as const

/** 流水时间严格递增 ⇒ 「按 createdAt 正序」有唯一答案。 */
const T = {
  recPraise: new Date('2026-10-20T01:00:00.000Z'),
  recExchange: new Date('2026-10-21T01:00:00.000Z'),
  consentGranted: new Date('2026-10-22T01:00:00.000Z'),
  consentWithdrawn: new Date('2026-10-23T01:00:00.000Z')
}

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.main },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.main },
  stranger: { 'x-kp-device-id': ID.devStranger, 'x-kp-child-id': ID.main },
  gone: { 'x-kp-device-id': ID.devGone, 'x-kp-child-id': ID.gone }
} as const

let prisma: PrismaService
let app: INestApplication
let url = ''

interface HttpResult {
  status: number
  body: Record<string, unknown>
  text: string
  headers: Headers
}

async function call(path: string, init: RequestInit = {}): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, init)
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body, text, headers: res.headers }
}

function get(path: string, headers: Record<string, string>): Promise<HttpResult> {
  return call(path, { headers })
}

async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)

  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: `导出套件 爸爸 ${RUN}`, openId: SECRET.openId },
      { id: ID.kid, displayName: `导出套件 孩子 ${RUN}` },
      { id: ID.stranger, displayName: `导出套件 路人 ${RUN}` }
    ]
  })

  await prisma.child.createMany({
    data: [
      {
        id: ID.main,
        name: `导出套件主孩子 ${RUN}`,
        pointsBalance: 30,
        ageBand: 'primary_low',
        focusAreas: ['study', 'habit'],
        onboardedAt: new Date('2026-10-01T00:00:00.000Z')
      },
      { id: ID.other, name: `导出套件另一个孩子 ${RUN}`, pointsBalance: 999 },
      { id: ID.gone, name: `导出套件已删孩子 ${RUN}`, status: 'deleted', deletedAt: new Date() }
    ]
  })

  await prisma.childMember.createMany({
    data: [
      // ★ 爸爸的成员位带上 pinHash：它绝不能被导出（口令材料）。
      {
        childId: ID.main,
        userId: ID.dad,
        role: 'guardian',
        status: 'active',
        pinHash: SECRET.pinHash,
        joinedAt: new Date('2026-10-01T00:00:00.000Z')
      },
      {
        childId: ID.main,
        userId: ID.kid,
        role: 'child',
        status: 'active',
        joinedAt: new Date('2026-10-02T00:00:00.000Z')
      },
      { childId: ID.other, userId: ID.dad, role: 'guardian', status: 'active' },
      { childId: ID.gone, userId: ID.dad, role: 'guardian', status: 'active' }
      // ID.stranger 刻意没有成员位：屏障二必须给 403（§9.21）。
    ]
  })

  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.main, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.main, userId: ID.kid, activeRole: 'child', expiresAt: future },
      { deviceId: ID.devStranger, childId: ID.main, userId: ID.stranger, activeRole: 'viewer', expiresAt: future },
      { deviceId: ID.devGone, childId: ID.gone, userId: ID.dad, activeRole: 'guardian', expiresAt: future }
    ]
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
        currentVersion: 2,
        createdAt: new Date('2026-09-01T00:00:00.000Z')
      },
      {
        id: ID.deletedRule,
        childId: ID.main,
        title: '已删规则',
        condition: '回收站里的规则',
        dailyLimit: 1,
        points: 99,
        direction: 'reward',
        icon: 'star',
        color: '#000000',
        status: 'deleted',
        deletedAt: new Date('2026-10-10T00:00:00.000Z'),
        createdAt: new Date('2026-09-02T00:00:00.000Z')
      },
      {
        id: ID.otherRule,
        childId: ID.other,
        title: '另一个孩子的规则',
        condition: '不应串门',
        dailyLimit: 1,
        points: 7,
        direction: 'reward',
        icon: 'star',
        color: '#000000'
      }
    ]
  })

  // ★ 版本史：导出必须包含整条变更史（02 §5.6），否则「当时为什么 +3」解释不了。
  await prisma.pointRuleVersion.createMany({
    data: [
      {
        ruleId: ID.rule,
        version: 1,
        title: '完成作业',
        condition: '当天作业全部完成',
        dailyLimit: 1,
        points: 1,
        direction: 'reward',
        changedByUserId: ID.dad,
        changedAt: new Date('2026-09-01T00:00:00.000Z')
      },
      {
        ruleId: ID.rule,
        version: 2,
        title: '完成作业',
        condition: '当天作业全部完成',
        dailyLimit: 2,
        points: 3,
        direction: 'reward',
        changedByUserId: ID.dad,
        changedAt: new Date('2026-09-15T00:00:00.000Z'),
        changeNote: '加量'
      }
    ]
  })

  await prisma.habit.createMany({
    data: [
      {
        id: ID.habit,
        childId: ID.main,
        sourceRuleId: ID.rule,
        title: '番茄钟写作业',
        points: 1,
        condition: '专注 25 分钟',
        dailyLimit: 2,
        icon: 'timer',
        color: '#FFB74D'
      },
      {
        id: ID.deletedHabit,
        childId: ID.main,
        title: '已删习惯',
        points: 9,
        condition: '回收站里的习惯',
        dailyLimit: 1,
        icon: 'star',
        color: '#000000',
        status: 'deleted',
        deletedAt: new Date('2026-10-11T00:00:00.000Z')
      }
    ]
  })

  await prisma.wish.createMany({
    data: [
      {
        id: ID.wish,
        childId: ID.main,
        title: '看一场电影',
        cost: 50,
        emoji: '🎬',
        coverStyle: 'B',
        redeemed: true,
        redeemedAt: T.recExchange
      },
      {
        id: ID.deletedWish,
        childId: ID.main,
        title: '已删心愿',
        cost: 1,
        emoji: '❌',
        coverStyle: 'C',
        status: 'deleted',
        deletedAt: new Date('2026-10-12T00:00:00.000Z')
      }
    ]
  })
}


/** 流水 / 审批 / 同意 / 审计 —— 单独一段，便于看清「谁引用了谁」。 */
async function seedHistory(): Promise<void> {
  // ① 表扬：引用规则**版本 1**（复合外键 ⇒ I3），并带上幂等键（绝不许导出）。
  await prisma.pointRecord.create({
    data: {
      id: ID.recPraise,
      childId: ID.main,
      ruleId: ID.rule,
      ruleVersion: 1,
      habitId: ID.habit,
      titleSnapshot: '完成作业',
      conditionSnapshot: '当天作业全部完成',
      dailyLimitSnapshot: 1,
      pointsDelta: 3,
      category: 'praise',
      source: 'guardian',
      operatorUserId: ID.dad,
      operatorRole: 'guardian',
      balanceAfter: 3,
      idempotencyKey: SECRET.idempotencyKey,
      createdAt: T.recPraise
    }
  })

  // ② 兑换：引用心愿，扣 50 ⇒ 余额 -47（刻意让余额可以「负」—— 导出不修饰真相）
  await prisma.pointRecord.create({
    data: {
      id: ID.recExchange,
      childId: ID.main,
      wishId: ID.wish,
      titleSnapshot: '看一场电影',
      costSnapshot: 50,
      pointsDelta: -50,
      category: 'exchange',
      source: 'approval',
      operatorUserId: ID.dad,
      operatorRole: 'guardian',
      balanceAfter: -47,
      createdAt: T.recExchange
    }
  })

  // ③ 另一个孩子的流水：一条都不许出现在主孩子的文件里。
  await prisma.pointRecord.create({
    data: {
      id: ID.recOther,
      childId: ID.other,
      titleSnapshot: '另一个孩子的流水',
      pointsDelta: 7,
      category: 'praise',
      source: 'guardian',
      operatorUserId: ID.dad,
      operatorRole: 'guardian',
      balanceAfter: 7,
      createdAt: new Date('2026-10-06T00:00:00.000Z')
    }
  })

  await prisma.approvalRequest.create({
    data: {
      id: ID.approval,
      childId: ID.main,
      requesterUserId: ID.kid,
      requesterRole: 'child',
      actionType: 'redeem',
      // ★ payload 原样导出：家长要能看到「孩子申请时看到的价格」（02 §4.3）。
      payload: { wishId: ID.wish, costSnapshot: 50 },
      status: 'approved',
      decidedByUserId: ID.dad,
      decidedAt: new Date('2026-10-21T00:30:00.000Z'),
      expiresAt: new Date('2026-10-24T01:00:00.000Z'),
      createdAt: new Date('2026-10-21T00:00:00.000Z')
    }
  })

  await prisma.approvalRequest.create({
    data: {
      id: ID.otherApproval,
      childId: ID.other,
      requesterUserId: ID.kid,
      requesterRole: 'child',
      actionType: 'redeem',
      payload: { wishId: 'other-wish', costSnapshot: 1 },
      expiresAt: new Date('2026-10-24T01:00:00.000Z')
    }
  })

  // ★ 最新一行就是 `withdrawn`：导出必须照样 200（数据可携带权），写入必须 403。
  await prisma.guardianConsent.create({
    data: {
      id: ID.consent,
      childId: ID.main,
      grantedByUserId: ID.dad,
      consentVersion: 'v1',
      status: 'withdrawn',
      grantedAt: T.consentGranted,
      withdrawnAt: T.consentWithdrawn,
      createdAt: T.consentGranted,
      ipHash: SECRET.ipHash
    }
  })

  await prisma.auditLog.createMany({
    data: [
      {
        id: ID.audit,
        childId: ID.main,
        actorUserId: ID.dad,
        actorRole: 'guardian',
        action: 'point_rule.update',
        targetType: 'PointRule',
        targetId: ID.rule,
        before: { points: 1, currentVersion: 1 },
        after: { points: 3, currentVersion: 2 },
        deviceId: ID.devDad,
        ipHash: SECRET.ipHash,
        createdAt: new Date('2026-09-15T00:00:00.000Z')
      },
      {
        id: ID.otherAudit,
        childId: ID.other,
        action: 'consent.grant',
        targetType: 'GuardianConsent',
        after: { status: 'granted' },
        createdAt: new Date('2026-10-06T00:00:00.000Z')
      }
    ]
  })
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()
  await seedHistory()

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


/** 导出文件里本套件会读到的字段（故意只声明用得到的，少即是多）。 */
interface ExportDoc {
  schemaVersion: number
  generator: string
  generatedAt: string
  child: {
    id: string
    name: string
    pointsBalance: number
    ageBand: string | null
    focusAreas: string[]
    onboardedAt: string | null
    createdAt: string
  }
  members: { userId: string; displayName: string | null; role: string; status: string; joinedAt: string }[]
  rules: {
    id: string
    status: string
    currentVersion: number
    deletedAt: string | null
    versions: { version: number; points: number; changeNote: string | null; changedAt: string }[]
  }[]
  habits: { id: string; status: string; sourceRuleId: string | null }[]
  wishes: { id: string; status: string; redeemed: boolean; redeemedAt: string | null }[]
  records: {
    id: string
    ruleId: string | null
    ruleVersion: number | null
    wishId: string | null
    createdAt: string
    balanceAfter: number
  }[]
  approvals: { id: string; payload: unknown; status: string }[]
  consents: { status: string; consentVersion: string; withdrawnAt: string | null }[]
  auditLogs: { action: string; targetId: string | null; before: unknown; after: unknown }[]
  summary: {
    counts: Record<string, number>
    totals: { records: number; approvals: number; auditLogs: number }
    truncated: boolean
    truncatedSections: string[]
  }
}

/** 一份导出只取一次（后面各组读同一份文件，别让断言互相干扰）。 */
let cached: Promise<HttpResult> | undefined
function exportOnce(): Promise<HttpResult> {
  cached ??= get('/export', H.dad)
  return cached
}

function docOf(res: HttpResult): ExportDoc {
  return res.body as unknown as ExportDoc
}

// ══ 组 A：装配 —— 200 必须来自 Prisma 适配器 ═════════════════════════════════
describe('组 A：真 AppModule 里 `EXPORT_REPOSITORY` 绑的是 Prisma 适配器', () => {
  it('DI 取到的端口是真适配器（否则 501 会让下面的文件断言无从谈起）', () => {
    const port = app.get<object>(EXPORT_REPOSITORY)
    assert.ok(
      port instanceof PrismaExportRepository,
      `导出端口是 ${port.constructor.name} —— 装配没接上，生产会以「每次导出 501」的样子活着`
    )
  })
})


// ══ 组 B：文件内容 —— 九段都对得上库 ═════════════════════════════════════════
describe('组 B：GET /export —— 九段与库里的行一一对应', () => {
  it('200 + 可下载 + 不缓存 + 版本号/生成时间可用', async () => {
    const res = await exportOnce()
    assert.equal(res.status, 200, `实际 ${res.status}：${res.text.slice(0, 300)}`)
    assert.match(
      res.headers.get('content-disposition') ?? '',
      /^attachment; filename="family-export-dbtest-.+-\d{4}-\d{2}-\d{2}\.json"$/
    )
    assert.equal(res.headers.get('cache-control'), 'no-store')

    const doc = docOf(res)
    assert.equal(doc.schemaVersion, 1)
    assert.equal(doc.generator, 'kids-points-backend')
    assert.equal(
      Number.isNaN(Date.parse(doc.generatedAt)),
      false,
      `generatedAt 不是可解析的时间：${doc.generatedAt}`
    )
  })

  it('档案：引导三字段原样导出（不是 `/home` 的精简版）', async () => {
    const { child } = docOf(await exportOnce())
    assert.equal(child.id, ID.main)
    assert.equal(child.name, `导出套件主孩子 ${RUN}`)
    assert.equal(child.pointsBalance, 30)
    assert.equal(child.ageBand, 'primary_low')
    assert.deepEqual(child.focusAreas, ['study', 'habit'])
    assert.equal(child.onboardedAt, '2026-10-01T00:00:00.000Z')
    assert.equal(child.createdAt, new Date(child.createdAt).toISOString())
  })

  it('成员：按入伙时间正序，显示名来自 User（不是 userId 拼的）', async () => {
    const { members } = docOf(await exportOnce())
    assert.deepEqual(
      members.map((m) => m.userId),
      [ID.dad, ID.kid]
    )
    assert.equal(members[0]?.role, 'guardian')
    assert.equal(members[0]?.displayName, `导出套件 爸爸 ${RUN}`)
    assert.equal(members[1]?.role, 'child')
    assert.equal(members[1]?.status, 'active')
  })

  it('★ 规则：软删的也在（与 /home 口径相反），且版本史一条不少', async () => {
    const { rules } = docOf(await exportOnce())
    assert.deepEqual(
      rules.map((r) => r.id),
      [ID.rule, ID.deletedRule],
      '软删规则被藏起来了 —— 流水里的 ruleId 会指向文件里不存在的行'
    )

    const active = rules[0]
    assert.ok(active !== undefined)
    assert.equal(active.currentVersion, 2)
    assert.deepEqual(
      active.versions.map((v) => v.version),
      [1, 2]
    )
    assert.deepEqual(
      active.versions.map((v) => v.points),
      [1, 3]
    )
    assert.deepEqual(
      active.versions.map((v) => v.changeNote),
      [null, '加量']
    )
    assert.equal(active.versions[1]?.changedAt, '2026-09-15T00:00:00.000Z')

    const deleted = rules[1]
    assert.ok(deleted !== undefined)
    assert.equal(deleted.status, 'deleted')
    assert.equal(deleted.deletedAt, '2026-10-10T00:00:00.000Z')
  })

  it('★ 习惯 / 心愿：软删的也在，且 `sourceRuleId` 能指回规则段', async () => {
    const doc = docOf(await exportOnce())
    assert.deepEqual(
      doc.habits.map((h) => h.id),
      [ID.habit, ID.deletedHabit]
    )
    assert.equal(doc.habits[0]?.sourceRuleId, ID.rule)
    assert.equal(doc.habits[1]?.status, 'deleted')

    assert.deepEqual(
      doc.wishes.map((w) => w.id),
      [ID.wish, ID.deletedWish]
    )
    assert.equal(doc.wishes[0]?.redeemed, true)
    assert.equal(doc.wishes[0]?.redeemedAt, T.recExchange.toISOString())
    assert.equal(doc.wishes[1]?.status, 'deleted')
  })
})


// ══ 组 C：流水 / 审批 / 同意 / 审计 + summary ════════════════════════════════
describe('组 C：账本与历史 —— 顺序、引用、全量计数', () => {
  it('★ 流水：按时间**正序**（家长要滚动求和核对 balanceAfter），引用与快照都在', async () => {
    const { records } = docOf(await exportOnce())
    assert.deepEqual(
      records.map((r) => r.id),
      [ID.recPraise, ID.recExchange],
      '流水不是按时间正序 —— 滚动核对 balanceAfter 会算错'
    )
    assert.deepEqual(
      records.map((r) => r.balanceAfter),
      [3, -47]
    )
    assert.equal(records[0]?.createdAt, T.recPraise.toISOString())
    assert.equal(records[0]?.ruleId, ID.rule)
    assert.equal(records[0]?.ruleVersion, 1)
    assert.equal(records[1]?.wishId, ID.wish)
  })

  it('审批：payload 快照原样透出（含 costSnapshot）', async () => {
    const { approvals } = docOf(await exportOnce())
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0]?.id, ID.approval)
    assert.equal(approvals[0]?.status, 'approved')
    assert.deepEqual(approvals[0]?.payload, { wishId: ID.wish, costSnapshot: 50 })
  })

  it('★ 同意：撤回行照样在文件里（历史不是「当前状态」的替代品）', async () => {
    const { consents } = docOf(await exportOnce())
    assert.deepEqual(
      consents.map((c) => c.status),
      ['withdrawn'],
      '撤回行不见了 —— 「曾经同意过、后来撤回了」这段历史正是家长要带走的'
    )
    assert.equal(consents[0]?.consentVersion, 'v1')
    assert.equal(consents[0]?.withdrawnAt, T.consentWithdrawn.toISOString())
  })

  it('审计：变更快照原样导出（before / after 不塌缩）', async () => {
    const { auditLogs } = docOf(await exportOnce())
    assert.equal(auditLogs.length, 1)
    assert.equal(auditLogs[0]?.action, 'point_rule.update')
    assert.equal(auditLogs[0]?.targetId, ID.rule)
    assert.deepEqual(auditLogs[0]?.before, { points: 1, currentVersion: 1 })
    assert.deepEqual(auditLogs[0]?.after, { points: 3, currentVersion: 2 })
  })

  it('summary：counts 是本文件条数、totals 是库里的全量、未被截断', async () => {
    const doc = docOf(await exportOnce())
    assert.deepEqual(doc.summary.counts, {
      members: doc.members.length,
      rules: doc.rules.length,
      habits: doc.habits.length,
      wishes: doc.wishes.length,
      records: doc.records.length,
      approvals: doc.approvals.length,
      consents: doc.consents.length,
      auditLogs: doc.auditLogs.length
    })
    assert.deepEqual(doc.summary.totals, { records: 2, approvals: 1, auditLogs: 1 })
    assert.equal(doc.summary.truncated, false)
    assert.deepEqual(doc.summary.truncatedSections, [])
  })
})


// ══ 组 D：数据最小化 + 跨孩子隔离 ════════════════════════════════════════════
describe('组 D：文件里没有别人的数据，也没有凭据', () => {
  it('★ 原始文本里不出现 openId / pinHash / ipHash / idempotencyKey', async () => {
    const res = await exportOnce()
    for (const [name, value] of Object.entries(SECRET)) {
      assert.equal(
        res.text.includes(value),
        false,
        `${name} 被导出了 —— 导出文件常被转发/存网盘，凭据与重放键一律不带`
      )
    }
    // 连键名都不该出现（防止以后「只改名不删值」）
    for (const key of ['openId', 'pinHash', 'ipHash', 'idempotencyKey', 'deviceId']) {
      assert.equal(res.text.includes(key), false, `导出里出现了字段名 ${key}`)
    }
  })

  it('★ 另一个孩子（含规则 / 流水 / 审批 / 审计）一条都不许串进来', async () => {
    const res = await exportOnce()
    for (const foreign of [
      ID.other,
      ID.otherRule,
      ID.recOther,
      ID.otherApproval,
      ID.otherAudit,
      `导出套件另一个孩子 ${RUN}`
    ]) {
      assert.equal(res.text.includes(foreign), false, `跨孩子泄漏：${foreign}`)
    }
  })
})

// ══ 组 E：撤回同意 ≠ 不能导出 ════════════════════════════════════════════════
describe('组 E：★ 同意已撤回 —— 导出仍 200，写入被 403（两件事必须同时成立）', () => {
  it('导出不受同意闸门影响（04 §5：数据可携带权）', async () => {
    const res = await exportOnce()
    assert.equal(
      res.status,
      200,
      `撤回同意后导出被拒（${res.status}）—— 那等于用「撤回」剥夺了家长带走数据的权利`
    )
    assert.equal(docOf(res).consents[0]?.status, 'withdrawn')
  })

  it('同一身份的写操作被拒：PATCH /child ⇒ 403 CONSENT_REQUIRED（withdrawn）', async () => {
    const res = await call('/child', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...H.dad },
      body: JSON.stringify({ name: '撤回后改名' })
    })
    assert.equal(res.status, 403, `实际 ${res.status}：${res.text.slice(0, 300)}`)
    assert.equal(res.body.code, 'CONSENT_REQUIRED')
    assert.deepEqual((res.body.details as { status?: string } | undefined)?.status, 'withdrawn')
  })
})


// ══ 组 F：拒绝与 404 —— 屏障、矩阵、软删 ═════════════════════════════════════
describe('组 F：拿不到导出的人与不存在的孩子', () => {
  it('孩子本人 ⇒ 403 FORBIDDEN（矩阵 export_family_data.child = DENY），文件为空', async () => {
    const res = await get('/export', H.kid)
    assert.equal(res.status, 403, `实际 ${res.status}：${res.text.slice(0, 300)}`)
    assert.equal(res.body.code, 'FORBIDDEN')
    assert.equal(res.body.records, undefined)
  })

  it('有会话但不是成员 ⇒ 403 MEMBER_NOT_FOUND（§9.21：不透露这个孩子存不存在）', async () => {
    const res = await get('/export', H.stranger)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'MEMBER_NOT_FOUND')
  })

  it('★ 孩子已软删 ⇒ 404 CHILD_NOT_FOUND（不是「空导出」）', async () => {
    const res = await get('/export', H.gone)
    assert.equal(res.status, 404, `实际 ${res.status}：${res.text.slice(0, 300)}`)
    assert.equal(res.body.code, 'CHILD_NOT_FOUND')
    assert.equal(res.body.child, undefined, '软删的孩子仍然吐出了档案段')
    assert.equal(res.body.records, undefined)
  })

  it('设备与会话都不认识 ⇒ 401 SESSION_NOT_FOUND（先回答「你是谁」）', async () => {
    const res = await get('/export', {
      'x-kp-device-id': `dbtest-${RUN}-exp-dev-unknown`,
      'x-kp-child-id': ID.main
    })
    assert.equal(res.status, 401)
    assert.equal(res.body.code, 'SESSION_NOT_FOUND')
  })
})


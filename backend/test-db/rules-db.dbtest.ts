/**
 * rules-db.dbtest.ts —— 规则写入口 **真库 × 真 HTTP** 套件（W5-A，2026-10-19）
 *
 * ── 与另外两份用例的分工 ────────────────────────────────────────────────────
 *   · `test/rules-http.test.ts` —— 真 HTTP，端口是替身：证明三道屏障、入参封闭、
 *     带符号 `points` 的唯一转换点、幂等语义；证明不了「版本行 / 审计真的落库」。
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `fetch`：
 *       新建 → 规则 ＋ v1 版本 ＋ 审计同一事务；
 *       编辑 → 归档 v+1 ＋ 条件更新（乐观锁）＋ 派生习惯同步 ＋ 审计；
 *       删除 → 只改状态位，**版本行一条不少**；
 *       加习惯 → 复制而非引用（`sourceRuleId`）、扣分规则拒绝。
 *
 * ── 为什么乐观锁必须在这里证 ────────────────────────────────────────────────
 *   `UPDATE ... WHERE currentVersion = ?` 影响 0 行才回滚，这是**库**的行为。
 *   替身端口只能证明「控制器把 expectedVersion 原样交给了端口」。
 *   本套件用「旧版本号再提交一次」制造真实的 0 行更新，并核对
 *   **回滚没有留下 v+1 的版本行**（事务外看不见的中间态也不许残留）。
 *
 * ── ★ 数据不清理（与 identity / ledger / read / habits 套件同一纪律）──────────
 *   规则行可以被软删，但 `PointRuleVersion.ruleId` 是 `Restrict`：
 *   删规则会先撞外键。本套件每次运行用全新 `dbtest-<run>` 前缀，
 *   于是「从零开始」这个前提成立，同时**不删任何既有数据**。
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
import { PrismaService } from '../src/prisma/prisma.service'
import { RULES_REPOSITORY } from '../src/rules/rules.repository'
import { PrismaRulesRepository } from '../src/rules/rules.prisma.repository'
import { grantConsentFor } from './support/consent-fixture'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-rule-dad`,
  kid: `dbtest-${RUN}-rule-kid`,
  main: `dbtest-${RUN}-rule-main`,
  other: `dbtest-${RUN}-rule-other`,
  devDad: `dbtest-${RUN}-rule-dev-dad`,
  devKid: `dbtest-${RUN}-rule-dev-kid`,
  devOther: `dbtest-${RUN}-rule-dev-other`
} as const

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.main },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.main },
  other: { 'x-kp-device-id': ID.devOther, 'x-kp-child-id': ID.other }
} as const

let prisma: PrismaService
let app: INestApplication
let url = ''

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function call(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const text = await res.text()
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed }
}

const VALID_CREATE = {
  title: '番茄钟写作业',
  condition: '专注 25 分钟',
  dailyLimit: 2,
  points: 3,
  icon: 'pencil',
  color: '#7bb0e8'
}

/** 建一条规则，返回它落库后的 id / currentVersion。 */
async function createRule(
  overrides: Partial<typeof VALID_CREATE> = {},
  headers: Record<string, string> = H.dad
): Promise<{ id: string; currentVersion: number }> {
  const res = await call('POST', '/point-rules', headers, {
    ...VALID_CREATE,
    ...overrides
  })
  assert.equal(res.status, 201, `建规则失败 ${res.status}：${JSON.stringify(res.body)}`)
  return {
    id: String(res.body.id),
    currentVersion: Number(res.body.currentVersion)
  }
}

async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)

  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: `规则套件 爸爸 ${RUN}` },
      { id: ID.kid, displayName: `规则套件 孩子 ${RUN}` }
    ]
  })
  await prisma.child.createMany({
    data: [
      { id: ID.main, name: `规则套件主孩子 ${RUN}`, pointsBalance: 0 },
      { id: ID.other, name: `规则套件另一个孩子 ${RUN}`, pointsBalance: 0 }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.main, userId: ID.dad, role: 'guardian', status: 'active' },
      { childId: ID.main, userId: ID.kid, role: 'child', status: 'active' },
      { childId: ID.other, userId: ID.dad, role: 'guardian', status: 'active' }
    ]
  })
  // ★ W7-A 起写端点都过 ConsentGuard：夹具显式给「有效同意」（测规则，不是闸门）。
  //   `other` 也给：跨孩子编辑 / 删除 / 加习惯要断言「404 不泄露存在性」，
  //   同意状态不该把那个 404 换成 403。
  await grantConsentFor(prisma, [
    [ID.main, ID.dad],
    [ID.other, ID.dad]
  ])
  await prisma.deviceSession.createMany({
    data: [
      {
        deviceId: ID.devDad,
        childId: ID.main,
        userId: ID.dad,
        activeRole: 'guardian',
        expiresAt: future
      },
      {
        deviceId: ID.devKid,
        childId: ID.main,
        userId: ID.kid,
        activeRole: 'child',
        expiresAt: future
      },
      {
        deviceId: ID.devOther,
        childId: ID.other,
        userId: ID.dad,
        activeRole: 'guardian',
        expiresAt: future
      }
    ]
  })
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

// ══ 组 A：装配 —— 下面的 201 必须来自 Prisma 适配器 ══════════════════════════
describe('组 A：真 AppModule 里 `RULES_REPOSITORY` 绑的是 Prisma 适配器', () => {
  it('DI 取到的端口是真适配器（否则 501 会让所有 201 断言无从谈起）', () => {
    const port = app.get<object>(RULES_REPOSITORY)
    assert.ok(
      port instanceof PrismaRulesRepository,
      `规则端口是 ${port.constructor.name} —— 装配没接上，生产会以「每次保存 501」的样子活着`
    )
  })
})

// ══ 组 B：新建 —— 规则 ＋ v1 版本 ＋ 审计同一事务 ═════════════════════════════
describe('组 B：POST /point-rules —— 201、v1 版本行、审计', () => {
  it('奖励规则：points 落正数、direction=reward，v1 快照与主体一致', async () => {
    const res = await call('POST', '/point-rules', H.dad, {
      ...VALID_CREATE,
      title: '  番茄钟写作业  ',
      condition: '  专注 25 分钟 '
    })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)

    const ruleId = String(res.body.id)
    assert.equal(res.body.points, 3, '客户端契约是带符号分值')
    assert.equal(res.body.direction, 'reward')
    assert.equal(res.body.currentVersion, 1)
    assert.equal(res.body.title, '番茄钟写作业', '标题必须去掉首尾空白')

    const rule = await prisma.pointRule.findUniqueOrThrow({ where: { id: ruleId } })
    assert.equal(rule.childId, ID.main)
    assert.equal(rule.points, 3)
    assert.equal(rule.direction, 'reward')
    assert.equal(rule.currentVersion, 1)
    assert.equal(rule.status, 'active')

    const versions = await prisma.pointRuleVersion.findMany({
      where: { ruleId },
      orderBy: { version: 'asc' }
    })
    assert.equal(versions.length, 1, '新建必须留下 v1 —— 否则 currentVersion 指向不存在的行')
    assert.equal(versions[0].version, 1)
    assert.equal(versions[0].title, '番茄钟写作业')
    assert.equal(versions[0].condition, '专注 25 分钟')
    assert.equal(versions[0].points, 3)
    assert.equal(versions[0].changedByUserId, ID.dad)

    const audits = await prisma.auditLog.findMany({
      where: { targetType: 'PointRule', targetId: ruleId, action: 'point_rule.create' }
    })
    assert.equal(audits.length, 1)
    assert.equal(audits[0].actorUserId, ID.dad)
    assert.equal(audits[0].actorRole, 'guardian')
    assert.equal(audits[0].before, null, '新建没有 before 快照')
    const after = audits[0].after as Record<string, unknown>
    assert.equal(after.id, ruleId)
    assert.equal(after.currentVersion, 1)
    assert.equal(after.status, 'active')
  })

  it('扣分规则：客户端 -3 ⇒ 库内 points=3 ＋ direction=penalty（符号只搬一次）', async () => {
    const res = await call('POST', '/point-rules', H.dad, {
      ...VALID_CREATE,
      title: '打人',
      condition: '动手打人一次',
      points: -3,
      icon: 'close',
      color: '#e26a5a'
    })
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(res.body.points, -3, '响应必须把符号还原给客户端')
    assert.equal(res.body.direction, 'penalty')

    const rule = await prisma.pointRule.findUniqueOrThrow({ where: { id: String(res.body.id) } })
    assert.equal(rule.points, 3, '库内恒为正；负号在 direction 里')
    assert.equal(rule.direction, 'penalty')
  })

  it('空约定 ⇒ 落成「家长约定」（与双端本地实现同口径）', async () => {
    const { id } = await createRule({ title: '按时睡觉', condition: '   ' })
    const rule = await prisma.pointRule.findUniqueOrThrow({ where: { id } })
    assert.equal(rule.condition, '家长约定')
  })

  it('★ 绕不过的边界：points=0 ⇒ 400，且**一行都不落库**', async () => {
    const beforeCount = await prisma.pointRule.count({ where: { childId: ID.main } })
    const res = await call('POST', '/point-rules', H.dad, {
      ...VALID_CREATE,
      points: 0
    })
    assert.equal(res.status, 400)
    assert.equal(await prisma.pointRule.count({ where: { childId: ID.main } }), beforeCount)
  })
})


// ══ 组 C：编辑 —— 归档 v+1 ＋ 条件更新 ＋ 派生习惯同步 ＋ 审计 ════════════════
describe('组 C：PATCH /point-rules/:id —— 乐观锁与版本归档', () => {
  it('改规则：200、currentVersion+1、v2 快照、派生习惯同步、审计 before/after', async () => {
    const created = await createRule({
      title: '每日阅读',
      condition: '读 20 分钟',
      dailyLimit: 1,
      points: 2,
      icon: 'book',
      color: '#81c784'
    })

    // 先由规则派生一个首页习惯（编辑时应当跟着新规走）。
    const habitRes = await call('POST', `/point-rules/${created.id}/habits`, H.dad)
    assert.equal(habitRes.status, 201, `加习惯失败：${JSON.stringify(habitRes.body)}`)
    const habitId = String(habitRes.body.id)

    const res = await call('PATCH', `/point-rules/${created.id}`, H.dad, {
      title: '每日阅读（新版）',
      condition: '读 30 分钟',
      dailyLimit: 2,
      points: 4,
      expectedVersion: 1
    })
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(res.body.currentVersion, 2)
    assert.equal(res.body.title, '每日阅读（新版）')
    assert.equal(res.body.points, 4)
    assert.equal(res.body.icon, 'book', '编辑不改图标（D9：图标只在新建时选择）')
    assert.equal(res.body.color, '#81c784')

    const rule = await prisma.pointRule.findUniqueOrThrow({ where: { id: created.id } })
    assert.equal(rule.currentVersion, 2)
    assert.equal(rule.dailyLimit, 2)

    const versions = await prisma.pointRuleVersion.findMany({
      where: { ruleId: created.id },
      orderBy: { version: 'asc' }
    })
    assert.deepEqual(
      versions.map((v) => v.version),
      [1, 2],
      '版本行只增不删，且不能跳号'
    )
    assert.equal(versions[1].title, '每日阅读（新版）')
    assert.equal(versions[1].points, 4)
    assert.equal(versions[1].changedByUserId, ID.dad)

    // §3.2「未来从新规」：派生习惯是规则的投影，必须同事务同步。
    const habit = await prisma.habit.findUniqueOrThrow({ where: { id: habitId } })
    assert.equal(habit.sourceRuleId, created.id)
    assert.equal(habit.title, '每日阅读（新版）')
    assert.equal(habit.condition, '读 30 分钟')
    assert.equal(habit.dailyLimit, 2)
    assert.equal(habit.points, 4)

    const audits = await prisma.auditLog.findMany({
      where: { targetType: 'PointRule', targetId: created.id, action: 'point_rule.update' }
    })
    assert.equal(audits.length, 1, '一次改动只能有一条审计')
    const before = audits[0].before as Record<string, unknown>
    const after = audits[0].after as Record<string, unknown>
    assert.equal(before.currentVersion, 1)
    assert.equal(before.title, '每日阅读')
    assert.equal(after.currentVersion, 2)
    assert.equal(after.title, '每日阅读（新版）')
  })

  it('★ 旧版本号再提交 ⇒ 409 RULE_VERSION_CONFLICT，且不留下 v3 版本行', async () => {
    const created = await createRule({ title: '整理书桌', condition: '书桌归位' })
    const first = await call('PATCH', `/point-rules/${created.id}`, H.dad, {
      title: '整理书桌',
      condition: '书桌归位（新版）',
      dailyLimit: 3,
      points: 2,
      expectedVersion: 1
    })
    assert.equal(first.status, 200)

    const stale = await call('PATCH', `/point-rules/${created.id}`, H.dad, {
      title: '整理书桌（覆盖别人的修改）',
      condition: '不该生效',
      dailyLimit: 4,
      points: 5,
      expectedVersion: 1
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.code, 'RULE_VERSION_CONFLICT')
    const details = stale.body.details as Record<string, unknown>
    assert.equal(details.currentVersion, 2)
    assert.equal(details.expectedVersion, 1)

    const versions = await prisma.pointRuleVersion.findMany({
      where: { ruleId: created.id },
      orderBy: { version: 'asc' }
    })
    assert.deepEqual(
      versions.map((v) => v.version),
      [1, 2],
      '条件更新 0 行必须在事务里连版本行一起回滚'
    )
    const rule = await prisma.pointRule.findUniqueOrThrow({ where: { id: created.id } })
    assert.equal(rule.title, '整理书桌')
    assert.equal(rule.currentVersion, 2)
  })

  it('★ 跨孩子编辑 ⇒ 404 RULE_NOT_FOUND（不泄露“存在但不属于你”）', async () => {
    const created = await createRule({ title: '主孩子的规则' })
    const res = await call('PATCH', `/point-rules/${created.id}`, H.other, {
      title: '偷改',
      condition: '不该生效',
      dailyLimit: 1,
      points: 1,
      expectedVersion: 1
    })
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'RULE_NOT_FOUND')
  })

  it('★ 孩子（child 角色）编辑 ⇒ 403（矩阵 DENY，不靠 UI 拦）', async () => {
    const created = await createRule({ title: '孩子不能改' })
    const res = await call('PATCH', `/point-rules/${created.id}`, H.kid, {
      title: '孩子改的',
      condition: '不该生效',
      dailyLimit: 1,
      points: 1,
      expectedVersion: 1
    })
    assert.equal(res.status, 403)
  })
})


// ══ 组 D：删除 —— 软删，版本行一条不少 ═══════════════════════════════════════
describe('组 D：DELETE /point-rules/:id —— 软删除', () => {
  it('删除：200、status=deleted、deletedAt 落库、版本行仍在、审计一条', async () => {
    const created = await createRule({ title: '待删规则' })
    await call('PATCH', `/point-rules/${created.id}`, H.dad, {
      title: '待删规则',
      condition: '改一次',
      dailyLimit: 2,
      points: 2,
      expectedVersion: 1
    })

    const res = await call('DELETE', `/point-rules/${created.id}`, H.dad)
    assert.equal(res.status, 200, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(res.body.ruleId, created.id)

    const rule = await prisma.pointRule.findUniqueOrThrow({ where: { id: created.id } })
    assert.equal(rule.status, 'deleted')
    assert.notEqual(rule.deletedAt, null)

    const versions = await prisma.pointRuleVersion.count({ where: { ruleId: created.id } })
    assert.equal(versions, 2, '版本行永不删 —— 历史流水的 (ruleId, ruleVersion) 仍要指得着')

    const audits = await prisma.auditLog.findMany({
      where: { targetType: 'PointRule', targetId: created.id, action: 'point_rule.delete' }
    })
    assert.equal(audits.length, 1)
    const after = audits[0].after as Record<string, unknown>
    assert.equal(after.status, 'deleted')
    assert.ok(typeof after.deletedAt === 'string' && after.deletedAt !== '')
  })

  it('重复删除 ⇒ 仍 200，但不再写第二条审计（幂等）', async () => {
    const created = await createRule({ title: '重复删除' })
    assert.equal((await call('DELETE', `/point-rules/${created.id}`, H.dad)).status, 200)
    assert.equal((await call('DELETE', `/point-rules/${created.id}`, H.dad)).status, 200)

    const audits = await prisma.auditLog.findMany({
      where: { targetType: 'PointRule', targetId: created.id, action: 'point_rule.delete' }
    })
    assert.equal(audits.length, 1, '重复点击不是第二次变更')
  })

  it('★ 跨孩子删除 ⇒ 404，且原规则仍是 active', async () => {
    const created = await createRule({ title: '跨孩子删除' })
    const res = await call('DELETE', `/point-rules/${created.id}`, H.other)
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'RULE_NOT_FOUND')

    const rule = await prisma.pointRule.findUniqueOrThrow({ where: { id: created.id } })
    assert.equal(rule.status, 'active')
  })
})


// ══ 组 E：加入今天的习惯 —— 复制而非引用 ══════════════════════════════════════
describe('组 E：POST /point-rules/:id/habits', () => {
  it('奖励规则 ⇒ 201，习惯保留 sourceRuleId，字段与规则一致', async () => {
    const created = await createRule({
      title: '自己穿衣服',
      condition: '不磨蹭',
      dailyLimit: 2,
      points: 2,
      icon: 'star',
      color: '#ffb74d'
    })
    const res = await call('POST', `/point-rules/${created.id}/habits`, H.dad)
    assert.equal(res.status, 201, `实际 ${res.status}：${JSON.stringify(res.body)}`)
    assert.equal(res.body.ruleId, created.id)
    assert.equal(res.body.title, '自己穿衣服')
    assert.equal(res.body.condition, '不磨蹭')
    assert.equal(res.body.dailyLimit, 2)
    assert.equal(res.body.points, 2)
    assert.equal(res.body.icon, 'star')
    assert.equal(res.body.color, '#ffb74d')

    const habit = await prisma.habit.findUniqueOrThrow({ where: { id: String(res.body.id) } })
    assert.equal(habit.childId, ID.main)
    assert.equal(habit.sourceRuleId, created.id)
    assert.equal(habit.status, 'active')

    const audits = await prisma.auditLog.findMany({
      where: { targetType: 'Habit', targetId: habit.id, action: 'habit.create' }
    })
    assert.equal(audits.length, 1)
    const after = audits[0].after as Record<string, unknown>
    assert.equal(after.sourceRuleId, created.id)
  })

  it('同一条规则再加一次 ⇒ 409 HABIT_ALREADY_EXISTS，只留一个习惯', async () => {
    const created = await createRule({ title: '每天喝水' })
    assert.equal((await call('POST', `/point-rules/${created.id}/habits`, H.dad)).status, 201)

    const again = await call('POST', `/point-rules/${created.id}/habits`, H.dad)
    assert.equal(again.status, 409)
    assert.equal(again.body.code, 'HABIT_ALREADY_EXISTS')

    const count = await prisma.habit.count({
      where: { childId: ID.main, sourceRuleId: created.id, status: 'active' }
    })
    assert.equal(count, 1)
  })

  it('★ 扣分规则 ⇒ 409 RULE_IS_PENALTY，且**不建**习惯（修 A1）', async () => {
    const created = await createRule({
      title: '动手打人',
      condition: '打人一次',
      points: -3,
      icon: 'close',
      color: '#e26a5a'
    })
    const res = await call('POST', `/point-rules/${created.id}/habits`, H.dad)
    assert.equal(res.status, 409)
    assert.equal(res.body.code, 'RULE_IS_PENALTY')

    const count = await prisma.habit.count({
      where: { childId: ID.main, sourceRuleId: created.id }
    })
    assert.equal(count, 0, '扣分规则绝不能变成“打卡加分”习惯')
  })

  it('★ 已删除的规则 ⇒ 404（回收站里的规则不能继续派生习惯）', async () => {
    const created = await createRule({ title: '已删除的规则' })
    assert.equal((await call('DELETE', `/point-rules/${created.id}`, H.dad)).status, 200)

    const res = await call('POST', `/point-rules/${created.id}/habits`, H.dad)
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'RULE_NOT_FOUND')
  })

  it('★ 跨孩子加习惯 ⇒ 404', async () => {
    const created = await createRule({ title: '主孩子的规则（加习惯）' })
    const res = await call('POST', `/point-rules/${created.id}/habits`, H.other)
    assert.equal(res.status, 404)
    assert.equal(res.body.code, 'RULE_NOT_FOUND')
  })
})


// ══ 组 F：幂等 —— 同一个 key 重放不会产生第二个版本 ══════════════════════════
describe('组 F：Idempotency-Key（真库表）', () => {
  it('PATCH 用同一个 key 重放 ⇒ 只执行一次，版本仍是 v2', async () => {
    const created = await createRule({ title: '幂等编辑' })
    const headers = { ...H.dad, 'idempotency-key': `rules-db-${RUN}-patch-1` }
    const payload = {
      title: '幂等编辑（新）',
      condition: '只改一次',
      dailyLimit: 2,
      points: 2,
      expectedVersion: 1
    }

    const first = await call('PATCH', `/point-rules/${created.id}`, headers, payload)
    const second = await call('PATCH', `/point-rules/${created.id}`, headers, payload)
    assert.equal(first.status, 200, `实际 ${first.status}：${JSON.stringify(first.body)}`)
    assert.equal(second.status, 200)
    assert.deepEqual(second.body, first.body, '重放必须原样返回首次响应')

    const versions = await prisma.pointRuleVersion.findMany({
      where: { ruleId: created.id },
      orderBy: { version: 'asc' }
    })
    assert.deepEqual(
      versions.map((v) => v.version),
      [1, 2],
      '重放却又归档了一版'
    )

    const audits = await prisma.auditLog.count({
      where: { targetType: 'PointRule', targetId: created.id, action: 'point_rule.update' }
    })
    assert.equal(audits, 1)
  })
})


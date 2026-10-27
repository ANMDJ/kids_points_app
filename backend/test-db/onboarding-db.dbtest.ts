/**
 * onboarding-db.dbtest.ts —— 首启引导 **真库 × 真 HTTP** 套件（W8-A，2026-10-27）
 *
 * ── 它与另外三份用例的分工 ─────────────────────────────────────────────────
 *   · `test/onboarding-policy.test.ts` —— 纯规则（排序 / 合并 / PIN 格式 / 哈希）；
 *   · `test/onboarding-http.test.ts` —— 真 HTTP，端口是替身（屏障 / 闸门 / 400 / 409）；
 *   · `test/onboarding-wiring.test.ts` —— 装配与守卫元数据；
 *   · **本文件** —— 真 `AppModule` ＋ 真库 ＋ 真守卫链 ＋ 真 `fetch`：
 *       草稿落库 → 采纳模板 → 规则 + v1 版本行 + PIN + 审计，然后逐表断言。
 *
 * ── 五条只有真库能回答的问题 ────────────────────────────────────────────────
 *   ① 采纳真的**复制**了模板字段吗（title / condition / dailyLimit / points /
 *      direction / icon / color），还是只写了个标题？模板之后下架影响不到已建规则？
 *   ② 每条规则真的有一条 `version = 1` 的版本行、`changeNote` 能追到 slug 吗？
 *   ③ `onboardedAt` / `ageBand` / `focusAreas` 三列是否**同时**落库（引导的权威状态）？
 *   ④ PIN 真的写成了可验回的哈希吗（`verifyPin` 验得回、库里不含明文）？
 *   ⑤ 「模板在提交瞬间下架」⇒ 404 时，**一条规则都没建、`onboardedAt` 仍为 null**？
 *      （校验在事务内、update 之前；这是 `04` §3「复制而非引用」的失败面）
 *
 * ── ★ 数据不清理 ────────────────────────────────────────────────────────────
 *   `PointRuleVersion.ruleId` 是 `Restrict`，删规则会先撞外键；审计是追加式的证据。
 *   每次运行用全新 `dbtest-<run>` 前缀，于是「从零开始」成立，也不删任何既有行。
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
import { PrismaOnboardingRepository } from '../src/onboarding/onboarding.prisma.repository'
import {
  NotImplementedOnboardingRepository,
  ONBOARDING_REPOSITORY,
  type OnboardingPort
} from '../src/onboarding/onboarding.repository'
import { verifyPin } from '../src/onboarding/pin-hash'
import { PrismaService } from '../src/prisma/prisma.service'
import { grantConsentFor } from './support/consent-fixture'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-ob-dad`,
  kid: `dbtest-${RUN}-ob-kid`,
  main: `dbtest-${RUN}-ob-main`,
  stale: `dbtest-${RUN}-ob-stale`,
  noConsent: `dbtest-${RUN}-ob-noconsent`,
  devDad: `dbtest-${RUN}-ob-dev-dad`,
  devKid: `dbtest-${RUN}-ob-dev-kid`,
  devStale: `dbtest-${RUN}-ob-dev-stale`,
  devNoConsent: `dbtest-${RUN}-ob-dev-noconsent`,
  tplA: `dbtest-${RUN}-ob-tpl-a`,
  tplB: `dbtest-${RUN}-ob-tpl-b`,
  tplGone: `dbtest-${RUN}-ob-tpl-gone`
} as const

const PIN = '4321'

function identity(deviceId: string, childId: string): Record<string, string> {
  return { 'x-kp-device-id': deviceId, 'x-kp-child-id': childId }
}

const H = {
  dad: identity(ID.devDad, ID.main),
  kid: identity(ID.devKid, ID.main),
  stale: identity(ID.devStale, ID.stale),
  noConsent: identity(ID.devNoConsent, ID.noConsent)
} as const

let prisma: PrismaService
let app: INestApplication
let url = ''

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function call(
  method: 'GET' | 'PATCH' | 'POST',
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

/** 夹具写成功了吗 —— 没写成功就不该去「清理」，否则 `after` 会用假错误盖住真错误。 */
let seeded = false

/**
 * 夹具（三个孩子，各自回答一个问题）：
 *   · `main`      —— 走完 ①同意 → ③④草稿 → ⑤⑥⑦完成 的全路径；dad=guardian、kid=child
 *   · `stale`     —— 提交瞬间模板已下架（TOCTOU）：必须 404 且**零副作用**
 *   · `noConsent` —— 有成员位、**没有同意**：GET 能开（读豁免），POST 403（写受管）
 *
 * 模板三件：
 *   · `tplB` focusAreas=['阅读','运动']、sortWeight 800 → 命中 2 次
 *   · `tplA` focusAreas=['阅读']、sortWeight 900      → 命中 1 次
 *   · `tplGone` 开局 active，用例里改成 deleted 再提交
 * 三张模板都是 `primary_low`，且 sortWeight 高于 seed 里的业务模板，
 * 于是「命中数优先于 sortWeight」这条排序链在本文件里**可观测**（B 在 A 之前）。
 */
async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)
  await prisma.child.createMany({
    data: [
      { id: ID.main, name: `引导 DB 套件 ${RUN} 主` },
      { id: ID.stale, name: `引导 DB 套件 ${RUN} 下架` },
      { id: ID.noConsent, name: `引导 DB 套件 ${RUN} 未同意` }
    ]
  })
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: '引导 DB 套件家长' },
      { id: ID.kid, displayName: '引导 DB 套件孩子' }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.main, userId: ID.dad, role: 'guardian' },
      { childId: ID.main, userId: ID.kid, role: 'child' },
      // stale / noConsent 只要家长成员位：孩子视角的 403 由 HTTP 套件覆盖，
      // 这里要证明的是「同意闸门在**写**上真的拦住了已登录家长」。
      { childId: ID.stale, userId: ID.dad, role: 'guardian' },
      { childId: ID.noConsent, userId: ID.dad, role: 'guardian' }
    ]
  })
  // ★ 只给会走写路径的两个孩子授权；`noConsent` 故意空着（组 C 的前提）。
  await grantConsentFor(prisma, [
    [ID.main, ID.dad],
    [ID.stale, ID.dad]
  ])
  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.main, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.main, userId: ID.kid, activeRole: 'child', expiresAt: future },
      { deviceId: ID.devStale, childId: ID.stale, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      {
        deviceId: ID.devNoConsent,
        childId: ID.noConsent,
        userId: ID.dad,
        activeRole: 'guardian',
        expiresAt: future
      }
    ]
  })
  await prisma.ruleTemplate.createMany({
    data: [
      {
        slug: ID.tplA,
        title: '睡前读 15 分钟',
        condition: '睡前阅读 15 分钟',
        dailyLimit: 1,
        points: 2,
        direction: 'reward',
        icon: '📖',
        color: '#4C6FFF',
        ageBand: 'primary_low',
        focusAreas: ['阅读'],
        sortWeight: 900
      },
      {
        slug: ID.tplB,
        title: '每天跳绳 200 下',
        condition: '跳绳 200 下',
        dailyLimit: 1,
        points: 3,
        direction: 'reward',
        icon: '🪢',
        color: '#2FBF71',
        ageBand: 'primary_low',
        focusAreas: ['阅读', '运动'],
        sortWeight: 800
      },
      {
        slug: ID.tplGone,
        title: '自己整理书包',
        condition: '睡前整理书包',
        dailyLimit: 1,
        points: 1,
        direction: 'reward',
        icon: '🎒',
        color: '#F2994A',
        ageBand: 'primary_low',
        focusAreas: ['生活习惯'],
        sortWeight: 700
      }
    ]
  })

  // 独立复核：夹具**真的**进了库 —— 否则下面的断言可能只是「恰好也过」
  assert.equal(await prisma.child.count({ where: { id: { in: [ID.main, ID.stale, ID.noConsent] } } }), 3)
  assert.equal(
    await prisma.childMember.count({ where: { childId: { in: [ID.main, ID.stale, ID.noConsent] } } }),
    4
  )
  assert.equal(
    await prisma.deviceSession.count({ where: { childId: { in: [ID.main, ID.stale, ID.noConsent] } } }),
    4
  )
  assert.equal(await prisma.ruleTemplate.count({ where: { slug: { startsWith: `dbtest-${RUN}-ob-tpl` } } }), 3)
  // 三个孩子都还没完成引导 —— 这是「下面任何一次 200 都是本文件造成的」的前提。
  assert.equal(
    await prisma.child.count({
      where: { id: { in: [ID.main, ID.stale, ID.noConsent] }, onboardedAt: { not: null } }
    }),
    0
  )
}


/**
 * ★ 数据**不清理**（与 `identity` / `ledger` / `read` / `habits` / `rules` 套件同一纪律）
 *
 *   硬事实：`PointRuleVersion` 的 `DELETE` 在真库上被 REVOKE（42501），
 *   而 `PointRuleVersion.ruleId` 又是 `Restrict` —— 于是「有规则的 Child」也删不掉。
 *   本文件必然建规则，所以「删干净」这个承诺在这里根本不可能兑现。
 *   承诺换成另一种：每次运行用全新 `dbtest-<RUN>` 前缀 ⇒「从零开始」成立，
 *   并**不删任何既有行**。`after` 做的是复核，不是清理。
 *
 *   于是这一段反而是最硬的一条证据：它证明「版本行不可删」是真的库行为，
 *   而不是我们「忘了删」。
 */
async function verifyRetained(): Promise<void> {
  const childIds = [ID.main, ID.stale, ID.noConsent]
  const audits = await prisma.auditLog.findMany({
    where: { childId: { in: childIds } },
    select: { id: true, action: true }
  })
  assert.ok(
    audits.some((row) => row.action === 'onboarding.complete'),
    '本轮没有 onboarding.complete 审计 —— 组 E 本该先红'
  )
  assert.ok(
    audits.some((row) => row.action === 'onboarding.profile_saved'),
    '本轮没有 onboarding.profile_saved 审计 —— 组 D 本该先红'
  )

  const rules = await prisma.pointRule.findMany({
    where: { childId: { in: childIds } },
    select: { id: true, childId: true, currentVersion: true }
  })
  assert.equal(rules.length, 3, '本轮规则数应为 main 2 条 + stale 1 条')
  assert.equal(await prisma.pointRule.count({ where: { childId: ID.noConsent } }), 0)
  assert.equal(
    await prisma.pointRuleVersion.count({ where: { ruleId: { in: rules.map((row) => row.id) } } }),
    3
  )
  assert.equal(rules.every((row) => row.currentVersion === 1), true)

  // ★ 直接尝试删一条版本行：真库必须拒绝（42501）。能删掉才是灾难。
  await prisma.pointRuleVersion
    .deleteMany({ where: { ruleId: rules[0].id } })
    .then(
      () => assert.fail('版本行居然删得掉 —— 审计性证据的 REVOKE 失效了'),
      (error: unknown) => {
        assert.equal(
          String((error as Error).message).includes('42501'),
          true,
          `期望 42501（permission denied），实际：${(error as Error).message}`
        )
      }
    )

  // 模板是**唯一**可以删的本轮产物：规则是副本（不引用模板），删掉它们既不影响
  // 上面的证据，又能让 `npm run db:verify` 的 P0（`RuleTemplate` 必须恰好 18 条）
  // 在第二次运行时不至于红 —— 残留 3 条模板会让「库是干净的」这条前提失效。
  await prisma.ruleTemplate.deleteMany({ where: { slug: { in: [ID.tplA, ID.tplB, ID.tplGone] } } })
  assert.equal(
    await prisma.ruleTemplate.count({ where: { slug: { in: [ID.tplA, ID.tplB, ID.tplGone] } } }),
    0
  )
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()
  seeded = true

  // ★ 刻意**不传** `hasDatabase`：要验的正是生产那条路（由 DATABASE_URL 推断）。
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()
})

after(async () => {
  // 三步各自独立：`before` 中途炸掉时 app / seeded 可能是空的，
  // 无条件 close 只会抛出「盖住真因」的错误。
  if (app !== undefined) await app.close()
  if (seeded) await verifyRetained()
  if (prisma !== undefined) await prisma.$disconnect()
})

// ══ 组 A：装配 —— 下面所有断言的**前提** ══════════════════════════════════════
describe('组 A：真 AppModule 的装配（否则 200/409 可能是在跟替身说话）', () => {
  it('引导端口是 Prisma 适配器（环境推断生效）', () => {
    assert.ok(
      app.get<OnboardingPort>(ONBOARDING_REPOSITORY) instanceof PrismaOnboardingRepository,
      '引导端口不是 Prisma 适配器 —— 组 D/F 的落库断言就只可能来自 501 替身'
    )
  })

  it('端口不是 501 替身（501 会让「未完成引导」看起来像一条业务规则）', () => {
    assert.equal(app.get<OnboardingPort>(ONBOARDING_REPOSITORY) instanceof NotImplementedOnboardingRepository, false)
  })
})


// ══ 组 B：读路径 —— 未同意也能打开引导页（否则第①步的同意按钮都渲染不出来）══
describe('组 B：GET /onboarding 在「未同意」下必须可用', () => {
  it('未同意的家长 ⇒ 200，onboarded:false，且三条 dbtest 模板都在', async () => {
    const res = await call('GET', '/onboarding', H.noConsent)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.onboarded, false)
    assert.equal(res.body.onboardedAt, null)
    assert.equal(res.body.ageBand, null)
    assert.deepEqual(res.body.focusAreas, [])

    const slugs = (res.body.templates as Array<{ slug: string }>).map((item) => item.slug)
    for (const slug of [ID.tplA, ID.tplB, ID.tplGone]) {
      assert.equal(slugs.includes(slug), true, `模板 ${slug} 不在列表里`)
    }
  })

  it('★ 读路径没有副作用：库里的三列仍是「未开始」（含未同意那个孩子）', async () => {
    const rows = await prisma.child.findMany({
      where: { id: { in: [ID.main, ID.stale, ID.noConsent] } },
      select: { onboardedAt: true, ageBand: true, focusAreas: true }
    })
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.equal(row.onboardedAt, null)
      assert.equal(row.ageBand, null)
      assert.deepEqual(row.focusAreas, [])
    }
    assert.equal(await prisma.pointRule.count({ where: { childId: { in: [ID.main, ID.stale, ID.noConsent] } } }), 0)
  })

  it('孩子视角 ⇒ 403（引导只给家长；与同意无关）', async () => {
    const res = await call('GET', '/onboarding', H.kid)
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'FORBIDDEN')
  })
})

// ══ 组 C：写路径的同意闸门 —— 在真库上，403 之后**一行都不能多** ══════════════
describe('组 C：未同意 ⇒ 写端点 403，且库内零副作用', () => {
  it('POST /onboarding/complete ⇒ 403 CONSENT_REQUIRED', async () => {
    const res = await call('POST', '/onboarding/complete', H.noConsent, {
      templateSlugs: [ID.tplA, ID.tplB],
      parentPin: PIN
    })
    assert.equal(res.status, 403, JSON.stringify(res.body))
    assert.equal(res.body.code, 'CONSENT_REQUIRED')
  })

  it('★ 闸门在**建库之前**：没有规则、没有版本行、没有审计、onboardedAt 仍 null', async () => {
    assert.equal(await prisma.pointRule.count({ where: { childId: ID.noConsent } }), 0)
    assert.equal(await prisma.pointRuleVersion.count({ where: { changedByUserId: ID.dad } }), 0)
    assert.equal(await prisma.auditLog.count({ where: { childId: ID.noConsent } }), 0)
    const child = await prisma.child.findUniqueOrThrow({
      where: { id: ID.noConsent },
      select: { onboardedAt: true, ageBand: true, focusAreas: true }
    })
    assert.deepEqual(child, { onboardedAt: null, ageBand: null, focusAreas: [] })
  })

  it('PATCH /onboarding/profile 同样 403（读豁免不等于写豁免）', async () => {
    const res = await call('PATCH', '/onboarding/profile', H.noConsent, {
      ageBand: 'primary_low',
      focusAreas: ['阅读']
    })
    assert.equal(res.status, 403, JSON.stringify(res.body))
    assert.equal(res.body.code, 'CONSENT_REQUIRED')
    const child = await prisma.child.findUniqueOrThrow({
      where: { id: ID.noConsent },
      select: { ageBand: true, focusAreas: true }
    })
    assert.deepEqual(child, { ageBand: null, focusAreas: [] })
  })
})


// ══ 组 D：草稿（PATCH profile）—— 落库、合并、幂等、排序 ═════════════════════════
// 三组用例对 `main` 有**顺序依赖**（D 存草稿 → E 完成 → F 拒绝重复），
// 这是刻意的：引导本来就是一条单向前进的流程，拆成互相独立的世界反而会掩盖
// 「第③步存的东西第⑤步还认得」这条要证明的事。
describe('组 D：草稿真的落库，且「未变不写审计」', () => {
  it('PATCH { ageBand, focusAreas } ⇒ 200，body 回读同一份状态', async () => {
    const res = await call('PATCH', '/onboarding/profile', H.dad, {
      ageBand: 'primary_low',
      focusAreas: ['阅读']
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.onboarded, false)
    assert.equal(res.body.ageBand, 'primary_low')
    assert.deepEqual(res.body.focusAreas, ['阅读'])
  })

  it('库里的三列真的变了（不是只在回包里）', async () => {
    const child = await prisma.child.findUniqueOrThrow({
      where: { id: ID.main },
      select: { ageBand: true, focusAreas: true, onboardedAt: true }
    })
    assert.equal(child.ageBand, 'primary_low')
    assert.deepEqual(child.focusAreas, ['阅读'])
    assert.equal(child.onboardedAt, null, '存草稿不等于完成引导')
  })

  it('审计 1 条 onboarding.profile_saved，before/after 都是完整二元组', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { childId: ID.main, action: 'onboarding.profile_saved' },
      select: { actorUserId: true, before: true, after: true, targetType: true, targetId: true }
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].actorUserId, ID.dad)
    assert.equal(rows[0].targetType, 'Child')
    assert.equal(rows[0].targetId, ID.main)
    assert.deepEqual(rows[0].before, { ageBand: null, focusAreas: [] })
    assert.deepEqual(rows[0].after, { ageBand: 'primary_low', focusAreas: ['阅读'] })
  })

  it('★ 相同值再 PATCH ⇒ 200 但**不写**审计（切换步骤重复提交不灌满审计）', async () => {
    const res = await call('PATCH', '/onboarding/profile', H.dad, {
      ageBand: 'primary_low',
      focusAreas: ['阅读']
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ageBand, 'primary_low')
    assert.equal(
      await prisma.auditLog.count({ where: { childId: ID.main, action: 'onboarding.profile_saved' } }),
      1
    )
  })

  it('省略 ageBand ⇒ 沿用旧值；只改 focusAreas ⇒ 审计第 2 条', async () => {
    const res = await call('PATCH', '/onboarding/profile', H.dad, {
      focusAreas: ['阅读', '运动']
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.ageBand, 'primary_low', 'undefined 不是「清空」')
    assert.deepEqual(res.body.focusAreas, ['阅读', '运动'])
    assert.equal(
      await prisma.auditLog.count({ where: { childId: ID.main, action: 'onboarding.profile_saved' } }),
      2
    )
  })

  it('GET 回读草稿，并按「关注点命中数」把 B 排在 A 前（排序而非过滤）', async () => {
    const res = await call('GET', '/onboarding', H.dad)
    assert.equal(res.status, 200)
    assert.equal(res.body.ageBand, 'primary_low')
    assert.deepEqual(res.body.focusAreas, ['阅读', '运动'])

    const slugs = (res.body.templates as Array<{ slug: string }>).map((item) => item.slug)
    const atA = slugs.indexOf(ID.tplA)
    const atB = slugs.indexOf(ID.tplB)
    assert.ok(atA >= 0 && atB >= 0, '两条 dbtest 模板都应出现')
    assert.ok(
      atB < atA,
      `命中 2 个关注点的 B 应排在命中 1 个的 A 之前（B=${atB}, A=${atA}）`
    )
  })
})


// ══ 组 E：完成引导 —— 模板「复制」成规则 + v1 版本行 + PIN 哈希 + 审计 ═════════
describe('组 E：POST /onboarding/complete 的五行落库', () => {
  let ruleIds: string[] = []

  it('不传 ageBand/focusAreas ⇒ 沿用草稿；规则顺序 = 提交顺序', async () => {
    const res = await call('POST', '/onboarding/complete', H.dad, {
      templateSlugs: [ID.tplB, ID.tplA],
      parentPin: PIN
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.childId, ID.main)
    assert.equal(typeof res.body.onboardedAt, 'string')

    const rules = res.body.rules as Array<{ ruleId: string; title: string; currentVersion: number }>
    assert.deepEqual(
      rules.map((rule) => rule.title),
      ['每天跳绳 200 下', '睡前读 15 分钟'],
      '顺序必须跟着家长点击的顺序，而不是模板库的 sortWeight'
    )
    assert.equal(rules.every((rule) => rule.currentVersion === 1), true)
    ruleIds = rules.map((rule) => rule.ruleId)
    assert.equal(new Set(ruleIds).size, 2)
  })

  it('★ 规则是模板的**副本**：七个字段逐一相等（不是只存标题）', async () => {
    const rows = await prisma.pointRule.findMany({
      where: { id: { in: ruleIds } },
      select: {
        id: true,
        title: true,
        condition: true,
        dailyLimit: true,
        points: true,
        direction: true,
        icon: true,
        color: true,
        currentVersion: true
      }
    })
    const byId = new Map(rows.map((row) => [row.id, row]))
    const expect = [
      { slug: ID.tplB, title: '每天跳绳 200 下', condition: '跳绳 200 下', points: 3, icon: '🪢', color: '#2FBF71' },
      { slug: ID.tplA, title: '睡前读 15 分钟', condition: '睡前阅读 15 分钟', points: 2, icon: '📖', color: '#4C6FFF' }
    ]
    expect.forEach((want, index) => {
      const row = byId.get(ruleIds[index])
      assert.ok(row !== undefined, `第 ${index} 条规则不存在`)
      assert.equal(row.title, want.title)
      assert.equal(row.condition, want.condition)
      assert.equal(row.points, want.points)
      assert.equal(row.icon, want.icon)
      assert.equal(row.color, want.color)
      assert.equal(row.dailyLimit, 1)
      assert.equal(row.direction, 'reward')
      assert.equal(row.currentVersion, 1)
    })
    // ★ 模板下架也不影响已建规则：clone 的意义就在这里。
    //   `try/finally` 不是洁癖：这条 UPDATE 若因断言失败留在库里，
    //   组 G「用 tplA 完成 stale」就会连带 404，把一个真因伪装成两个。
    await prisma.ruleTemplate.update({ where: { slug: ID.tplA }, data: { status: 'deleted' } })
    try {
      const survived = await prisma.pointRule.findUniqueOrThrow({ where: { id: ruleIds[1] } })
      assert.equal(survived.title, '睡前读 15 分钟')
      assert.equal(survived.points, 2)
    } finally {
      await prisma.ruleTemplate.update({ where: { slug: ID.tplA }, data: { status: 'active' } })
    }
  })

  it('每条规则一条 v1 版本行，changeNote 能追回 slug，changedBy = 家长', async () => {
    const rows = await prisma.pointRuleVersion.findMany({
      where: { ruleId: { in: ruleIds } },
      select: {
        ruleId: true,
        version: true,
        title: true,
        points: true,
        changedByUserId: true,
        changeNote: true
      }
    })
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.version, 1)
      assert.equal(row.changedByUserId, ID.dad)
      assert.equal((row.changeNote ?? '').startsWith('引导采纳模板：dbtest-'), true)
    }
    assert.deepEqual(
      rows.map((row) => `${row.ruleId}:${row.changeNote}`).sort(),
      [
        `${ruleIds[0]}:引导采纳模板：${ID.tplB}`,
        `${ruleIds[1]}:引导采纳模板：${ID.tplA}`
      ].sort()
    )
  })

  it('孩子三列同时落库：onboardedAt 非空 / ageBand / focusAreas = 草稿', async () => {
    const child = await prisma.child.findUniqueOrThrow({
      where: { id: ID.main },
      select: { onboardedAt: true, ageBand: true, focusAreas: true }
    })
    assert.equal(child.onboardedAt instanceof Date, true)
    assert.equal(child.ageBand, 'primary_low')
    assert.deepEqual(child.focusAreas, ['阅读', '运动'])
  })

  it('★ PIN 落成 scrypt 哈希：可验回、库里无明文、pinSetAt 有值', async () => {
    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.main, userId: ID.dad },
      select: { pinHash: true, pinSetAt: true }
    })
    assert.equal(typeof member.pinHash, 'string')
    assert.equal(member.pinHash?.startsWith('scrypt$'), true)
    assert.equal(member.pinHash?.includes(PIN), false, '明文出现在库里 —— 等于没设 PIN')
    assert.equal(member.pinSetAt instanceof Date, true)
    assert.equal(await verifyPin(PIN, member.pinHash ?? ''), true)
    assert.equal(await verifyPin('0000', member.pinHash ?? ''), false)
  })

  it('审计 1 条 onboarding.complete：ruleIds / templateSlugs 顺序 / pinSet，且不含 PIN', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { childId: ID.main, action: 'onboarding.complete' },
      select: { actorUserId: true, actorRole: true, before: true, after: true, targetType: true }
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].actorUserId, ID.dad)
    assert.equal(rows[0].actorRole, 'guardian')
    assert.equal(rows[0].targetType, 'Child')
    assert.deepEqual(rows[0].before, { onboardedAt: null, ageBand: 'primary_low', focusAreas: ['阅读', '运动'] })

    const after = rows[0].after as Record<string, unknown>
    assert.deepEqual(after.ruleIds, ruleIds)
    assert.deepEqual(after.templateSlugs, [ID.tplB, ID.tplA])
    assert.equal(after.pinSet, true)
    assert.equal(typeof after.onboardedAt, 'string')
    assert.equal(JSON.stringify(rows[0]).includes(PIN), false)
  })
})


// ══ 组 F：完成之后 —— 重复提交 409，草稿也关闸（引导是单向门）═════════════════
describe('组 F：完成后的写路径必须整片关掉', () => {
  it('重复 POST complete ⇒ 409 ONBOARDING_ALREADY_COMPLETED', async () => {
    const res = await call('POST', '/onboarding/complete', H.dad, {
      templateSlugs: [ID.tplA]
    })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.equal(res.body.code, 'ONBOARDING_ALREADY_COMPLETED')
  })

  it('★ 重复提交没有副作用：规则仍 2 条、版本行仍 2 条、审计仍 1 条', async () => {
    assert.equal(await prisma.pointRule.count({ where: { childId: ID.main } }), 2)
    assert.equal(
      await prisma.pointRuleVersion.count({
        where: { rule: { childId: ID.main } }
      }),
      2
    )
    assert.equal(await prisma.auditLog.count({ where: { childId: ID.main, action: 'onboarding.complete' } }), 1)
  })

  it('完成后再 PATCH profile ⇒ 409（不能借草稿端点改已采纳的画像）', async () => {
    const res = await call('PATCH', '/onboarding/profile', H.dad, {
      ageBand: 'junior_high',
      focusAreas: []
    })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assert.equal(res.body.code, 'ONBOARDING_ALREADY_COMPLETED')
    const child = await prisma.child.findUniqueOrThrow({
      where: { id: ID.main },
      select: { ageBand: true, focusAreas: true }
    })
    assert.deepEqual(child, { ageBand: 'primary_low', focusAreas: ['阅读', '运动'] })
  })

  it('GET ⇒ onboarded: true（前端据此跳过引导）', async () => {
    const res = await call('GET', '/onboarding', H.dad)
    assert.equal(res.status, 200)
    assert.equal(res.body.onboarded, true)
    assert.equal(typeof res.body.onboardedAt, 'string')
  })
})

// ══ 组 G：TEAM TOCTOU —— 提交瞬间模板下架 ⇒ 404 且零副作用 ═════════════════════
describe('组 G：模板在提交瞬间下架', () => {
  it('先把它下架（模拟「引导页加载时还在」）', async () => {
    await prisma.ruleTemplate.update({ where: { slug: ID.tplGone }, data: { status: 'deleted' } })
    assert.equal(
      (await prisma.ruleTemplate.findUniqueOrThrow({ where: { slug: ID.tplGone } })).status,
      'deleted'
    )
    // 下架即从列表消失 —— 组 B 里它是出现过的，两处一起才说明「下架」真的生效。
    const res = await call('GET', '/onboarding', H.stale)
    const slugs = (res.body.templates as Array<{ slug: string }>).map((item) => item.slug)
    assert.equal(slugs.includes(ID.tplGone), false)
  })

  it('POST complete 含已下架 slug ⇒ 404 ONBOARDING_TEMPLATE_NOT_AVAILABLE', async () => {
    const res = await call('POST', '/onboarding/complete', H.stale, {
      templateSlugs: [ID.tplA, ID.tplGone]
    })
    assert.equal(res.status, 404, JSON.stringify(res.body))
    assert.equal(res.body.code, 'ONBOARDING_TEMPLATE_NOT_AVAILABLE')
  })

  it('★ 全有或全无：一条规则都没建、版本行没有、onboardedAt 仍 null、无完成审计', async () => {
    const child = await prisma.child.findUniqueOrThrow({
      where: { id: ID.stale },
      select: { onboardedAt: true, ageBand: true, focusAreas: true }
    })
    assert.deepEqual(child, { onboardedAt: null, ageBand: null, focusAreas: [] })
    assert.equal(await prisma.pointRule.count({ where: { childId: ID.stale } }), 0)
    assert.equal(await prisma.auditLog.count({ where: { childId: ID.stale, action: 'onboarding.complete' } }), 0)
  })

  it('去掉下架那条后重试 ⇒ 200（402/404 不是「这个孩子永久不能完成」）', async () => {
    const res = await call('POST', '/onboarding/complete', H.stale, {
      templateSlugs: [ID.tplA]
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal((res.body.rules as unknown[]).length, 1)
    assert.equal(await prisma.pointRule.count({ where: { childId: ID.stale } }), 1)
    assert.equal(await prisma.auditLog.count({ where: { childId: ID.stale, action: 'onboarding.complete' } }), 1)
    // 省略 PIN ⇒ 没有 PIN 哈希（第⑥步可跳过，且不会被顺手设成空串）
    const member = await prisma.childMember.findFirstOrThrow({
      where: { childId: ID.stale, userId: ID.dad },
      select: { pinHash: true, pinSetAt: true }
    })
    assert.equal(member.pinHash, null)
    assert.equal(member.pinSetAt, null)
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { childId: ID.stale, action: 'onboarding.complete' },
      select: { after: true }
    })
    assert.equal((audit.after as Record<string, unknown>).pinSet, false)
  })
})


/**
 * approvals-db.dbtest.ts —— **真库 × 真 HTTP** 的审批/身份/屏障一矩阵（W2-D 起，W3-A 更新）
 *
 * ── 本文件守的是哪一个格子 ──────────────────────────────────────────────────
 *   仓库里另外两种测试各自诚实地只覆盖一半：
 *     · `test/*-http.test.ts` —— 真 HTTP，但世界**钉死**在无库；
 *     · `test-db/identity-db.dbtest.ts` —— 真库，但只验适配器，不发 HTTP。
 *   本文件 = **真库 ＋ 真 `AppModule` ＋ 真守卫链 ＋ 真 `fetch`**，
 *   断言的是**最终状态码、业务 code 与库里的行**。
 *
 * ── W3-A 起的变化（旧结论不要再读）──────────────────────────────────────────
 *   审批端口不再是 501：`ApprovalsModule.register({ hasDatabase: true })` 现在绑
 *   `PrismaApprovalsRepository`，所以「合法请求」这一格从 501 变成了**真的落库**。
 *   本文件只覆盖**不写账本**的路径：建 `pending`、拒绝、`invalidated`、`expired`。
 *   **会写 `PointRecord` 的执行路径在 `approvals-execution-db.dbtest.ts`**：
 *   账本行删不掉（I5 的 REVOKE ＋ `onDelete: Restrict`），所以那边的夹具永久留下。
 *
 * ── ★ 三条不能读过头的事 ────────────────────────────────────────────────────
 *   ① 202/409 都发生在**守卫全过之后**：身份、屏障一、屏障二各自都有拒绝用例
 *      排在前面，所以这里的码只能来自审批层，不是“没人拦所以默认放行”。
 *   ② `invalidated` / `expired` 是**要留下的历史**：接口回 409，但库里必须能看到
 *      终态行与 `autoReason`。若哪天回 409 而库里还是 `pending`，说明实现又在
 *      事务里抛异常、把刚写下的历史回滚了（客户端会永远重试同一条）。
 *   ③ 本文件只清**业务行**（`User / Child / ChildMember / DeviceSession / Wish /
 *      ApprovalRequest`）。`AuditLog` 的 `DELETE` 与 `UPDATE` 都被 REVOKE
 *      （`900_ledger_revoke.sql` 的 I5）—— 审计行**删不掉**，删 `Child` 时外键
 *      只能把它们的 `childId` 置空（`onDelete: SetNull`）。
 *      所以“清完审计计数为 0”是个**兑现不了的承诺**；这里改成两条真能验证的事：
 *        · 业务行归零（否则下一次运行的前提就脏了）；
 *        · 本轮写下的审计行**仍然存在**（只是不再挂孩子）—— 这正是
 *          “审计不可删改”的定义，而不是没扫干净。
 *      另外 `PointRecord` 必须为 0：本文件绝不写账本，出现流水说明执行路径漏了。
 *
 * 入口：`npm run test:db`（= `scripts/run-db-tests.mjs`；缺 `DATABASE_URL` 直接红）。
 * 只许对着**开发/实验库**跑（入口脚本里有 `NODE_ENV=production` 硬拒绝）。
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
import { DEVICE_SESSION_REPOSITORY, type DeviceSessionPort } from '../src/device-session/device-session.repository'
import { PrismaDeviceSessionRepository } from '../src/device-session/device-session.prisma.repository'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'
import { PrismaMembershipRepository } from '../src/membership/membership.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'
import { grantConsentFor } from './support/consent-fixture'

/** 本轮运行的唯一前缀 —— 每次跑都是“新孩子、新设备、新成员位”，与历史数据互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  dad: `dbtest-${RUN}-dad`,
  kid: `dbtest-${RUN}-kid`,
  stranger: `dbtest-${RUN}-stranger`,
  childP: `dbtest-${RUN}-p`,
  childR: `dbtest-${RUN}-r`,
  devDad: `dbtest-${RUN}-dev-dad`,
  devKid: `dbtest-${RUN}-dev-kid`,
  devDadR: `dbtest-${RUN}-dev-dad-r`,
  devExpired: `dbtest-${RUN}-dev-expired`,
  devStranger: `dbtest-${RUN}-dev-stranger`,
  devUnknown: `dbtest-${RUN}-dev-unknown`,
  // 心愿夹具：每个用例一条，避免“上一条用例把状态改了”这种顺序耦合。
  wishMain: `dbtest-${RUN}-wish-main`,
  wishInsuff: `dbtest-${RUN}-wish-insuff`,
  wishDel: `dbtest-${RUN}-wish-del`,
  wishExpire: `dbtest-${RUN}-wish-expire`,
  /** 已兑换过的心愿（`redeemed: true`）—— 只用于 409 `WISH_ALREADY_REDEEMED` 那格。 */
  wishDone: `dbtest-${RUN}-wish-done`,
  wishR: `dbtest-${RUN}-wish-r`
} as const

/** 请求头 = 身份的**全部**输入（客户端不再自报角色，W1-C）。 */
const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.childP },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.childP },
  dadR: { 'x-kp-device-id': ID.devDadR, 'x-kp-child-id': ID.childR },
  expired: { 'x-kp-device-id': ID.devExpired, 'x-kp-child-id': ID.childP },
  stranger: { 'x-kp-device-id': ID.devStranger, 'x-kp-child-id': ID.childP },
  unknown: { 'x-kp-device-id': ID.devUnknown, 'x-kp-child-id': ID.childP },
  deviceOnly: { 'x-kp-device-id': ID.devDad }
} as const

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

let prisma: PrismaService
let app: INestApplication
let url = ''
/** 夹具写成功了吗 —— 没写成功就不该去“清理”，否则 `after` 会用假错误盖住真错误。 */
let seeded = false

/** 发一条真 HTTP 请求；响应体尽力按 JSON 解析（400 是管道给的，形状与业务错误不同）。 */
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

/**
 * 夹具（形状刻意做全）：
 *   · child P：dad=guardian(active)、kid=child(active)；stranger **没有**成员位
 *   · child R：dad=guardian(**removed**) —— 与“没有成员位”必须分成两种 403
 *   · 会话：dad/kid/stranger 各一行（stranger 有会话但无成员位 ⇒ 屏障一要自己说话）、
 *           dad 在 R 上一行、以及一行**已过期**的 guardian（TTL 降级用）
 *   · 心愿：child P 五条（主用例 / 余额不足 / 待删除 / 待过期 / **已兑换**），child R 一条（越权用）
 *   · child P 的 `pointsBalance` 保持 0：本文件**不执行**兑换（执行路径另见
 *     `approvals-execution-db.dbtest.ts`），所以“余额不足”是这里的正常前提，
 *     而不是靠某个用例偷偷改余额制造出来的。
 */
async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)
  const past = new Date(Date.now() - 60 * 60_000)
  await prisma.child.createMany({
    data: [
      { id: ID.childP, name: `审批 DB 套件 ${RUN} P` },
      { id: ID.childR, name: `审批 DB 套件 ${RUN} R` }
    ]
  })
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: 'DB 套件家长' },
      { id: ID.kid, displayName: 'DB 套件孩子' },
      { id: ID.stranger, displayName: 'DB 套件陌生人' }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.childP, userId: ID.dad, role: 'guardian' },
      { childId: ID.childP, userId: ID.kid, role: 'child' },
      { childId: ID.childR, userId: ID.dad, role: 'guardian', status: 'removed', removedAt: new Date() }
    ]
  })
  // ★ W7-A 起写端点都过 ConsentGuard：只给**会走写路径**的 childP 授权。
  //   childR 的成员是 `removed` —— 那个 403 由屏障一先给，不该被同意状态掩盖。
  await grantConsentFor(prisma, [[ID.childP, ID.dad]])
  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.childP, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.childP, userId: ID.kid, activeRole: 'child', expiresAt: future },
      { deviceId: ID.devDadR, childId: ID.childR, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devExpired, childId: ID.childP, userId: ID.dad, activeRole: 'guardian', expiresAt: past },
      {
        deviceId: ID.devStranger,
        childId: ID.childP,
        userId: ID.stranger,
        activeRole: 'guardian',
        expiresAt: future
      }
    ]
  })
  await prisma.wish.createMany({
    data: [
      { id: ID.wishMain, childId: ID.childP, title: '乐高积木', cost: 30, emoji: '🧱' },
      { id: ID.wishInsuff, childId: ID.childP, title: '遥控车', cost: 30, emoji: '🚗' },
      { id: ID.wishDel, childId: ID.childP, title: '贴纸', cost: 20, emoji: '✨' },
      { id: ID.wishExpire, childId: ID.childP, title: '漫画书', cost: 40, emoji: '📚' },
      // `redeemed: true` 是**历史事实**（兑换已经发生过），不是本文件执行的结果 ——
      // 本文件不碰账本，`cleanup` 会复核 `PointRecord` 计数为 0。
      { id: ID.wishDone, childId: ID.childP, title: '生日蛋糕', cost: 25, emoji: '🎂', redeemed: true },
      { id: ID.wishR, childId: ID.childR, title: '别人的心愿', cost: 10, emoji: '🎁' }
    ]
  })

  // 独立复核：夹具**真的**进了库 —— 否则下面的断言可能只是“恰好也过”（D12 家族的老毛病）
  assert.equal(await prisma.child.count({ where: { id: { in: [ID.childP, ID.childR] } } }), 2)
  assert.equal(await prisma.childMember.count({ where: { childId: { in: [ID.childP, ID.childR] } } }), 3)
  assert.equal(await prisma.deviceSession.count({ where: { childId: { in: [ID.childP, ID.childR] } } }), 5)
  assert.equal(await prisma.wish.count({ where: { childId: { in: [ID.childP, ID.childR] } } }), 6)
  // 夹具里的 `redeemed` 真的落库了（否则 409 用例只是“恰好也过”）
  assert.equal((await prisma.wish.findUniqueOrThrow({ where: { id: ID.wishDone } })).redeemed, true)
}

/**
 * 只删**业务行**：`AuditLog` 的 `DELETE` 被 REVOKE（文件头 ③），审计行删不掉；
 * 删 `Child` 时外键把它们 `childId` 置空，行本身留作“不可删改”的证据。
 */
async function cleanup(): Promise<void> {
  const auditIds = (
    await prisma.auditLog.findMany({
      where: { childId: { in: [ID.childP, ID.childR] } },
      select: { id: true }
    })
  ).map((row) => row.id)
  assert.ok(
    auditIds.length > 0,
    '本轮一条审计都没写 —— 组 E 里的 approval.* 断言本该先红，“审计仍在”也就无从验证'
  )

  // ★ 这里**没有** `auditLog.deleteMany`：在真库上它是 42501（permission denied）。
  //   曾经的“自清理”承诺从 W3-A 起就不成立 —— 审批一落库就写审计，而审计删不掉。
  await prisma.approvalRequest.deleteMany({ where: { childId: { in: [ID.childP, ID.childR] } } })
  await prisma.wish.deleteMany({ where: { childId: { in: [ID.childP, ID.childR] } } })
  await prisma.deviceSession.deleteMany({ where: { childId: { in: [ID.childP, ID.childR] } } })
  await prisma.childMember.deleteMany({ where: { childId: { in: [ID.childP, ID.childR] } } })
  await prisma.child.deleteMany({ where: { id: { in: [ID.childP, ID.childR] } } })
  await prisma.user.deleteMany({ where: { id: { in: [ID.dad, ID.kid, ID.stranger] } } })

  const left = {
    child: await prisma.child.count({ where: { id: { in: [ID.childP, ID.childR] } } }),
    member: await prisma.childMember.count({ where: { childId: { in: [ID.childP, ID.childR] } } }),
    session: await prisma.deviceSession.count({ where: { childId: { in: [ID.childP, ID.childR] } } }),
    user: await prisma.user.count({ where: { id: { in: [ID.dad, ID.kid, ID.stranger] } } }),
    wish: await prisma.wish.count({ where: { childId: { in: [ID.childP, ID.childR] } } }),
    approval: await prisma.approvalRequest.count({ where: { childId: { in: [ID.childP, ID.childR] } } }),
    // `childId` 已被外键置空 ⇒ 这里必须是 0（“没有仍挂在这个孩子上的审计行”），
    // 而不是“审计行没了”—— 行一定还在，见下面的 id 复核。
    audit: await prisma.auditLog.count({ where: { childId: { in: [ID.childP, ID.childR] } } }),
    // ★ 本文件**不该**写账本；若这里不是 0，说明执行路径漏进了不写账本的分支，
    //   清理也就会在 Child 上撞到 `onDelete: Restrict`（下一次运行的前提直接脏掉）。
    record: await prisma.pointRecord.count({ where: { childId: { in: [ID.childP, ID.childR] } } })
  }
  assert.deepEqual(
    left,
    { child: 0, member: 0, session: 0, user: 0, wish: 0, approval: 0, audit: 0, record: 0 },
    '夹具没清干净 —— 下一次运行的前提就脏了'
  )

  // ★ 审计行**必须还在**：删 Child 只触发 `ON DELETE SET NULL`，行本身不可删。
  //   若这里少了，说明 I5 的 REVOKE 失效、或外键被改成了 Cascade 之外的东西。
  assert.equal(
    await prisma.auditLog.count({ where: { id: { in: auditIds } } }),
    auditIds.length,
    '审计行随着 Child 一起消失了 —— 不可删改的审计链被破坏（I5）'
  )
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()
  seeded = true

  // ★ 刻意**不传**任何 `hasDatabase`：要验的正是**生产那条路**（由 `DATABASE_URL` 推断）。
  //   这也是本文件与离线 HTTP 用例最根本的区别 —— 那边必须把世界钉死，这边必须是真世界。
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = moduleRef.createNestApplication()
  applyGlobalPipes(app) // 与 main.ts 共用同一函数
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()
})

// ══ 组 A：装配 —— 下面所有断言的**前提** ══════════════════════════════════════
describe('组 A：真 AppModule 的装配（否则下面的 202/409 可能是在跟替身说话）', () => {
  it('三个端口都是 Prisma 适配器（环境推断生效）', () => {
    assert.ok(
      app.get<DeviceSessionPort>(DEVICE_SESSION_REPOSITORY) instanceof PrismaDeviceSessionRepository,
      '身份端口不是 Prisma 适配器 —— HTTP 请求会在 501 上停住，本文件的每个 401/403 都失去意义'
    )
    assert.ok(
      app.get<MembershipPort>(MEMBERSHIP_REPOSITORY) instanceof PrismaMembershipRepository,
      '屏障一端口不是 Prisma 适配器 —— 403 的两种 code 就永远不会在真数据上出现'
    )
    assert.ok(
      app.get<object>(APPROVALS_REPOSITORY) instanceof PrismaApprovalsRepository,
      '审批端口不是 Prisma 适配器 —— 组 E 的 202/409 就只可能来自 501 替身，W3-A 根本没接上'
    )
  })
})

// ══ 组 B：身份层（W1-C 的语义在**真库**上同样成立）════════════════════════════
describe('组 B：身份层 —— 真查 `DeviceSession`', () => {
  it('缺 `x-kp-device-id` / `x-kp-child-id` ⇒ 401 `UNAUTHENTICATED`（身份不完整 ≠ 匿名 child）', async () => {
    const both = await send('/approvals', { body: { action: 'redeem' } })
    assert.equal(both.status, 401, '没有身份头却进了业务层 —— 身份层被跳过了')
    assert.equal(both.body.code, 'UNAUTHENTICATED')

    const deviceOnly = await send('/approvals', { body: { action: 'redeem' }, headers: H.deviceOnly })
    assert.equal(deviceOnly.status, 401, '缺孩子上下文却放行了 —— “在哪个孩子档案上”不是可选项')
    assert.equal(deviceOnly.body.code, 'UNAUTHENTICATED')
  })

  it('★ 未登记设备 ⇒ 401 `SESSION_NOT_FOUND`（**不是 501**）', async () => {
    const r = await send('/approvals', { body: { action: 'redeem' }, headers: H.unknown })
    assert.equal(
      r.status,
      401,
      `未登记设备拿到 ${r.status} —— 若仍是 501，说明有库世界根本没查库（装配没接上）`
    )
    assert.equal(
      r.body.code,
      'SESSION_NOT_FOUND',
      '「查不到会话」必须与「无库端口未实现」分开报：前者是身份问题，后者是配置问题'
    )
  })
})

// ══ 组 C：屏障一（两种 403 必须在真数据上分得开）══════════════════════════════
describe('组 C：屏障一 —— 真查 `ChildMember`', () => {
  it('有会话、**没有成员位** ⇒ 403 `MEMBER_NOT_FOUND`', async () => {
    const r = await send('/approvals', { body: { action: 'redeem' }, headers: H.stranger })
    assert.equal(r.status, 403, '没有成员位却放行了 —— 屏障一没跑或跑在矩阵之后')
    assert.equal(
      r.body.code,
      'MEMBER_NOT_FOUND',
      `拿到 ${String(r.body.code)}：若为 MEMBER_REMOVED，说明适配器把“从未加入”说成了“已被移出”`
    )
  })

  it('成员位 `status=removed` ⇒ 403 `MEMBER_REMOVED`（不是 `MEMBER_NOT_FOUND`）', async () => {
    const r = await send('/approvals', { body: { action: 'redeem' }, headers: H.dadR })
    assert.equal(r.status, 403)
    assert.equal(
      r.body.code,
      'MEMBER_REMOVED',
      `拿到 ${String(r.body.code)}：若为 MEMBER_NOT_FOUND，说明适配器把 removed 行筛掉了 —— 这条语义在生产里就从未发生过`
    )
  })
})

// ══ 组 D：屏障二 ＋ TTL 降级 ═══════════════════════════════════════════════════
describe('组 D：屏障二 ＋ TTL（过期是**降级**，不是“查不到”）', () => {
  it('child 批准（矩阵 `review_approvals` = DENY）⇒ 403 `FORBIDDEN`', async () => {
    const r = await send(`/approvals/${ID.wishMain}/decide`, {
      body: { decision: 'approved' },
      headers: H.kid
    })
    assert.equal(
      r.status,
      403,
      `孩子批准拿到 ${r.status}：若是 401/501，说明会话或成员位没被读到 —— 屏障二根本没机会执行`
    )
    assert.equal(r.body.code, 'FORBIDDEN')
    // 屏障二在**业务层之前**：否则会变成 404（没有这条）或 400（id 不是审批 id）
    assert.notEqual(r.body.code, 'APPROVAL_NOT_FOUND', '矩阵没拦住，请求进了业务层')
  })

  it('★ 过期 guardian 批准 ⇒ 403 `FORBIDDEN`（**不是** 401 `SESSION_NOT_FOUND`）', async () => {
    const r = await send(`/approvals/${ID.wishMain}/decide`, {
      body: { decision: 'approved' },
      headers: H.expired
    })
    assert.equal(
      r.status,
      403,
      `过期会话拿到 ${r.status}：401 说明 TTL 被实现成“查不到”（把降级做成了拒绝），` +
        '那会让孩子的设备到期后连“看自己积分”都做不了'
    )
    assert.equal(
      r.body.code,
      'FORBIDDEN',
      `拿到 ${String(r.body.code)}：过期的 guardian 必须回落成 child，再被矩阵拒绝`
    )
  })
})

// ══ 组 E：审批落库（**真 Prisma**）—— 只覆盖不写账本的路径 ═════════════════════
/**
 * 这一组守的是 W3-A 最容易“看起来装好了”的地方：
 *   · 202 之后**库里真的有一行** `pending`（而不是只回了个 JSON）；
 *   · `invalidated` / `expired` 回 409，但**行必须留下**（历史不能被事务回滚掉）；
 *   · 失败的路径**不写账本**（`PointRecord` 计数由 `cleanup` 兜底复核）。
 *
 * 会扣分、会写流水、会改 `Child.pointsBalance` 的用例全部在
 * `approvals-execution-db.dbtest.ts` —— 这里若出现 0 以外的流水计数，
 * 说明分叉漏了（`cleanup` 会当场红）。
 */
describe('组 E：审批落库 —— 建 pending / 拒绝 / 无效 / 过期', () => {
  let pendingMainId = ''

  it('★ 孩子申请兑换 ⇒ 202 ＋ 库里一行 `pending`（payload 是**当时**的价格快照）', async () => {
    const r = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishMain }, headers: H.kid })

    assert.equal(r.status, 202, `合法申请拿到 ${r.status}：501 说明端口还是替身；400 说明形状/动作被拒`)
    assert.equal(r.body.status, 'pending')
    assert.equal(r.body.action, 'redeem')
    assert.equal(r.body.autoReason, null, 'pending 行不该带 autoReason —— 那是 invalidated 的专属字段')

    pendingMainId = String(r.body.id)
    assert.ok(pendingMainId.length > 0, '响应里没有审批 id —— 客户端无法再调 decide')

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pendingMainId } })
    assert.equal(row.childId, ID.childP, '审批挂到了别的孩子上 —— childId 必须来自 Guard 验过的头，不是请求体')
    assert.equal(row.requesterUserId, ID.kid)
    assert.equal(row.requesterRole, 'child')
    assert.equal(row.actionType, 'redeem')
    assert.equal(row.status, 'pending')
    assert.deepEqual(
      row.payload,
      { wishId: ID.wishMain, titleSnapshot: '乐高积木', costSnapshot: 30 },
      'payload 快照不对 —— 家长 3 小时后同意时必须按孩子申请时看到的价格扣分（02 §4.3）'
    )

    const ttl = row.expiresAt.getTime() - Date.now()
    assert.ok(
      ttl > 71.9 * 3600_000 && ttl < 72.1 * 3600_000,
      `TTL 是 ${(ttl / 3600_000).toFixed(2)}h，不是 72h —— 过期口径漂了（02 §4.3）`
    )

    assert.equal(
      await prisma.auditLog.count({ where: { targetId: pendingMainId, action: 'approval.requested' } }),
      1,
      '建请求没有留下 approval.requested —— 审计与业务写入不在同一事务？'
    )
  })

  it('`redeem` 不带 targetId ⇒ 400 `APPROVAL_TARGET_REQUIRED`，且**不建行**', async () => {
    const before = await prisma.approvalRequest.count({ where: { childId: ID.childP } })
    const r = await send('/approvals', { body: { action: 'redeem' }, headers: H.dad })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'APPROVAL_TARGET_REQUIRED')
    assert.equal(
      await prisma.approvalRequest.count({ where: { childId: ID.childP } }),
      before,
      '被拒的请求留下了行 —— “拒掉”必须发生在落库之前'
    )
  })

  it('★ 拿**别的孩子**的心愿 id ⇒ 404 `WISH_NOT_FOUND`（不泄露“那个孩子有这件心愿”）', async () => {
    const r = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishR }, headers: H.dad })
    assert.equal(r.status, 404)
    assert.equal(
      r.body.code,
      'WISH_NOT_FOUND',
      `拿到 ${String(r.body.code)}：403 等于承认“这个 id 存在但不属于你”—— 越权探测的口子`
    )
  })

  /**
   * W5-C：双端的兑换入口都走 `POST /approvals`，因此这个 409 是**客户端唯一能看见的**
   * 「别重复兑换」信号 —— 两端 `write_api_errors` 直接按 code 翻文案。
   *
   * 钉住三件事：
   *   ① 状态码是 409 ＋ `WISH_ALREADY_REDEEMED`（不是 400/404，客户端按 409 分流）；
   *   ② **不建审批行** —— 建一条 pending 等于让家长再批一次、再扣一次分；
   *   ③ 拒绝发生在快照阶段，所以**不写账本**（`cleanup` 会复核 `PointRecord` 为 0）。
   */
  it('★ 兑换一个**已经兑换过**的心愿 ⇒ 409 `WISH_ALREADY_REDEEMED`，且不建审批行', async () => {
    const before = await prisma.approvalRequest.count({ where: { childId: ID.childP } })

    const r = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishDone }, headers: H.kid })

    assert.equal(
      r.status,
      409,
      `重复兑换拿到 ${r.status}：400 会让客户端以为“请求写错了”，404 会让孩子以为心愿没了`
    )
    assert.equal(r.body.code, 'WISH_ALREADY_REDEEMED')
    assert.equal(
      await prisma.approvalRequest.count({ where: { childId: ID.childP } }),
      before,
      '被拒的重复兑换留下了审批行 —— 家长会收到一条注定重复扣分的申请'
    )
    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.childP } }),
      0,
      '重复兑换产生了流水 —— 本文件不该写账本，写出来说明快照校验在扣分之后'
    )
    // 心愿本身保持已兑换状态，不被这次失败请求改动
    assert.equal((await prisma.wish.findUniqueOrThrow({ where: { id: ID.wishDone } })).redeemed, true)
  })

  it('没有执行器的动作 ⇒ 400 `APPROVAL_ACTION_NOT_EXECUTABLE`（不落一条永远批不动的 pending）', async () => {
    const before = await prisma.approvalRequest.count({ where: { childId: ID.childP } })
    const r = await send('/approvals', { body: { action: 'add_rule' }, headers: H.dad })
    assert.equal(r.status, 400)
    assert.equal(r.body.code, 'APPROVAL_ACTION_NOT_EXECUTABLE')
    assert.equal(
      await prisma.approvalRequest.count({ where: { childId: ID.childP } }),
      before,
      '不可执行的动作仍建了 pending —— 用户会等一个永远不会来的批准'
    )
  })

  it('★ 拒绝 ⇒ 200 `rejected`；再拒一次 ⇒ 409 `ALREADY_DECIDED`（第二次不许覆盖）', async () => {
    const first = await send(`/approvals/${pendingMainId}/decide`, {
      body: { decision: 'rejected' },
      headers: H.dad
    })
    assert.equal(first.status, 200)
    assert.equal(first.body.status, 'rejected')
    assert.equal(first.body.decidedByUserId, ID.dad)
    assert.equal(first.body.selfApproved, false)

    const second = await send(`/approvals/${pendingMainId}/decide`, {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(second.status, 409)
    assert.equal(
      second.body.code,
      'ALREADY_DECIDED',
      '第二次决出没被挡住 —— 双击“同意”会变成重复扣分（02 §4.4 / §9.10）'
    )

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: pendingMainId } })
    assert.equal(row.status, 'rejected', '终态被覆盖了 —— 第一次的决定必须永远保留')
    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.childP } }),
      0,
      '拒绝也写了流水 —— 拒绝是“不执行”，不是“记一笔 0 分”'
    )
    assert.equal(
      await prisma.auditLog.count({ where: { targetId: pendingMainId, action: 'approval.rejected' } }),
      1
    )
  })

  it('★ 余额不足时批准 ⇒ 409 `APPROVAL_INVALIDATED` ＋ 库里留 `INSUFFICIENT_POINTS`（不是 500）', async () => {
    const created = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishInsuff }, headers: H.kid })
    assert.equal(created.status, 202)
    const id = String(created.body.id)

    const r = await send(`/approvals/${id}/decide`, { body: { decision: 'approved' }, headers: H.dad })
    assert.equal(r.status, 409, `余额 0 却批成功了（${r.status}）—— 那会扣出负分`)
    assert.equal(r.body.code, 'APPROVAL_INVALIDATED')
    assert.equal(r.body.autoReason, 'INSUFFICIENT_POINTS')
    assert.equal(r.body.approvalId, id)

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal(row.status, 'invalidated', '409 之后行没落成 invalidated —— 历史被事务回滚了')
    assert.equal(row.autoReason, 'INSUFFICIENT_POINTS')
    assert.equal(row.decidedByUserId, ID.dad, 'invalidated 也要记得是谁点的批准（不是“系统拒绝”）')

    assert.equal(
      await prisma.auditLog.count({ where: { targetId: id, action: 'approval.invalidated' } }),
      1
    )
    assert.equal(
      await prisma.pointRecord.count({ where: { childId: ID.childP } }),
      0,
      '余额不足仍然写了流水 —— 账本会出现负余额'
    )
    assert.equal((await prisma.child.findUniqueOrThrow({ where: { id: ID.childP } })).pointsBalance, 0)
  })

  it('★ 心愿在批准前被删 ⇒ 409 `APPROVAL_INVALIDATED` ＋ `WISH_DELETED`（审查的是**批准那一刻**）', async () => {
    const created = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishDel }, headers: H.kid })
    assert.equal(created.status, 202)
    const id = String(created.body.id)

    await prisma.wish.update({
      where: { id: ID.wishDel },
      data: { status: 'deleted', deletedAt: new Date() }
    })

    const r = await send(`/approvals/${id}/decide`, { body: { decision: 'approved' }, headers: H.dad })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'APPROVAL_INVALIDATED')
    assert.equal(
      r.body.autoReason,
      'WISH_DELETED',
      `拿到 ${String(r.body.autoReason)}：UI 必须能区分“心愿没了”与“家长不同意”（02 §4.2）`
    )

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal(row.status, 'invalidated')
    assert.equal(row.autoReason, 'WISH_DELETED')
  })

  it('★ TTL 到期 ⇒ 409 `APPROVAL_EXPIRED`，库里留 `expired`（惰性过期也要有历史）', async () => {
    const created = await send('/approvals', { body: { action: 'redeem', targetId: ID.wishExpire }, headers: H.kid })
    assert.equal(created.status, 202)
    const id = String(created.body.id)

    // 把 TTL 拨到过去（等价于扫描任务已跑过）—— 只改这一行，不影响别的用例。
    await prisma.approvalRequest.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) }
    })

    const r = await send(`/approvals/${id}/decide`, { body: { decision: 'approved' }, headers: H.dad })
    assert.equal(r.status, 409)
    assert.equal(r.body.code, 'APPROVAL_EXPIRED')
    assert.equal(r.body.status, 'expired')

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id } })
    assert.equal(row.status, 'expired', '过期回 409 但行还是 pending —— 客户端会永远重试同一条')
    assert.equal(
      await prisma.auditLog.count({ where: { targetId: id, action: 'approval.expired' } }),
      1,
      '过期没有审计 —— 之后没人能解释“这条为什么没批成”'
    )
  })

  it('批准一条**不存在**的审批 ⇒ 404 `APPROVAL_NOT_FOUND`（不是 501，也不是 500）', async () => {
    const r = await send(`/approvals/dbtest-${RUN}-missing/decide`, {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(r.status, 404, `不存在的审批拿到 ${r.status}：501 说明请求没进适配器`)
    assert.equal(r.body.code, 'APPROVAL_NOT_FOUND')
  })

  it('★ body 带多余键 ⇒ 400（**不是业务 code**）—— 管道先于端口', async () => {
    const r = await send('/approvals', {
      body: { action: 'redeem', targetId: ID.wishMain, foo: 5 },
      headers: H.dad
    })
    assert.equal(
      r.status,
      400,
      `多余键拿到 ${r.status}：若进了业务层，说明 ValidationPipe 的 forbidNonWhitelisted 没生效`
    )
    assert.equal(r.body.statusCode, 400, '400 必须来自 ValidationPipe（它有 statusCode，没有业务 code）')
    assert.equal(
      r.body.code,
      undefined,
      '这个 400 不该带业务 code —— 形状校验与“权限/成员/端口”是不同层的错误'
    )
  })
})

// ══ 组 F：世界口径 —— “无库”只在子模块/用例里存在 ══════════════════════════════
describe('组 F：世界口径', () => {
  it('★ 空 `DATABASE_URL` ⇒ 真 AppModule **起不来**且点名 DATABASE_URL（生产不静默落 501）', async () => {
    const previous = process.env.DATABASE_URL
    process.env.DATABASE_URL = ''
    try {
      await assert.rejects(
        () => Test.createTestingModule({ imports: [AppModule] }).compile(),
        (err: unknown) => {
          assert.match(
            String(err),
            /DATABASE_URL 未设置/,
            '缺连接串时抛的不是那条可读的错误 —— 生产部署会得到一个莫名其妙的启动失败'
          )
          return true
        },
        '空 DATABASE_URL 时真 AppModule 竟然建起来了 —— 若它静默绑到 501 实现，生产会以“每请求 501”的样子活着'
      )
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })
})

after(async () => {
  // ★ 三步都要能独立失败：`before` 中途炸掉时，`app`/`seeded` 可能是空的，
  //   此时再无条件 `app.close()` 只会抛出 "reading 'close'" 这种**盖住真因**的错误。
  if (app !== undefined) await app.close()
  if (seeded) await cleanup()
  if (prisma !== undefined) await prisma.$disconnect()
})

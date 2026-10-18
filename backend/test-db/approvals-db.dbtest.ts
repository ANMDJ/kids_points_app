/**
 * approvals-db.dbtest.ts —— **真库 × 真 HTTP** 的审批/身份/屏障一矩阵（W2-D 补洞）
 *
 * ── 这个文件补的是哪一个洞（读清楚，否则会被当成"重复用例"）──────────────────
 *   本仓库此前有两种测试，各自都诚实地**只覆盖一半**：
 *     · `test/*-http.test.ts` —— 真 HTTP，但世界**钉死**在无库
 *       （`register({ hasDatabase: false })`）⇒ 验的是 501；
 *     · `test-db/identity-db.dbtest.ts` —— 真库，但只验**适配器/装配**，不发 HTTP。
 *   ⇒ **"有库 ＋ 真 HTTP"这个格子从来没有人守**。文档里"成员查询落地后
 *     错误码回到 403/400"这句话，也正是因为这一格空着才只能写成**预期**。
 *   本文件就是那一格：真 `AppModule`（真 Prisma ＋ 真守卫链 ＋ 真全局管道）
 *   ＋ 真实夹具行 ＋ 真 `fetch` ⇒ 断言的是**最终状态码与 code**。
 *
 * ── 它与离线 HTTP 用例的断言**刻意不同**（别把两处对齐，那会毁掉证据）──────
 *   同一条请求在两个世界里**必须**给出不同的响亮：
 *     | 场景 | 无库（`test/approvals-http.test.ts`） | 有库（本文件） |
 *     | 会话查不到 | 501 `SESSION_LOOKUP_NOT_IMPLEMENTED` | 401 `SESSION_NOT_FOUND` |
 *     | 无成员位 | 501 `MEMBERSHIP_QUERY_NOT_IMPLEMENTED`（被替身绕过） | 403 `MEMBER_NOT_FOUND` |
 *     | 成员位 removed | 同上 | 403 `MEMBER_REMOVED` |
 *     | 合法请求 | 501 `APPROVALS_PERSISTENCE_NOT_IMPLEMENTED` | **同样 501**（★ 本文件最重要的一条） |
 *     | body 多余键 | 400（管道） | **400（管道）**“成员查询落地后回到 400”的有库半边 |
 *
 * ── ★ 三件不能读过头的事 ────────────────────────────────────────────────────
 *   ① **501 不是"没接线"**：第 8/10 条之前，身份、屏障一、屏障二**全都真的跑过并放行**
 *      （前面的用例已分别证明它们各自会拒绝），所以那个 501 只能来自 `ApprovalsPort`；
 *      用例里另有一条 `instanceof NotImplementedApprovalsRepository` 把它钉死。
 *   ② **"无库装配"只在子模块/用例层面存在**：真 `AppModule` 恒 `imports: [PrismaModule]`
 *      ⇒ 空 `DATABASE_URL` 时应用**起不来**（`PrismaService` 构造即抛错）。组 F 把这条
 *      钉住 —— 它不是缺陷，而是"生产不许静默落在 501 世界"的响亮失败。
 *   ③ 本文件**会清理自己**（与 `ledger-db.dbtest.ts` 相反）：只写 `User/Child/ChildMember/
 *      DeviceSession` 四张表，没有 `PointRecord` ⇒ 级联删得掉。用例结束复核计数为 0，
 *      否则会污染下一次运行（"链从 0 开始"这个前提就没了）。
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
import { APPROVALS_REPOSITORY, NotImplementedApprovalsRepository } from '../src/approvals/approvals.repository'
import { DEVICE_SESSION_REPOSITORY, type DeviceSessionPort } from '../src/device-session/device-session.repository'
import { PrismaDeviceSessionRepository } from '../src/device-session/device-session.prisma.repository'
import { MEMBERSHIP_REPOSITORY, type MembershipPort } from '../src/membership/membership.repository'
import { PrismaMembershipRepository } from '../src/membership/membership.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 —— 每次跑都是"新孩子、新设备、新成员位"，与历史数据互不干扰。 */
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
  devUnknown: `dbtest-${RUN}-dev-unknown`
}

/** 请求头 = 身份的**全部**输入（客户端不再自报角色，W1-C）。 */
const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.childP },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.childP },
  dadR: { 'x-kp-device-id': ID.devDadR, 'x-kp-child-id': ID.childR },
  expired: { 'x-kp-device-id': ID.devExpired, 'x-kp-child-id': ID.childP },
  stranger: { 'x-kp-device-id': ID.devStranger, 'x-kp-child-id': ID.childP },
  unknown: { 'x-kp-device-id': ID.devUnknown, 'x-kp-child-id': ID.childP },
  deviceOnly: { 'x-kp-device-id': ID.devDad }
}

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

let prisma: PrismaService
let app: INestApplication
let url = ''
/** 夹具写成功了吗 —— 没写成功就不该去"清理"，否则 `after` 会用假错误盖住真错误。 */
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
 * 夹具（四张表，形状刻意做全）：
 *   · child P：dad=guardian(active)、kid=child(active)；stranger **没有**成员位
 *   · child R：dad=guardian(**removed**) —— 与"没有成员位"必须分成两种 403
 *   · 会话：dad/kid/stranger 各一行（stranger 有会话但无成员位 ⇒ 屏障一要自己说话）、
 *           dad 在 R 上一行、以及一行**已过期**的 guardian（TTL 降级用）
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

  // 独立复核：夹具**真的**进了库 —— 否则下面的断言可能只是"恰好也过"（D12 家族的老毛病）
  assert.equal(await prisma.child.count({ where: { id: { in: [ID.childP, ID.childR] } } }), 2)
  assert.equal(await prisma.childMember.count({ where: { childId: { in: [ID.childP, ID.childR] } } }), 3)
  assert.equal(await prisma.deviceSession.count({ where: { childId: { in: [ID.childP, ID.childR] } } }), 5)
}

/** 只删自己写的行：没有 PointRecord ⇒ 级联删得掉（与账本套件相反，见文件头 ③）。 */
async function cleanup(): Promise<void> {
  await prisma.deviceSession.deleteMany({ where: { childId: { in: [ID.childP, ID.childR] } } })
  await prisma.childMember.deleteMany({ where: { childId: { in: [ID.childP, ID.childR] } } })
  await prisma.child.deleteMany({ where: { id: { in: [ID.childP, ID.childR] } } })
  await prisma.user.deleteMany({ where: { id: { in: [ID.dad, ID.kid, ID.stranger] } } })

  const left = {
    child: await prisma.child.count({ where: { id: { in: [ID.childP, ID.childR] } } }),
    member: await prisma.childMember.count({ where: { childId: { in: [ID.childP, ID.childR] } } }),
    session: await prisma.deviceSession.count({ where: { childId: { in: [ID.childP, ID.childR] } } }),
    user: await prisma.user.count({ where: { id: { in: [ID.dad, ID.kid, ID.stranger] } } })
  }
  assert.deepEqual(left, { child: 0, member: 0, session: 0, user: 0 }, '夹具没清干净 —— 下一次运行的前提就脏了')
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
describe('组 A：真 AppModule 的装配（否则下面的 401/403 可能是在跟替身说话）', () => {
  it('身份 / 屏障一端口是 Prisma 适配器（环境推断生效）', () => {
    assert.ok(
      app.get<DeviceSessionPort>(DEVICE_SESSION_REPOSITORY) instanceof PrismaDeviceSessionRepository,
      '身份端口不是 Prisma 适配器 —— HTTP 请求会在 501 上停住，本文件的每个 401/403 都失去意义'
    )
    assert.ok(
      app.get<MembershipPort>(MEMBERSHIP_REPOSITORY) instanceof PrismaMembershipRepository,
      '屏障一端口不是 Prisma 适配器 —— 403 的两种 code 就永远不会在真数据上出现'
    )
  })

  it('★ 审批端口仍是 `NotImplementedApprovalsRepository`（有库也是 501）', () => {
    const port = app.get<object>(APPROVALS_REPOSITORY)
    assert.ok(
      port instanceof NotImplementedApprovalsRepository,
      `审批端口变成了 ${port.constructor.name} —— 若真实现了，组 E 的 501 断言与整个 W2-D 口径都要一起改`
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
    assert.equal(deviceOnly.status, 401, '缺孩子上下文却放行了 —— "在哪个孩子档案上"不是可选项')
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
      `拿到 ${String(r.body.code)}：若为 MEMBER_REMOVED，说明适配器把"从未加入"说成了"已被移出"`
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
describe('组 D：屏障二 ＋ TTL（过期是**降级**，不是"查不到"）', () => {
  it('child 批准（矩阵 `review_approvals` = DENY）⇒ 403 `FORBIDDEN`', async () => {
    const r = await send('/approvals/ap-x/decide', {
      body: { decision: 'approved' },
      headers: H.kid
    })
    assert.equal(
      r.status,
      403,
      `孩子批准拿到 ${r.status}：若是 401/501，说明会话或成员位没被读到 —— 屏障二根本没机会执行`
    )
    assert.equal(r.body.code, 'FORBIDDEN')
    // 屏障二在**业务层之前**：否则会变成 404（没有这条）或 501（端口未实现）
    assert.notEqual(r.body.code, 'APPROVALS_PERSISTENCE_NOT_IMPLEMENTED', '矩阵没拦住，请求进了业务层')
  })

  it('★ 过期 guardian 批准 ⇒ 403 `FORBIDDEN`（**不是** 401 `SESSION_NOT_FOUND`）', async () => {
    const r = await send('/approvals/ap-x/decide', {
      body: { decision: 'approved' },
      headers: H.expired
    })
    assert.equal(
      r.status,
      403,
      `过期会话拿到 ${r.status}：401 说明 TTL 被实现成"查不到"（把降级做成了拒绝），` +
        '那会让孩子的设备到期后连"看自己积分"都做不了'
    )
    assert.equal(
      r.body.code,
      'FORBIDDEN',
      `拿到 ${String(r.body.code)}：过期的 guardian 必须回落成 child，再被矩阵拒绝`
    )
  })
})

// ══ 组 E：审批端口（★ 有库也是 501）＋ 管道先于端口 ═══════════════════════════
describe('组 E：审批端口 —— 守卫全过之后才轮到它', () => {
  it('★★ 合法 guardian 提交 `redeem` ⇒ 501 `APPROVALS_PERSISTENCE_NOT_IMPLEMENTED`', async () => {
    const r = await send('/approvals', { body: { action: 'redeem' }, headers: H.dad })
    assert.equal(
      r.status,
      501,
      `合法请求拿到 ${r.status}：若是 2xx/202，说明审批落库**已经实现**（那 W2-D 的口径与文档都要改）`
    )
    assert.equal(
      r.body.code,
      'APPROVALS_PERSISTENCE_NOT_IMPLEMENTED',
      '501 的码必须是审批端口的 —— 若是 SESSION_*/MEMBERSHIP_*，说明前面那两道根本没走通'
    )
  })

  it('合法 guardian 批准 ⇒ 同样是 501（`decide` 的第一步就要查库）', async () => {
    const r = await send('/approvals/ap-x/decide', {
      body: { decision: 'approved' },
      headers: H.dad
    })
    assert.equal(r.status, 501, '批准路径若返回 404，说明它绕过了端口直接查库；若 2xx 说明落库已实现')
    assert.equal(r.body.code, 'APPROVALS_PERSISTENCE_NOT_IMPLEMENTED')
  })

  it('★ body 带多余键 ⇒ 400（**不是 501**）—— "成员查询落地后回到 400" 的有库半边', async () => {
    const r = await send('/approvals', {
      body: { action: 'redeem', amount: 5 },
      headers: H.dad
    })
    assert.equal(
      r.status,
      400,
      `多余键拿到 ${r.status}：若 501，说明请求先撞上了端口 —— 管道与守卫的顺序反了`
    )
    assert.equal(r.body.statusCode, 400, '400 必须来自 ValidationPipe（它有 statusCode，没有业务 code）')
    assert.equal(
      r.body.code,
      undefined,
      '这个 400 不该带业务 code —— 形状校验与"权限/成员/端口"是不同层的错误'
    )
  })
})

// ══ 组 F：世界口径 —— "无库"只在子模块/用例里存在 ══════════════════════════════
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
        '空 DATABASE_URL 时真 AppModule 竟然建起来了 —— 若它静默绑到 501 实现，生产会以"每请求 501"的样子活着'
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

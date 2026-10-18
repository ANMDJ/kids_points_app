/**
 * identity-db.dbtest.ts —— 身份层（`DeviceSession`）＋ 屏障一（`ChildMember`）的**真库套件**
 * （W2-D，2026-10-16）
 *
 * ── 与离线用例的分工（缺一边就都算没验）──────────────────────────────────────
 *   · 离线：`test/device-session-wiring.test.ts` / `test/membership-wiring.test.ts`
 *     管「装配**声明**了什么」＋「适配器把哪几个键交给 Prisma」（替身收下 `where`）；
 *   · 本文件管「**接了库之后真的按那个键读**」—— 这些恰恰是替身**永远证明不了**的东西：
 *       ① `@@unique([deviceId, childId])` 在**真库**里就是适配器用的那个键（重复插入 ⇒ P2002）；
 *       ② 同一台设备在**另一个孩子**上读出来的是**另一行**（不是同一行被过滤器放过）；
 *       ③ `status='removed'` 的行**真的**躺在库里、且能被读出来（否则 `MEMBER_REMOVED`
 *          这条语义在真库上从来没发生过）；
 *       ④ `restrictions` 是**裸 `Json`**：真库不会帮你洗掉拼错的键 —— 形状病必须走到 500。
 *
 * ── ★ 本套件为什么会永久留下实验数据（写清楚，免得被当成漏清理）──────────────
 *   刻意**不做** `DELETE` 清理：套件跑完后"那两行还在"本身就是证据（可回看、可复核），
 *   而清理代码一旦哪天删错东西，伤的是别的套件的数据。取而代之的是**每次运行一个新前缀**
 *   （`dbtest-<run>-…`），于是"同一个 deviceId 下有两个孩子"这类前提永远从零开始，
 *   也不会与历史数据互撞。
 *
 * ── 入口与纪律 ────────────────────────────────────────────────────────────
 *   `npm run test:db`（= `scripts/run-db-tests.mjs`；缺 `DATABASE_URL` 直接红，
 *   `NODE_ENV=production` 硬拒绝）。它只许对着开发/实验库跑。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { Test } from '@nestjs/testing'
import { Prisma } from '@prisma/client'

import { ApprovalsModule } from '../src/approvals/approvals.module'
import {
  APPROVALS_REPOSITORY,
  NotImplementedApprovalsRepository,
  type ApprovalsPort
} from '../src/approvals/approvals.repository'
import { DeviceSessionGuard } from '../src/device-session/device-session.guard'
import { DeviceSessionModule } from '../src/device-session/device-session.module'
import { PrismaDeviceSessionRepository } from '../src/device-session/device-session.prisma.repository'
import {
  DEVICE_SESSION_REPOSITORY,
  type DeviceSessionPort
} from '../src/device-session/device-session.repository'
import { effectiveRole, resolveSession } from '../src/device-session/session.gate'
import {
  MemberRowShapeError,
  resolveMembership,
  toMembership
} from '../src/membership/membership.gate'
import { MembershipModule } from '../src/membership/membership.module'
import { PrismaMembershipRepository } from '../src/membership/membership.prisma.repository'
import {
  MEMBERSHIP_REPOSITORY,
  type MembershipPort
} from '../src/membership/membership.repository'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 —— 保证"新设备、新孩子、新成员位"，与历史数据互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

let prisma: PrismaService
let sessions: DeviceSessionPort
let memberships: MembershipPort
let operatorUserId: string

/** 建一个全新孩子（id 带运行前缀）。 */
async function makeChild(label: string): Promise<string> {
  const id = `dbtest-${RUN}-child-${label}`
  await prisma.child.create({ data: { id, name: `DB 身份套件 ${label}` } })
  return id
}

/** 建一个全新账号（id 带运行前缀）。 */
async function makeUser(label: string): Promise<string> {
  const id = `dbtest-${RUN}-user-${label}`
  await prisma.user.create({ data: { id, displayName: `DB 身份套件 ${label}` } })
  return id
}

/** 写一行设备会话（`expiresAt` 由调用方给：本套件要能造"已过期"的行）。 */
async function makeSession(
  deviceId: string,
  childId: string,
  userId: string,
  activeRole: 'guardian' | 'child' | 'viewer',
  expiresAt: Date
): Promise<void> {
  await prisma.deviceSession.create({
    data: { deviceId, childId, userId, activeRole, expiresAt }
  })
}

/** 写一行成员位（`restrictions` 是裸 Json，故意允许传任意形状）。 */
async function makeMember(
  childId: string,
  userId: string,
  role: 'guardian' | 'child',
  extra: { status?: 'active' | 'removed'; restrictions?: Prisma.InputJsonValue } = {}
): Promise<void> {
  await prisma.childMember.create({
    data: {
      childId,
      userId,
      role,
      status: extra.status ?? 'active',
      ...(extra.restrictions === undefined ? {} : { restrictions: extra.restrictions })
    }
  })
}

before(async () => {
  prisma = new PrismaService()
  // ★ 本套件用**手工实例化**的适配器（与账本套件一致）：先把"适配器在真库上怎么读"验清楚，
  //   装配那一层留给组 D（真 `register()` 建图、从注入器里取端口）。
  sessions = new PrismaDeviceSessionRepository(prisma)
  memberships = new PrismaMembershipRepository(prisma)
  operatorUserId = await makeUser('guardian')
})

// ══ 组 A：会话的**复合唯一键**既是查询键、也是库上的唯一键 ══════════════════
describe('组 A：`(deviceId, childId)` —— 一个键，两处含义', () => {
  it('同一台设备在两个孩子的档案上各一行 ⇒ 各读各的；没有会话的孩子 ⇒ null', async () => {
    const deviceId = `dbtest-${RUN}-dev-A`
    const child1 = await makeChild('a1')
    const child2 = await makeChild('a2')
    const child3 = await makeChild('a3')
    const expiresAt = new Date(Date.now() + 5 * 60_000)

    // 同一个 userId、同一台设备，只有 childId 不同 ⇒ 两行必须**都能存在**
    // （这正是唯一约束写成 `@@unique([deviceId, childId])` 而不是单 `deviceId` 的意义）。
    await makeSession(deviceId, child1, operatorUserId, 'guardian', expiresAt)
    await makeSession(deviceId, child2, operatorUserId, 'child', expiresAt)

    const row1 = await sessions.findSession(deviceId, child1)
    const row2 = await sessions.findSession(deviceId, child2)
    assert.ok(row1 !== null, '孩子在 child1 上的会话没读出来')
    assert.ok(row2 !== null, '同一设备在 child2 上的会话没读出来 —— 用单键查的实现会在这里红')
    assert.equal(
      row1.childId,
      child1,
      'child1 的会话读成了另一个孩子的行 —— 查询键里少了 childId'
    )
    assert.equal(
      row2.childId,
      child2,
      '同一设备在 child2 上读到了 child1 的那一行 —— childId 被当成过滤器了（单键查的典型后果）'
    )
    assert.notEqual(
      row1.activeRole,
      row2.activeRole,
      '两个孩子的会话读成了同一行（角色都一样）—— childId 被当成过滤器了'
    )
    assert.equal(row1.activeRole, 'guardian')
    assert.equal(row2.activeRole, 'child')

    assert.equal(
      await sessions.findSession(deviceId, child3),
      null,
      '第三个孩子没有会话却读到了行 —— 查询键里少了 childId'
    )
    assert.equal(
      await sessions.findSession(child1, child1),
      null,
      '拿孩子 id 当设备 id 查却读到了东西 —— 两个参数的位置/含义被搞混了'
    )
  })

  it('★ 重复写同一个 `(deviceId, childId)` 会被**库**拒绝（P2002）—— 适配器的键就是库的键', async () => {
    const deviceId = `dbtest-${RUN}-dev-uniq`
    const childId = await makeChild('uniq')
    const expiresAt = new Date(Date.now() + 5 * 60_000)
    await makeSession(deviceId, childId, operatorUserId, 'child', expiresAt)

    await assert.rejects(
      async () => makeSession(deviceId, childId, operatorUserId, 'child', expiresAt),
      (err: unknown) => {
        assert.ok(
          err instanceof Prisma.PrismaClientKnownRequestError,
          `第二次写入没被库拒绝：${String(err)}`
        )
        assert.equal(err.code, 'P2002', '拒绝的理由不是唯一约束（那说明库上根本没有这个键）')
        return true
      },
      '库上没有 `(deviceId, childId)` 唯一约束 —— 适配器的复合键就成了一句空话（同一设备会有两份会话）'
    )
  })

  it('读出来的行能直接过内核（`select` 少读一列，这里就会崩在形状校验上）', async () => {
    const deviceId = `dbtest-${RUN}-dev-core`
    const childId = await makeChild('core')
    const now = new Date()
    await makeSession(deviceId, childId, operatorUserId, 'guardian', new Date(now.getTime() + 60_000))

    const row = await sessions.findSession(deviceId, childId)
    assert.ok(row !== null)
    assert.equal(resolveSession(row, childId, now).kind, 'ALLOW', '真库读回来的行没能过判定')
    assert.equal(effectiveRole(row, now), 'guardian')
    assert.ok(
      row.expiresAt instanceof Date,
      `真库给的 expiresAt 应当是 Date（实际 ${typeof row.expiresAt}）—— 形状校验依赖它`
    )
  })
})

// ══ 组 B：过期行**必须读得出来**（筛掉它 = TTL 降级永远不发生）═══════════════
describe('组 B：TTL 到期是"降级"，不是"查不到"', () => {
  it('★ 已过期的 guardian 行照样读得回来，有效角色回落 child', async () => {
    const deviceId = `dbtest-${RUN}-dev-expired`
    const childId = await makeChild('expired')
    const now = new Date()
    await makeSession(deviceId, childId, operatorUserId, 'guardian', new Date(now.getTime() - 60_000))

    // 独立复核：这一行**真的在库里** —— 否则"读不到"与"被实现筛掉了"分不开。
    assert.equal(
      await prisma.deviceSession.count({ where: { deviceId, childId } }),
      1,
      '夹具行没写进库 —— 下面的断言就成了"恰好也过"'
    )

    const row = await sessions.findSession(deviceId, childId)
    assert.ok(
      row !== null,
      '过期会话读成了 null —— 那 §9.19 的"过期 ⇒ 回落 child"永远走不到（全会变成 401 SESSION_NOT_FOUND）'
    )
    assert.equal(resolveSession(row, childId, now).kind, 'ALLOW', '过期不是拒绝：设备与身份仍然有效')
    assert.equal(effectiveRole(row, now), 'child', '过期 guardian 没有回落 child')
  })

  it('边界：`expiresAt` 恰好等于 now ⇒ 已过期（同一口径，在真库读回来的行上也成立）', async () => {
    const deviceId = `dbtest-${RUN}-dev-boundary`
    const childId = await makeChild('boundary')
    const now = new Date()
    await makeSession(deviceId, childId, operatorUserId, 'guardian', now)

    const row = await sessions.findSession(deviceId, childId)
    assert.ok(row !== null)
    assert.equal(
      new Date(row.expiresAt).getTime(),
      now.getTime(),
      '落库/读回把时间戳改了精度 —— 边界用例就白写了（列精度必须与 JS 的毫秒一致）'
    )
    assert.equal(effectiveRole(row, new Date(now.getTime())), 'child', '`expiresAt === now` 必须是已过期')
    assert.equal(
      effectiveRole(row, new Date(now.getTime() - 1)),
      'guardian',
      '差 1ms 未到期时必须仍是 guardian（边界只有一处，且是"到期即失效"）'
    )
  })
})

// ══ 组 C：成员位的复合唯一键 ＋ 两条 403 在真库上分得开 ═════════════════════
describe('组 C：`(childId, userId)` 是查询键；`removed` 不许塌成"不是成员"', () => {
  it('★ 同一个人：A 家是 active、B 家是 removed、C 家没记录 ⇒ 三格各不相同', async () => {
    const childA = await makeChild('memA')
    const childB = await makeChild('memB')
    const childC = await makeChild('memC')
    await makeMember(childA, operatorUserId, 'guardian')
    await makeMember(childB, operatorUserId, 'child', { status: 'removed' })

    const rowA = await memberships.findMembership(childA, operatorUserId)
    assert.ok(rowA !== null, 'A 家的成员位没读出来')
    assert.equal(rowA.childId, childA, '读回来的成员位属于另一个孩子 —— childId 被当成过滤器了')
    assert.equal(rowA.status, 'active')
    assert.equal(resolveMembership(rowA).kind, 'ALLOW')

    // ★ 独立复核：B 家那一行**真的在库里**（`removed` 不是适配器返回的残影）。
    assert.equal(
      await prisma.childMember.count({
        where: { childId: childB, userId: operatorUserId, status: 'removed' }
      }),
      1,
      '被移出的成员位没写进库 —— 下面的断言就成了"恰好也过"'
    )

    const rowB = await memberships.findMembership(childB, operatorUserId)
    assert.ok(
      rowB !== null,
      '`removed` 的行读成了 null —— 屏障一会把"你已被移出"说成"你不是成员"（对被移出的人这句话是错的）'
    )
    assert.equal(rowB.status, 'removed')
    const verdictB = resolveMembership(rowB)
    assert.equal(verdictB.kind, 'DENY')
    assert.equal(
      verdictB.kind === 'DENY' ? verdictB.code : '?',
      'MEMBER_REMOVED',
      '真库里的 `removed` 没能走到 MEMBER_REMOVED —— 这条语义在生产里就从未发生过'
    )

    // 第三格：真的一行都没有 ⇒ MEMBER_NOT_FOUND（两条 403 在真库数据上分得开）
    const rowC = await memberships.findMembership(childC, operatorUserId)
    assert.equal(rowC, null, 'C 家没有成员位却读到了行')
    assert.equal(
      (resolveMembership(rowC) as { code?: string }).code,
      'MEMBER_NOT_FOUND',
      '不存在的成员位必须判成 MEMBER_NOT_FOUND（与上面的 MEMBER_REMOVED 是两种 403）'
    )
  })

  it('★ 默认 `restrictions`（`@default("{}")`）读回来能过形状校验（库里每行默认值都不许 500）', async () => {
    const childId = await makeChild('memDefault')
    await makeMember(childId, operatorUserId, 'child') // 刻意不传 restrictions
    const row = await memberships.findMembership(childId, operatorUserId)
    assert.ok(row !== null)
    assert.deepEqual(
      row.restrictions,
      {},
      `库里的默认值形状不是 {}：${JSON.stringify(row.restrictions)} —— 形状校验会在这里红`
    )
    const membership = toMembership(row)
    assert.deepEqual(
      membership.restrictions,
      {},
      '默认 {} 没过形状校验 —— 屏障一会把整库的默认行判成 500（离线只能验替身给的 {}，真库那行只有这里能验）'
    )
    assert.equal(membership.childId, childId)
    assert.equal(membership.userId, operatorUserId)
    assert.equal(membership.role, 'child')
  })

  it('★ `restrictions` 是**裸 Json**：拼错的键照样读出来 ⇒ 形状病必须响亮（500），不许静默失效', async () => {
    const childId = await makeChild('memTypo')
    await makeMember(childId, operatorUserId, 'child', {
      restrictions: { childCannotAddwis: true }
    })
    const row = await memberships.findMembership(childId, operatorUserId)
    assert.ok(row !== null)
    assert.deepEqual(
      row.restrictions,
      { childCannotAddwis: true },
      '真库/适配器把非法键洗掉了 —— 那样一条写坏的限制会**静默失效**（D3b 的病）'
    )
    assert.throws(
      () => toMembership(row),
      (err: unknown) => {
        assert.ok(err instanceof MemberRowShapeError, `抛的不是形状错误：${String(err)}`)
        assert.equal(err.code, 'INVALID_MEMBER_RESTRICTIONS')
        return true
      },
      '裸 Json 里的形状病必须在读的时候响亮（500 + code），而不是被当成"没有限制"继续'
    )
  })

  it('★ 同一个孩子、同一个人重复写 ⇒ 库拒绝（P2002）："一人一个成员位"（02 §1）由库兜住', async () => {
    const childId = await makeChild('memUniq')
    await makeMember(childId, operatorUserId, 'guardian')
    await assert.rejects(
      async () => makeMember(childId, operatorUserId, 'guardian'),
      (err: unknown) => {
        assert.ok(
          err instanceof Prisma.PrismaClientKnownRequestError,
          `第二次写入没被库拒绝：${String(err)}`
        )
        assert.equal(err.code, 'P2002')
        return true
      },
      '库上没有 `(childId, userId)` 唯一约束 —— 同一个人会有两份成员位，"权限取自哪一份"就没有答案'
    )
  })
})

// ══ 组 D：装配口径 —— 从**注入器**取端口，读的是真库 ════════════════════════
describe('组 D：装配口径 —— DI 取到的端口真的查库（真 `register()`，走环境推断）', () => {
  it('★ 两个子模块：端口是 Prisma 适配器，且读得到上面写下的行', async () => {
    // 刻意**不传** `{ hasDatabase: true }`：要验的正是生产/真库那条路（由 `DATABASE_URL` 推断）。
    const moduleRef = await Test.createTestingModule({
      imports: [DeviceSessionModule.register(), MembershipModule.register()]
    }).compile()
    try {
      const sessionPort = moduleRef.get<DeviceSessionPort>(DEVICE_SESSION_REPOSITORY)
      const memberPort = moduleRef.get<MembershipPort>(MEMBERSHIP_REPOSITORY)
      assert.ok(
        sessionPort instanceof PrismaDeviceSessionRepository,
        `身份端口是 ${sessionPort.constructor.name}，不是 Prisma 适配器 —— 装配没接上（真库跑起来会是 501）`
      )
      assert.ok(
        memberPort instanceof PrismaMembershipRepository,
        `屏障一端口是 ${memberPort.constructor.name}，不是 Prisma 适配器 —— 装配没接上`
      )

      const deviceId = `dbtest-${RUN}-dev-wired`
      const childId = await makeChild('wired')
      await makeSession(deviceId, childId, operatorUserId, 'guardian', new Date(Date.now() + 60_000))
      await makeMember(childId, operatorUserId, 'guardian')

      const row = await sessionPort.findSession(deviceId, childId)
      assert.ok(
        row !== null,
        '由 DI 装配出来的端口读不到刚写的会话 —— 端口拿的不是同一个连接 / 不是同一张库？'
      )
      assert.equal(row.userId, operatorUserId)
      assert.equal((await memberPort.findMembership(childId, operatorUserId))?.status, 'active')
    } finally {
      await moduleRef.close()
    }
  })

  it('★ `ApprovalsModule.register()`（不传参）：世界转发给两个子模块；审批端口**仍是** 501', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ApprovalsModule.register()]
    }).compile()
    try {
      // 转发成功的证据：在这张图里，两个子模块绑的是**真适配器**（转发若断了，这里会是 501 实现）。
      assert.ok(
        moduleRef.get<DeviceSessionPort>(DEVICE_SESSION_REPOSITORY) instanceof
          PrismaDeviceSessionRepository,
        '`ApprovalsModule.register()` 没把"有库"转发给 DeviceSessionModule —— 生产里守卫会拿着 501 去跑'
      )
      assert.ok(
        moduleRef.get<MembershipPort>(MEMBERSHIP_REPOSITORY) instanceof PrismaMembershipRepository,
        '`ApprovalsModule.register()` 没把"有库"转发给 MembershipModule'
      )

      // 诚实的那一半：审批端口**没有**真实现，仍是显式 501
      //（别把"能建图"读成"审批能用了"—— 那正是 W3 的活）。
      const approvals = moduleRef.get<ApprovalsPort>(APPROVALS_REPOSITORY)
      assert.ok(
        approvals instanceof NotImplementedApprovalsRepository,
        `审批端口变成了 ${approvals.constructor.name} —— 若真实现了，本行要一起改成"已验证实现"`
      )

      // 宿主模块实例化的守卫必须真的解得开（端口没被 exports 出来时，这一行会抛依赖解析错误）。
      assert.ok(moduleRef.get(DeviceSessionGuard) instanceof DeviceSessionGuard)

      const deviceId = `dbtest-${RUN}-dev-approvals`
      const childId = await makeChild('approvals')
      await makeSession(deviceId, childId, operatorUserId, 'child', new Date(Date.now() + 60_000))
      const row = await moduleRef
        .get<DeviceSessionPort>(DEVICE_SESSION_REPOSITORY)
        .findSession(deviceId, childId)
      assert.equal(row?.childId, childId, '整张审批图装好之后，端口读的还是真库吗？')
    } finally {
      await moduleRef.close()
    }
  })
})

after(async () => {
  // 用完就断连线（数据**故意不删**，理由见文件头）。
  await prisma.$disconnect()
})

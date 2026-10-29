/**
 * auth-session-db.dbtest.ts —— 认证会话（`AuthSession`）＋ 登录/补会话的**真库**不变量套件
 * （W9-A，2026-10-29 / `docs/design/40-login-and-session-design.md` §5、§8、§9.3）
 *
 * ── 与另外两份用例的分工（缺哪份都算没验完）────────────────────────────────
 *   · `test/identity-http.test.ts` —— 真 Nest + 真路由 + 真守卫，但端口是**替身**：
 *     它证明"路由怎么回"（401/403/500 的边界、响应形状、限流），**SQL 一行没跑**。
 *   · `test/auth-boot-config.test.ts` —— 启动期配置判据（旁路开关不能活到生产）。
 *   · **本文件** —— 真 `PrismaIdentityRepository` + `PrismaAuthSessionRepository` +
 *     真 Postgres，补的正是替身**永远证明不了**的六件事：
 *
 *   ① **同一家长两台设备同时首次登录 ⇒ 只有一个 `User`**：先 `findUnique` 再 `create`
 *      在 READ COMMITTED 下会双双读到 `null`，第二个 `INSERT` 撞 `User.openId` 唯一键 ⇒ 500。
 *      这正是 `loginWithOpenId` 用**单条** `INSERT … ON CONFLICT` 的理由（`40` §6.2）。
 *      并发是**正常动作**，不是攻击 —— 所以它必须有一条并发用例钉着。
 *   ② **停用的账号连一行会话都不留**：`USER_NOT_ACTIVE` 是 403 而不是"发了凭据再说"，
 *      且 `AuthSession` 表里**没有**这次登录的任何痕迹（事务整体回滚）。
 *   ③ **适配器的 `findByTokenHash` 不过滤 `revokedAt` / `expiresAt`**（只查、不判）：
 *      已撤销与已到期的行**都读得出来**。若在 SQL 里过滤，"已到期（可静默重登）"与
 *      "已撤销（重登也修不好）"会塌成同一个 401 —— 而这两种结局驱动**完全不同的客户端动作**。
 *   ④ **`touch()` 只写 `lastSeenAt`**：`expiresAt`／`issuedAt` 一个字节都不变。
 *      顺手续期就是滑动窗口：手机丢了之后凭据无限期活着（§4.3）。
 *   ⑤ **`revoke()` 的幂等是结构性的**（条件 `updateMany`）：并发/重复撤销只留
 *      **第一个** `revokedAt` 与**第一条** reason —— 那是证据，不能被后来的调用覆盖。
 *   ⑥ **`ensureChildSession` 的 upsert 键真的是 `(deviceId, childId)`**，且共享平板上的
 *      "这台设备已有别人的会话" ⇒ 409 且**行没被改写**（静默接管会让上一位家长消失）。
 *
 * ── ★ 与其它真库套件同一条纪律：不做 DELETE 清理 ─────────────────────────────
 *   每轮用新前缀（`dbtest-<run>-as-…`），跑完"那些行还在"本身就是证据。
 *
 * ── 入口 ────────────────────────────────────────────────────────────────────
 *   `npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { AuthSessionShapeError, type AuthMethod, resolveAuthSession } from '../src/identity/auth-session.gate'
import { PrismaAuthSessionRepository } from '../src/identity/auth-session.prisma.repository'
import { PrismaIdentityRepository } from '../src/identity/identity.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 ——「新账号、新 token、新设备」，与历史数据互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const DAY_MS = 24 * 60 * 60 * 1000

let prisma: PrismaService
let authSessions: PrismaAuthSessionRepository
let identity: PrismaIdentityRepository

/** 每个用例一个新 openId（微信 openId 是**账号**的身份，复用会串数据）。 */
function newOpenId(): string {
  return `dbtest-${RUN}-as-openid-${randomUUID().slice(0, 8)}`
}

/** 直接造一个 token 的哈希（与 `hashToken()` 同一算法，但本文件**不**依赖内核实现）。 */
function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newToken(): string {
  return `kps_${randomUUID().replace(/-/g, '')}`
}

/** 造一个停用账号（用来验"不发凭据、也不留会话"）。 */
async function makeSuspendedUser(label: string): Promise<{ userId: string; openId: string }> {
  const openId = newOpenId()
  const userId = `dbtest-${RUN}-as-${label}`
  await prisma.user.create({
    data: { id: userId, openId, displayName: `DB 认证套件 ${label}`, status: 'suspended' }
  })
  return { userId, openId }
}

/** 登录一次（真适配器），返回 token 与哈希。 */
async function login(
  openId: string,
  options: { method?: AuthMethod; deviceId?: string | null; expiresAt?: Date } = {}
): Promise<{ userId: string; token: string; tokenHash: string; expiresAt: Date }> {
  const token = newToken()
  const tokenHash = sha256(token)
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 7 * DAY_MS)
  const user = await identity.loginWithOpenId({
    openId,
    tokenHash,
    method: options.method ?? 'wechat_mp',
    deviceId: options.deviceId ?? `dbtest-${RUN}-as-device`,
    expiresAt
  })
  return { userId: user.userId, token, tokenHash, expiresAt }
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  authSessions = new PrismaAuthSessionRepository(prisma)
  identity = new PrismaIdentityRepository(prisma)
})

after(async () => {
  await prisma.$disconnect()
})


describe('组 A：`loginWithOpenId` —— 唯一的 User ＋ 一行 AuthSession（同一事务）', () => {
  it('★ 5 个并发首次登录（同一 openId）⇒ `User` 只有一行，5 行会话都指向它', async () => {
    const openId = newOpenId()
    // 真实场景：同一家长两台设备同时点"微信登录"，外加弱网重试。**这不是攻击**。
    // 先 findUnique 再 create 的实现会在这里抛 P2002（500），并且 Postgres 里
    // 一条语句报错会让整个事务进入 aborted 状态 —— catch P2002 也救不回来。
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        login(openId, { deviceId: `dbtest-${RUN}-as-par-${randomUUID().slice(0, 6)}` })
      )
    )

    assert.equal(
      await prisma.user.count({ where: { openId } }),
      1,
      '同一个 openId 建出了多个 User —— 并发首次登录会把家长拆成两个账号'
    )
    const userIds = new Set(results.map((r) => r.userId))
    assert.equal(userIds.size, 1, '5 次登录返回了不同的 userId')

    const sessions = await prisma.authSession.findMany({
      where: { tokenHash: { in: results.map((r) => r.tokenHash) } },
      select: { userId: true }
    })
    assert.equal(sessions.length, 5, '并发登录丢了会话行（某次登录"成功"但没有凭据）')
    assert.deepEqual(new Set(sessions.map((s) => s.userId)), userIds, '会话行挂到了别的账号上')
  })

  it('库里的就是**我们给的那个哈希**（不二次哈希、不存明文）', async () => {
    const openId = newOpenId()
    const issuedAt = new Date()
    const expiresAt = new Date(issuedAt.getTime() + 7 * DAY_MS)
    const { token, tokenHash } = await login(openId, { deviceId: `dbtest-${RUN}-as-shape`, expiresAt })

    const row = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash } })
    assert.equal(row.method, 'wechat_mp')
    assert.equal(row.deviceId, `dbtest-${RUN}-as-shape`)
    assert.equal(row.revokedAt, null)
    assert.equal(row.revokedReason, null)
    assert.equal(
      row.expiresAt.getTime(),
      expiresAt.getTime(),
      'expiresAt 被改写 —— 签发的绝对到期必须原样落库（7 天不滑动）'
    )
    // 明文 token 绝不能出现在任何一列里（它是 `kps_…`，只要存了就扫得到）。
    assert.equal(JSON.stringify(row).includes(token), false, '明文 token 落库了')
  })

  it('★ 停用账号 ⇒ 403 USER_NOT_ACTIVE，且**一行会话都不留**（整体回滚）', async () => {
    const { userId, openId } = await makeSuspendedUser('suspended')
    const tokenHash = sha256(newToken())

    await assert.rejects(
      () =>
        identity.loginWithOpenId({
          openId,
          tokenHash,
          method: 'wechat_mp',
          deviceId: `dbtest-${RUN}-as-susp`,
          expiresAt: new Date(Date.now() + DAY_MS)
        }),
      (error: unknown) => {
        const shape = error as { getStatus?: () => number; getResponse?: () => unknown }
        assert.equal(shape.getStatus?.(), 403, '停用账号不是 403')
        const body = shape.getResponse?.() as { code?: string } | undefined
        assert.equal(body?.code, 'USER_NOT_ACTIVE')
        return true
      }
    )

    assert.equal(await prisma.authSession.count({ where: { tokenHash } }), 0, '发了凭据却没有账号可用')
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } })
    assert.equal(user.status, 'suspended', '登录尝试把停用账号改回 active 了')
  })

  it('`readUser` 只认 active：停用 ⇒ null（service 翻 403，不是 401）', async () => {
    const { userId: activeId } = await login(newOpenId())
    const { userId: suspendedId } = await makeSuspendedUser('readuser')
    assert.deepEqual(await identity.readUser(activeId), { userId: activeId, displayName: null })
    assert.equal(await identity.readUser(suspendedId), null)
  })
})
describe('组 B：`PrismaAuthSessionRepository` —— 只查不判（判定权在 `resolveAuthSession`）', () => {
  it('按 `tokenHash` 查：两个家长各查回自己的那一行', async () => {
    const a = await login(newOpenId())
    const b = await login(newOpenId())

    const rowA = await authSessions.findByTokenHash(a.tokenHash)
    const rowB = await authSessions.findByTokenHash(b.tokenHash)
    assert.equal(rowA?.userId, a.userId)
    assert.equal(rowB?.userId, b.userId)
    assert.notEqual(rowA?.id, rowB?.id)

    // 适配器必须把 tokenHash 带回来：内核要用它做"适配器有没有查错键"的同源校验。
    assert.equal(rowA?.tokenHash, a.tokenHash)
  })

  it('不认识的 tokenHash ⇒ `null`（不是异常：守卫翻 401）', async () => {
    assert.equal(await authSessions.findByTokenHash(sha256(newToken())), null)
  })

  it('★ 已撤销 / 已到期的行**照样读得出来**（SQL 里不许过滤）', async () => {
    const revoked = await login(newOpenId())
    await authSessions.revoke(revoked.tokenHash, new Date(), 'logout')

    const expired = await login(newOpenId(), { expiresAt: new Date(Date.now() - 1000) })

    const revokedRow = await authSessions.findByTokenHash(revoked.tokenHash)
    const expiredRow = await authSessions.findByTokenHash(expired.tokenHash)

    assert.notEqual(revokedRow, null, '撤销后在 SQL 里被过滤掉了 —— 撤销与"不认识"会塌成同一个 401')
    assert.notEqual(expiredRow, null, '过期后在 SQL 里被过滤掉了 —— 客户端将无法"静默重登一次"')

    // 两个 DENY 必须是**不同**的码（否则家长每次换手机都看到登录页，而重登也修不好）。
    const now = new Date()
    assert.deepEqual(resolveAuthSession(revokedRow, revoked.tokenHash, now), {
      kind: 'DENY',
      code: 'TOKEN_INVALID'
    })
    assert.deepEqual(resolveAuthSession(expiredRow, expired.tokenHash, now), {
      kind: 'DENY',
      code: 'TOKEN_EXPIRED'
    })
    // 同一份数据，把"现在"拨回签发时刻 ⇒ 都是 ALLOW（说明拒绝只来自时间/撤销，不是形状）。
    assert.equal(
      resolveAuthSession(expiredRow, expired.tokenHash, new Date(expired.expiresAt.getTime() - 1)).kind,
      'ALLOW'
    )
  })

  it('★ `touch()` 只写 `lastSeenAt`：`expiresAt` / `issuedAt` 一个字节都不变', async () => {
    const { tokenHash, expiresAt } = await login(newOpenId())
    const before = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash } })

    const later = new Date(before.lastSeenAt.getTime() + 60_000)
    await authSessions.touch(tokenHash, later)

    const after = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash } })
    assert.equal(after.lastSeenAt.getTime(), later.getTime(), 'lastSeenAt 没有写进去')
    assert.equal(after.expiresAt.getTime(), expiresAt.getTime(), '★ 顺手续期了 —— 这就是滑动窗口')
    assert.equal(after.issuedAt.getTime(), before.issuedAt.getTime())
    assert.equal(after.revokedAt, null)
  })

  it('`touch()` 对不存在的 hash 不抛错（并发撤销是正常竞态，不该 500）', async () => {
    await assert.doesNotReject(() => authSessions.touch(sha256(newToken()), new Date()))
  })

  it('★ `revoke()` 幂等：第二次 ⇒ false，且**第一次**的时刻与理由保留（证据）', async () => {
    const { tokenHash } = await login(newOpenId())
    const first = new Date()
    assert.equal(await authSessions.revoke(tokenHash, first, 'logout'), true)

    const second = new Date(first.getTime() + 60_000)
    assert.equal(await authSessions.revoke(tokenHash, second, 'logout-again'), false)

    const row = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash } })
    assert.equal(row.revokedAt?.getTime(), first.getTime(), '撤销时刻被后来的调用覆盖了')
    assert.equal(row.revokedReason, 'logout', '撤销理由被后来的调用覆盖了')
  })

  it('`tokenHash` 唯一：同一个 token 不可能有两行（`create` 直接撞唯一键）', async () => {
    const { tokenHash } = await login(newOpenId())
    const row = await prisma.authSession.findUniqueOrThrow({ where: { tokenHash }, select: { userId: true, method: true, deviceId: true, expiresAt: true } })

    await assert.rejects(
      () =>
        authSessions.create({
          userId: row.userId,
          tokenHash,
          method: row.method as AuthMethod,
          deviceId: row.deviceId,
          expiresAt: row.expiresAt
        }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'P2002')
        return true
      }
    )
  })
})

describe('组 C：`ensureChildSession` —— 补一行，不改变权限', () => {
  /** 造一个孩子 + 一条成员位（角色由调用方给）。 */
  async function makeChildWithMember(label: string, userId: string, role: 'guardian' | 'child' | 'viewer') {
    const childId = `dbtest-${RUN}-as-child-${label}`
    await prisma.child.create({ data: { id: childId, name: `DB 认证套件 ${label}` } })
    await prisma.childMember.create({ data: { childId, userId, role, status: 'active' } })
    return childId
  }

  it('★ 两次调用只有一行（`(deviceId, childId)` 真的是 upsert 键），角色取成员位', async () => {
    const { userId } = await login(newOpenId())
    const childId = await makeChildWithMember('upsert', userId, 'guardian')
    const deviceId = `dbtest-${RUN}-as-upsert-device`

    const firstWindow = new Date(Date.now() + DAY_MS)
    const first = await identity.ensureChildSession({
      userId,
      childId,
      deviceId,
      sessionExpiresAt: firstWindow
    })
    assert.equal(first.role, 'guardian')
    assert.equal(first.sessionExpiresAt.getTime(), firstWindow.getTime())

    const secondWindow = new Date(Date.now() + 30 * DAY_MS)
    await identity.ensureChildSession({ userId, childId, deviceId, sessionExpiresAt: secondWindow })

    const rows = await prisma.deviceSession.findMany({ where: { deviceId, childId } })
    assert.equal(rows.length, 1, '第二次补会话插出了第二行 —— upsert 键写错了')
    assert.equal(rows[0]?.userId, userId)
    assert.equal(rows[0]?.activeRole, 'guardian')
    assert.equal(rows[0]?.expiresAt.getTime(), secondWindow.getTime(), 'TTL 没有被刷新')
  })

  it('成员位是 `child` ⇒ 补出来的会话也是 `child`（成员位说了算）', async () => {
    const { userId } = await login(newOpenId())
    const childId = await makeChildWithMember('childrole', userId, 'child')
    const result = await identity.ensureChildSession({
      userId,
      childId,
      deviceId: `dbtest-${RUN}-as-child-device`,
      sessionExpiresAt: new Date(Date.now() + 30 * DAY_MS)
    })
    assert.equal(result.role, 'child')
  })

  it('没有成员位 ⇒ 403 NOT_A_MEMBER，且**一行都没写**', async () => {
    const { userId } = await login(newOpenId())
    const strangerId = (await login(newOpenId())).userId
    const childId = await makeChildWithMember('stranger', userId, 'guardian')
    const deviceId = `dbtest-${RUN}-as-stranger-device`

    await assert.rejects(
      () =>
        identity.ensureChildSession({
          userId: strangerId,
          childId,
          deviceId,
          sessionExpiresAt: new Date(Date.now() + 30 * DAY_MS)
        }),
      (error: unknown) => {
        const shape = error as { getStatus?: () => number; getResponse?: () => unknown }
        assert.equal(shape.getStatus?.(), 403)
        assert.equal((shape.getResponse?.() as { code?: string } | undefined)?.code, 'NOT_A_MEMBER')
        return true
      }
    )

    assert.equal(await prisma.deviceSession.count({ where: { deviceId, childId } }), 0)
  })

  it('★ 共享平板：这台设备在该孩子上已有**别人**的会话 ⇒ 409，且那行没被改写', async () => {
    const owner = await login(newOpenId())
    const other = await login(newOpenId())
    const childId = await makeChildWithMember('shared', owner.userId, 'guardian')
    await prisma.childMember.create({ data: { childId, userId: other.userId, role: 'child', status: 'active' } })
    const deviceId = `dbtest-${RUN}-as-shared-device`

    // 上一位使用者（孩子）留下会话。
    const originalWindow = new Date(Date.now() + DAY_MS)
    await identity.ensureChildSession({
      userId: owner.userId,
      childId,
      deviceId,
      sessionExpiresAt: originalWindow
    })

    await assert.rejects(
      () =>
        identity.ensureChildSession({
          userId: other.userId,
          childId,
          deviceId,
          sessionExpiresAt: new Date(Date.now() + 30 * DAY_MS)
        }),
      (error: unknown) => {
        const shape = error as { getStatus?: () => number; getResponse?: () => unknown }
        assert.equal(shape.getStatus?.(), 409, '静默覆盖会把上一位使用者的会话变成新登录者的')
        assert.equal(
          (shape.getResponse?.() as { code?: string } | undefined)?.code,
          'DEVICE_SESSION_CONFLICT'
        )
        return true
      }
    )

    const row = await prisma.deviceSession.findUniqueOrThrow({
      where: { deviceId_childId: { deviceId, childId } }
    })
    assert.equal(row.userId, owner.userId, '冲突时行仍被改写了')
    assert.equal(row.expiresAt.getTime(), originalWindow.getTime())
  })
})

describe('组 D：形状病在真库上也会响亮（坏数据 ⇒ 500，不是 401）', () => {
  it('★ 库里 `method` 被改成白名单外的值 ⇒ `resolveAuthSession()` 抛 `INVALID_AUTH_METHOD`', async () => {
    const { tokenHash } = await login(newOpenId())
    // 绕过适配器直接改库：模拟"有人手工改数据 / 枚举演进后旧行没迁移"。
    await prisma.authSession.update({ where: { tokenHash }, data: { method: 'sms' } })

    const row = await authSessions.findByTokenHash(tokenHash)

    assert.throws(
      () => resolveAuthSession(row, tokenHash, new Date()),
      (error: unknown) => {
        assert.ok(error instanceof AuthSessionShapeError)
        assert.equal(error.code, 'INVALID_AUTH_METHOD')
        return true
      }
    )
  })
})


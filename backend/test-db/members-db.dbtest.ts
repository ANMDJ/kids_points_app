/**
 * members-db.dbtest.ts —— 成员管理的**真库**不变量套件（W5-H，2026-10-22）
 *
 * 离线用例（`test/members-http.test.ts`）只能证明「路由问对了问题」 —— 端口是替身，
 * 它**不可能真的并发**，也不需要真的去改一行 `ChildMember`。本文件补的正是替身
 * 永远证明不了的几件事：
 *
 *   ① **最后一位家长不会被降没 / 移没**：单请求的拒绝只是及格线；
 *      真正的危险是 `02 §8` 那种并发 —— 两个家长同时把对方降级，各自都看到
 *      "还有 2 位家长"。这里用真事务并发证明：3 位家长环形降级 ⇒ **恰好 2 个成功、
 *      库里恒剩 1 位家长**（第二笔事务等第一笔提交，在已提交的数据上重新计数）。
 *   ② **失败不留下半截状态**：409 之后那一行仍是 `active` 原角色，**没有**审计。
 *   ③ **降级与收回会话是同一件事**（`02 §7`）：成员位变 child 的那些人，手上
 *      `activeRole='guardian'` 的会话必须在同一条事务里变成 child ——
 *      否则"降级"只是一次写库，他的设备照样能改别人。
 *   ④ **移出不删会话**：删了屏障一只能回 401 `SESSION_NOT_FOUND`，把"你已被移出"
 *      伪装成"你没登录"。会话行必须在，让屏障一回 `MEMBER_REMOVED`。
 *   ⑤ **审计快照只含角色**：`pinHash` / `restrictions` / `openId` 不进审计。
 *
 * ── ★ 与其它真库套件同一条纪律：不做 DELETE 清理 ──────────────────────────
 *   每轮用一个新前缀（`dbtest-<run>-…`），跑完"那些行还在"本身就是证据。
 *
 * ── 入口 ──────────────────────────────────────────────────────────────────
 *   `npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import {
  ConflictException,
  ForbiddenException,
  NotFoundException
} from '@nestjs/common'

import type {
  ChangeMemberRoleInput,
  RemoveMemberInput
} from '../src/members/members.repository'
import { PrismaMembersRepository } from '../src/members/members.prisma.repository'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 —— 保证「新孩子、新账号」，与历史数据互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

let prisma: PrismaService
let repository: PrismaMembersRepository

async function makeChild(label: string): Promise<string> {
  const id = `dbtest-${RUN}-child-${label}`
  await prisma.child.create({ data: { id, name: `DB 成员套件 ${label}` } })
  return id
}

/** `displayName` 留空的用户用于证明"没设名字"是 `null` 而不是编出来的串。 */
async function makeUser(label: string, displayName: string | null = `DB 成员 ${label}`): Promise<string> {
  const id = `dbtest-${RUN}-user-${label}`
  await prisma.user.create({ data: { id, displayName } })
  return id
}

interface MemberSeed {
  role: 'guardian' | 'child' | 'viewer'
  status?: 'active' | 'removed'
}

/** 直接造一行成员位（`joinedAt` 递增，保证列表顺序断言是确定的）。 */
async function addMember(
  childId: string,
  userId: string,
  options: MemberSeed,
  joinedAtOffsetMs = 0
): Promise<string> {
  const status = options.status ?? 'active'
  const row = await prisma.childMember.create({
    data: {
      childId,
      userId,
      role: options.role,
      status,
      joinedAt: new Date(Date.now() + joinedAtOffsetMs),
      removedAt: status === 'removed' ? new Date() : null
    },
    select: { id: true }
  })
  return row.id
}

/** 造一条会话（`activeRole` 是该设备的"票"，与成员位是两份独立事实）。 */
async function addSession(
  childId: string,
  userId: string,
  deviceId: string,
  activeRole: 'guardian' | 'child' | 'viewer'
): Promise<void> {
  await prisma.deviceSession.create({
    data: {
      deviceId,
      childId,
      userId,
      activeRole,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }
  })
}

function roleInput(
  childId: string,
  memberId: string,
  operatorUserId: string,
  role: 'guardian' | 'child',
  deviceId: string | null = null
): ChangeMemberRoleInput {
  return {
    childId,
    memberId,
    role,
    operatorUserId,
    operatorRole: 'guardian',
    deviceId
  }
}

function removeInput(
  childId: string,
  memberId: string,
  operatorUserId: string,
  deviceId: string | null = null
): RemoveMemberInput {
  return { childId, memberId, operatorUserId, operatorRole: 'guardian', deviceId }
}

/** 从 `HttpException` 的响应体里取业务 code（同一个 409/403 有多种原因）。 */
function errorCode(error: unknown): string {
  if (
    error instanceof ConflictException ||
    error instanceof ForbiddenException ||
    error instanceof NotFoundException
  ) {
    const response = error.getResponse()
    if (typeof response === 'object' && response !== null) {
      return String((response as { code?: unknown }).code)
    }
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** 数这个孩子**当前**还剩几位 active 家长（断言"家没被弄成没有家长"的直接证据）。 */
async function activeGuardianCount(childId: string): Promise<number> {
  return await prisma.childMember.count({
    where: { childId, role: 'guardian', status: 'active' }
  })
}

before(async () => {
  prisma = new PrismaService()
  // 手工实例化适配器（与 invites / identity 套件一致）：先验"接了真库怎么读写"。
  repository = new PrismaMembersRepository(prisma)
})

after(async () => {
  await prisma.$disconnect()
})

// ══ 组 A：listActiveMembers ═══════════════════════════════════════════════════
describe('组 A：listActiveMembers —— 只回 active、家长在前、字段集合封闭', () => {
  it('成员列表：家长 → 孩子 → viewer，被移出的不在列表里，别家的行不混进来', async () => {
    const childId = await makeChild('a1')
    const otherChild = await makeChild('a1-other')

    const dad = await makeUser('a1-dad', '爸爸')
    const kid = await makeUser('a1-kid', '小满')
    const grandma = await makeUser('a1-grandma', null) // displayName 为 null ⇒ 列表里必须原样是 null
    const gone = await makeUser('a1-gone', '已离开的舅舅')

    // 加入顺序刻意"孩子 → 爷爷 → viewer"，证明顺序不是插入顺序。
    await addMember(childId, kid, { role: 'child' }, 1000)
    const grandpa = await makeUser('a1-grandpa', '爷爷')
    await addMember(childId, grandpa, { role: 'guardian' }, 2000)
    await addMember(childId, dad, { role: 'guardian' }, 0)
    await addMember(childId, grandma, { role: 'viewer' }, 3000)
    await addMember(childId, gone, { role: 'guardian', status: 'removed' }, 4000)
    await addMember(otherChild, dad, { role: 'guardian' })

    const rows = await repository.listActiveMembers(childId)

    assert.deepEqual(
      rows.map((row) => row.userId),
      [dad, grandpa, kid, grandma],
      '顺序：家长在前（同级按加入时间），孩子其次，viewer 最后'
    )
    assert.equal(rows.length, 4, '已移出的成员位不该出现在列表里')
    assert.deepEqual(
      rows.map((row) => row.role),
      ['guardian', 'guardian', 'child', 'viewer']
    )

    const byUser = new Map(rows.map((row) => [row.userId, row]))
    assert.equal(byUser.get(grandma)?.displayName, null, '没设名字必须是 null，不能编一个')
    assert.equal(byUser.get(kid)?.displayName, '小满')
    assert.equal(byUser.get(dad)?.status, 'active')
    assert.equal(byUser.get(dad)?.removedAt, null)
    assert.ok(byUser.get(dad)?.joinedAt instanceof Date, 'joinedAt 必须在端口层仍是 Date')
  })

  it('★ 端口行字段集合封闭：不夹带 pinHash / restrictions / openId（那是另一类数据）', async () => {
    const childId = await makeChild('a2')
    const dad = await makeUser('a2-dad')
    await addMember(childId, dad, { role: 'guardian' })

    const rows = await repository.listActiveMembers(childId)
    assert.equal(rows.length, 1)
    assert.deepEqual(
      Object.keys(rows[0]).sort(),
      ['displayName', 'joinedAt', 'memberId', 'removedAt', 'role', 'status', 'userId'],
      '端口行多了字段 —— 列表端点是"家里有谁"，不是成员档案详情'
    )
  })

  it('没有任何成员位的孩子 ⇒ 空数组（不是 null / 不是造假的一行）', async () => {
    const childId = await makeChild('a3')
    assert.deepEqual(await repository.listActiveMembers(childId), [])
  })
})


// ══ 组 B：changeMemberRole ════════════════════════════════════════════════════
describe('组 B：changeMemberRole —— 真写入、审计、会话收回、幂等与拒绝', () => {
  it('★ 家长降为孩子 ⇒ 成员位落库 + **同一事务**把他该孩子的 guardian 会话收回 child', async () => {
    const childId = await makeChild('b1')
    const dad = await makeUser('b1-dad')
    const mother = await makeUser('b1-mother')
    await addMember(childId, dad, { role: 'guardian' }, 0)
    const memberId = await addMember(childId, mother, { role: 'guardian' }, 1000)

    const otherChild = await makeChild('b1-other')
    await addMember(otherChild, mother, { role: 'guardian' })
    await addSession(childId, mother, `dbtest-${RUN}-dev-b1-a`, 'guardian')
    await addSession(childId, mother, `dbtest-${RUN}-dev-b1-b`, 'child')
    // 别的孩子的会话不该被这次降级碰到。
    await addSession(otherChild, mother, `dbtest-${RUN}-dev-b1-c`, 'guardian')

    const result = await repository.changeMemberRole(
      roleInput(childId, memberId, dad, 'child', `dbtest-${RUN}-dev-b1-dad`)
    )

    assert.equal(result.changed, true)
    assert.equal(result.member.role, 'child')
    assert.equal(result.member.memberId, memberId)

    const stored = await prisma.childMember.findUniqueOrThrow({ where: { id: memberId } })
    assert.equal(stored.role, 'child')

    const sessions = await prisma.deviceSession.findMany({
      where: { childId, userId: mother },
      orderBy: { deviceId: 'asc' }
    })
    assert.deepEqual(
      sessions.map((row) => row.activeRole),
      ['child', 'child'],
      '降级后他手上的 guardian 会话还在 —— 他的设备下一分钟仍然是家长'
    )
    const otherSession = await prisma.deviceSession.findFirstOrThrow({
      where: { childId: otherChild, userId: mother }
    })
    assert.equal(otherSession.activeRole, 'guardian', '降级串到了别的孩子')

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { childId, action: 'member.role_change', targetId: memberId }
    })
    assert.equal(audit.actorUserId, dad)
    assert.equal(audit.actorRole, 'guardian')
    assert.equal(audit.targetType, 'ChildMember')
    assert.equal(audit.deviceId, `dbtest-${RUN}-dev-b1-dad`)
    assert.deepEqual(audit.before, { role: 'guardian' })
    assert.deepEqual(audit.after, { role: 'child' })
  })

  it('升级 child → guardian 不碰会话（孩子的票本来就只能是 child）', async () => {
    const childId = await makeChild('b2')
    const dad = await makeUser('b2-dad')
    const kid = await makeUser('b2-kid')
    await addMember(childId, dad, { role: 'guardian' }, 0)
    const memberId = await addMember(childId, kid, { role: 'child' }, 1000)
    await addSession(childId, kid, `dbtest-${RUN}-dev-b2`, 'child')

    const result = await repository.changeMemberRole(roleInput(childId, memberId, dad, 'guardian'))
    assert.equal(result.member.role, 'guardian')

    const session = await prisma.deviceSession.findFirstOrThrow({
      where: { childId, userId: kid }
    })
    assert.equal(session.activeRole, 'child', '升级不该顺手把他的票也升成家长')
    assert.equal(await activeGuardianCount(childId), 2)
  })

  it('幂等：目标角色本来就一样 ⇒ changed=false，且**不写第二条审计**', async () => {
    const childId = await makeChild('b3')
    const dad = await makeUser('b3-dad')
    const kid = await makeUser('b3-kid')
    await addMember(childId, dad, { role: 'guardian' }, 0)
    const memberId = await addMember(childId, kid, { role: 'child' }, 1000)

    const result = await repository.changeMemberRole(roleInput(childId, memberId, dad, 'child'))
    assert.equal(result.changed, false)
    assert.equal(result.member.role, 'child')
    assert.equal(
      await prisma.auditLog.count({ where: { childId, action: 'member.role_change' } }),
      0,
      '没有发生变化却写了审计 —— 每点一次按钮就多一条噪音'
    )
  })

  it('改自己 ⇒ 403 CANNOT_MODIFY_SELF，库里一行不变、无审计', async () => {
    const childId = await makeChild('b4')
    const dad = await makeUser('b4-dad')
    const mother = await makeUser('b4-mother')
    const dadMemberId = await addMember(childId, dad, { role: 'guardian' }, 0)
    await addMember(childId, mother, { role: 'guardian' }, 1000)

    await assert.rejects(
      repository.changeMemberRole(roleInput(childId, dadMemberId, dad, 'child')),
      (error: unknown) => errorCode(error) === 'CANNOT_MODIFY_SELF'
    )

    const stored = await prisma.childMember.findUniqueOrThrow({ where: { id: dadMemberId } })
    assert.equal(stored.role, 'guardian')
    assert.equal(await prisma.auditLog.count({ where: { childId } }), 0)
  })
})


// ══ 组 B（续）：NotFound / 非 active / 唯一家长 ═════════════════════════════════
describe('组 B：拒绝路径不留下半截状态', () => {
  it('跨孩子的 memberId ⇒ 404 MEMBER_NOT_FOUND（不泄露别家那一行是否存在）', async () => {
    const childId = await makeChild('b5')
    const otherChild = await makeChild('b5-other')
    const dad = await makeUser('b5-dad')
    const stranger = await makeUser('b5-stranger')
    await addMember(childId, dad, { role: 'guardian' })
    await addMember(otherChild, dad, { role: 'guardian' })
    const foreignMemberId = await addMember(otherChild, stranger, { role: 'child' })

    await assert.rejects(
      repository.changeMemberRole(roleInput(childId, foreignMemberId, dad, 'guardian')),
      (error: unknown) => errorCode(error) === 'MEMBER_NOT_FOUND'
    )

    const foreign = await prisma.childMember.findUniqueOrThrow({ where: { id: foreignMemberId } })
    assert.equal(foreign.role, 'child', '404 却把别家的行改了 —— 跨孩子不是"顺手能改"')
  })

  it('已移出的成员位 ⇒ 409 MEMBER_NOT_ACTIVE（不把 removed 行"复活"成家长）', async () => {
    const childId = await makeChild('b6')
    const dad = await makeUser('b6-dad')
    const gone = await makeUser('b6-gone')
    await addMember(childId, dad, { role: 'guardian' }, 0)
    const memberId = await addMember(childId, gone, { role: 'child', status: 'removed' }, 1000)

    await assert.rejects(
      repository.changeMemberRole(roleInput(childId, memberId, dad, 'guardian')),
      (error: unknown) => errorCode(error) === 'MEMBER_NOT_ACTIVE'
    )
    assert.equal(await activeGuardianCount(childId), 1)
    const stored = await prisma.childMember.findUniqueOrThrow({ where: { id: memberId } })
    assert.equal(stored.role, 'child')
    assert.equal(stored.status, 'removed')
  })

  it('★ 唯一家长被别人降级 ⇒ 409 LAST_GUARDIAN_PROTECTED，他仍是 active guardian', async () => {
    const childId = await makeChild('b7')
    const soloParent = await makeUser('b7-solo')
    const kid = await makeUser('b7-kid')
    const soloMemberId = await addMember(childId, soloParent, { role: 'guardian' }, 0)
    await addMember(childId, kid, { role: 'child' }, 1000)

    // 适配器的判据是**集合**（还有几位家长），与谁发起无关，所以这里直接用孩子
    // 账号当 operator —— 若哪天"最后一位家长"被写成"看 operator 是不是他"，这条会红。
    await assert.rejects(
      repository.changeMemberRole(roleInput(childId, soloMemberId, kid, 'child')),
      (error: unknown) => errorCode(error) === 'LAST_GUARDIAN_PROTECTED'
    )

    const stored = await prisma.childMember.findUniqueOrThrow({ where: { id: soloMemberId } })
    assert.equal(stored.role, 'guardian')
    assert.equal(await activeGuardianCount(childId), 1)
    assert.equal(await prisma.auditLog.count({ where: { childId } }), 0)
  })
})

// ══ 组 C：removeMember ════════════════════════════════════════════════════════
describe('组 C：removeMember —— 软移除、会话保留、构造幂等', () => {
  it('★ 移出家长 ⇒ status=removed + removedAt，**会话行留着**（让屏障一回 MEMBER_REMOVED）', async () => {
    const childId = await makeChild('c1')
    const dad = await makeUser('c1-dad')
    const uncle = await makeUser('c1-uncle')
    const dadMemberId = await addMember(childId, dad, { role: 'guardian' }, 0)
    const memberId = await addMember(childId, uncle, { role: 'guardian' }, 1000)
    await addSession(childId, uncle, `dbtest-${RUN}-dev-c1`, 'guardian')

    const result = await repository.removeMember(
      removeInput(childId, memberId, dad, `dbtest-${RUN}-dev-c1-dad`)
    )
    assert.equal(result.alreadyRemoved, false)
    assert.equal(result.memberId, memberId)

    const stored = await prisma.childMember.findUniqueOrThrow({ where: { id: memberId } })
    assert.equal(stored.status, 'removed')
    assert.ok(stored.removedAt instanceof Date, 'removedAt 没写')
    assert.equal(stored.role, 'guardian', '移出不改角色（他离开时是家长，这是历史事实）')

    const sessions = await prisma.deviceSession.count({ where: { childId, userId: uncle } })
    assert.equal(
      sessions,
      1,
      '会话被删了 —— 屏障一只能回 401"没登录"，把"你已被移出"伪装成了另一种事实'
    )

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { childId, action: 'member.remove', targetId: memberId }
    })
    assert.equal(audit.actorUserId, dad)
    assert.equal(audit.targetType, 'ChildMember')
    assert.deepEqual(audit.before, { status: 'active', role: 'guardian' })
    assert.deepEqual(audit.after, { status: 'removed' })

    const list = await repository.listActiveMembers(childId)
    assert.deepEqual(
      list.map((row) => row.memberId),
      [dadMemberId],
      '移出后仍出现在成员列表里（或把还留着的家长也一并抹掉了）'
    )
  })


  it('再移一次 ⇒ alreadyRemoved=true，removedAt 不变、审计仍只有一条', async () => {
    const childId = await makeChild('c2')
    const dad = await makeUser('c2-dad')
    const uncle = await makeUser('c2-uncle')
    await addMember(childId, dad, { role: 'guardian' }, 0)
    const memberId = await addMember(childId, uncle, { role: 'guardian' }, 1000)

    const first = await repository.removeMember(removeInput(childId, memberId, dad))
    const second = await repository.removeMember(removeInput(childId, memberId, dad))

    assert.equal(first.alreadyRemoved, false)
    assert.equal(second.alreadyRemoved, true)
    assert.equal(
      second.removedAt.getTime(),
      first.removedAt.getTime(),
      '第二次移出改了 removedAt —— 客户端会看到"刚刚移出"的时间在往后跳'
    )
    assert.equal(
      await prisma.auditLog.count({ where: { childId, action: 'member.remove' } }),
      1,
      '重复移出写了第二条审计'
    )
  })

  it('移出自己 ⇒ 403 CANNOT_MODIFY_SELF（"退出家庭"不是这条路由的顺手实现）', async () => {
    const childId = await makeChild('c3')
    const dad = await makeUser('c3-dad')
    const mother = await makeUser('c3-mother')
    const dadMemberId = await addMember(childId, dad, { role: 'guardian' }, 0)
    await addMember(childId, mother, { role: 'guardian' }, 1000)

    await assert.rejects(
      repository.removeMember(removeInput(childId, dadMemberId, dad)),
      (error: unknown) => errorCode(error) === 'CANNOT_MODIFY_SELF'
    )

    const stored = await prisma.childMember.findUniqueOrThrow({ where: { id: dadMemberId } })
    assert.equal(stored.status, 'active')
    assert.equal(await prisma.auditLog.count({ where: { childId } }), 0)
  })

  it('★ 移出唯一家长 ⇒ 409 LAST_GUARDIAN_PROTECTED，他仍 active（家不会被移空）', async () => {
    const childId = await makeChild('c4')
    const soloParent = await makeUser('c4-solo')
    const kid = await makeUser('c4-kid')
    const soloMemberId = await addMember(childId, soloParent, { role: 'guardian' }, 0)
    await addMember(childId, kid, { role: 'child' }, 1000)

    await assert.rejects(
      repository.removeMember(removeInput(childId, soloMemberId, kid)),
      (error: unknown) => errorCode(error) === 'LAST_GUARDIAN_PROTECTED'
    )

    const stored = await prisma.childMember.findUniqueOrThrow({ where: { id: soloMemberId } })
    assert.equal(stored.status, 'active')
    assert.equal(stored.removedAt, null)
    assert.equal(await prisma.auditLog.count({ where: { childId } }), 0)
  })

  it('移出孩子不受"最后一位家长"影响（保护的是家长集合，不是"最后一个人"）', async () => {
    const childId = await makeChild('c5')
    const dad = await makeUser('c5-dad')
    const kid = await makeUser('c5-kid')
    await addMember(childId, dad, { role: 'guardian' }, 0)
    const kidMemberId = await addMember(childId, kid, { role: 'child' }, 1000)

    const result = await repository.removeMember(removeInput(childId, kidMemberId, dad))
    assert.equal(result.alreadyRemoved, false)
    assert.equal(await activeGuardianCount(childId), 1)
  })
})


// ══ 组 D：并发 —— 替身永远证明不了的那一半 ═══════════════════════════════════
describe('组 D：并发（真库串行化）', () => {
  it('★ 三位家长环形降级 ⇒ 恰好 2 成功 / 1×409，库里**恒剩 1 位家长**', async () => {
    const childId = await makeChild('d1')
    const a = await makeUser('d1-a', '家长 A')
    const b = await makeUser('d1-b', '家长 B')
    const c = await makeUser('d1-c', '家长 C')
    const memberA = await addMember(childId, a, { role: 'guardian' }, 0)
    const memberB = await addMember(childId, b, { role: 'guardian' }, 1000)
    const memberC = await addMember(childId, c, { role: 'guardian' }, 2000)

    // A 降 B、B 降 C、C 降 A —— 每个请求单独看都合法（都不是"改自己"），
    // 只有"还有几位家长"这个集合事实能挡住最后一笔。
    const results = await Promise.allSettled([
      repository.changeMemberRole(roleInput(childId, memberB, a, 'child')),
      repository.changeMemberRole(roleInput(childId, memberC, b, 'child')),
      repository.changeMemberRole(roleInput(childId, memberA, c, 'child'))
    ])

    const ok = results.filter((result) => result.status === 'fulfilled')
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    assert.equal(ok.length, 2, `应恰好 2 个成功，实际 ${ok.length} 个`)
    assert.equal(failed.length, 1, `应恰好 1 个失败，实际 ${failed.length} 个`)
    assert.equal(
      errorCode(failed[0].reason),
      'LAST_GUARDIAN_PROTECTED',
      '失败的原因必须是"最后一位家长"，不是死锁 / 超时'
    )
    assert.equal(
      await activeGuardianCount(childId),
      1,
      '并发降级把家里的家长降没了 —— 先查后改 / 单条条件 UPDATE 的典型漏法'
    )
    assert.equal(
      await prisma.auditLog.count({ where: { childId, action: 'member.role_change' } }),
      2,
      '审计条数与真正发生的变更数不一致'
    )
  })

  it('★ 两个人同时被移出（互为对方的操作人）⇒ 恰好 1 成功 / 1×409，仍剩 1 位家长', async () => {
    const childId = await makeChild('d2')
    const a = await makeUser('d2-a', '家长 A')
    const b = await makeUser('d2-b', '家长 B')
    const memberA = await addMember(childId, a, { role: 'guardian' }, 0)
    const memberB = await addMember(childId, b, { role: 'guardian' }, 1000)

    const results = await Promise.allSettled([
      repository.removeMember(removeInput(childId, memberB, a)),
      repository.removeMember(removeInput(childId, memberA, b))
    ])

    const ok = results.filter((result) => result.status === 'fulfilled')
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    assert.equal(ok.length, 1, `应恰好 1 个成功，实际 ${ok.length} 个`)
    assert.equal(failed.length, 1)
    assert.equal(errorCode(failed[0].reason), 'LAST_GUARDIAN_PROTECTED')
    assert.equal(await activeGuardianCount(childId), 1)
    assert.equal(
      await prisma.auditLog.count({ where: { childId, action: 'member.remove' } }),
      1
    )
  })

  it('★ 连点两次同一个降级 ⇒ 两个请求都成功，但**只有一次真正的变更**、一条审计', async () => {
    const childId = await makeChild('d3')
    const dad = await makeUser('d3-dad')
    const mother = await makeUser('d3-mother')
    await addMember(childId, dad, { role: 'guardian' }, 0)
    const memberId = await addMember(childId, mother, { role: 'guardian' }, 1000)

    const results = await Promise.all([
      repository.changeMemberRole(roleInput(childId, memberId, dad, 'child')),
      repository.changeMemberRole(roleInput(childId, memberId, dad, 'child'))
    ])

    assert.equal(
      results.filter((result) => result.changed).length,
      1,
      '两笔都报了"改了" —— 第二笔应该看到角色已经是 child，走幂等 no-op'
    )
    assert.equal(
      await prisma.auditLog.count({ where: { childId, action: 'member.role_change' } }),
      1
    )
    assert.equal(await activeGuardianCount(childId), 1)
  })
})

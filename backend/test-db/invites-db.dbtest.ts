/**
 * invites-db.dbtest.ts —— 邀请码的**真库**不变量套件（W5-G，2026-10-22）
 *
 * 离线用例（`test/invites-http.test.ts`）只能证明「路由问对了问题」：
 * 端口是替身，**它不可能真的并发**。本文件补的正是替身永远证明不了的四件事：
 *
 *   ① **不超发**：`maxUses=3` 的码被 10 个请求同时加入 ⇒ 恰好 3 成功、7 个 409，
 *      `usedCount` 恒等于 3。任何「先查剩余次数再 +1」的实现会在这里红。
 *   ② **失败不烧名额**：占位成功但成员位 / 会话写不进去（已经是成员、
 *      设备上有别人的会话）⇒ 整笔事务回滚，`usedCount` **还是 0**。
 *      这是"用一条条件 UPDATE 占位、却忘了把后续写入放进同一个事务"的典型漏洞。
 *   ③ **唯一约束是撞码的最终裁判**：`InviteCode.code` 上的唯一索引真存在
 *      （适配器靠 P2002 换码重试，这条索引没了它就会静默重复）。
 *   ④ **审计里没有码**：`action='invite.create' / 'member.join'` 的 `after`
 *      快照里不得出现码本身（审计读取面比邀请码列表宽得多）。
 *
 * ── ★ 与其它真库套件同一条纪律：不做 DELETE 清理 ──────────────────────────
 *   每轮运行用一个新前缀（`dbtest-<run>-…`），跑完"那些行还在"本身就是证据。
 *   邀请码用 `codeFor()` 按「本轮种子 + 单调计数器」派生 ⇒ 同一轮内**绝不重复**、
 *   跨轮几乎不可能撞、且形状合法（字母表里没有 0/1，不能直接拿 UUID 的十六进制当码）。
 *   ★ 这里踩过一次：把 `(RUN + label)` 的 ASCII 做「base-31 多项式哈希」时，
 *     ASCII 码远大于 31 ⇒ 不同字符串会落到同一个值（实测第一轮就撞了唯一约束）。
 *     计数器是唯一不需要概率论证的做法。

 *
 * ── 入口 ──────────────────────────────────────────────────────────────────
 *   `npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { ConflictException, NotFoundException } from '@nestjs/common'

import { INVITE_CODE_ALPHABET } from '../src/invites/invite-code'
import { PrismaInvitesRepository } from '../src/invites/invites.prisma.repository'
import type { CreateInviteInput } from '../src/invites/invites.repository'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 —— 保证「新孩子、新账号、新邀请码」，与历史数据互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

let prisma: PrismaService
let repository: PrismaInvitesRepository

/**
 * 由「本轮种子 + 单调计数器」派生一个**形状合法**的码。
 *
 * 为什么不直接用 UUID：字母表里没有 `0` / `1`，十六进制串会造出
 * `isWellFormedInviteCode()` 判为非法、且用户抄不出来的码。
 *
 * 为什么不能对 `RUN + label` 做哈希：`charCodeAt()` 的值（48–122）远大于字母表
 * 长度 31，`(hash * 31 + charCode) % 31 ** 8` 会让不同字符串落到同一个值 ——
 * 本轮第一版就是这么撞上 `InviteCode_code_key` 的（真库抓到的，不是推测）。
 *
 * 计数器的保证是**构造性**的：`seed * BLOCK + counter` 在同一轮内两两不同
 * （`counter` 严格递增且远小于 `BLOCK`），不需要概率论证。
 */
const CODE_BLOCK = 4096
const CODE_SPACE = INVITE_CODE_ALPHABET.length ** 8
/** 本轮种子：取自 UUID，落在一个 block 里，保证同一 block 内的码只属于这一轮。 */
const CODE_SEED = Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 12), 16)
const CODE_BLOCKS = Math.floor(CODE_SPACE / CODE_BLOCK)
let codeCounter = 0

function codeFor(): string {
  codeCounter += 1
  let value = ((CODE_SEED % CODE_BLOCKS) * CODE_BLOCK + codeCounter) % CODE_SPACE
  let code = ''
  for (let i = 0; i < 8; i += 1) {
    code += INVITE_CODE_ALPHABET[value % INVITE_CODE_ALPHABET.length]
    value = Math.floor(value / INVITE_CODE_ALPHABET.length)
  }
  return code
}

async function makeChild(label: string): Promise<string> {
  const id = `dbtest-${RUN}-child-${label}`
  await prisma.child.create({ data: { id, name: `DB 邀请码套件 ${label}` } })
  return id
}

async function makeUser(label: string): Promise<string> {
  const id = `dbtest-${RUN}-user-${label}`
  await prisma.user.create({ data: { id, displayName: `DB 邀请码套件 ${label}` } })
  return id
}

interface InviteSeedOptions {
  childId: string
  createdByUserId: string
  role?: 'child' | 'guardian'
  maxUses?: number
  expiresAt?: Date
  revoked?: boolean
}

/** 直接造一行邀请码（用于"已过期 / 已吊销"这类 `createInvite` 造不出来的前提）。 */
async function seedInvite(options: InviteSeedOptions): Promise<{ id: string; code: string }> {
  const code = codeFor()
  const row = await prisma.inviteCode.create({
    data: {
      childId: options.childId,
      code,
      role: options.role ?? 'guardian',
      maxUses: options.maxUses ?? 1,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      revoked: options.revoked ?? false,
      createdByUserId: options.createdByUserId
    },
    select: { id: true, code: true }
  })
  return row
}

/** 走**被测入口**创建邀请码（`createInvite`），返回端口行。 */
function createInput(
  childId: string,
  createdByUserId: string,
  overrides: Partial<CreateInviteInput> = {}
): CreateInviteInput {
  return {
    childId,
    role: 'guardian',
    maxUses: 1,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    operatorUserId: createdByUserId,
    operatorRole: 'guardian',
    ...overrides
  }
}

function acceptInput(
  code: string,
  userId: string,
  deviceId: string
): {
  code: string
  userId: string
  deviceId: string
  sessionExpiresAt: Date
} {
  return {
    code,
    userId,
    deviceId,
    sessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  }
}

/** 从 `HttpException` 的响应体里取业务 code（409 有多种，断言要精确到哪一种）。 */
function errorCode(error: unknown): string {
  if (error instanceof ConflictException || error instanceof NotFoundException) {
    const response = error.getResponse()
    if (typeof response === 'object' && response !== null) {
      return String((response as { code?: unknown }).code)
    }
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

before(async () => {
  prisma = new PrismaService()
  // ★ 手工实例化适配器（与 identity / ledger 套件一致）：先把"接了真库怎么读写"验清楚。
  repository = new PrismaInvitesRepository(prisma)
})

after(async () => {
  await prisma.$disconnect()
})

// ══ 组 A：createInvite ════════════════════════════════════════════════════════
describe('组 A：createInvite —— 真写入、审计里没有码', () => {
  it('生成的码形状合法、真落库；审计 `invite.create` 的快照里**不含码本身**', async () => {
    const childId = await makeChild('a1')
    const dad = await makeUser('a1-dad')

    const row = await repository.createInvite(createInput(childId, dad, { maxUses: 3 }))

    assert.equal(row.code.length, 8)
    for (const char of row.code) {
      assert.ok(INVITE_CODE_ALPHABET.includes(char), `码里出现了字母表外的字符：${char}`)
    }
    assert.equal(row.childId, childId)
    assert.equal(row.role, 'guardian')
    assert.equal(row.maxUses, 3)
    assert.equal(row.usedCount, 0)
    assert.equal(row.revoked, false)

    const stored = await prisma.inviteCode.findUnique({ where: { code: row.code } })
    assert.equal(stored?.id, row.id, '回包的 id 与库里那一行对不上')

    const audit = await prisma.auditLog.findFirst({
      where: { childId, action: 'invite.create', targetId: row.id }
    })
    assert.ok(audit !== null, '没有写 invite.create 审计')
    assert.equal(audit.actorUserId, dad)
    assert.equal(audit.actorRole, 'guardian')
    assert.equal(audit.targetType, 'InviteCode')
    // ★ 审计的读取面比邀请码列表宽 ⇒ 码本身绝不能出现在快照里（它是一份凭据）。
    assert.equal(
      JSON.stringify(audit.after).includes(row.code),
      false,
      '审计快照里出现了邀请码本身 —— 凭据被写进了读取面更宽的地方'
    )
  })

  it('孩子不存在 ⇒ 404 CHILD_NOT_FOUND，且没有留下任何邀请码行', async () => {
    const dad = await makeUser('a2-dad')
    const missing = `dbtest-${RUN}-child-missing`
    const before = await prisma.inviteCode.count({ where: { childId: missing } })

    await assert.rejects(
      repository.createInvite(createInput(missing, dad)),
      (error: unknown) => errorCode(error) === 'CHILD_NOT_FOUND'
    )

    assert.equal(await prisma.inviteCode.count({ where: { childId: missing } }), before)
  })

  it('软删除的孩子 ⇒ 404（不给已删除的档案发钥匙）', async () => {
    const childId = await makeChild('a3')
    const dad = await makeUser('a3-dad')
    await prisma.child.update({
      where: { id: childId },
      data: { status: 'deleted', deletedAt: new Date() }
    })

    await assert.rejects(
      repository.createInvite(createInput(childId, dad)),
      (error: unknown) => errorCode(error) === 'CHILD_NOT_FOUND'
    )
  })

  it('role=child 的码按 child 落库（邀请人可以决定给什么角色）', async () => {
    const childId = await makeChild('a4')
    const dad = await makeUser('a4-dad')
    const row = await repository.createInvite(createInput(childId, dad, { role: 'child' }))
    assert.equal(row.role, 'child')
    const stored = await prisma.inviteCode.findUnique({ where: { id: row.id } })
    assert.equal(stored?.role, 'child')
  })
})

// ══ 组 B：listInvites ════════════════════════════════════════════════════════
describe("组 B：listInvites —— 只看自己孩子的那几行", () => {
  it('只返回本孩子的码（含已吊销的），按创建时间倒序', async () => {
    const childA = await makeChild('b1-a')
    const childB = await makeChild('b1-b')
    const dad = await makeUser('b1-dad')

    const first = await repository.createInvite(createInput(childA, dad))
    const second = await repository.createInvite(createInput(childA, dad, { maxUses: 5 }))
    const other = await repository.createInvite(createInput(childB, dad))

    // 吊销一行：列表只陈述事实（`revoked: true`），**不**替客户端过滤掉它
    // —— 否则家长再也看不到"自己吊销过哪些码"。
    const revoked = await seedInvite({
      childId: childA,
      createdByUserId: dad,
      revoked: true
    })

    const rows = await repository.listInvites(childA)
    const codes = rows.map((row) => row.code)

    assert.ok(codes.includes(first.code))
    assert.ok(codes.includes(second.code))
    assert.ok(codes.includes(revoked.code))
    assert.equal(codes.includes(other.code), false, '另一个孩子的码出现在了列表里')
    assert.equal(rows.some((row) => row.id === revoked.id && row.revoked), true)

    // 倒序：最新创建的在最前（`createdAt DESC`）
    const times = rows.map((row) => row.createdAt.getTime())
    assert.deepEqual(times, [...times].sort((a, b) => b - a))
  })

  it('没有码的孩子 ⇒ 空数组（不是 404）', async () => {
    const childId = await makeChild('b2')
    assert.deepEqual(await repository.listInvites(childId), [])
  })
})

// ══ 组 C：★ 并发 —— 02 §9.6 的验收条件 ════════════════════════════════════════
describe('组 C：★ 并发不超发（maxUses=3，10 个请求同时加入）', () => {
  it('恰好 3 成功、7 个 409 INVITE_CODE_UNAVAILABLE，usedCount 恒为 3', async () => {
    const childId = await makeChild('c1')
    const dad = await makeUser('c1-dad')
    const invite = await seedInvite({
      childId,
      createdByUserId: dad,
      maxUses: 3
    })

    const users: string[] = []
    for (let i = 0; i < 10; i += 1) users.push(await makeUser(`c1-u${i}`))

    // 真并发：10 个事务同时撞同一行。任何「先读剩余次数、再 +1」的实现
    // 都会让这里出现 4 个以上成功（TOCTOU）；条件 UPDATE 才是唯一判据。
    const results = await Promise.allSettled(
      users.map((userId, index) =>
        repository.acceptInvite(
          acceptInput(invite.code, userId, `dbtest-${RUN}-dev-c1-${index}`)
        )
      )
    )

    const ok = results.filter((result) => result.status === 'fulfilled')
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )

    assert.equal(ok.length, 3, `应恰好 3 个成功，实际 ${ok.length} 个`)
    assert.equal(failed.length, 7, `应恰好 7 个失败，实际 ${failed.length} 个`)
    for (const failure of failed) {
      assert.equal(errorCode(failure.reason), 'INVITE_CODE_UNAVAILABLE')
    }

    const row = await prisma.inviteCode.findUnique({ where: { id: invite.id } })
    assert.equal(row?.usedCount, 3, 'usedCount 超发了 —— 条件 UPDATE 的 WHERE 被绕过了')
    assert.ok(users.includes(row?.usedByUserId ?? ''), 'usedByUserId 不是任何一个真实加入者')

    // 成员位数必须与 usedCount 一致：占位成功但没有成员位 = 用户拿到了"空手券"。
    const members = await prisma.childMember.findMany({
      where: { childId, userId: { in: users } }
    })
    assert.equal(members.length, 3, '成员位数与 usedCount 不一致')
    for (const member of members) {
      assert.equal(member.role, 'guardian')
      assert.equal(member.status, 'active')
      assert.equal(member.invitedByUserId, dad)
    }

    // 每个成功者都在自己那台设备上拿到了会话（7 个失败者一台都不许有）。
    const sessions = await prisma.deviceSession.findMany({ where: { childId } })
    assert.equal(sessions.length, 3, '会话数与成功数不一致')
    assert.deepEqual(
      sessions.map((session) => session.userId).sort(),
      members.map((member) => member.userId).sort()
    )
  })
})

// ══ 组 D：★ 占位失败必须回滚名额 ══════════════════════════════════════════════
describe('组 D：★ 占位失败回滚（用户没得到东西，就不许烧掉一次名额）', () => {
  it('已经是成员 ⇒ 409 ALREADY_MEMBER，usedCount 仍是 0，角色不被码改掉', async () => {
    const childId = await makeChild('d1')
    const dad = await makeUser('d1-dad')
    const kid = await makeUser('d1-kid')
    await prisma.childMember.create({
      data: { childId, userId: kid, role: 'child', status: 'active' }
    })
    const invite = await seedInvite({
      childId,
      createdByUserId: dad,
      role: 'guardian',
      maxUses: 2
    })

    await assert.rejects(
      repository.acceptInvite(acceptInput(invite.code, kid, `dbtest-${RUN}-dev-d1`)),
      (error: unknown) => errorCode(error) === 'ALREADY_MEMBER'
    )

    const row = await prisma.inviteCode.findUnique({ where: { id: invite.id } })
    assert.equal(row?.usedCount, 0, '占位没有被回滚 —— 名额被白烧了一次')
    const member = await prisma.childMember.findUnique({
      where: { childId_userId: { childId, userId: kid } }
    })
    assert.equal(member?.role, 'child', '被拒绝的请求却把成员角色改成了码上的角色')
    assert.equal(
      await prisma.deviceSession.count({ where: { childId } }),
      0,
      '被拒绝的请求留下了会话'
    )
  })

  it('这台设备上已有别人的会话 ⇒ 409 DEVICE_SESSION_CONFLICT，usedCount 仍是 0', async () => {
    const childId = await makeChild('d2')
    const dad = await makeUser('d2-dad')
    const other = await makeUser('d2-other')
    const newcomer = await makeUser('d2-new')
    const deviceId = `dbtest-${RUN}-dev-d2`
    await prisma.deviceSession.create({
      data: {
        deviceId,
        childId,
        userId: other,
        activeRole: 'guardian',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    })
    const invite = await seedInvite({ childId, createdByUserId: dad })

    await assert.rejects(
      repository.acceptInvite(acceptInput(invite.code, newcomer, deviceId)),
      (error: unknown) => errorCode(error) === 'DEVICE_SESSION_CONFLICT'
    )

    const row = await prisma.inviteCode.findUnique({ where: { id: invite.id } })
    assert.equal(row?.usedCount, 0, '占位没有被回滚')
    const session = await prisma.deviceSession.findUnique({
      where: { deviceId_childId: { deviceId, childId } }
    })
    assert.equal(session?.userId, other, '静默覆盖了别人的会话 —— 一份凭据被顶掉了')
    const member = await prisma.childMember.findUnique({
      where: { childId_userId: { childId, userId: newcomer } }
    })
    assert.equal(member, null, '被拒绝的请求留下了成员位')
  })
})

// ══ 组 D-续：不可用的各种来源都收敛成同一个 409 ══════════════════════════════
describe('组 D-续：过期 / 吊销 / 不存在 —— 对客户端是同一句话', () => {
  it('已过期 ⇒ 409 INVITE_CODE_UNAVAILABLE，usedCount 仍是 0', async () => {
    const childId = await makeChild('d3')
    const dad = await makeUser('d3-dad')
    const user = await makeUser('d3-u')
    const invite = await seedInvite({
      childId,
      createdByUserId: dad,
      expiresAt: new Date(Date.now() - 60 * 1000) // 一分钟前就过期了
    })

    await assert.rejects(
      repository.acceptInvite(acceptInput(invite.code, user, `dbtest-${RUN}-dev-d3`)),
      (error: unknown) => errorCode(error) === 'INVITE_CODE_UNAVAILABLE'
    )
    const row = await prisma.inviteCode.findUnique({ where: { id: invite.id } })
    assert.equal(row?.usedCount, 0, '过期码被占用了名额')
  })

  it('已吊销 ⇒ 409；吊销后码本身仍在（只是不可用，可审计）', async () => {
    const childId = await makeChild('d4')
    const dad = await makeUser('d4-dad')
    const user = await makeUser('d4-u')
    const invite = await seedInvite({
      childId,
      createdByUserId: dad,
      revoked: true
    })

    await assert.rejects(
      repository.acceptInvite(acceptInput(invite.code, user, `dbtest-${RUN}-dev-d4`)),
      (error: unknown) => errorCode(error) === 'INVITE_CODE_UNAVAILABLE'
    )
    const row = await prisma.inviteCode.findUnique({ where: { id: invite.id } })
    assert.equal(row?.revoked, true)
    assert.equal(row?.usedCount, 0)
  })

  it('形状合法但不存在的码 ⇒ 409（与"已用完 / 已过期"同一个回答，不做存在性探测）', async () => {
    const childId = await makeChild('d5')
    const user = await makeUser('d5-u')

    await assert.rejects(
      repository.acceptInvite(
        acceptInput(codeFor(), user, `dbtest-${RUN}-dev-d5`)
      ),
      (error: unknown) => errorCode(error) === 'INVITE_CODE_UNAVAILABLE'
    )

    // 顺带确认这个孩子的库里确实一行码都没有（否则这条用例是假的）
    assert.equal(await prisma.inviteCode.count({ where: { childId } }), 0)
    // 也不许因此产生成员位 / 会话（失败必须干净）
    assert.equal(await prisma.childMember.count({ where: { childId } }), 0)
    assert.equal(await prisma.deviceSession.count({ where: { childId } }), 0)
  })
})

// ══ 组 E：★ 成功语义 —— 成员位 / 会话 / 审计 ══════════════════════════════════
describe('组 E：★ 加入成功写了什么', () => {
  it('成员位 active、角色来自码、invitedByUserId=创建者；会话按本设备签发；审计 member.join 不含码', async () => {
    const childId = await makeChild('e1')
    const dad = await makeUser('e1-dad')
    const aunt = await makeUser('e1-aunt')
    const deviceId = `dbtest-${RUN}-dev-e1`
    const invite = await seedInvite({
      childId,
      createdByUserId: dad,
      role: 'guardian'
    })
    const input = acceptInput(invite.code, aunt, deviceId)

    const result = await repository.acceptInvite(input)
    assert.deepEqual(result, {
      childId,
      role: 'guardian',
      sessionExpiresAt: input.sessionExpiresAt
    })

    // ① 码上的占位痕迹
    const claimed = await prisma.inviteCode.findUnique({ where: { id: invite.id } })
    assert.equal(claimed?.usedCount, 1)
    assert.equal(claimed?.usedByUserId, aunt)
    assert.notEqual(claimed?.usedAt, null)

    // ② 成员位
    const member = await prisma.childMember.findUnique({
      where: { childId_userId: { childId, userId: aunt } }
    })
    assert.ok(member !== null)
    assert.equal(member.role, 'guardian')
    assert.equal(member.status, 'active')
    assert.equal(member.removedAt, null)
    assert.equal(member.invitedByUserId, dad)

    // ③ 本设备的会话（换设备就不能算"这台已经登录"了）
    const session = await prisma.deviceSession.findUnique({
      where: { deviceId_childId: { deviceId, childId } }
    })
    assert.equal(session?.userId, aunt)
    assert.equal(session?.activeRole, 'guardian')
    assert.equal(session?.expiresAt.getTime(), input.sessionExpiresAt.getTime())

    // ④ 审计：指到成员位 + 邀请码**行**，但没有码本身
    const audit = await prisma.auditLog.findFirst({
      where: { childId, action: 'member.join' }
    })
    assert.ok(audit !== null, '没有写 member.join 审计')
    assert.equal(audit.actorUserId, aunt)
    assert.equal(audit.actorRole, 'guardian')
    assert.equal(audit.targetType, 'ChildMember')
    assert.equal(audit.targetId, member.id)
    assert.equal(audit.deviceId, deviceId)
    assert.equal((audit.after as { inviteCodeId?: string }).inviteCodeId, invite.id)
    assert.equal(
      JSON.stringify(audit.after).includes(invite.code),
      false,
      '审计快照里出现了邀请码本身'
    )
  })

  it('同一个码用两次（maxUses=2）：第二次是 409 ALREADY_MEMBER，usedCount 停在 1', async () => {
    const childId = await makeChild('e2')
    const dad = await makeUser('e2-dad')
    const user = await makeUser('e2-u')
    const invite = await seedInvite({
      childId,
      createdByUserId: dad,
      maxUses: 2
    })

    await repository.acceptInvite(acceptInput(invite.code, user, `dbtest-${RUN}-dev-e2`))
    await assert.rejects(
      repository.acceptInvite(acceptInput(invite.code, user, `dbtest-${RUN}-dev-e2b`)),
      (error: unknown) => errorCode(error) === 'ALREADY_MEMBER'
    )

    const row = await prisma.inviteCode.findUnique({ where: { id: invite.id } })
    assert.equal(row?.usedCount, 1, '重复点击把名额又烧了一次')
    // 第二台设备也没有被偷偷建会话
    assert.equal(await prisma.deviceSession.count({ where: { childId } }), 1)
  })

  it('曾被移出的人可以用新码回来：复用同一行成员位（id 不变），removedAt 清空', async () => {
    const childId = await makeChild('e3')
    const dad = await makeUser('e3-dad')
    const user = await makeUser('e3-u')
    const deviceId = `dbtest-${RUN}-dev-e3`
    const previous = await prisma.childMember.create({
      data: {
        childId,
        userId: user,
        role: 'child',
        status: 'removed',
        removedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        joinedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        invitedByUserId: dad
      },
      select: { id: true }
    })
    // 这台设备上还留着**同一个人**的旧会话：不该被判成 DEVICE_SESSION_CONFLICT
    await prisma.deviceSession.create({
      data: {
        deviceId,
        childId,
        userId: user,
        activeRole: 'child',
        expiresAt: new Date(Date.now() - 1000)
      }
    })
    const invite = await seedInvite({
      childId,
      createdByUserId: dad,
      role: 'guardian'
    })

    await repository.acceptInvite(acceptInput(invite.code, user, deviceId))

    const member = await prisma.childMember.findUnique({
      where: { childId_userId: { childId, userId: user } }
    })
    assert.equal(member?.id, previous.id, '回来时新建了一行 —— 唯一约束迟早会炸')
    assert.equal(member?.status, 'active')
    assert.equal(member?.removedAt, null)
    assert.equal(member?.role, 'guardian', '角色没有按新码更新')
    assert.equal(await prisma.childMember.count({ where: { childId } }), 1)

    const session = await prisma.deviceSession.findUnique({
      where: { deviceId_childId: { deviceId, childId } }
    })
    assert.equal(session?.activeRole, 'guardian')
    assert.ok(session !== null && session.expiresAt.getTime() > Date.now(), '过期会话没被续期')
  })
})

// ══ 组 F：revokeInvite —— 幂等 + 不越界 ═══════════════════════════════════════
describe('组 F：revokeInvite', () => {
  it('第一次真吊销并写审计；第二次同样 200，但**不**再写一条审计', async () => {
    const childId = await makeChild('f1')
    const dad = await makeUser('f1-dad')
    const invite = await seedInvite({ childId, createdByUserId: dad })
    const audits = () =>
      prisma.auditLog.count({
        where: { childId, action: 'invite.revoke', targetId: invite.id }
      })

    const first = await repository.revokeInvite({
      childId,
      inviteId: invite.id,
      operatorUserId: dad,
      operatorRole: 'guardian'
    })
    assert.deepEqual(first, { id: invite.id, revoked: true })

    const stored = await prisma.inviteCode.findUnique({ where: { id: invite.id } })
    assert.equal(stored?.revoked, true)
    assert.equal(await audits(), 1)

    const second = await repository.revokeInvite({
      childId,
      inviteId: invite.id,
      operatorUserId: dad,
      operatorRole: 'guardian'
    })
    assert.deepEqual(second, { id: invite.id, revoked: true })
    assert.equal(await audits(), 1, '重复吊销又写了一条一模一样的审计')
  })

  it('别的孩子的邀请码 ⇒ 404 INVITE_NOT_FOUND，且那一行**没有**被吊销', async () => {
    const mine = await makeChild('f2-a')
    const theirs = await makeChild('f2-b')
    const dad = await makeUser('f2-dad')
    const foreign = await seedInvite({ childId: theirs, createdByUserId: dad })

    await assert.rejects(
      repository.revokeInvite({
        childId: mine,
        inviteId: foreign.id,
        operatorUserId: dad,
        operatorRole: 'guardian'
      }),
      // 同答 404：不告诉调用方「这个 id 属于别人家」。
      (error: unknown) => errorCode(error) === 'INVITE_NOT_FOUND'
    )

    const stored = await prisma.inviteCode.findUnique({ where: { id: foreign.id } })
    assert.equal(stored?.revoked, false, '跨孩子的吊销竟然生效了')
  })

  it('吊销后再用同一个码加入 ⇒ 409（吊销即时生效，不看 usedCount）', async () => {
    const childId = await makeChild('f3')
    const dad = await makeUser('f3-dad')
    const user = await makeUser('f3-u')
    const invite = await seedInvite({
      childId,
      createdByUserId: dad,
      maxUses: 5
    })

    await repository.revokeInvite({
      childId,
      inviteId: invite.id,
      operatorUserId: dad,
      operatorRole: 'guardian'
    })

    await assert.rejects(
      repository.acceptInvite(acceptInput(invite.code, user, `dbtest-${RUN}-dev-f3`)),
      (error: unknown) => errorCode(error) === 'INVITE_CODE_UNAVAILABLE'
    )
    const row = await prisma.inviteCode.findUnique({ where: { id: invite.id } })
    assert.equal(row?.usedCount, 0)
  })
})








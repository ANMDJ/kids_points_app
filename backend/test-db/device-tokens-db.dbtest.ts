/**
 * device-tokens-db.dbtest.ts —— 设备推送 token 的**真库**不变量套件（W6-A，2026-10-24）
 *
 * ── 与另外两份用例的分工（缺哪份都算没验完）────────────────────────────────
 *   · `test/device-tokens.test.ts` —— 纯离线：矩阵 / 枚举对账 / 501 / service 口径 /
 *     配置解析 / `WebhookPushAdapter` 对真 HTTP 假网关的四种回答。端口是替身。
 *   · `test/device-tokens-http.test.ts` —— 真 Nest + 真路由：三道屏障、响应形状、
 *     409 / 404 机器码、请求体封闭。端口仍是替身 ⇒ SQL 一行都没跑。
 *   · **本文件** —— 真 `PrismaDeviceTokensRepository` + 真 Postgres，补的正是替身
 *     永远证明不了的几件事：
 *
 *   ① **`token` 唯一约束真的在兜底**：并发注册同一个 token 时，先查后写会双双落空，
 *      只有 `P2002` 能把它收敛成「一行、同一个 id」；
 *   ② **换账号注册不会悄悄接管**：`owned_by_other` 之后那一行的 `userId` / `platform` /
 *      `lastSeenAt` **一个字节都没变**（共享平板上换人登录是真实场景）；
 *   ③ **LRU 淘汰收敛到 10**：注册第 11 个时被下线的是 `lastSeenAt` **最旧**的那条，
 *      且反复上报已有 token **不会**把自己挤掉；
 *   ④ **注销的幂等是结构性的**（条件 `updateMany`）：并发注销两条都回**同一个**
 *      `revokedAt`，库里只有一个非空时间 —— 不是「代码里记得 if」；
 *   ⑤ **不是我的 = 不存在**：别人的 token 注销回 `not_found`，行仍 `active`
 *      （区分 403 与 404 等于给出探测口）；
 *   ⑥ **`410` 批量下线是按 token 的**：`deactivateTokens` 不受 `userId` 限制也安全
 *      （`token` 全局唯一，网关说它失效就是失效），且重复调用回 0；
 *   ⑦ **删档案不断推送**：`childId` 是 `SetNull`，孩子被删后 token 仍 `active`
 *      —— 推送的收件人是 `userId`，换档案不需要重新上报。
 *
 * ── ★ 与其它真库套件同一条纪律：不做 DELETE 清理 ──────────────────────────
 *   每轮用新前缀（`dbtest-<run>-dt-…`），跑完「那些行还在」本身就是证据。
 *   **唯一一处删除**是组 E：那个 `-gone` 孩子是**被测对象**（证明 `SetNull`），
 *   不是清理手段。
 *
 * ── 入口 ──────────────────────────────────────────────────────────────────
 *   `npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { PrismaDeviceTokensRepository } from '../src/device-tokens/device-tokens.prisma.repository'
import {
  MAX_ACTIVE_TOKENS_PER_USER,
  type RegisterDeviceTokenInput
} from '../src/device-tokens/device-tokens.types'
import { PrismaService } from '../src/prisma/prisma.service'

/** 本轮运行的唯一前缀 —— 「新账号、新 token」，与历史数据互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

let prisma: PrismaService
let repository: PrismaDeviceTokensRepository

async function makeUser(label: string): Promise<string> {
  const id = `dbtest-${RUN}-dt-${label}`
  await prisma.user.create({ data: { id, displayName: `DB token 套件 ${label}` } })
  return id
}

async function makeChild(label: string): Promise<string> {
  const id = `dbtest-${RUN}-dt-child-${label}`
  await prisma.child.create({ data: { id, name: `DB token 套件 ${label}` } })
  return id
}

/** token 必须 ≥ 8 字符（DTO 口径）；带上 `RUN` 保证本轮不与历史行撞唯一键。 */
function tokenOf(label: string): string {
  return `tok-${RUN}-${label}`
}

function input(
  userId: string,
  token: string,
  overrides: Partial<RegisterDeviceTokenInput> = {}
): RegisterDeviceTokenInput {
  return {
    userId,
    childId: null,
    platform: 'ios',
    token,
    ...overrides
  }
}

/** 直接读库，不经过端口 —— 断言的是**列上的事实**，不是端口回给我们的说法。 */
async function rowOf(token: string) {
  return prisma.deviceToken.findUnique({ where: { token } })
}

async function activeCount(userId: string): Promise<number> {
  return prisma.deviceToken.count({ where: { userId, active: true } })
}

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  repository = new PrismaDeviceTokensRepository(prisma)
})

/** 把 `RegisterDeviceTokenResult` 收窄成 ok 分支（失败时 assert 会给出 kind）。 */
function ok(
  result: Awaited<ReturnType<PrismaDeviceTokensRepository['register']>>
): Extract<Awaited<ReturnType<PrismaDeviceTokensRepository['register']>>, { kind: 'ok' }> {
  assert.equal(result.kind, 'ok', `期望 ok，实际 ${result.kind}`)
  return result as Extract<
    Awaited<ReturnType<PrismaDeviceTokensRepository['register']>>,
    { kind: 'ok' }
  >
}

// ══ 组 A：唯一约束与归属 ═════════════════════════════════════════════════════
describe('组 A：唯一约束与归属（换账号不许接管）', () => {
  it('同账号重复上报 ⇒ created 先 true 后 false、同一 id、平台以最新一次为准', async () => {
    const dad = await makeUser('a1')
    const child = await makeChild('a1')
    const token = tokenOf('a1')

    const first = ok(await repository.register(input(dad, token, { childId: child })))
    assert.equal(first.created, true)
    assert.equal(first.row.active, true)

    const second = ok(
      await repository.register(input(dad, token, { childId: child, platform: 'android' }))
    )
    assert.equal(second.created, false, '第二次上报被当成了新登记 —— 会长出第二行')
    assert.equal(second.row.id, first.row.id)
    assert.equal(second.row.platform, 'android', '重复上报没有刷新平台')
    assert.ok(
      second.row.lastSeenAt.getTime() >= first.row.lastSeenAt.getTime(),
      'lastSeenAt 倒退了 —— LRU 会把刚上报的设备先淘汰掉'
    )

    const rows = await prisma.deviceToken.count({ where: { token } })
    assert.equal(rows, 1, `同一 token 长出了 ${rows} 行`)
    assert.equal((await rowOf(token))?.userId, dad)
  })

  it('★ 换账号上报同一个 token ⇒ owned_by_other，且原行**一个字节都没变**', async () => {
    const mom = await makeUser('a2-mom')
    const dad = await makeUser('a2-dad')
    const token = tokenOf('a2')

    const original = ok(await repository.register(input(mom, token)))
    const before = await rowOf(token)

    const result = await repository.register(input(dad, token, { platform: 'android' }))
    assert.equal(result.kind, 'owned_by_other')

    const after = await rowOf(token)
    assert.equal(after?.userId, mom, '后一次注册悄悄接管了前一个账号的推送')
    assert.equal(after?.platform, 'ios', '冲突路径顺手刷新了平台 —— 那不是"没动"')
    assert.equal(
      after?.lastSeenAt.getTime(),
      before?.lastSeenAt.getTime(),
      '冲突路径刷新了 lastSeenAt —— 别人的设备被我们的上报续了命'
    )
    assert.equal(after?.id, original.row.id)
    assert.equal(await activeCount(dad), 0, '为冲突的账号插了一行')
  })

  it('★ 并发注册同一个 token（同账号）⇒ 全部 ok、同一个 id、库中恰好一行', async () => {
    const dad = await makeUser('a3')
    const token = tokenOf('a3')

    // 先查后写在并发下会双双看到 null，只有 `P2002` 分支能收敛。
    const results = await Promise.all(
      Array.from({ length: 4 }, () => repository.register(input(dad, token)))
    )

    const ids = new Set(results.map((result) => ok(result).row.id))
    assert.equal(ids.size, 1, `并发注册给出了 ${ids.size} 个不同 id`)
    assert.equal(await prisma.deviceToken.count({ where: { token } }), 1)
    assert.equal(await activeCount(dad), 1)
  })
})

// ══ 组 B：LRU 淘汰 ═══════════════════════════════════════════════════════════
describe(`组 B：LRU 淘汰（上限 ${MAX_ACTIVE_TOKENS_PER_USER}）`, () => {
  /** 直接造 `count` 行 active token，`lastSeenAt` 递增 ⇒ 第 0 条最旧。 */
  async function seedActive(userId: string, count: number, prefix: string): Promise<string[]> {
    const base = Date.now() - 10 * 60 * 1000
    const tokens: string[] = []
    for (let index = 0; index < count; index += 1) {
      const token = tokenOf(`${prefix}-${index}`)
      await prisma.deviceToken.create({
        data: {
          userId,
          platform: 'ios',
          token,
          lastSeenAt: new Date(base + index * 1000)
        }
      })
      tokens.push(token)
    }
    return tokens
  }

  it('★ 注册第 11 个 ⇒ 下线的正是 lastSeenAt 最旧的那条，active 恒为 10', async () => {
    const dad = await makeUser('b1')
    const seeded = await seedActive(dad, MAX_ACTIVE_TOKENS_PER_USER, 'b1')
    const oldest = seeded[0]

    const fresh = tokenOf('b1-new')
    ok(await repository.register(input(dad, fresh)))

    assert.equal(await activeCount(dad), MAX_ACTIVE_TOKENS_PER_USER, '上限没有收敛')
    const evicted = await rowOf(oldest)
    assert.equal(evicted?.active, false, '被淘汰的不是最旧的那条')
    assert.notEqual(evicted?.revokedAt, null, '淘汰没有留下 revokedAt —— 无法解释"为什么收不到"')

    const activeTokens = await repository.listActiveForUser(dad)
    assert.equal(activeTokens.length, MAX_ACTIVE_TOKENS_PER_USER)
    assert.equal(
      activeTokens.some((row) => row.token === oldest),
      false,
      '列表里还有已下线的 token'
    )
    assert.equal(
      activeTokens.some((row) => row.token === fresh),
      true
    )
  })

  it('反复上报**已有** token ⇒ 不淘汰任何人，只是把它变成最新', async () => {
    const dad = await makeUser('b2')
    const seeded = await seedActive(dad, MAX_ACTIVE_TOKENS_PER_USER, 'b2')

    ok(await repository.register(input(dad, seeded[0], { platform: 'android' })))

    assert.equal(await activeCount(dad), MAX_ACTIVE_TOKENS_PER_USER, '刷新路径把别人挤掉了')
    const all = await prisma.deviceToken.findMany({ where: { userId: dad }, select: { active: true } })
    assert.equal(all.every((row) => row.active), true)
    const list = await repository.listActiveForUser(dad)
    assert.equal(list[0].token, seeded[0], '刷新后没有排到最前（LRU 会先淘汰它）')
    assert.equal(list[0].platform, 'android')
  })
})
// ══ 组 C：注销的幂等 ═════════════════════════════════════════════════════════
describe('组 C：注销（条件 UPDATE ⇒ 幂等是结构性的）', () => {
  function okRevoke(
    result: Awaited<ReturnType<PrismaDeviceTokensRepository['revoke']>>
  ): Extract<Awaited<ReturnType<PrismaDeviceTokensRepository['revoke']>>, { kind: 'ok' }> {
    assert.equal(result.kind, 'ok', `期望 ok，实际 ${result.kind}`)
    return result as Extract<
      Awaited<ReturnType<PrismaDeviceTokensRepository['revoke']>>,
      { kind: 'ok' }
    >
  }

  it('注销 ⇒ active:false + revokedAt；再注销 ⇒ 回**同一个** revokedAt（不覆盖时间）', async () => {
    const dad = await makeUser('c1')
    const token = tokenOf('c1')
    ok(await repository.register(input(dad, token)))

    const first = okRevoke(await repository.revoke({ userId: dad, token }))
    assert.equal(first.row.active, false)
    assert.ok(first.row.revokedAt instanceof Date, '注销没有写 revokedAt')

    const second = okRevoke(await repository.revoke({ userId: dad, token }))
    assert.equal(
      second.row.revokedAt?.getTime(),
      first.row.revokedAt?.getTime(),
      '第二次注销覆盖了时间 —— 运维再也查不到「什么时候被注销的」'
    )

    const row = await rowOf(token)
    assert.equal(row?.active, false)
  })

  it('★ 并发注销同一个 token ⇒ 两条都成功，且只有一个 revokedAt 值', async () => {
    const dad = await makeUser('c2')
    const token = tokenOf('c2')
    ok(await repository.register(input(dad, token)))

    const [left, right] = await Promise.all([
      repository.revoke({ userId: dad, token }),
      repository.revoke({ userId: dad, token })
    ])
    const leftRow = okRevoke(left).row
    const rightRow = okRevoke(right).row

    assert.equal(
      leftRow.revokedAt?.getTime(),
      rightRow.revokedAt?.getTime(),
      '两笔并发注销写入了两个不同时间 —— 说明是「先查后写」，不是条件 UPDATE'
    )
    assert.equal(await prisma.deviceToken.count({ where: { token, active: true } }), 0)
  })

  it('★ 注销别人的 token ⇒ not_found，那一行仍是 active（不给探测口）', async () => {
    const mom = await makeUser('c3-mom')
    const dad = await makeUser('c3-dad')
    const token = tokenOf('c3')
    ok(await repository.register(input(mom, token)))

    const result = await repository.revoke({ userId: dad, token })
    assert.equal(result.kind, 'not_found')

    const row = await rowOf(token)
    assert.equal(row?.active, true, '别人的 token 被注销了 —— 一个家长能踢掉另一个家长的设备')
    assert.equal(row?.revokedAt, null)
  })

  it('注销后重新上报 ⇒ 同一行复活（active:true、revokedAt:null），不是新登记', async () => {
    const dad = await makeUser('c4')
    const token = tokenOf('c4')
    const first = ok(await repository.register(input(dad, token)))
    okRevoke(await repository.revoke({ userId: dad, token }))

    const back = ok(await repository.register(input(dad, token, { platform: 'weapp' })))
    assert.equal(back.created, false)
    assert.equal(back.row.id, first.row.id)
    assert.equal(back.row.active, true)
    assert.equal(back.row.revokedAt, null, '复活后仍带着吊销时间 —— 列表与解释都会自相矛盾')
    assert.equal(back.row.platform, 'weapp')
  })
})



after(async () => {
  await prisma.$disconnect()
})

// ══ 组 D：给网关读的那份事实（列表 / 批量下线）═══════════════════════════════
describe('组 D：listActiveForUser 与 deactivateTokens', () => {
  it('列表只含**我这个账号**的 active token（不含已注销、不含别人的）', async () => {
    const dad = await makeUser('d1')
    const mom = await makeUser('d1-mom')
    const mine = tokenOf('d1-mine')
    const revoked = tokenOf('d1-revoked')
    const mothers = tokenOf('d1-mom')

    ok(await repository.register(input(dad, mine)))
    ok(await repository.register(input(dad, revoked)))
    await repository.revoke({ userId: dad, token: revoked })
    ok(await repository.register(input(mom, mothers)))

    const list = await repository.listActiveForUser(dad)
    assert.deepEqual(list, [{ token: mine, platform: 'ios' }])
    // 网关只需要 token + platform：多给 userId / childId 等于把用户关系送进第三方。
    assert.deepEqual(Object.keys(list[0]).sort(), ['platform', 'token'])
  })

  it('`deactivateTokens([])` ⇒ 0，且不动任何行（空数组不许变成 updateMany 全表）', async () => {
    const dad = await makeUser('d2')
    const token = tokenOf('d2')
    ok(await repository.register(input(dad, token)))

    assert.equal(await repository.deactivateTokens([]), 0)
    assert.equal((await rowOf(token))?.active, true)
  })

  it('★ 批量下线按 token 生效（跨账号也安全），返回真正改动条数、重复调用回 0', async () => {
    const mom = await makeUser('d3-mom')
    const dad = await makeUser('d3-dad')
    const mine = tokenOf('d3-mine')
    const gone = tokenOf('d3-gone')
    const mothers = tokenOf('d3-mom')

    ok(await repository.register(input(dad, mine)))
    ok(await repository.register(input(dad, gone)))
    await repository.revoke({ userId: dad, token: gone })
    ok(await repository.register(input(mom, mothers)))

    // 网关 410 说的是「这几条 token 已失效」—— token 全局唯一，所以按 token 下线是对的。
    const count = await repository.deactivateTokens([mine, gone, mothers, tokenOf('d3-unknown')])
    assert.equal(count, 2, `期望改动 2 条（我的 active + 妈妈那条 active），实际 ${count}`)

    assert.equal((await rowOf(mine))?.active, false)
    assert.equal((await rowOf(mothers))?.active, false)
    assert.equal((await rowOf(tokenOf('d3-unknown'))), null, '为不存在的 token 造了行')

    assert.equal(await repository.deactivateTokens([mine, gone, mothers]), 0, '重复下线不是 0')
  })

  it('列表按 lastSeenAt 倒序（网关先收到最近用过的设备）', async () => {
    const dad = await makeUser('d4')
    const base = Date.now() - 60 * 60 * 1000
    for (const [index, label] of ['old', 'mid', 'new'].entries()) {
      await prisma.deviceToken.create({
        data: {
          userId: dad,
          platform: 'ios',
          token: tokenOf(`d4-${label}`),
          lastSeenAt: new Date(base + index * 60 * 1000)
        }
      })
    }

    const list = await repository.listActiveForUser(dad)
    assert.deepEqual(
      list.map((row) => row.token),
      [tokenOf('d4-new'), tokenOf('d4-mid'), tokenOf('d4-old')]
    )
  })
})

// ══ 组 E：childId 是记录，不是归属 ═══════════════════════════════════════════
describe('组 E：删除档案不影响 token（`childId` 为 SetNull）', () => {
  it('★ 删掉那个孩子 ⇒ token 的 childId 变 null，但仍 active（换档案不用重报）', async () => {
    const dad = await makeUser('e1')
    const child = await makeChild('e1')
    const token = tokenOf('e1')
    ok(await repository.register(input(dad, token, { childId: child })))
    assert.equal((await rowOf(token))?.childId, child)

    // 这里的 DELETE 是**被测动作**（验证 `onDelete: SetNull`），不是清理。
    await prisma.child.delete({ where: { id: child } })

    const row = await rowOf(token)
    assert.equal(row?.childId, null, '删孩子把 token 一并带走了（Cascade）—— 推送从此静默')
    assert.equal(row?.active, true)
    assert.deepEqual(
      (await repository.listActiveForUser(dad)).map((entry) => entry.token),
      [token]
    )
  })
})


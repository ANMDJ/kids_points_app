/**
 * registration-invites-db.dbtest.ts —— 网站发码额度的**真库**不变量套件
 *                                     （W12 遗留项，2026-11-04 补齐）
 *
 * ── 为什么必须有一个真库文件，而不是只留手工探针 ──────────────────────────
 *   `test/registration-invite-http.test.ts` 的文件头（第 13–16 行）写着：
 *     「额度自增与落码在同一事务」「并发下恰好 50 张」需要活库，**由 `test-db/` 负责**。
 *   而 2026-11-04 之前 `test-db/` 里**没有**这个文件 —— 那句话是一条悬空承诺，
 *   唯一证据是手工探针 `npm run probe:invite-quota`（人不跑就等于不存在）。
 *   本文件把那句承诺落地成**常驻用例**：`npm run test:db` / `npm run ci:db` 会跑它。
 *
 * ── 本文件钉住什么（内存替身永远证不了的）──────────────────────────────────
 *   ① **不超发**：`dailyLimit=50` 时 60 笔并发 ⇒ 恰好 50 `created` / 10
 *      `quota_exhausted`，且落库的码行**正好 50 行**。
 *      任何「先 `COUNT(*)` 再 `INSERT`」的实现在这里红（TOCTOU）。
 *   ② **额度用尽后不再发放**：同一业务日再打 5 笔 ⇒ 全 `quota_exhausted`，
 *      `issued` 不动、码行数不动（不会因为重试而多出来）。
 *   ③ **第一张不会误判「额度用完」**：`INSERT … ON CONFLICT DO NOTHING`
 *      若被删掉，全新业务日的第一笔会走「UPDATE 0 行」分支 ⇒ 这里红。
 *   ④ **落码失败 ⇒ 额度回滚**：占额度的 UPDATE 成功、随后 `INSERT` 抛错时，
 *      整笔事务必须回滚（额度那一格回到原值，且那一行额度**不存在**）。
 *      这是「先自增额度、插码失败还白烧一个名额」的典型漏洞。
 *   ⑤ **`readQuota` 只读**：`GET …/quota` 不该顺手创建当日额度行。
 *
 * ── ★ 与其它真库套件同一条纪律：不做 DELETE 清理 ──────────────────────────
 *   每轮用一个不可能与真实业务日重合的 `day`（`dbtest-<run>-…`，与手工探针
 *   同一做法）⇒ 不污染线上/开发库的真实额度计数；跑完「那些行还在」本身就是证据。
 *
 * ── 入口 ──────────────────────────────────────────────────────────────────
 *   `npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'

import { isWellFormedInviteCode } from '../src/invites/invite-code'
import { PrismaService } from '../src/prisma/prisma.service'
import { PrismaRegistrationInviteRepository } from '../src/registration-invites/registration-invite.prisma.repository'
import type {
  CreateRegistrationInviteInput,
  CreateRegistrationInviteResult
} from '../src/registration-invites/registration-invite.types'

/** 本轮运行的唯一前缀 —— 与历史行、其它套件互不干扰。 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

/** 与生产默认值一致的每日上限（`REGISTRATION_INVITE_DAILY_LIMIT` 默认 50）。 */
const DAILY_LIMIT = 50

let prisma: PrismaService
let repository: PrismaRegistrationInviteRepository

before(() => {
  prisma = new PrismaService()
  repository = new PrismaRegistrationInviteRepository(prisma)
})

after(async () => {
  await prisma.$disconnect()
})

let daySeq = 0

/**
 * 一个只属于本套件的「业务日」。
 *
 * `RegistrationInviteQuota.day` 只是主键字符串，服务层传的是 `YYYY-MM-DD`；
 * 这里传 `dbtest-<run>-…` ⇒ 与真实业务日**不可能**重合（手工探针同一理由）。
 */
function freshDay(label: string): string {
  daySeq += 1
  return `dbtest-${RUN}-${label}-${daySeq}`
}

function inputFor(
  day: string,
  label: string,
  dailyLimit = DAILY_LIMIT,
  overrides: Partial<CreateRegistrationInviteInput> = {}
): CreateRegistrationInviteInput {
  return {
    phone: '19900000001',
    email: `dbtest-${RUN}-${label}@example.com`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    day,
    dailyLimit,
    issuedIpHash: null,
    ...overrides
  }
}

function createdRows(results: CreateRegistrationInviteResult[]) {
  return results.filter(
    (result): result is Extract<CreateRegistrationInviteResult, { kind: 'created' }> =>
      result.kind === 'created'
  )
}

function exhaustedRows(results: CreateRegistrationInviteResult[]) {
  return results.filter(
    (result): result is Extract<CreateRegistrationInviteResult, { kind: 'quota_exhausted' }> =>
      result.kind === 'quota_exhausted'
  )
}


// ══ 组 A：并发不超发 ══════════════════════════════════════════════════════════
describe('组 A：额度并发（60 笔抢 50 个名额）', () => {
  /**
   * ★ 两条用例必须共用**同一个业务日**：第二条的前提是「这一天已经发满 50 张」。
   *   第一版各自 `freshDay()` ⇒ 第二条打的是一个全新业务日，5 笔全部成功，
   *   断言以 `5 !== 0` 变红（真库抓到的，不是推测）。
   */
  const day = freshDay('a')

  it('恰好 50 笔 created / 10 笔 quota_exhausted，码两两不同且真的落库 50 行', async () => {
    const email = `dbtest-${RUN}-a@example.com`

    const results = await Promise.all(
      Array.from({ length: DAILY_LIMIT + 10 }, () => repository.createInvite(inputFor(day, 'a')))
    )

    const created = createdRows(results)
    assert.equal(created.length, DAILY_LIMIT, '超发或漏发：并发下不是恰好 50 笔成功')
    assert.equal(exhaustedRows(results).length, 10, '被拒的笔数不对')

    const codes = created.map((result) => result.row.code)
    assert.equal(new Set(codes).size, DAILY_LIMIT, '出现了重复的码（唯一约束没生效？）')
    for (const code of codes) {
      assert.ok(isWellFormedInviteCode(code), `生成的码形状非法：${code}`)
    }

    // 额度是**同一行**的原子自增 ⇒ issued 必须正好等于上限。
    const quota = await repository.readQuota({ day, dailyLimit: DAILY_LIMIT })
    assert.equal(quota.issued, DAILY_LIMIT)
    assert.equal(quota.remainingToday, 0)

    // 「占额度」与「落码」在同一事务 ⇒ 码行数必须与 issued 一致（不多不少）。
    assert.equal(await prisma.registrationInvite.count({ where: { email } }), DAILY_LIMIT)
  })

  it('额度用尽后再打 5 笔：全部被拒，issued 与码行数都不动', async () => {
    const email = `dbtest-${RUN}-b@example.com`
    // 「这一天发出去的码」= 组 A 第一条那 50 行 + 本条可能新增的行
    const issuedRows = () =>
      prisma.registrationInvite.count({
        where: { email: { in: [`dbtest-${RUN}-a@example.com`, email] } }
      })
    const before = await issuedRows()

    const results = await Promise.all(
      Array.from({ length: 5 }, () => repository.createInvite(inputFor(day, 'b')))
    )

    assert.equal(createdRows(results).length, 0, '额度用尽后仍然发出了码')
    assert.equal(exhaustedRows(results).length, 5)

    const quota = await repository.readQuota({ day, dailyLimit: DAILY_LIMIT })
    assert.equal(quota.issued, DAILY_LIMIT)
    assert.equal(await issuedRows(), before)
  })
})

// ══ 组 B：首张路径与最小额度 ══════════════════════════════════════════════════
describe('组 B：全新业务日的首张（INSERT … ON CONFLICT DO NOTHING）', () => {
  it('dailyLimit=1：第一笔 created / remainingToday=0，第二笔 quota_exhausted / issued=1', async () => {
    const day = freshDay('c')
    const email = `dbtest-${RUN}-c@example.com`

    const first = await repository.createInvite(inputFor(day, 'c', 1))
    assert.equal(first.kind, 'created', '全新业务日的第一笔被误判成「额度用完」')
    if (first.kind !== 'created') return
    assert.equal(first.row.remainingToday, 0)

    const second = await repository.createInvite(inputFor(day, 'c', 1))
    assert.equal(second.kind, 'quota_exhausted')
    if (second.kind !== 'quota_exhausted') return
    assert.equal(second.issued, 1)

    assert.equal(await prisma.registrationInvite.count({ where: { email } }), 1)
  })

  it('dailyLimit=1 时两笔并发：恰好 1 成功 1 被拒（最小并发下的原子占额）', async () => {
    const day = freshDay('d')
    const email = `dbtest-${RUN}-d@example.com`

    const results = await Promise.all([
      repository.createInvite(inputFor(day, 'd', 1)),
      repository.createInvite(inputFor(day, 'd', 1))
    ])

    assert.equal(createdRows(results).length, 1)
    assert.equal(exhaustedRows(results).length, 1)
    assert.equal(await prisma.registrationInvite.count({ where: { email } }), 1)
  })
})

// ══ 组 C：事务原子性 ═══════════════════════════════════════════════════════════
describe('组 C：事务原子性', () => {
  it('落码失败（非法 expiresAt）时，占掉的额度必须回滚、当日额度行不残留', async () => {
    const day = freshDay('e')

    await assert.rejects(
      repository.createInvite(
        // `Invalid Date` 会让 `registrationInvite.create()` 抛错 —— 此时上一步
        // `UPDATE … issued = issued + 1` 已经在同一事务里执行过。
        inputFor(day, 'e', DAILY_LIMIT, { expiresAt: new Date(Number.NaN) })
      )
    )

    // 回滚的判据：额度还是 0，而且那一行**不存在**（INSERT … ON CONFLICT 也被回滚了）。
    const quota = await repository.readQuota({ day, dailyLimit: DAILY_LIMIT })
    assert.equal(quota.issued, 0, '落码失败却白烧了一个名额')
    assert.equal(quota.remainingToday, DAILY_LIMIT)
    assert.equal(
      await prisma.registrationInviteQuota.count({ where: { day } }),
      0,
      '失败的事务留下了额度行'
    )
  })

  it('readQuota 只读：不存在的业务日不会因为一次查询被建出来', async () => {
    const day = freshDay('f')

    const snapshot = await repository.readQuota({ day, dailyLimit: DAILY_LIMIT })
    assert.equal(snapshot.issued, 0)
    assert.equal(snapshot.remainingToday, DAILY_LIMIT)
    assert.equal(await prisma.registrationInviteQuota.count({ where: { day } }), 0)
  })
})

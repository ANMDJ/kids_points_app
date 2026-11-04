/**
 * 每日额度并发探针（W12，2026-11-02）—— **手工运行，不进 CI**
 *
 *     npm run probe:invite-quota
 *
 * ── 它证明什么（替身证不了的那一件）────────────────────────────────────────
 *   网站发码的额度是「每天最多 50 个」。内存替身只能证明「额度用完 ⇒ 429」，
 *   不可能真的并发；而「先 COUNT 再 INSERT」在并发下会发出第 51 张。
 *
 *   ★ 它**直接调用真实适配器** `PrismaRegistrationInviteRepository.createInvite()`，
 *     不是复刻 SQL：撞码重试（`withFreshInviteCode`）、额度自增、落码都在
 *     被测代码里。60 笔并发断言：恰好 50 笔 `created`、10 笔 `quota_exhausted`、
 *     `readQuota().issued === 50`、且 50 个码两两不同。
 *
 * ── 为什么用一个**假业务日**（`probe-<时间戳>`）─────────────────────────────
 *   探针要自己建行、自己清理，不能污染真实业务日的额度计数。
 *   `RegistrationInviteQuota.day` 只是主键字符串，服务层传的是 `YYYY-MM-DD`；
 *   这里传一个不可能与真实日期重合的值，跑完即删。
 *
 * ── 为什么不进 CI ──────────────────────────────────────────────────────────
 *   它要求一个**可写的活库**；`npm run ci` 是**无库**跑的（见 run-tests.mjs）。
 *   与 `wx:probe` 同类：需要真实环境的检查，单独手工跑。
 *   每次改额度 SQL 都应重跑一次。
 */
import 'dotenv/config'

import { PrismaService } from '../src/prisma/prisma.service'
import { PrismaRegistrationInviteRepository } from '../src/registration-invites/registration-invite.prisma.repository'

const limit = 50
const attempts = 60
const day = `probe-${Date.now()}`
const email = `${day}@example.com`
const phone = '19900000001'

async function main(): Promise<void> {
  const prisma = new PrismaService()
  const repository = new PrismaRegistrationInviteRepository(prisma)

  try {
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        repository.createInvite({
          phone,
          email,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          day,
          dailyLimit: limit,
          issuedIpHash: null,
          // W12 边界（2026-11-04）：探针只验全局额度，不验 IP 上限 ⇒ 放宽到 50、
          // 业务日窗口给足一天（否则会被"同 IP 每天 N 张"提前挡住，60 笔并发验不出额度）。
          ipDailyLimit: 50,
          dayStart: new Date(Date.now() - 60 * 60 * 1000),
          dayEnd: new Date(Date.now() + 24 * 60 * 60 * 1000)
        })
      )
    )

    const created = results.filter((result) => result.kind === 'created')
    const exhausted = results.filter((result) => result.kind === 'quota_exhausted')
    const codes = new Set(
      created
        .filter((result) => result.kind === 'created')
        .map((result) => (result.kind === 'created' ? result.row.code : ''))
    )
    const quota = await repository.readQuota({ day, dailyLimit: limit })

    console.log(
      `day=${day} attempts=${attempts} created=${created.length} ` +
        `exhausted=${exhausted.length} uniqueCodes=${codes.size} ` +
        `quotaIssued=${quota.issued} remaining=${quota.remainingToday}`
    )

    const problems: string[] = []
    if (created.length !== limit) problems.push(`期望 created=${limit}，实际 ${created.length}`)
    if (exhausted.length !== attempts - limit) {
      problems.push(`期望 exhausted=${attempts - limit}，实际 ${exhausted.length}`)
    }
    if (codes.size !== limit) problems.push(`期望 ${limit} 个不同的码，实际 ${codes.size}`)
    if (quota.issued !== limit) problems.push(`期望 issued=${limit}，实际 ${quota.issued}`)
    if (quota.remainingToday !== 0) {
      problems.push(`期望 remaining=0，实际 ${quota.remainingToday}`)
    }

    // 清理探针数据（只删本次唯一的 email / day，不碰真实业务行）
    await prisma.registrationInvite.deleteMany({ where: { email } })
    await prisma.registrationInviteQuota.deleteMany({ where: { day } })

    if (problems.length > 0) {
      for (const problem of problems) console.error(`FAIL：${problem}`)
      process.exitCode = 1
      return
    }
    console.log(`PASS：并发 ${attempts} 笔，恰好 ${limit} 笔拿到名额，码无重复`)
  } finally {
    await prisma.$disconnect()
  }
}

void main()

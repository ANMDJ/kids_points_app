#!/usr/bin/env node
/**
 * verify-db.mjs —— **数据库层不变量验证**（02 §5.7 I5 / 02 §9.14）
 *
 * 为什么必须有这个脚本，而不是"我手动跑过一次 psql"：
 *   一句永远不报错的 `REVOKE` 就是一句空承诺 —— 与 D12（CI 假绿）同类。
 *   因此把验证固化为**可重跑、会失败、退出码非 0** 的脚本。
 *
 * ★ 它验证的不只是"权限没给"，还验证**没有给过头**：
 *   P0  应用角色必须**本来就能用**（这条最关键 —— 见下）
 *   A–D 必须以 permission denied 失败（账本/版本/审计表禁改禁删）
 *   F   必须以所有者身份**成功**（证明限制来自**角色分离**，不是表本身不可更新）
 *   G   INSERT 必须**不是** permission denied（证明账本仍然写得进去）
 *
 * ★★ P0 为什么必须存在（实测发现的第二种假绿）：
 *   `prisma migrate reset` 会执行 `DROP SCHEMA public CASCADE` ——
 *   角色级 GRANT USAGE 随 schema 一起消失。此时应用角色"连表都看不见"，
 *   A–D 依然会以 permission denied 报错并通过 —— **理由是"没有 schema USAGE"，
 *   而不是"表级 REVOKE 生效"**。绿灯，但灯是错的。
 *   P0 先验证"角色本来可用"，不可用时 A–D 一律判为**不可判定（FAIL）**，不算通过。
 *
 * 前置：`prisma migrate deploy` + `prisma/sql/900_ledger_revoke.sql` 已执行。
 *       ⚠ `migrate reset` 之后必须**重跑 900 脚本**（否则 P0 会变红，这正是它的用途）。
 * 用法：npm run db:verify      （需要活库；与不需要库的 `npm run ci` 分开）
 * 退出码：0 = 全部符合预期；1 = 有不变量未生效
 */

import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.DATABASE_URL

if (!ownerUrl || !appUrl) {
  console.error('✖ 需要 MIGRATION_DATABASE_URL 与 DATABASE_URL（见 backend/.env.example）')
  process.exit(1)
}

let failures = 0
let appUsable = false
const report = (name, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** Prisma 的报错是多行的；这里只取首行，避免把输出刷成一大片。 */
const brief = (error) => String(error).split('\n').find((l) => l.trim() !== '') ?? String(error)

/**
 * 是否属于「权限不足」。
 * ★ 不靠英文文案：本机 PostgreSQL 的报错是**中文**（"权限不够"），
 *   不同环境语言也不同 —— 因此以 **SQLSTATE 42501** 为准，文案仅作兜底。
 */
function isPermissionDenied(error) {
  const text = `${error?.code ?? ''} ${error?.meta?.code ?? ''} ${String(error)}`
  return text.includes('42501') || text.includes('permission denied') || text.includes('权限不够')
}

/**
 * P0 —— 前置检查：应用角色必须**本来就能正常读写**。
 *
 * 理由：如果角色连 schema 都进不去（例如 `migrate reset` 后忘了重跑 900 脚本），
 * 那么 A–D 的 permission denied 会**因为错误的理由**通过 —— 那是最难发现的一种假绿。
 */
async function checkAppRoleEnvironment() {
  try {
    const templateCount = await app.ruleTemplate.count()
    const recordCount = await app.pointRecord.count()
    appUsable = templateCount === 18
    report(
      'P0. 应用角色可正常读表（schema USAGE + SELECT）',
      appUsable,
      `RuleTemplate=${templateCount}（期望 18）, PointRecord=${recordCount}`
    )
  } catch (error) {
    appUsable = false
    report(
      'P0. 应用角色可正常读表（schema USAGE + SELECT）',
      false,
      `应用角色不可用 —— 后续"被拒绝"全部不可判定（多半是 migrate reset 后没重跑 900 脚本）：${brief(error)}`
    )
  }
}

/** 期望「被权限拒绝」的调用。 */
async function expectPermissionDenied(name, fn) {
  if (!appUsable) {
    // ★ 关键：不能因为"连不上"就当成"权限被正确收回"。
    report(name, false, '不可判定：应用角色本身不可用（P0 未通过），拒绝理由不成立')
    return
  }
  try {
    await fn()
    report(name, false, '竟然成功了！不变量未生效')
  } catch (error) {
    report(
      name,
      isPermissionDenied(error),
      isPermissionDenied(error) ? 'permission denied（SQLSTATE 42501）' : `报错但类型不符：${brief(error)}`
    )
  }
}

const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) })
const app = new PrismaClient({ adapter: new PrismaPg({ connectionString: appUrl }) })

async function main() {
  // ── P0：先证明"应用角色本来就能用"，否则后面的"被拒绝"可能是假阳性 ──
  await checkAppRoleEnvironment()

  // ── A–D：追加式表的 UPDATE / DELETE 必须被拒 ─────────────────────
  await expectPermissionDenied('A. 应用角色 UPDATE "PointRecord" 必须被拒', () =>
    app.pointRecord.updateMany({ where: { id: '__no_such__' }, data: { pointsDelta: 0 } })
  )
  await expectPermissionDenied('B. 应用角色 DELETE "PointRecord" 必须被拒', () =>
    app.pointRecord.deleteMany({ where: { id: '__no_such__' } })
  )
  await expectPermissionDenied('C. 应用角色 UPDATE "PointRuleVersion" 必须被拒', () =>
    app.pointRuleVersion.updateMany({ where: { id: '__no_such__' }, data: { points: 0 } })
  )
  await expectPermissionDenied('D. 应用角色 UPDATE "AuditLog" 必须被拒', () =>
    app.auditLog.updateMany({ where: { id: '__no_such__' }, data: { action: 'tampered' } })
  )

  // ── F：所有者**可以**更新 → 限制来自角色分离，不是表不可写 ──────
  try {
    const updated = await owner.pointRecord.updateMany({
      where: { id: '__no_such__' },
      data: { pointsDelta: 0 }
    })
    report('F. 所有者 UPDATE "PointRecord" 必须成功', true, `影响 ${updated.count} 行（0 = 无匹配）`)
  } catch (error) {
    report('F. 所有者 UPDATE "PointRecord" 必须成功', false, brief(error))
  }

  // ── G：账本仍须可写入（INSERT 未被误撤）──────────────────────
  try {
    await app.pointRecord.create({
      data: {
        childId: '__no_such_child__',
        titleSnapshot: '权限探针',
        pointsDelta: 0,
        category: 'praise',
        source: 'system',
        balanceAfter: 0
      }
    })
    report('G. 应用角色 INSERT "PointRecord" 不应被权限拒绝', true, '插入成功（探针数据需手动清理）')
  } catch (error) {
    report(
      'G. 应用角色 INSERT "PointRecord" 不应被权限拒绝',
      !isPermissionDenied(error),
      isPermissionDenied(error) ? '被权限拒绝 —— 账本将完全写不进去' : '因约束失败（外键），说明权限已放行'
    )
  }
}

try {
  await main()
} catch (error) {
  console.error('✖ 验证脚本自身异常：', error)
  failures += 1
} finally {
  await app.$disconnect()
  await owner.$disconnect()
}

console.log(`\n${failures === 0 ? 'ALL PASS —— I5 在真实库上生效' : `FAILED ${failures} 项`}`)
process.exitCode = failures === 0 ? 0 : 1

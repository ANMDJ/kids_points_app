/**
 * rule-templates.ts —— 规则模板**入库**脚本（幂等，可重复执行）
 *
 * 职责（04 §3 / §4）：
 *   把 `templates.data.ts` 的 18 条平台级模板按 `slug` upsert 进 `RuleTemplate`。
 *
 * ★ 为什么必须先跑 `validateTemplates()` 再写库：
 *   图标名 / 配色 / 分值越界这类错误**编译期不报错**，只会在渲染时静默缺失
 *   （见 templates.data.ts 头部说明）。一个不会失败的检查等于没有检查（D12/D13 教训），
 *   因此自检不通过时**拒绝写库**并返回退出码 1，而不是"尽量写进去"。
 *
 * ★ 连接串为什么优先 `MIGRATION_DATABASE_URL`：
 *   本脚本是**迁移引导链**的一环（由 `prisma db seed` → `prisma.config.ts` 的 `migrations.seed` 调用）；
 *   首次执行时应用角色 `kids_points_app` 可能**尚不存在**（由 900_ledger_revoke.sql 创建）。
 *   故与 prisma.config.ts 同源，优先用所有者连接串，回退到 DATABASE_URL。
 *
 * ⚠ 实测更正（Prisma 7，见 06 §10 缺陷 11）：`migrate dev` / `migrate reset` **不会**自动
 *   触发本脚本。必须显式执行 `npm run seed`，否则模板库是**空的且不报错**。
 *
 * 幂等性：以 `slug` 为准 upsert —— 改文案重跑即可，不会产生重复模板。
 *
 * 用法：npm run seed                                  （= `prisma db seed`，推荐）
 *      或 npx tsx prisma/seed/rule-templates.ts      （单跑，便于排错）
 */

import 'dotenv/config'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { RULE_TEMPLATES, validateTemplates } from './templates.data'

const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL
if (connectionString === undefined || connectionString === '') {
  // 失败要响亮 —— 静默跳过 seed 会让引导第⑤步拿到空模板库（D12 同类错误）。
  throw new Error(
    'MIGRATION_DATABASE_URL / DATABASE_URL 均未设置，无法写库（见 backend/.env.example）'
  )
}

async function seedRuleTemplates(): Promise<void> {
  /** 写库前的离线自检：不通过就**拒绝写库**，绝不"带病入库"。 */
  const problems = validateTemplates(RULE_TEMPLATES)
  if (problems.length > 0) {
    console.error('✖ 模板数据自检失败，拒绝写库：')
    for (const p of problems) console.error(`    - ${p}`)
    process.exitCode = 1
    return
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  let created = 0
  let updated = 0

  try {
    for (const t of RULE_TEMPLATES) {
      // slug 为业务键（schema: `@unique`）；采纳模板时是**复制而非引用**，
      // 因此这里的更新只影响"平台模板库"，不会静默改动任何已采纳的家庭规则（04 §3）。
      const data = {
        title: t.title,
        condition: t.condition,
        dailyLimit: t.dailyLimit,
        points: t.points,
        direction: t.direction,
        icon: t.icon,
        color: t.color,
        ageBand: t.ageBand,
        focusAreas: [...t.focusAreas],
        sortWeight: t.sortWeight,
        isSystem: true,
        status: 'active' as const
      }

      const existing = await prisma.ruleTemplate.findUnique({ where: { slug: t.slug } })
      if (existing === null) {
        await prisma.ruleTemplate.create({ data: { slug: t.slug, ...data } })
        created += 1
      } else {
        await prisma.ruleTemplate.update({ where: { slug: t.slug }, data })
        updated += 1
      }
    }

    const total = await prisma.ruleTemplate.count()
    const penalty = RULE_TEMPLATES.filter((t) => t.direction === 'penalty').length

    console.log(
      `✔ 模板库已就绪：新增 ${created} 条 / 更新 ${updated} 条 / 库内合计 ${total} 条` +
        `（reward ${RULE_TEMPLATES.length - penalty} 条 / penalty ${penalty} 条）`
    )
  } finally {
    // 必须 disconnect：否则连接池留着 socket，进程会在 CI 里"挂住"而不是退出。
    await prisma.$disconnect()
  }
}

// ★ 这里**不能**用顶层 await：tsx 按 tsconfig 的 `module: commonjs` 编译，
//   顶层 await 会直接报 “Top-level await is currently not supported with the cjs output format”
//   （实测踩到 —— 见 docs/design/06-w0-report.md §10 缺陷 12）。
seedRuleTemplates().catch((error: unknown) => {
  console.error('✖ 模板写库失败：', error)
  process.exitCode = 1
})

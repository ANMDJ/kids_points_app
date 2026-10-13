#!/usr/bin/env node
/**
 * relation-kind-check.mjs —— 监护关系枚举守门人（阶段 D-a，落地 06 §3.1 决策 D1b）
 *
 * 存在理由：`RelationKind` 的取值要**手抄三处** ——
 *   ① schema.prisma 的 `enum RelationKind`（Prisma 的真相）
 *   ② 同文件 `UserChildRelation.relation` 的注释（人读的真相）
 *   ③ 迁移 SQL 的 `CREATE TYPE "RelationKind" AS ENUM (...)`（数据库的真相）
 * 三处都是手抄，且**没有任何编译器会比对它们**：改枚举忘了改迁移 → 库里的类型还是旧的；
 * 改注释忘了改枚举 → 下一个人照着注释写数据。这与 **D9**（图标名三份手抄）是同一种病，
 * 修法与守门方式也照抄 C5。
 *
 * 另有一条本阶段特有的风险：把 `String` 改成枚举时，Prisma 默认生成的是
 *   `DROP COLUMN "relation", ADD COLUMN "relation" ...` —— **有数据即被清空且不报错**。
 * 所以 ③ 不只比对取值，还要钉住「必须走 `USING` 保数据转型、不许 DROP+ADD」。
 *
 * 检查项（任一条红即退出码 1）：
 *   ① 三处取值清单**逐字相等**（且各自非空、无重复；空集合永远「相等」，不能算通过）
 *   ② `UserChildRelation.relation` 的类型必须是 `RelationKind`，不得退回 `String`
 *   ③ 迁移必须**保数据**：恰好一处 `CREATE TYPE "RelationKind"`；应用它的 ALTER 必须带 `USING`；
 *      全仓库迁移里不得出现 `DROP COLUMN "relation"` / `ADD COLUMN "relation"`
 *   ④ 仓库里出现的 relation 字符串字面量必须**全部落在枚举内**（越界即红）
 *   ⑤ 文档对账：`06` §3.1 的 D1b 行必须已改口为「✅ 已落地」并点名 `RelationKind`
 *      —— 「文档说未落地、代码说已落地」正是本项目 03 §0 那条头号病
 *
 * fail-closed：文件不存在、解析不出、清单为空 —— 一律红，绝不静默跳过。
 *
 * 自测（一个永远通过的检查等于没有检查，见 D13；逐例清单见 `10-d1b-handoff.md`）：
 *   KP_RELATION_SCHEMA=<被篡改的副本> node tools/relation-kind-check.mjs   → 必须红
 *   （KP_RELATION_MIGRATIONS_DIR / KP_RELATION_REPORT / KP_RELATION_SCAN_ROOTS 同理）
 *
 * 用法：node tools/relation-kind-check.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** 允许用环境变量覆盖（只为**证伪自测**：把篡改过的副本指进来，必须变红）。 */
const PATHS = {
  schema: process.env.KP_RELATION_SCHEMA ?? 'backend/prisma/schema.prisma',
  migrationsDir: process.env.KP_RELATION_MIGRATIONS_DIR ?? 'backend/prisma/migrations',
  report: process.env.KP_RELATION_REPORT ?? 'docs/design/06-w0-report.md',
  scanRoots: (
    process.env.KP_RELATION_SCAN_ROOTS ??
    'backend/src,backend/prisma/seed,backend/scripts,contracts,kids_points_mp/src,lib'
  ).split(','),
}

const abs = (rel) => resolve(ROOT, rel)

function readRel(rel) {
  const p = abs(rel)
  if (!existsSync(p)) throw new Error(`文件不存在：${rel}`)
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/** 剥掉注释：**证据只取代码**（见 icon-names-check.mjs 同款说明）。保留换行，行号不漂移。 */
function stripComments(src) {
  let out = ''
  let i = 0
  let block = false
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (block) {
      if (c === '*' && n === '/') {
        block = false
        i += 2
      } else {
        if (c === '\n') out += '\n'
        i += 1
      }
      continue
    }
    if (c === '/' && n === '*') {
      block = true
      i += 2
      continue
    }
    if (c === '/' && n === '/' && src[i - 1] !== ':') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** 剥掉 SQL 注释（`--` 行注释与 `/* *​/` 块注释）：**证据只取可执行语句**。
 *  ★ 本函数是首跑变红后的修正：迁移文件里那段「Prisma 原文是 DROP COLUMN …」的**注释**
 *    被当成证据，于是工具把「解释坏形态」读成了「坏形态本身」。注释不算证据，这里的
 *    错误形态也同理 —— 解释与事实必须分开。 */
function stripSqlComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
}

const dups = (list) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))]
const listText = (list) => (list.length === 0 ? '（无）' : list.join(', '))


// ── 解析器（写法变了就直接抛错，绝不静默返回空）──────────────────────────────

/** ① schema 的 `enum RelationKind { ... }` 取值（按书写顺序）。 */
function parseSchemaEnum(src) {
  const block = src.match(/enum RelationKind \{([\s\S]*?)\n\}/)
  if (!block) throw new Error('解析不出 schema 的 enum RelationKind（写法变了？）')
  return [...block[1].matchAll(/^ {2}(\w+)$/gm)].map((m) => m[1])
}

/** ② `relation` 字段注释里的「关系取值：a / b / c」清单。 */
function parseSchemaComment(src) {
  const m = src.match(/关系取值：([^\n]+)/)
  if (!m) throw new Error('解析不出 schema 里「关系取值：」那行注释（写法变了？）')
  return m[1]
    .replace(/[。.]\s*$/, '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** ③ 迁移目录里所有 *.sql（按名字排序 = 时间顺序）。 */
function readMigrations() {
  const dir = abs(PATHS.migrationsDir)
  if (!existsSync(dir)) throw new Error(`迁移目录不存在：${PATHS.migrationsDir}`)
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.sql')) {
        out.push({
          rel: p.slice(ROOT.length + 1).replace(/\\/g, '/'),
          text: readFileSync(p, 'utf8').replace(/\r\n/g, '\n'),
        })
      }
    }
  }
  walk(dir)
  if (out.length === 0) throw new Error(`${PATHS.migrationsDir} 下一个 .sql 都没有（扫错目录了？）`)
  return out
}

/** ③ 从迁移 SQL 里取 `CREATE TYPE "RelationKind" AS ENUM ('a', 'b')` 的取值。 */
function parseMigrationEnum(migrations) {
  const hits = migrations.filter((m) => /CREATE TYPE "RelationKind" AS ENUM/.test(m.text))
  if (hits.length === 0) throw new Error('迁移里找不到 CREATE TYPE "RelationKind"（数据库的真相不存在）')
  if (hits.length > 1) {
    throw new Error(`CREATE TYPE "RelationKind" 出现 ${hits.length} 次：${hits.map((h) => h.rel).join(', ')}`)
  }
  const body = hits[0].text.match(/CREATE TYPE "RelationKind" AS ENUM \(([^)]*)\)/)[1]
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** ④ 递归收源码文件（扫不到任何文件说明目录指错了 → 抛错，不静默通过）。 */
function codeFilesUnder(rel) {
  const root = abs(rel)
  if (!existsSync(root)) throw new Error(`目录不存在：${rel}`)
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue
        walk(p)
      } else if (/\.(ts|tsx|mts|js|mjs|json|dart)$/.test(name)) {
        out.push(p)
      }
    }
  }
  walk(root)
  if (out.length === 0) throw new Error(`${rel} 下一个源码文件都没有（扫错目录了？）`)
  return out
}

// ── 取源 + 解析（fail-closed）────────────────────────────────────────────────
let SRC
let PARSED
try {
  const schemaRaw = readRel(PATHS.schema)
  SRC = { schema: schemaRaw, report: readRel(PATHS.report), migrations: readMigrations() }
  PARSED = {
    schemaEnum: parseSchemaEnum(schemaRaw),
    schemaComment: parseSchemaComment(schemaRaw),
    migrationEnum: parseMigrationEnum(SRC.migrations),
  }
  const empty = Object.entries(PARSED).filter(([, v]) => v.length === 0).map(([k]) => k)
  if (empty.length > 0) throw new Error(`这些清单解析为空：${empty.join(', ')} —— 解析器失效（比漏检更危险）`)
} catch (err) {
  console.log('FAIL  准备阶段（取源 / 解析）')
  console.log(`        - ${err.message}`)
  console.log('\nFAILED 1 项  （取源或解析失败：宁可红，不静默通过）')
  process.exit(1)
}

const { schemaEnum, schemaComment, migrationEnum } = PARSED
const schemaCode = stripComments(SRC.schema)

// ── 断言运行器 ──────────────────────────────────────────────────────────────
let passed = 0
let failed = 0

function run(label, fn) {
  let result = {}
  try {
    result = fn() ?? {}
  } catch (err) {
    result = { problems: [`抛错：${err.message}`] }
  }
  const problems = result.problems ?? []
  if (problems.length === 0) {
    passed += 1
    console.log(`PASS  ${label}`)
    if (result.note) console.log(`        · ${result.note}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}`)
    for (const p of problems) console.log(`        - ${p}`)
  }
}

console.log(
  `监护关系枚举对账（06 §3.1 D1b）：\n  schema   ${PATHS.schema}\n  迁移     ${PATHS.migrationsDir}\n  文档     ${PATHS.report}\n`
)

// ① ────────────────────────────────────────────────────────────────────────
run('① 三处取值清单逐字相等（枚举 / 注释 / 迁移 SQL）', () => {
  const problems = []
  for (const [label, list] of [
    ['schema enum RelationKind', schemaEnum],
    ['schema relation 注释', schemaComment],
    ['迁移 CREATE TYPE', migrationEnum],
  ]) {
    const d = dups(list)
    if (d.length > 0) problems.push(`${label} 有重复项：${listText(d)}（重复时「相等」本身就不可信）`)
    if (list.length === 0) problems.push(`${label} 为空 —— 空集合永远「相等」，不能算通过`)
  }
  for (const [label, other] of [
    ['schema 注释', schemaComment],
    ['迁移 CREATE TYPE', migrationEnum],
  ]) {
    if (other.join('|') !== schemaEnum.join('|')) {
      problems.push(
        `${label} [${listText(other)}] ≠ schema enum [${listText(schemaEnum)}] —— 三份手抄必须逐字逐序相等`
      )
    }
  }
  return { problems, note: `三处各 ${schemaEnum.length} 个：${listText(schemaEnum)}` }
})

// ② ────────────────────────────────────────────────────────────────────────
run('② UserChildRelation.relation 必须是 RelationKind（不得退回 String）', () => {
  const problems = []
  const model = schemaCode.match(/model UserChildRelation \{([\s\S]*?)\n\}/)
  if (!model) {
    problems.push('schema 里找不到 model UserChildRelation —— fail-closed，不跳过')
  } else {
    const field = model[1].match(/^\s*relation\s+(\S+)/m)
    if (!field) problems.push('UserChildRelation 里找不到 relation 字段')
    else if (field[1] !== 'RelationKind') {
      problems.push(`relation 的类型是 ${field[1]}（应为 RelationKind）—— 自由字符串正是 D1b 的病灶`)
    }
  }
  if (/^\s*relation\s+String\b/m.test(schemaCode)) {
    problems.push('schema 里仍有 `relation String` —— 自由字符串又回来了')
  }
  return { problems }
})

// ③ ────────────────────────────────────────────────────────────────────────
run('③ 迁移必须保数据转型（USING，不许 DROP+ADD）', () => {
  const problems = []
  const all = SRC.migrations.map((m) => stripSqlComments(m.text)).join('\n')
  if (/DROP COLUMN\s+"relation"/.test(all)) {
    problems.push('迁移里出现 DROP COLUMN "relation" —— Prisma 默认形态会静默清空该列（有数据也不报错）')
  }
  if (/ADD COLUMN\s+"relation"/.test(all)) {
    problems.push('迁移里出现 ADD COLUMN "relation" —— 同上：这是「删列再建列」，不是转型')
  }
  const alters = SRC.migrations.filter(
    (m) =>
      /ALTER TABLE "UserChildRelation"/.test(stripSqlComments(m.text)) &&
      /ALTER COLUMN "relation" TYPE/.test(stripSqlComments(m.text))
  )
  if (alters.length === 0) {
    problems.push('找不到 `ALTER TABLE "UserChildRelation" ALTER COLUMN "relation" TYPE ...` —— 建了类型却没人用它')
  } else {
    for (const m of alters) {
      if (!/USING\s+"relation"::"RelationKind"/.test(stripSqlComments(m.text))) {
        problems.push(`${m.rel} 的转型没有 USING 强制转换 —— 取值不会被保留/校验`)
      }
    }
  }
  return { problems, note: `扫了 ${SRC.migrations.length} 个迁移文件（只取可执行语句，注释不算）` }
})

// ④ ────────────────────────────────────────────────────────────────────────
run('④ 仓库里的 relation 字面量必须全部落在枚举内', () => {
  const problems = []
  const files = PATHS.scanRoots.flatMap((r) => codeFilesUnder(r))
  const patterns = [/[^.\w]relation\s*:\s*'([^']+)'/g, /"relation"\s*:\s*"([^"]+)"/g]
  const seen = []
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
    const code = stripComments(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    for (const re of patterns) {
      for (const m of code.matchAll(re)) {
        seen.push(`${rel}: ${m[1]}`)
        if (!schemaEnum.includes(m[1])) {
          problems.push(`${rel} 出现越界取值 '${m[1]}' —— 枚举里没有它（数据库会当场拒绝，但编译期没人拦）`)
        }
      }
    }
  }
  return {
    problems,
    note: `扫了 ${files.length} 个源码文件；relation 字面量 ${seen.length} 处${
      seen.length ? `：${listText(seen)}` : '（当前仓库尚未写入任何 relation 数据）'
    }`,
  }
})

// ⑤ ────────────────────────────────────────────────────────────────────────
run('⑤ 文档对账：06 §3.1 的 D1b 行已改口为「已落地」', () => {
  const problems = []
  const row = SRC.report.split('\n').find((l) => l.startsWith('| **D1b** |'))
  if (!row) problems.push(`${PATHS.report} 里找不到 §3.1 的 D1b 行 —— fail-closed，不跳过`)
  else {
    if (!/✅ \*\*已落地/.test(row)) problems.push('D1b 行仍是「⏳ 待落地」形态 —— 文档说未落地、代码说已落地')
    if (!/RelationKind/.test(row)) problems.push('D1b 行没有点名 RelationKind（读者无从知道落地成了什么）')
  }
  return { problems }
})

// ── 汇总 ──────────────────────────────────────────────────────────────────
const total = passed + failed
console.log(
  `\n${failed === 0 ? 'ALL PASS' : `FAILED ${failed} 项`}  （共 ${total} 项检查${
    failed === 0 ? '，三处取值逐字相等、迁移保数据、文档已改口' : ''
  }）`
)
process.exitCode = failed === 0 ? 0 : 1


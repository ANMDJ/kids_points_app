#!/usr/bin/env node
/**
 * restrictions-check.mjs —— `ChildMember.restrictions` 形状定形守门人（阶段 D-b，落地 06 §3.1 决策 D3b）
 *
 * 存在理由：`ChildMember.restrictions` 是**裸 `Json`** —— Prisma **无法表达 `Json` 的内部形状**，
 * 所以形状只能写在别处（注释 / 设计文档 / 应用层类型），而这几处**没有任何编译器会比对**：
 * 谁把键名拼错、或把 `boolean` 写成字符串，编译期与运行期都**没人拦**，限制会**静默失效**。
 * 这与 **D9**（图标名三份手抄）、**D1b**（`relation` 取值三处手抄）是同一种病，守门方式照抄 C5/D-a。
 *
 * ── 权威与「被比对方」的分工（★ 与 D-a 的教训直接相关）──────────────────
 * **注释不算证据**（D-a 首跑就是被自己的解释性注释骗红的）。因此：
 *   权威 = `backend/src/contracts/member-restrictions.ts` 里**可执行**的 `RESTRICTION_KEYS`
 *          ＋ 同文件的 class 装饰器 ＋ `validateRestrictions()` 的实现；
 *   被比对方 = `schema.prisma` 的 `/// 形状：{ ... }` 注释 与 `02` §3 的代码块 ——
 *          它们是**手抄清单**，比对的是「抄得对不对」，不是「注释能当行为证据」。
 *
 * 检查项（任一条红即退出码 1）：
 *   ① 三处键名清单**逐字逐序相等**（权威 `RESTRICTION_KEYS` / schema 注释 / `02` §3 代码块），
 *      且各自非空、无重复（空集合永远「相等」，不能算通过）
 *   ② schema 里 `ChildMember.restrictions` 必须仍是 `Json` 且**带 `@default("{}")`**
 *      —— 定形落在应用层，不是把列改型 / 也不是把空形状的默认值丢掉
 *   ③ 权威 class 的每个键都必须**有运行时约束**：`@IsOptional()` ＋ 类型装饰器，
 *      且装饰器族与 TS 类型一致（`@IsBoolean()↔boolean` / `@IsInt()|@IsNumber()↔number`），
 *      字段清单与 `RESTRICTION_KEYS` 同序同集 —— 否则「类型」与「运行时」各说各话
 *   ④ `validateRestrictions()` 必须真的**封闭形状**：`plainToInstance(` ＋ `whitelist: true`
 *      ＋ `forbidNonWhitelisted: true`（少任何一项，多余键/未实例化都会让守卫静默放行）
 *   ⑤ 离线自检必须**真的接进 `ci`**：`package.json` 有 `restrictions:check`、`ci` 链引用它、
 *      自检脚本里有 `validateRestrictions(` 调用 ＋ `process.exitCode` 赋值
 *      —— 一个不跑的自检、一个不通传导的失败，都等于没有检查（D12/D13 的形态）
 *   ⑥ 文档对账：`06` §3.1 的 D3b 行必须已改口为「✅ 已落地」并点名守卫与闸门
 *      —— 「文档说未落地、代码说已落地」正是本项目 03 §0 那条头号病
 *
 * fail-closed：文件不存在、解析不出、清单为空、JSON 解析失败 —— 一律红，绝不静默跳过。
 *
 * 自测（逐例清单见 `docs/design/11-d3b-handoff.md` §4；一个永远通过的检查等于没有检查，见 D13）：
 *   KP_RESTRICTIONS_TYPES=<被篡改的副本> node tools/restrictions-check.mjs   → 必须红
 *   （KP_RESTRICTIONS_SCHEMA / KP_RESTRICTIONS_DESIGN / KP_RESTRICTIONS_REPORT /
 *     KP_RESTRICTIONS_PACKAGE / KP_RESTRICTIONS_SELFCHECK 同理）
 *
 * 用法：node tools/restrictions-check.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** 允许用环境变量覆盖（只为**证伪自测**：把篡改过的副本指进来，必须变红）。 */
const PATHS = {
  types: process.env.KP_RESTRICTIONS_TYPES ?? 'backend/src/contracts/member-restrictions.ts',
  schema: process.env.KP_RESTRICTIONS_SCHEMA ?? 'backend/prisma/schema.prisma',
  design: process.env.KP_RESTRICTIONS_DESIGN ?? 'docs/design/02-rbac-and-approval.md',
  report: process.env.KP_RESTRICTIONS_REPORT ?? 'docs/design/06-w0-report.md',
  pkg: process.env.KP_RESTRICTIONS_PACKAGE ?? 'backend/package.json',
  selfCheck: process.env.KP_RESTRICTIONS_SELFCHECK ?? 'backend/scripts/check-restrictions.ts',
}

const abs = (rel) => resolve(ROOT, rel)

function readRel(rel) {
  const p = abs(rel)
  if (!existsSync(p)) throw new Error(`文件不存在：${rel}`)
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/** 剥掉注释：**证据只取可执行语句**（见 icon-names-check.mjs / relation-kind-check.mjs 同款说明）。 */
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

const dups = (list) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))]
const listText = (list) => (list.length === 0 ? '（无）' : list.join(', '))

// ── 解析器（写法变了就直接抛错，绝不静默返回空）──────────────────────────────

/** 权威：`RESTRICTION_KEYS = [...] as const` 里的键名（**可执行**清单）。 */
function parseAuthorityKeys(code) {
  const block = code.match(/export const RESTRICTION_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/)
  if (!block) throw new Error('解析不出 `export const RESTRICTION_KEYS = [...] as const`（写法变了？）')
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** 被比对方 ②：`schema.prisma` 里 `/// 形状：{ a?, b?, c? }` 那行注释里的键名。 */
function parseSchemaCommentKeys(src) {
  const m = src.match(/形状：\{([^}]*)\}/)
  if (!m) throw new Error('解析不出 schema 里「形状：{ ... }」那行注释（写法变了？）')
  return [...m[1].matchAll(/(\w+)\s*\?/g)].map((x) => x[1])
}

/** 被比对方 ③：`02` §3 屏障三代码块里 `ChildMember.restrictions: { ... }` 的键名。 */
function parseDesignKeys(src) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => /ChildMember\.restrictions:\s*\{/.test(l))
  if (start < 0) throw new Error('解析不出 02 §3 里 `ChildMember.restrictions: {` 代码块（写法变了？）')
  const keys = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line.startsWith('}')) break
    const m = line.match(/^(\w+)\?/)
    if (m) keys.push(m[1])
  }
  return keys
}

/** 权威 class 的字段与装饰器：`[{ name, type, decorators }]`（顺序 = 书写顺序）。 */
function parseClassFields(code) {
  const body = code.match(/export class ChildMemberRestrictions\s*\{([\s\S]*?)\n\}/)
  if (!body) throw new Error('解析不出 `export class ChildMemberRestrictions { ... }`（写法变了？）')
  const fields = []
  let decorators = []
  for (const raw of body[1].split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const dec = line.match(/^@(\w+)\(?/)
    if (dec) {
      decorators.push(dec[1])
      continue
    }
    const f = line.match(/^(\w+)\?\s*:\s*([\w<>[\]| ]+)$/)
    if (f) {
      fields.push({ name: f[1], type: f[2].trim(), decorators })
      decorators = []
    }
  }
  if (fields.length === 0) {
    throw new Error('class ChildMemberRestrictions 里一个字段都没解析出来（写法变了？）')
  }
  return fields
}

// ── 取源 + 解析（fail-closed）────────────────────────────────────────────────
let SRC
let PARSED
try {
  const typesRaw = readRel(PATHS.types)
  SRC = {
    types: typesRaw,
    schema: readRel(PATHS.schema),
    design: readRel(PATHS.design),
    report: readRel(PATHS.report),
    pkg: readRel(PATHS.pkg),
    selfCheck: readRel(PATHS.selfCheck),
  }
  PARSED = {
    authorityKeys: parseAuthorityKeys(stripComments(typesRaw)),
    schemaCommentKeys: parseSchemaCommentKeys(SRC.schema),
    designKeys: parseDesignKeys(SRC.design),
    classFields: parseClassFields(stripComments(typesRaw)),
  }
  const empty = Object.entries(PARSED)
    .filter(([, v]) => v.length === 0)
    .map(([k]) => k)
  if (empty.length > 0) throw new Error(`这些清单解析为空：${empty.join(', ')} —— 解析器失效（比漏检更危险）`)
} catch (err) {
  console.log('FAIL  准备阶段（取源 / 解析）')
  console.log(`        - ${err.message}`)
  console.log('\nFAILED 1 项  （取源或解析失败：宁可红，不静默通过）')
  process.exit(1)
}

const { authorityKeys, schemaCommentKeys, designKeys, classFields } = PARSED
const typesCode = stripComments(SRC.types)
const schemaCode = stripComments(SRC.schema)
const selfCheckCode = stripComments(SRC.selfCheck)

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
  `成员级限制形状对账（06 §3.1 D3b）：\n  权威   ${PATHS.types}\n  schema ${PATHS.schema}\n  设计   ${PATHS.design}\n  自检   ${PATHS.selfCheck}\n`
)

// ① ────────────────────────────────────────────────────────────────────────
run('① 三处键名清单逐字逐序相等（权威 RESTRICTION_KEYS / schema 注释 / 02 §3）', () => {
  const problems = []
  for (const [label, list] of [
    ['权威 RESTRICTION_KEYS', authorityKeys],
    ['schema 形状注释', schemaCommentKeys],
    ['02 §3 代码块', designKeys],
  ]) {
    const d = dups(list)
    if (d.length > 0) problems.push(`${label} 有重复项：${listText(d)}（重复时「相等」本身就不可信）`)
    if (list.length === 0) problems.push(`${label} 为空 —— 空集合永远「相等」，不能算通过`)
  }
  for (const [label, other] of [
    ['schema 形状注释', schemaCommentKeys],
    ['02 §3 代码块', designKeys],
  ]) {
    if (other.join('|') !== authorityKeys.join('|')) {
      problems.push(
        `${label} [${listText(other)}] ≠ 权威 RESTRICTION_KEYS [${listText(
          authorityKeys
        )}] —— 三份手抄必须逐字逐序相等`
      )
    }
  }
  return { problems, note: `三处各 ${authorityKeys.length} 个：${listText(authorityKeys)}` }
})

// ② ────────────────────────────────────────────────────────────────────────
run('② ChildMember.restrictions 必须仍是 Json 且带 @default("{}")', () => {
  const problems = []
  const model = schemaCode.match(/model ChildMember \{([\s\S]*?)\n\}/)
  if (!model) {
    problems.push('schema 里找不到 model ChildMember —— fail-closed，不跳过')
  } else {
    const field = model[1].match(/^\s*restrictions\s+([^\s]+)([^\n]*)$/m)
    if (!field) problems.push('ChildMember 里找不到 restrictions 字段 —— fail-closed，不跳过')
    else {
      if (field[1] !== 'Json') {
        problems.push(`restrictions 的类型是 ${field[1]}（应为 Json）—— 定形落在应用层，不是把列改型`)
      }
      if (!/@default\("\{\}"\)/.test(field[2])) {
        problems.push('restrictions 丢了 `@default("{}")` —— 空形状的默认值本身就是契约（新成员位不带限制）')
      }
    }
  }
  return { problems, note: '形状仍由应用层守卫定形（Prisma 无法表达 Json 的内部形状）' }
})

// ③ ────────────────────────────────────────────────────────────────────────
run('③ 权威 class：每键都有 @IsOptional + 类型约束，且装饰器与 TS 类型一致', () => {
  const problems = []
  /** 装饰器族 → 它能守住的 TS 类型（`@Min()` 之类是附加约束，不在此表） */
  const TYPE_OF = { IsBoolean: 'boolean', IsInt: 'number', IsNumber: 'number' }
  const declared = classFields.map((f) => f.name)
  if (declared.join('|') !== authorityKeys.join('|')) {
    problems.push(
      `class 字段 [${listText(declared)}] ≠ RESTRICTION_KEYS [${listText(
        authorityKeys
      )}] —— 清单与类型必须同集同序`
    )
  }
  for (const f of classFields) {
    if (!f.decorators.includes('IsOptional')) {
      problems.push(`${f.name} 没有 @IsOptional() —— 键是可选语义，缺了它 \`@default("{}")\` 会变成非法输入`)
    }
    const constraints = f.decorators.filter((d) => d in TYPE_OF)
    if (constraints.length === 0) {
      problems.push(`${f.name} 没有任何类型约束装饰器 —— 运行时守卫对它形同虚设（裸 Json 又回来了）`)
    } else if (!constraints.some((d) => TYPE_OF[d] === f.type)) {
      problems.push(
        `${f.name} 的 TS 类型 ${f.type} 与装饰器 @${constraints.join(' / @')} 不一致 —— 类型与运行时守卫各说各话`
      )
    }
  }
  return { problems, note: `${classFields.length} 个字段：${listText(declared)}` }
})

// ④ ────────────────────────────────────────────────────────────────────────
run('④ 运行时守卫必须封闭形状（plainToInstance + whitelist + forbidNonWhitelisted）', () => {
  const problems = []
  const body = typesCode.match(/export function validateRestrictions\([\s\S]*?\n\}/)
  if (!body) {
    problems.push('找不到 `export function validateRestrictions(...)` 的实现 —— fail-closed，不跳过')
  } else {
    if (!/plainToInstance\(/.test(body[0])) {
      problems.push('守卫没有 `plainToInstance(...)` —— 裸对象上装饰器不生效，校验会静默通过')
    }
    if (!/whitelist:\s*true/.test(body[0])) problems.push('守卫没有 `whitelist: true`')
    if (!/forbidNonWhitelisted:\s*true/.test(body[0])) {
      problems.push(
        '守卫没有 `forbidNonWhitelisted: true` —— 多余键（如拼错的 childCannotAddwis）会被静默丢弃，等于形状没有封闭'
      )
    }
  }
  return { problems }
})

// ⑤ ────────────────────────────────────────────────────────────────────────
run('⑤ 离线自检必须真的接进 ci（且有调用、有退出码传导）', () => {
  const problems = []
  let pkg
  try {
    pkg = JSON.parse(SRC.pkg)
  } catch (err) {
    return { problems: [`${PATHS.pkg} 不是合法 JSON：${err.message}`] }
  }
  const scripts = pkg.scripts ?? {}
  const script = scripts['restrictions:check']
  if (!script) {
    problems.push(`${PATHS.pkg} 里没有 restrictions:check —— 定形没有守门人`)
  } else if (!script.includes(basename(PATHS.selfCheck))) {
    problems.push(`restrictions:check = "${script}" 没有指向 ${PATHS.selfCheck}`)
  }
  if (!/npm run restrictions:check/.test(scripts.ci ?? '')) {
    problems.push('ci 链里没有 `npm run restrictions:check` —— 一个不跑的自检等于没有自检')
  }
  if (!/validateRestrictions\(/.test(selfCheckCode)) {
    problems.push(`${PATHS.selfCheck} 里没有调用 validateRestrictions(...) —— 自检是空壳`)
  }
  if (!/process\.exitCode\s*=/.test(selfCheckCode)) {
    problems.push(`${PATHS.selfCheck} 没有 process.exitCode 赋值 —— 失败不会传导给 ci（D12 的形态）`)
  }
  return { problems, note: 'ci 链含 restrictions:check；自检调用守卫并传导退出码' }
})

// ⑥ ────────────────────────────────────────────────────────────────────────
run('⑥ 文档对账：06 §3.1 的 D3b 行已改口为「已落地」并点名守卫 / 闸门', () => {
  const problems = []
  const row = SRC.report.split('\n').find((l) => l.startsWith('| **D3b** |'))
  if (!row) problems.push(`${PATHS.report} 里找不到 §3.1 的 D3b 行 —— fail-closed，不跳过`)
  else {
    if (!/✅ \*\*已落地/.test(row)) {
      problems.push('D3b 行仍是「⏳ 阶段 D-b」形态 —— 文档说未落地、代码说已落地')
    }
    if (!/restrictions:check/.test(row)) problems.push('D3b 行没有点名闸门 `restrictions:check`')
    if (!/validateRestrictions|member-restrictions/.test(row)) {
      problems.push('D3b 行没有点名守卫（validateRestrictions / member-restrictions）—— 读者无从知道落地成了什么')
    }
  }
  return { problems }
})

// ── 汇总 ──────────────────────────────────────────────────────────────────
const total = passed + failed
console.log(
  `\n${failed === 0 ? 'ALL PASS' : `FAILED ${failed} 项`}  （共 ${total} 项检查${
    failed === 0 ? '，三处键名逐字相等、形状封闭、自检已接进 ci、文档已改口' : ''
  }）`
)
process.exitCode = failed === 0 ? 0 : 1

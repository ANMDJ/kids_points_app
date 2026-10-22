#!/usr/bin/env node
/**
 * run-tests.mjs —— 后端测试入口（**真编译** + Node 内置 runner + 四处 fail-closed 守卫）
 *
 * ── 为什么必须「先编译再跑」（2026-10-14 阶段 B4 实测，Node v26.10.0）───────────────
 *   起因：给审批 HTTP 路径写用例时，用原先的 `node --import tsx --test` 跑带**装饰器**的
 *   controller，连编译都过不去：
 *     ERROR: Parameter decorators only work when experimental decorators are enabled
 *   （tsx 只在**被 tsconfig 的 include 覆盖**的文件上才套用 `experimentalDecorators`；
 *    探针实测：同一份文件放 `backend/` 根 → 报错，放进 `src/` → 能跑。）
 *   把文件挪进 include 后装饰器能转译了，但发生了**更危险**的事：
 *     **`ValidationPipe` 完全静默失效** —— `{action:'redeem', foo:1}`（多余键）与
 *     `{action:'nope'}`（非法枚举）**都返回 201**。测试若只断言「200 系列」就会全绿。
 *   根因是硬事实：**esbuild 不产出 `emitDecoratorMetadata`**，Nest 拿不到
 *   `design:paramtypes` ⇒ 「这个参数要不要校验」判不出来 ⇒ 整体跳过，且**不报错**。
 *   故本入口改为：`tsc` 真编译（`src` + `test` → `.tmp_test_build/`），**在编译产物上跑**。
 *   tsc 产出的 metadata 与 `npm run build` / 生产**同一套** —— 测的就是要上线的东西。
 *
 * ── 三处 fail-closed 守卫 ────────────────────────────────────────────────────
 *   ① **自己遍历**收集 `*.test.ts`（不依赖 Node 的发现规则，也不依赖 tsc 的 include）；
 *      `KP_TEST_DIR` 可覆盖路径，供 `test:canfail` 用**空目录**证伪本守卫。
 *   ② 数用例：`tests ≥ 1`，且 `tests ≥ 文件数`（有文件一个用例都没贡献 ⇒ 红）。
 *   ③ 新增：**源码测试文件数 == 编译产物测试文件数**（少一个 ⇒ 红，并点名差在哪）。
 *      防的是「某个文件没被编译出来，于是它静默地没跑」—— 与 D12（测试器假绿）同类。
 *   ④ 新增（W5-H 踩到后补）：**不许有「整个文件被当成一条用例」**。
 *      形态：`describe` / `it` 被少写一个 `})` 关进了 `after()` / `before()` 回调里 ——
 *      Node 一条子用例都不注册，却把**文件本身**记成 `✔`，`tests N` 里那个文件的贡献变成 1，
 *      于是守卫 ② 的 `tests ≥ 文件数` 照样满足：**整套用例一条都没跑，却是绿的**。
 *      判据：报告里出现**顶格**的 `✔ <…>.test.js (12ms)` 行 ⇒ 那个文件没有子用例。
 *   历史背景（这些行为仍在拦）：目录里只放 `*.spec.ts` → `tests 0` **退出码 0**；
 *   空目录 → `tests 0` **退出码 0**。即「一个用例都没跑」看起来是绿的。
 *
 * ── 为什么是内置 runner，而不是 jest / vitest ────────────────────────────────
 *   ① 零新增依赖（`tsx` / `typescript` 都已是 devDependency，编译用仓库自带的 tsc）；
 *   ② 本仓库是 CommonJS + 无扩展名导入，Node 26 原生类型剥离**跑不起来**；
 *   ③ 内置 runner 的「失败 ⇒ 退出码 1」已被 `npm run test:canfail` 用夹具**证明过**（D12 的对策）。
 *
 * 用法：npm test（已接进 `npm run ci`）
 * ★ `--test-concurrency=1` 是**刻意**的：本仓库硬约束「共享状态（数据库 / 构建产物）不许并发」，
 *   W2 的数据库不变量用例必须串行；现在就定死，免得以后变成偶发假绿。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname, '..') // backend/
const TEST_DIR = resolve(HERE, process.env.KP_TEST_DIR ?? 'test')
/**
 * ★ `KP_TEST_SUFFIX`（W2-B 新增）：默认 `.test.ts` —— **无库用例**。
 *   真库套件（`test-db/*.dbtest.ts`）走它自己的入口 `scripts/run-db-tests.mjs`，
 *   由那里把本变量设成 `.dbtest.ts`。为什么不干脆放进同一个目录：
 *   `npm run ci` 是**无库**跑的，"要活库的用例"一旦混进来，CI 就必须在
 *   "跳过（假绿）"与"必红（噪音）"之间二选一 —— 分目录 + 分入口才是唯一诚实的形状。
 *   守卫本身不变（空目录仍然红、源文件数与产物数仍要一一对应），只是匹配的后缀变了。
 */
const SUFFIX = process.env.KP_TEST_SUFFIX ?? '.test.ts'
const COMPILED_SUFFIX = SUFFIX.replace(/\.ts$/, '.js')
const BUILD_DIR = resolve(HERE, '.tmp_test_build')
const SHOWN = relative(HERE, TEST_DIR) || TEST_DIR

/** 去掉 ANSI 颜色码：解析前必须先剥，否则 `ℹ tests N` 会被转义序列切碎。 */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/** 自己遍历（不依赖任何发现规则）：返回 `<dir>/**` 下所有以 `suffix` 结尾的文件。 */
function collect(dir, suffix) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found // 目录不存在 = 没有文件；由调用方的守卫判红，而不是崩掉
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collect(full, suffix))
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(full)
  }
  return found
}

// ── 守卫 ①：源目录里必须真的有 `*<SUFFIX>` ────────────────────────────────────
const sources = collect(TEST_DIR, SUFFIX)
if (sources.length === 0) {
  console.error(`FAIL  在 ${SHOWN} 下没有发现任何 *${SUFFIX}`)
  console.error('      0 个用例**不算通过** —— 这正是本包装器要拦的假绿（见文件头的实测记录）')
  process.exit(1)
}

// ── 真编译（每次 rm 重建：**绝不复用上一次的产物**，否则就是「用旧代码考满分」，见 PRD §16.3）──
rmSync(BUILD_DIR, { recursive: true, force: true })
const tscBin = resolve(dirname(createRequire(import.meta.url).resolve('typescript')), '..', 'bin', 'tsc')
if (!existsSync(tscBin)) {
  console.error(`FAIL  找不到 tsc（${tscBin}）—— 拒绝在「无法编译」的情况下宣称测试通过`)
  process.exit(1)
}

try {
  const buildLog = execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.test.build.json'], {
    cwd: HERE,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' }
  })
  if (buildLog.trim() !== '') process.stdout.write(stripAnsi(buildLog))
} catch (err) {
  process.stdout.write(stripAnsi(`${err.stdout ?? ''}${err.stderr ?? ''}`))
  console.error('\nFAIL  tsc 编译未通过（src + test）—— 拒绝在编译不过的代码上跑测试')
  process.exit(1)
}

// ── 守卫 ③：源码文件与编译产物必须**一一对应**（少一个 ⇒ 那个文件静默没跑）──────
const COMPILED_DIR = resolve(BUILD_DIR, relative(HERE, TEST_DIR))
const compiled = collect(COMPILED_DIR, COMPILED_SUFFIX)
if (compiled.length !== sources.length) {
  const missing = sources
    .map((f) => relative(TEST_DIR, f).replace(/\.ts$/, '.js'))
    .filter((f) => !compiled.some((c) => c.endsWith(f)))
  console.error(
    `FAIL  源码有 ${sources.length} 个 *${SUFFIX}，编译产物只有 ${compiled.length} 个 *${COMPILED_SUFFIX}`
  )
  console.error(`      没编译出来的：${missing.join('、') || '（无法逐一点名，但数量不等）'}`)
  process.exit(1)
}

// ── 跑编译产物（`--test-concurrency=1` 见文件头；`NO_COLOR` 见 stripAnsi 的说明）────
let output = ''
let status = 1
try {
  output = execFileSync(
    process.execPath,
    ['--test', '--test-reporter=spec', '--test-concurrency=1', ...compiled],
    {
      cwd: HERE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' }
    }
  )
  status = 0
} catch (err) {
  output = `${err.stdout ?? ''}${err.stderr ?? ''}`
  status = typeof err.status === 'number' ? err.status : 1
}
process.stdout.write(stripAnsi(output))

if (status !== 0) {
  console.error(`\nFAIL  测试未通过（runner 退出码 ${status}）`)
  process.exit(1)
}

// ── 守卫 ②：必须真的跑到了用例（`tests N` 汇总行解析不出来也判红）──────────────
const summary = stripAnsi(output).match(/^\s*.?\s*tests (\d+)\s*$/m)
if (!summary) {
  console.error('\nFAIL  解析不出用例汇总（输出里没有 `tests N` 汇总行）—— 拒绝把“读不懂”当成通过')
  process.exit(1)
}

const total = Number(summary[1])
if (total < 1) {
  console.error(`\nFAIL  跑了 ${compiled.length} 个用例文件，但用例数是 0`)
  process.exit(1)
}
if (total < compiled.length) {
  console.error(
    `\nFAIL  发现 ${compiled.length} 个用例文件，却只跑了 ${total} 个用例 —— 有文件一个用例都没贡献`
  )
  process.exit(1)
}

/**
 * ── 守卫 ④：不许有「整个文件被当成一条用例」─────────────────────────────────
 * Node 的内置报告器会把**根本没有子用例**的测试文件本身记成一条 `✔ <path> (12ms)`
 * （顶格、带耗时）。这在 `describe` 被少一个 `})` 关进 `after()` 回调时发生 ——
 * 用例写在那儿、语法也合法、`tsc` 也不报错，但**一条都不会注册**。
 * 守卫 ② 的 `tests ≥ 文件数` 拦不住它：那个文件贡献的 `1` 正好凑够数。
 * 所以这里直接看报告：出现顶格的 `<被测文件>.js (…ms)` 行 ⇒ 红。
 * 判据取自实测（2026-10-22，W5-H）：健康的 30 文件 / 544 用例输出里**一行都没有**。
 */
function findFilesWithoutTests(report) {
  const escaped = COMPILED_SUFFIX.replace(/\./g, '\\.')
  const pattern = new RegExp(`^[✔✖]\\s+(.+${escaped})\\s+\\(`, 'u')
  const found = []
  for (const line of stripAnsi(report).split('\n')) {
    if (/^\s/.test(line)) continue // 缩进行是 describe / it 的子节点，不是文件节点
    const match = line.match(pattern)
    if (match !== null) found.push(match[1])
  }
  return found
}

// ── 守卫 ④：不许有「整个文件被当成一条用例」（见上方函数注释）───────────────
const emptyFiles = findFilesWithoutTests(output)
if (emptyFiles.length > 0) {
  console.error(
    `\nFAIL  ${emptyFiles.length} 个用例文件**一条子用例都没注册**，却被记成通过：`
  )
  for (const file of emptyFiles) console.error(`      · ${relative(HERE, file)}`)
  console.error(
    '      多半是`describe` / `it` 被少写一个 `})` 关进了 `before()` / `after()` 回调里：'
  )
  console.error(
    '      语法合法、tsc 不报错、报告里还显示 ✔ —— 但那批用例**一次都没跑**（D12 同款假绿）。'
  )
  process.exit(1)
}

console.log(
  `\nPASS  ${compiled.length} 个用例文件 / ${total} 个用例全部通过（${SHOWN} → .tmp_test_build/）`
)
process.exit(0)


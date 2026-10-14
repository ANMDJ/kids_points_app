#!/usr/bin/env node
/**
 * run-tests.mjs —— 后端测试入口（包装 Node 内置 runner，补两处 fail-closed 守卫）
 *
 * ── 为什么不能只写 `node --import tsx --test test/`（**实测记录**，Node v26.10.0，2026-10-14）──
 *   ① 目录里只放 `*.spec.ts` → `ℹ tests 0`，**退出码 0**（Node 的默认发现规则不认 `.spec.ts`）；
 *   ② **空目录 / 一个用例都没有** → `ℹ tests 0`，**退出码 0**。
 *   即「一个用例都没跑」看起来是**绿的** —— 与 D12（测试器假绿）同一类病。
 *   故本包装器**不依赖** Node 的发现规则，自己干两件事：
 *     ① **自己遍历** `<testDir>/**` 收集 `*.test.ts`（`KP_TEST_DIR` 可覆盖，供 `test:canfail` 用空目录证伪）；
 *     ② 从输出里**数用例**：`tests ≥ 1`，且 `tests ≥ 文件数`（有文件一个用例都没贡献 ⇒ 红）。
 *
 * ── 为什么用内置 runner + tsx，而不是 jest / vitest ────────────────────────────
 *   ① 零新增依赖（`tsx` 已是 devDependency）；② 本仓库是 CommonJS + 无扩展名导入，
 *   Node 26 原生类型剥离**跑不起来**（实测 `ERR_MODULE_NOT_FOUND`），必须有 tsx 这类加载器；
 *   ③ 内置 runner 的"失败 ⇒ 退出码 1"已被 `npm run test:canfail` 用夹具**证明过**（D12 的对策）。
 *
 * 用法：npm test（已接进 `npm run ci`）
 * ★ `--test-concurrency=1` 是**刻意**的：本仓库硬约束「共享状态（数据库 / 构建产物）不许并发」，
 *   W2 的数据库不变量用例必须串行；现在就定死，免得以后变成偶发假绿。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname, '..') // backend/
const TEST_DIR = resolve(HERE, process.env.KP_TEST_DIR ?? 'test')

/** 自己遍历（不依赖 Node 的发现规则）：任何 `*.test.ts`，**包括 `__fixtures__` 里的**。 */
function collect(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found // 目录不存在 = 没有用例；由下面的守卫判红，而不是崩掉
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collect(full))
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(full)
  }
  return found
}

const shown = relative(HERE, TEST_DIR) || TEST_DIR
const files = collect(TEST_DIR)

if (files.length === 0) {
  console.error(`FAIL  在 ${shown} 下没有发现任何 *.test.ts`)
  console.error('      0 个用例**不算通过** —— 这正是本包装器要拦的假绿（见文件头的实测记录）')
  process.exit(1)
}

let output = ''
let status = 1
try {
  output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-reporter=spec',
      '--test-concurrency=1',
      ...files
    ],
    {
      cwd: HERE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // NO_COLOR：管道输出若带 ANSI 颜色码，下面的正则就解析不出汇总行 —— 那会把绿套件误判成红。
      env: { ...process.env, NO_COLOR: '1' }
    }
  )
  status = 0
} catch (err) {
  output = `${err.stdout ?? ''}${err.stderr ?? ''}`
  status = typeof err.status === 'number' ? err.status : 1
}
process.stdout.write(stripAnsi(output))

/** 去掉 ANSI 颜色码：解析前必须先剥，否则 `ℹ tests N` 会被转义序列切碎。 */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

if (status !== 0) {
  console.error(`\nFAIL  测试未通过（runner 退出码 ${status}）`)
  process.exit(1)
}

const summary = stripAnsi(output).match(/^\s*.?\s*tests (\d+)\s*$/m)
if (!summary) {
  console.error('\nFAIL  解析不出用例汇总（输出里没有 `tests N` 汇总行）—— 拒绝把"读不懂"当成通过')
  process.exit(1)
}

const total = Number(summary[1])
if (total < 1) {
  console.error(`\nFAIL  跑了 ${files.length} 个用例文件，但用例数是 0`)
  process.exit(1)
}
if (total < files.length) {
  console.error(
    `\nFAIL  发现 ${files.length} 个用例文件，却只跑了 ${total} 个用例 —— 有文件一个用例都没贡献`
  )
  process.exit(1)
}

console.log(`\nPASS  ${files.length} 个用例文件 / ${total} 个用例全部通过（${shown}）`)
process.exit(0)

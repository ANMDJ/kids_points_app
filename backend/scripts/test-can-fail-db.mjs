#!/usr/bin/env node
/**
 * test-can-fail-db.mjs —— 证明「真库入口（`scripts/run-db-tests.mjs`）的守卫**真的会拦**」（W2-B）
 *
 * 为什么要有这个文件：`run-db-tests.mjs` 的三道守卫都是 **fail-closed 断言**，
 * 而"从来没红过的守卫"和"没有守卫"在磁盘上长得一模一样。`npm test`（离线）侧的同名文件
 * `test-can-fail.mjs` 已经确立了这套做法（D12 的教训常设化），真库入口必须**同样**被证伪过。
 *
 * 检查项（全部**不碰数据库**；E 用的是打不通的假连接串）：
 *   A. `NODE_ENV=production` → 必须**在写入任何数据之前**就红，并点名理由；
 *   B. 缺 `DATABASE_URL` → 必须红（"没验证" ≠ "通过"），并点名理由；
 *   C. `test-db/` 空目录（`KP_DB_TEST_DIR` 指向空目录）→ 必须红；
 *   D. 后缀不匹配（把 `test-db/` 交给默认后缀 `.test.ts` 的 runner）→ 必须红
 *      —— 0 个用例**不许**假绿；
 *   E. **正向控制**：三道守卫都满足时，必须真的把控制权交给 runner（输出里出现运行横幅），
 *      且**没有活库**时整体退出码 ≠ 0（真库套件不许在无库时"静默通过"）。
 *      ↑ 没有 E 的话，上面 A–D 全绿也可能是"入口永远红"——那种守卫一样没用。
 *
 * 用法：npm run test:canfail:db（已接进 `npm run ci`；无需数据库）
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const HERE = resolve(import.meta.dirname, '..') // backend/
const ENTRY = 'scripts/run-db-tests.mjs'
const RUNNER = 'scripts/run-tests.mjs'
const EMPTY_DIR = 'scripts/__fixtures__/empty-test-dir'
/** 打不通的连接串（端口 1 ⇒ 立刻 ECONNREFUSED，不会挂住）：E 要的正是"没活库" */
const DEAD_DB = 'postgresql://nobody:nobody@127.0.0.1:1/nope'
/**
 * 让 `dotenv` **什么也别加载**（`run-db-tests.mjs` 会 `import 'dotenv/config'`）。
 * 否则本机 `backend/.env` 里的真 `DATABASE_URL` 会把 B 与 E 的前提悄悄改掉：
 * B 变成"有库"（守卫不触发 ⇒ 假红），E 变成"连真库跑全套"（会真的写数据）。
 */
const NO_ENV_FILE = { DOTENV_CONFIG_PATH: './__canfail-no-such-env-file' }

let failures = 0
const CHECKS = []

function report(name, ok, detail = '') {
  CHECKS.push(name)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`)
}

/** 跑一条命令，返回 { status, output }（不抛异常）。 */
function run(args, extraEnv = {}) {
  try {
    const output = execFileSync(process.execPath, args, {
      cwd: HERE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', ...NO_ENV_FILE, ...extraEnv }
    })
    return { status: 0, output }
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
  }
}

/** 输入里必须出现某段文字（用来判断"红在**对的**理由上"，而不是红在别的毛病上）。 */
const says = (output, needle) => output.includes(needle)
/** 运行横幅：**只有**三道守卫都过了才会打印 ⇒ 它出现 = 入口真的把控制权交给了 runner。 */
const BANNER = '真库不变量套件'

// ── A. 不许对着生产跑 ──────────────────────────────────────────────────────
const prod = run([ENTRY], { NODE_ENV: 'production', DATABASE_URL: DEAD_DB })
report('A. NODE_ENV=production → 退出码非 0', prod.status !== 0, `退出码=${prod.status}`)
report(
  'A2. 且点名理由，并且**在写入任何数据之前**就停了（没有运行横幅）',
  says(prod.output, 'NODE_ENV=production') && !says(prod.output, BANNER),
  says(prod.output, '只许对着开发/实验库跑') ? '理由已打印：写进去的流水删不掉（I5）' : '（未找到理由文本）'
)

// ── B. 没库 ⇒ 红（"没验证"不许当成"通过"）──────────────────────────────────
const noUrlEnv = { ...process.env, NODE_ENV: 'test' }
delete noUrlEnv.DATABASE_URL
const noUrl = run([ENTRY], { ...noUrlEnv, DATABASE_URL: '' })
report('B. 缺 DATABASE_URL → 退出码非 0', noUrl.status !== 0, `退出码=${noUrl.status}`)
report(
  'B2. 且说明这是「一条都没验证」而不是跳过（没有运行横幅）',
  says(noUrl.output, 'DATABASE_URL 未设置') && !says(noUrl.output, BANNER),
  noUrl.output.split('\n').find((l) => l.includes('DATABASE_URL 未设置')) ?? '（未找到说明）'
)
report(
  'B3. 且**没有**出现「跳过 / skipped」这类伪装成通过的说法',
  !/skip|跳过/i.test(noUrl.output),
  noUrl.output.split('\n').find((l) => /skip|跳过/i.test(l)) ?? '（无）'
)

// ── C. 空套件目录 ⇒ 红（0 个真库用例不算通过）──────────────────────────────
const empty = run([ENTRY], { DATABASE_URL: DEAD_DB, KP_DB_TEST_DIR: EMPTY_DIR })
report('C. test-db/ 里一个 *.dbtest.ts 都没有 → 退出码非 0', empty.status !== 0, `退出码=${empty.status}`)
report(
  'C2. 且点名缺的是 `.dbtest.ts`（不是红在别的理由上），也没有运行横幅',
  says(empty.output, '没有发现任何 *.dbtest.ts') && !says(empty.output, BANNER),
  empty.output.split('\n').find((l) => l.includes('没有发现')) ?? '（未找到说明）'
)

// ── D. 后缀不匹配 ⇒ 红（0 用例不许假绿）───────────────────────────────────
//    真库套件靠 `KP_TEST_SUFFIX=.dbtest.ts` 与离线用例分开；这一条钉住"分开"这件事本身：
//    如果哪天有人把 `.dbtest.ts` 写成 `.test.ts`（或反过来改后缀），必须**红**，不许静默跑 0 个。
const wrongSuffix = run([RUNNER], { KP_TEST_DIR: 'test-db' })
report('D. 用默认后缀 .test.ts 扫 test-db/ → 退出码非 0（0 用例不许假绿）', wrongSuffix.status !== 0, `退出码=${wrongSuffix.status}`)
report(
  'D2. 且点名期望的后缀是 `.test.ts`（红在对的理由上）',
  says(wrongSuffix.output, '没有发现任何 *.test.ts'),
  wrongSuffix.output.split('\n').find((l) => l.includes('没有发现')) ?? '（未找到说明）'
)

// ── E. 正向控制：守卫**不是**"永远红" ────────────────────────────────────
const reach = run([ENTRY], { DATABASE_URL: DEAD_DB })
report(
  'E. 三道守卫都满足 → 真的把控制权交给了 runner（出现运行横幅）',
  says(reach.output, BANNER),
  says(reach.output, BANNER) ? BANNER + ' ✔' : '（没看到横幅 ⇒ 守卫把正常调用也拦了？）'
)
report(
  'E2. 但没有活库时**整体退出码必须非 0**（真库套件不许在无库时静默通过）',
  reach.status !== 0,
  `退出码=${reach.status}（连接串打不通 ⇒ 用例应全部失败）`
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `FAILED ${failures} 项`}  （共 ${CHECKS.length} 项检查）`)
process.exitCode = failures === 0 ? 0 : 1

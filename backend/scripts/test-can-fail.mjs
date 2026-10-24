#!/usr/bin/env node
/**
 * test-can-fail.mjs —— 证明「测试**真的会红**」（把 D12 的教训常设化）
 *
 * 检查项：
 *   A. 夹具（`scripts/__fixtures__/always-red-runner.fixture.ts`）必须让 runner **退出码非 0**，
 *      且输出里**点名**夹具内的用例名 —— 防止"红在别的理由上"（D-a 阶段踩过的坑：
 *      闸门首跑红在错的理由上，等于没验证到它）。
 *   B. **入口守卫**：把 `run-tests.mjs` 指向一个**空目录**（`KP_TEST_DIR`）→ 必须**退出码非 0**。
 *      这一条堵的是实测到的 runner 固有行为：空目录时 `ℹ tests 0` 且退出码 **0**（假绿）。
 *   C. **守卫 ④（文件级 `✔`）**：现场造一个「`describe` 被关进 `after()`」的夹具目录，交给
 *      `run-tests.mjs` ⇒ 必须**退出码非 0** 且**点名那个文件**。
 *      这是 W5-H 真踩到的形态：语法合法、`tsc` 不报错、报告显示 `✔ <文件> (11s)`，
 *      而 `tests N` 里那个文件的贡献是 1 —— 守卫 ② 的 `tests ≥ 文件数` 照样满足。
 *      ★ 夹具必须建在 `test/` **下面**（tsc 的 `include` 才编译它，且不点开头不然被 glob 跳过），
 *      跑完在 `finally` 里删掉：留在仓库里会让 `npm test` 永远红。
 *   D. **守卫 ⑤（文档漂移）**：把 `honesty-probe.mjs` 指向一份故意漂移的夹具 PRD
 *      （`scripts/__fixtures__/prd-drifted.fixture.md`）⇒ 必须**退出码非 0** 且**点名**那个
 *      判定写错的动作。W6-A 的真实形状：PRD §7 停在「29 个动作」而代码已 35，
 *      十几轮 CI 全绿 —— 因为没有一条检查看文档。
 *
 * 附注（不判定成败，只记录）：同一空目录交给 runner 本身时它返回什么 —— 供将来 Node 改行为时对照。
 *
 * 只读操作；夹具按**显式路径**调用，不参与自动发现。
 *
 * 用法：npm run test:canfail（已接进 `npm run ci`）
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname, '..') // backend/
const FIXTURE = 'scripts/__fixtures__/always-red-runner.fixture.ts'
const EMPTY_DIR = 'scripts/__fixtures__/empty-test-dir'
const EXPECTED_CASES = ['夹具・必红①', '夹具・必红②']
/** 守卫 ④ 的现场夹具（相对 `backend/`）：必须**不带点**，否则 tsc 的 glob 会跳过。 */
const NESTED_DIR = 'test/tmp-guard-probe'

let failures = 0
let checks = 0

function report(name, ok, detail = '') {
  checks += 1
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
      // NO_COLOR：与 run-tests.mjs 同一理由 —— 别让 ANSI 颜色码干扰“输出里有没有那个名字”的判断
      env: { ...process.env, NO_COLOR: '1', ...extraEnv }
    })
    return { status: 0, output }
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
  }
}

// ── A. 夹具必须变红，且红在"对的理由"上 ────────────────────────────────
const red = run(['--import', 'tsx', '--test', '--test-reporter=spec', FIXTURE])
const named = EXPECTED_CASES.filter((name) => red.output.includes(name))
report(
  'A. 必红夹具 → runner 退出码非 0',
  red.status !== 0,
  `退出码=${red.status}`
)
report(
  'A2. 且输出**点名**夹具里的两条失败用例（不是红在别的理由上）',
  named.length === EXPECTED_CASES.length,
  `点名 ${named.length}/${EXPECTED_CASES.length}：${named.join('、') || '（无）'}`
)

// ── 附注：runner 自己对空目录的判定（只记录，不判定成败）────────────────
const bare = run(['--import', 'tsx', '--test', '--test-reporter=spec', EMPTY_DIR])
const bareTests = bare.output.match(/^ℹ tests (\d+)$/m)?.[1] ?? '?'
console.log(
  `附注  runner 自身对空目录：退出码=${bare.status}，用例数=${bareTests}` +
    (bare.status === 0 ? '（⇒ 0 用例会被当成通过，故必须有下面的入口守卫）' : '')
)

// ── B. 入口守卫：同一空目录交给真实入口 → 必须红 ─────────────────────────
const guarded = run(['scripts/run-tests.mjs'], { KP_TEST_DIR: EMPTY_DIR })
report(
  'B. 入口守卫：run-tests.mjs 指向空目录（0 用例）→ 必须退出码非 0',
  guarded.status !== 0,
  `退出码=${guarded.status}`
)
report(
  'B2. 且给出可读懂的理由（不是崩栈）',
  /没有发现任何 \*\.test\.ts/.test(guarded.output),
  guarded.output.split('\n').find((l) => l.includes('没有发现')) ?? '（未找到说明）'
)

// ── C. 守卫 ④：describe 被关进 after() ⇒ 必须红并点名那个文件（W5-H 的真实形状）──
const nestedAbs = join(HERE, NESTED_DIR)
const NESTED_FIXTURE = `/**
 * ★ 本文件只在 \`npm run test:canfail\` 执行期间存在（脚本现场写入、\`finally\` 里删除）。
 * 形态：所有 describe / it 都被关进 after() 回调 ⇒ 一条子用例都不注册，
 * Node 只把**文件本身**记成 ✔ —— 正是 W5-H 踩到的假绿，守卫 ④ 要拦的就是它。
 * ★ 里面的 it **必须通过**：若它 assert 失败，Node 自己就会给出非 0 退出码，
 *   那这条检查就变成「红在别的理由上」，证明不了守卫 ④ 有牙齿。
 */
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

after(() => {
  describe('被关进 after 的用例', () => {
    it('这条永远不会被注册（通过断言，保证不会自己变红）', () => {
      assert.equal(1, 1)
    })
  })
})
`
let nested = { status: 0, output: '' }
rmSync(nestedAbs, { recursive: true, force: true })
mkdirSync(nestedAbs, { recursive: true })
writeFileSync(join(nestedAbs, 'only-nested.test.ts'), NESTED_FIXTURE, 'utf8')
try {
  nested = run(['scripts/run-tests.mjs'], { KP_TEST_DIR: NESTED_DIR })
} finally {
  rmSync(nestedAbs, { recursive: true, force: true })
}
report(
  'C. 守卫 ④：用例全被关进 after()（文件级 ✔，子用例 0 条）→ 必须退出码非 0',
  nested.status !== 0,
  `退出码=${nested.status}`
)
report(
  'C2. 且点名那个文件（不是红在别的理由上）',
  nested.output.includes('only-nested'),
  nested.output
    .split('\n')
    .find((l) => l.includes('only-nested'))
    ?.trim() ?? '（未点名）'
)

// ── D. 守卫 ⑤（文档漂移）：PRD §7 写错 ⇒ 诚实性探针必须红并点名（W6-A 的真实形状）
// W6-A 发现 PRD §7 停在「29 个动作」而代码已 35 —— 一条测试都不会因此变红。
// 这里把「文档漂移可被听见」证明一次：给探针一份故意漂移的夹具 PRD。
const DRIFT_FIXTURE = 'scripts/__fixtures__/prd-drifted.fixture.md'
const drifted = run(['scripts/honesty-probe.mjs'], { HONESTY_PRD_PATH: DRIFT_FIXTURE })
report(
  'D. 守卫 ⑤：PRD §7 与矩阵不一致 → honesty-probe 必须退出码非 0',
  drifted.status !== 0,
  `退出码=${drifted.status}`
)
report(
  'D2. 且点名那个判定不一致的动作（不是红在别的理由上）',
  drifted.output.includes('undo_check_in') && drifted.output.includes('判定不一致'),
  drifted.output
    .split('\n')
    .find((l) => l.includes('判定不一致'))
    ?.trim() ?? '（未点名）'
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `FAILED ${failures} 项`}  （共 ${checks} 项检查）`)
process.exitCode = failures === 0 ? 0 : 1

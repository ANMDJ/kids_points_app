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
 *
 * 附注（不判定成败，只记录）：同一空目录交给 runner 本身时它返回什么 —— 供将来 Node 改行为时对照。
 *
 * 只读操作；夹具按**显式路径**调用，不参与自动发现。
 *
 * 用法：npm run test:canfail（已接进 `npm run ci`）
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const HERE = resolve(import.meta.dirname, '..') // backend/
const FIXTURE = 'scripts/__fixtures__/always-red-runner.fixture.ts'
const EMPTY_DIR = 'scripts/__fixtures__/empty-test-dir'
const EXPECTED_CASES = ['夹具・必红①', '夹具・必红②']

let failures = 0

function report(name, ok, detail = '') {
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

console.log(`\n${failures === 0 ? 'ALL PASS' : `FAILED ${failures} 项`}  （共 4 项检查）`)
process.exitCode = failures === 0 ? 0 : 1

#!/usr/bin/env node
/**
 * honesty-probe.mjs —— CI 诚实性探针
 *
 * 存在理由：本项目最严重的历史缺陷 **D12** 不是「某个测试没跑」，
 * 而是**测试器花括号嵌套错位导致 `process.exitCode` 被提前锁死为 0** ——
 * 汇总行 `ALL PASS` 在 2 个检查执行完之前就打印，此后 6 个检查即使失败
 * 也无法改变退出码。**CI 从此永久假绿。**
 *
 * 这类缺陷的共同特征是：**「测试通过」这个信号本身没有被测试过。**
 * 因此本探针的第一原则是：**先证明「失败能被听见」，再谈任何测试结果。**
 *
 * 检查项：
 *   A. 注入必失败断言 → 退出码必须非 0（证明管道没有把失败吞掉）
 *   B. 注入必成功断言 → 退出码必须为 0（证明非 0 不是恒定的）
 *   C. D12 回归守卫：扫描测试运行器，汇总/退出码赋值**不得嵌套在回调内部**
 *   D. 契约漂移守卫：permission-matrix.ts 的 ActionType 与 schema.prisma 的 enum 必须一致
 *
 * 用法：node scripts/honesty-probe.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dirname, '..')
const REPO = resolve(HERE, '..')

let failures = 0
const results = []

function report(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** 运行一个子 node 进程，返回退出码（不抛异常）。 */
function runNode(file) {
  try {
    execFileSync(process.execPath, [file], { stdio: 'pipe' })
    return 0
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 1
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'honesty-'))

try {
  // ── A：必失败断言必须让退出码非 0 ────────────────────────────────
  const failCase = join(tmp, 'must-fail.mjs')
  writeFileSync(
    failCase,
    `// 本文件**故意**包含一个必然失败的断言（D12 探针 A）\n` +
      `import assert from 'node:assert'\n` +
      `assert.strictEqual(1, 2, '探针 A：这个断言必须失败')\n`
  )
  const failCode = runNode(failCase)
  report(
    'A. 注入必失败断言 → 退出码非 0',
    failCode !== 0,
    `退出码=${failCode}`
  )

  // ── B：必成功断言必须让退出码为 0（证明非 0 不是恒定的）──────────
  const passCase = join(tmp, 'must-pass.mjs')
  writeFileSync(
    passCase,
    `import assert from 'node:assert'\nassert.strictEqual(1, 1)\n`
  )
  const passCode = runNode(passCase)
  report(
    'B. 注入必成功断言 → 退出码为 0',
    passCode === 0,
    `退出码=${passCode}`
  )

  // ── C：D12 回归守卫（静态：汇总与退出码赋值必须位于顶层）──────────
  // HONESTY_RUNNER_PATH 用于**自测本检查项本身**：指向一个复现 D12 的夹具，
  // 该探针必须报 FAIL。一个永远通过的检查等于没有检查（见 D13 的同类教训）。
  const runner = process.env.HONESTY_RUNNER_PATH
    ? resolve(process.env.HONESTY_RUNNER_PATH)
    : join(REPO, 'kids_points_mp', '.tmp_test', 'run.js')
  if (!existsSync(runner)) {
    report('C. D12 回归守卫', false, `找不到测试运行器 ${runner}`)
  } else {
    const src = readFileSync(runner, 'utf8')
    const lines = src.split(/\r?\n/)
    let depth = 0
    const offenders = []
    /** 逐行累计花括号深度；`process.exitCode` / 汇总打印必须在 depth 0 处。 */
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      // 赋值/汇总行先于本行花括号变化判定，避免被本行自身的 `}` 干扰
      if (/process\.exitCode\s*=/.test(line) || /ALL PASS|ANY FAIL/.test(line)) {
        if (depth !== 0) offenders.push(`第 ${i + 1} 行（嵌套深度 ${depth}）：${line.trim()}`)
      }
      // 忽略行尾注释对花括号计数的干扰（字符串内的花括号不影响本检查的保守性）
      const code = line.replace(/\/\/.*$/, '')
      for (const ch of code) {
        if (ch === '{') depth += 1
        else if (ch === '}') depth -= 1
      }
    }
    report(
      'C. D12 回归守卫（汇总/退出码不得嵌套在回调内）',
      offenders.length === 0,
      offenders.length === 0 ? '全部位于顶层' : `\n    ${offenders.join('\n    ')}`
    )
  }

  // ── D：契约漂移守卫（permission-matrix.ts ↔ schema.prisma）───────
  const matrixFile = join(HERE, 'src', 'contracts', 'permission-matrix.ts')
  const schemaFile = join(HERE, 'prisma', 'schema.prisma')
  if (!existsSync(matrixFile) || !existsSync(schemaFile)) {
    report('D. ActionType 契约漂移守卫', false, '缺少 permission-matrix.ts 或 schema.prisma')
  } else {
    const tsSrc = readFileSync(matrixFile, 'utf8')
    const prSrc = readFileSync(schemaFile, 'utf8')
    // 矩阵键：形如 `  action_name: { guardian:` 的顶层键
    const tsActions = [...tsSrc.matchAll(/^\s{2}([a-z_]+):\s*\{\s*guardian:/gm)].map((m) => m[1])
    // Prisma 枚举：enum ActionType { ... } 内的值
    const enumBody = prSrc.match(/enum ActionType \{([\s\S]*?)\n\}/)
    const prActions = enumBody
      ? enumBody[1]
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('///'))
      : []
    const missingInPrisma = tsActions.filter((a) => !prActions.includes(a))
    const missingInTs = prActions.filter((a) => !tsActions.includes(a))
    const ok = tsActions.length > 0 && missingInPrisma.length === 0 && missingInTs.length === 0
    report(
      'D. ActionType 契约漂移守卫（矩阵 ↔ Prisma enum）',
      ok,
      ok
        ? `两侧一致，共 ${tsActions.length} 个动作`
        : `TS=${tsActions.length} Prisma=${prActions.length}｜仅在 TS：${missingInPrisma}｜仅在 Prisma：${missingInTs}`
    )
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

// 汇总 —— 必须只在所有检查之后结算（这正是 D12 的反面）
console.log(`\n${failures === 0 ? 'ALL PASS' : `FAILED ${failures} 项`}  （共 ${results.length} 项检查）`)
process.exitCode = failures === 0 ? 0 : 1

/**
 * 小程序端**所有** `run-*.mjs` 行为用例的统一入口（W14，2026-11-03）。
 *
 * ── 为什么需要它（这是 W14 自查里认账的那一条）──────────────────────────────
 *   这些 `run-*.mjs` 一直存在，但**没有接进任何 npm script**：
 *   `package.json` 的 scripts 以前只有 4 条 build/dev。
 *   写了没人会跑，比没写更坏 —— 它会让人以为"小程序有测试"。
 *   现在 `npm test` = `tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-all.mjs`。
 *
 * ── 口径 ────────────────────────────────────────────────────────────────────
 *   · 只跑 `run-w*.mjs`（按文件名排序，w14 自然排在最后）；
 *   · 逐个 `spawnSync` 串行执行（共享编译产物，不允许并发）；
 *   · 任何一条非 0 退出 ⇒ 汇总里点名，并以 1 退出。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const runners = readdirSync(dir)
  .filter((name) => /^run-w\d+[a-z]?\.mjs$/.test(name))
  .sort()

if (runners.length === 0) {
  console.error('FAIL  没有找到任何 run-w*.mjs —— 用例入口本身坏了')
  process.exit(1)
}

const failed = []
for (const name of runners) {
  console.log(`\n=== ${name} ===`)
  const result = spawnSync(process.execPath, [join(dir, name)], {
    stdio: 'inherit'
  })
  if (result.status !== 0) failed.push(name)
}

console.log('')
if (failed.length > 0) {
  console.error(`FAIL  ${failed.length}/${runners.length} 个用例文件未通过：${failed.join('、')}`)
  process.exit(1)
}
console.log(`PASS  小程序端 ${runners.length} 个用例文件全部通过`)

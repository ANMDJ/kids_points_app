#!/usr/bin/env node
/**
 * run-db-tests.mjs —— **真库不变量套件**入口（W2-B）
 *
 * 与 `npm test` 的分工（必须分清，否则会立刻变成假绿）：
 *   · `npm test`（`scripts/run-tests.mjs`）—— **无库**用例，CI 里跑（可移植）；
 *   · 本入口 —— **要活库**的用例（`test-db/*.dbtest.ts`），只在 `npm run ci:db` 里跑。
 *
 * ── 为什么要一个独立入口，而不是"没库就跳过"──────────────────────────────
 *   "跳过"在报告里长得和"通过"一样。本仓库的纪律是：**没验证 ≠ 通过了**。
 *   所以这里没有 `skip` 分支 —— 缺 `DATABASE_URL` 直接**退出码 1**，
 *   并说明"这一整套不变量**一条都没被验证**"。
 *
 * ── 三道 fail-closed 守卫 ─────────────────────────────────────────────────
 *   ① 禁止 `NODE_ENV=production`：套件会**写入真实的行**，而且账本表 `DELETE`
 *      被 REVOKE（I5）—— 写进去的流水**删不掉**。只许对着开发/实验库跑；
 *   ② `DATABASE_URL` 必须存在（缺 ⇒ 红，见上）；
 *   ③ 复用 `run-tests.mjs` 的全部守卫（空目录红 / 源与产物一一对应 / `tests N` 解析）。
 *
 * 用法：`npm run test:db`（= 本文件）；`npm run ci:db` = `db:verify` ＋ 本文件。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import 'dotenv/config' // 与 verify-db.mjs 同一口径：跑本脚本要能读到 backend/.env

const HERE = resolve(import.meta.dirname, '..') // backend/
/**
 * `KP_DB_TEST_DIR` 默认 `test-db`。允许覆盖**只有一个理由**：让
 * `scripts/test-can-fail-db.mjs` 能把本入口指向一个**空目录**，从而证明守卫 ③
 * 「0 个真库用例 ⇒ 红」真的会拦（跟 `run-tests.mjs` 的 `KP_TEST_DIR` 同一套路）。
 * 守卫不可证伪 = 没有牙齿。
 */
const DB_TEST_DIR = resolve(HERE, process.env.KP_DB_TEST_DIR ?? 'test-db')

function fail(reason, hint = '') {
  console.error(`FAIL  ${reason}`)
  if (hint !== '') console.error(`      ${hint}`)
  process.exit(1)
}

// ── 守卫 ①：绝不对着生产跑 ────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  fail(
    'NODE_ENV=production —— 拒绝跑真库套件',
    '套件会写入 PointRecord（而账本表 DELETE 已被 REVOKE，I5）⇒ 写进去就删不掉。只许对着开发/实验库跑。'
  )
}

// ── 守卫 ②：必须有活库连接串 ──────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  fail(
    'DATABASE_URL 未设置 —— 真库套件**一条都没跑**（这不是"通过"，是"没验证"）',
    '复制 backend/.env.example 为 backend/.env，或先跑 `npm run ci:db` 的前置：migrate deploy + prisma/sql/900 + 901'
  )
}

// ── 守卫 ③（前置检查）：套件目录里必须真的有 `*.dbtest.ts` ─────────────────
const hasSuite = existsSync(DB_TEST_DIR)
  ? readdirSync(DB_TEST_DIR).some((name) => name.endsWith('.dbtest.ts'))
  : false
if (!hasSuite) {
  fail(
    `在 test-db/ 下没有发现任何 *.dbtest.ts`,
    '0 个真库用例**不算通过** —— 与 run-tests.mjs 的同类守卫同一理由（见其文件头）'
  )
}

console.log(
  '── 真库不变量套件（会**写入**实验数据：账本表不可删，见文件头）——\n'
)

try {
  execFileSync(process.execPath, [join(HERE, 'scripts', 'run-tests.mjs')], {
    cwd: HERE,
    stdio: 'inherit',
    env: { ...process.env, KP_TEST_DIR: 'test-db', KP_TEST_SUFFIX: '.dbtest.ts' }
  })
} catch (err) {
  // 子进程的失败理由已经原样打在屏幕上（stdio: inherit）；这里只负责**把退出码传出去**，
  // 绝不"看起来跑过了就返回 0"（D12 的形状）。
  process.exit(typeof err.status === 'number' ? err.status : 1)
}

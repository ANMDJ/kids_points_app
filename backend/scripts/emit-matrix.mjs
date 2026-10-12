#!/usr/bin/env node
/**
 * emit-matrix.mjs —— 把 TS 版 PERMISSION_MATRIX 输出为 JSON，供 Python Agent 消费
 *
 * 为什么需要这一步：02 §2 的架构约束是「权限只能在一处定义」，
 * 由 HTTP Guard 与 Agent action-dispatcher **消费同一张表**。
 * 但 backend_agent 是 Python，**无法 import TypeScript** ——
 * 若让它自己抄一份矩阵，两条入口必然漂移，Agent 会成为提权通道（02 §3 屏障二的反面）。
 *
 * 因此：TS 是唯一事实源，本脚本生成 contracts/permission-matrix.json，Agent 只读该 JSON。
 * **绝不允许手改 JSON**，也绝不允许在 Python 侧另抄一份。
 *
 * 前置：先 `npm run build`（本脚本读取 dist 产物，而非去解析 TS 源码文本 —— 解析源码
 *       是脆弱的：一次格式调整就会静默漏掉一个动作）。
 *
 * 用法：npm run contracts:emit
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const BACKEND = resolve(import.meta.dirname, '..')
const REPO = resolve(BACKEND, '..')
const COMPILED = join(BACKEND, 'dist', 'contracts', 'permission-matrix.js')
const OUT = join(REPO, 'contracts', 'permission-matrix.json')

if (!existsSync(COMPILED)) {
  console.error(`✗ 找不到编译产物：${COMPILED}\n  请先运行：npm run build`)
  process.exitCode = 1
  process.exit()
}

const mod = require(COMPILED)

if (typeof mod.PERMISSION_MATRIX !== 'object' || mod.PERMISSION_MATRIX === null) {
  console.error('✗ 编译产物未导出 PERMISSION_MATRIX —— 契约生成中止（绝不产出半成品）')
  process.exitCode = 1
  process.exit()
}

const actions = Object.keys(mod.PERMISSION_MATRIX)
const payload = {
  $schema: 'generated — 请勿手工编辑',
  generatedFrom: relative(REPO, resolve(BACKEND, 'src', 'contracts', 'permission-matrix.ts'))
    .split('\\')
    .join('/'),
  authority: 'HTTP Guard 与 Agent action-dispatcher 消费本文件，权限定义只能存在于唯一事实源',
  actionCount: actions.length,
  verdictSeverity: mod.VERDICT_SEVERITY,
  actions,
  matrix: mod.PERMISSION_MATRIX
}

mkdirSync(join(REPO, 'contracts'), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(`✔ 已生成 ${relative(REPO, OUT).split('\\').join('/')}（${actions.length} 个动作）`)

#!/usr/bin/env node
/**
 * password-rules-check.mjs —— 密码规则三份镜像的守门人（2026-11-03）
 *
 * ── 它拦的是哪一种病 ────────────────────────────────────────────────────────
 *   密码强度现在有三份实现，都是**手抄**：
 *     ① 服务端唯一判据：`backend/src/identity/account-identifier.ts`
 *        （`validatePasswordStrength()` / `passwordMessage()` / `COMMON_PASSWORDS`）
 *     ② App 镜像：`lib/data/password_rules.dart`
 *     ③ 小程序镜像：`kids_points_mp/src/utils/password_rules.ts`
 *   没有编译器会比对它们。漂移的后果很具体：**本地放行、服务端 400** ——
 *   用户改一次密码、再撞一次，而界面上那句提示还是错的（2026-11-03 的现场）。
 *
 *   与 D9（图标名三份手抄）/ D1b（关系枚举三处手抄）同一种病，修法一致：
 *   写一个**会红**的守门脚本，而不是靠"下次记得同步"。
 *
 * ── 检查项（任一条红即退出码 1）──────────────────────────────────────────────
 *   ① 两个边界（`PASSWORD_MIN` / `PASSWORD_MAX`）三份**逐字相等**；
 *   ② 六条拒绝文案三份**逐字相等**（`${PASSWORD_MIN}` / `$kPasswordMin`
 *      这类插值先归一成 `{MIN}` / `{MAX}` 再比）；
 *   ③ 弱口令表三份是**同一个集合**（顺序无关），且非空（≥ 10 条）；
 *   ④ 三份都必须真的实现了上面六条（少一条 = 有一类弱密码在某一端静默通过）。
 *
 * ── fail-closed ────────────────────────────────────────────────────────────
 *   文件不存在 / 解析不出 / 集合为空 —— 一律红。空集合"相等"不能算通过。
 *
 * ── 自测（一个永远通过的检查等于没有检查，见 D13）──────────────────────────────
 *   三个路径都可用环境变量指向**被篡改的副本**，用来证伪自己：
 *     KP_PASSWORD_BACKEND=<副本> node tools/password-rules-check.mjs   → 必须红
 *     （KP_PASSWORD_MP / KP_PASSWORD_DART 同理）
 *
 * 用法：node tools/password-rules-check.mjs
 *      （已接进 `backend` 的 `npm run password:check` 与 `npm run ci`）
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const PATHS = {
  backend: process.env.KP_PASSWORD_BACKEND ?? 'backend/src/identity/account-identifier.ts',
  mp: process.env.KP_PASSWORD_MP ?? 'kids_points_mp/src/utils/password_rules.ts',
  dart: process.env.KP_PASSWORD_DART ?? 'lib/data/password_rules.dart'
}

const REASONS = ['too_short', 'too_long', 'all_same', 'all_digits', 'common', 'same_as_identifier']

const failures = []

function fail(message) {
  failures.push(message)
}

function read(rel) {
  const full = resolve(ROOT, rel)
  if (!existsSync(full)) throw new Error(`文件不存在：${rel}`)
  return readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
}

/** 把三种语言的插值写法归一：`${PASSWORD_MIN}` / `$kPasswordMin` ⇒ `{MIN}`。 */
function normalizeMessage(text) {
  return text
    .replace(/\$\{PASSWORD_MIN\}|\$kPasswordMin/g, '{MIN}')
    .replace(/\$\{PASSWORD_MAX\}|\$kPasswordMax/g, '{MAX}')
    .trim()
}

/** `TOO_SHORT` / `tooShort` / `too_short` ⇒ `too_short`。 */
function normalizeReason(raw) {
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** 从一段 switch 里抓：`case <键>: … return <字面量>`（三种语言的写法通吃）。 */
function collectMessages(src, casePattern, returnPattern) {
  const found = new Map()
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const keyMatch = lines[i].match(casePattern)
    if (keyMatch === null) continue
    // `return` 可能在同一行，也可能在下一两行（`case` 与 `return` 分行写）
    const window = lines.slice(i, i + 4).join('\n')
    const valueMatch = window.match(returnPattern)
    if (valueMatch === null) continue
    const reason = normalizeReason(keyMatch[1])
    if (!REASONS.includes(reason)) continue
    found.set(reason, normalizeMessage(valueMatch[1]))
  }
  return found
}

function collectStrings(block) {
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

// ── 读三份源码 ──────────────────────────────────────────────────────────────
let backend = ''
let mp = ''
let dart = ''
try {
  backend = read(PATHS.backend)
  mp = read(PATHS.mp)
  dart = read(PATHS.dart)
} catch (error) {
  fail(error.message)
}

if (failures.length === 0) {
  // ── ① 边界 ────────────────────────────────────────────────────────────────
  const pick = (src, re, label) => {
    const match = src.match(re)
    if (match === null) {
      fail(`${label}：解析不出（正则 ${re}）`)
      return null
    }
    return Number(match[1])
  }

  const bounds = {
    backend: [
      pick(backend, /export const PASSWORD_MIN = (\d+)/, `${PATHS.backend} PASSWORD_MIN`),
      pick(backend, /export const PASSWORD_MAX = (\d+)/, `${PATHS.backend} PASSWORD_MAX`)
    ],
    mp: [
      pick(mp, /export const PASSWORD_MIN = (\d+)/, `${PATHS.mp} PASSWORD_MIN`),
      pick(mp, /export const PASSWORD_MAX = (\d+)/, `${PATHS.mp} PASSWORD_MAX`)
    ],
    dart: [
      pick(dart, /const int kPasswordMin = (\d+)/, `${PATHS.dart} kPasswordMin`),
      pick(dart, /const int kPasswordMax = (\d+)/, `${PATHS.dart} kPasswordMax`)
    ]
  }

  const [backendMin, backendMax] = bounds.backend
  for (const [name, [min, max]] of Object.entries(bounds)) {
    if (name === 'backend') continue
    if (min !== backendMin) fail(`最小长度不一致：backend=${backendMin}，${name}=${min}`)
    if (max !== backendMax) fail(`最大长度不一致：backend=${backendMax}，${name}=${max}`)
  }

  // ── ② 六条文案 ────────────────────────────────────────────────────────────
  const messages = {
    backend: collectMessages(backend, /case '([A-Z_]+)':/, /return [`']([^`'\n]+)[`']/),
    mp: collectMessages(mp, /case '([a-z_]+)':/, /return [`']([^`'\n]+)[`']/),
    dart: collectMessages(dart, /case PasswordFailure\.(\w+):/, /return '([^'\n]+)';/)
  }

  for (const [name, map] of Object.entries(messages)) {
    for (const reason of REASONS) {
      if (!map.has(reason)) {
        fail(`${name}：缺少 ${reason} 的文案（有一类弱密码在该端会静默通过）`)
      }
    }
  }

  for (const reason of REASONS) {
    const expected = messages.backend.get(reason)
    if (expected === undefined) continue
    for (const name of ['mp', 'dart']) {
      const actual = messages[name].get(reason)
      if (actual === undefined) continue
      if (actual !== expected) {
        fail(`文案不一致（${reason}）：\n    backend: ${expected}\n    ${name}: ${actual}`)
      }
    }
  }

  // ── ③ 弱口令表 ────────────────────────────────────────────────────────────
  const blockOf = (src, re, label) => {
    const match = src.match(re)
    if (match === null) {
      fail(`${label}：解析不出弱口令表`)
      return null
    }
    return match[1]
  }

  const lists = {
    backend: blockOf(
      backend,
      /const COMMON_PASSWORDS = new Set\(\[([\s\S]*?)\]\)/,
      `${PATHS.backend} COMMON_PASSWORDS`
    ),
    mp: blockOf(
      mp,
      /export const COMMON_PASSWORDS: readonly string\[\] = \[([\s\S]*?)\]/,
      `${PATHS.mp} COMMON_PASSWORDS`
    ),
    dart: blockOf(
      dart,
      /const Set<String> kCommonPasswords = <String>\{([\s\S]*?)\}/,
      `${PATHS.dart} kCommonPasswords`
    )
  }

  const sets = {}
  for (const [name, block] of Object.entries(lists)) {
    const values = block === null ? [] : collectStrings(block)
    if (values.length < 10) {
      fail(`${name}：弱口令表只有 ${values.length} 条（至少 10 条，且不许为空）`)
    }
    if (new Set(values).size !== values.length) fail(`${name}：弱口令表内有重复项`)
    sets[name] = new Set(values)
  }

  for (const name of Object.keys(sets)) {
    if (name === 'backend') continue
    for (const entry of sets.backend) {
      if (!sets[name].has(entry)) fail(`弱口令表不一致：backend 有 '${entry}'，${name} 没有`)
    }
    for (const entry of sets[name]) {
      if (!sets.backend.has(entry)) fail(`弱口令表不一致：${name} 有 '${entry}'，backend 没有`)
    }
  }

  if (failures.length === 0) {
    console.log(
      `PASS  密码规则三份一致：${backendMin}–${backendMax} 位 / 6 条文案 / ${sets.backend.size} 条弱口令`
    )
    console.log(`      backend: ${PATHS.backend}`)
    console.log(`      mp     : ${PATHS.mp}`)
    console.log(`      dart   : ${PATHS.dart}`)
  }
}

if (failures.length > 0) {
  console.error(`FAIL  密码规则镜像漂移（${failures.length} 处）——本地会放行、服务端会拒绝：`)
  for (const message of failures) console.error(`  · ${message}`)
  console.error('\n  改哪一份都要同步另外两份；文案必须逐字相同（插值先归一成 {MIN}/{MAX}）。')
  process.exit(1)
}

process.exit(0)

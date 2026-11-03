#!/usr/bin/env node
/**
 * kid-mode-check.mjs —— 孩子模式时长规则的**三端镜像**守门人（W14，2026-11-03）
 *
 * ── 它拦的是哪一种病 ────────────────────────────────────────────────────────
 *   「一次给孩子用 1–30 分钟」这个数字同时写在三处，全是手抄：
 *     ① 服务端唯一判定：`backend/src/auth/kid-mode.policy.ts`（含 DTO 的 @Min/@Max）；
 *     ② App：`lib/models/kid_mode.dart`；
 *     ③ 小程序：`kids_points_mp/src/data/parent_mode.ts`。
 *   没有编译器会比对它们。漂移的后果很具体：UI 允许 45 分钟 → 服务端 400（或
 *   反过来，服务端放宽了而三端 UI 还在 30）—— 与 `password-rules-check.mjs`
 *   同一个病，修法也一样：写一个**会红**的脚本。
 *
 * ── 检查项（任一条红即退出码 1）──────────────────────────────────────────────
 *   ① `MIN / MAX / DEFAULT` 三份**逐字相等**；
 *   ② 快捷时长列表（Dart / TS）是**同一个数组**（顺序也一致，UI 顺序就是产品顺序）；
 *   ③ 列表非空、值都在 [MIN, MAX] 内、且**必须包含 MAX**（不许出现"选了 30 却发不出去"）；
 *   ④ `DEFAULT` 必须在列表里（否则面板初始值不在任何一个 chip 上）。
 *
 * ── fail-closed ────────────────────────────────────────────────────────────
 *   文件不存在 / 解析不出 / 解析出 `undefined` —— 一律红。缺值不能算"一致"。
 *
 * ── 自测（一个永远通过的检查等于没有检查，见 D13）──────────────────────────────
 *   三个路径都可用环境变量指向**被篡改的副本**，用来证伪自己：
 *     KP_KID_MODE_BACKEND=<副本> node tools/kid-mode-check.mjs   → 必须红
 *     （KP_KID_MODE_MP / KP_KID_MODE_DART 同理）
 *
 * 用法：node tools/kid-mode-check.mjs
 *      （已接进 `backend` 的 `npm run kidmode:check` 与 `npm run ci`）
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const PATHS = {
  backend: process.env.KP_KID_MODE_BACKEND ?? 'backend/src/auth/kid-mode.policy.ts',
  mp: process.env.KP_KID_MODE_MP ?? 'kids_points_mp/src/data/parent_mode.ts',
  dart: process.env.KP_KID_MODE_DART ?? 'lib/models/kid_mode.dart'
}

const failures = []

function fail(message) {
  failures.push(message)
}

function read(rel) {
  const full = resolve(ROOT, rel)
  if (!existsSync(full)) throw new Error(`文件不存在：${rel}`)
  return readFileSync(full, 'utf8').replace(/\r\n/g, '\n')
}

/** 抓一个整数常量；抓不到 ⇒ 红并返回 null。 */
function pickInt(src, pattern, label) {
  const match = src.match(pattern)
  if (match === null) {
    fail(`${label}：解析不出（常量被改名/删除，或写法变了）`)
    return null
  }
  return Number(match[1])
}

/** 抓一个整数数组；抓不到 ⇒ 红并返回 null。 */
function pickIntList(src, pattern, label) {
  const match = src.match(pattern)
  if (match === null) {
    fail(`${label}：解析不出快捷时长列表`)
    return null
  }
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => Number(item))
}

function sameArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function main() {
  const backend = read(PATHS.backend)
  const mp = read(PATHS.mp)
  const dart = read(PATHS.dart)

  // ── ① 三个数字 ────────────────────────────────────────────────────────────
  const bounds = {
    backend: {
      min: pickInt(backend, /export const KID_MODE_MIN_MINUTES = (\d+)/, `${PATHS.backend} KID_MODE_MIN_MINUTES`),
      max: pickInt(backend, /export const KID_MODE_MAX_MINUTES = (\d+)/, `${PATHS.backend} KID_MODE_MAX_MINUTES`),
      def: pickInt(backend, /export const KID_MODE_DEFAULT_MINUTES = (\d+)/, `${PATHS.backend} KID_MODE_DEFAULT_MINUTES`)
    },
    mp: {
      min: pickInt(mp, /export const KID_MODE_MIN_MINUTES = (\d+)/, `${PATHS.mp} KID_MODE_MIN_MINUTES`),
      max: pickInt(mp, /export const KID_MODE_MAX_MINUTES = (\d+)/, `${PATHS.mp} KID_MODE_MAX_MINUTES`),
      def: pickInt(mp, /export const KID_MODE_DEFAULT_MINUTES = (\d+)/, `${PATHS.mp} KID_MODE_DEFAULT_MINUTES`)
    },
    dart: {
      min: pickInt(dart, /const int kKidModeMinMinutes = (\d+);/, `${PATHS.dart} kKidModeMinMinutes`),
      max: pickInt(dart, /const int kKidModeMaxMinutes = (\d+);/, `${PATHS.dart} kKidModeMaxMinutes`),
      def: pickInt(dart, /const int kKidModeDefaultMinutes = (\d+);/, `${PATHS.dart} kKidModeDefaultMinutes`)
    }
  }

  const { min, max, def } = bounds.backend
  for (const [name, values] of Object.entries(bounds)) {
    if (name === 'backend') continue
    for (const key of ['min', 'max', 'def']) {
      if (values[key] !== bounds.backend[key]) {
        fail(`${key} 不一致：backend=${bounds.backend[key]}，${name}=${values[key]}`)
      }
    }
  }

  if (min !== null && max !== null && def !== null) {
    if (!(min < max)) fail(`边界不成立：MIN=${min} 必须小于 MAX=${max}`)
    if (def < min || def > max) fail(`默认值越界：DEFAULT=${def} 不在 ${min}–${max}`)
  }

  // ── ② 快捷时长列表 ────────────────────────────────────────────────────────
  const choices = {
    mp: pickIntList(
      mp,
      /KID_MODE_DURATION_CHOICES: readonly number\[\] = \[([^\]]*)\]/,
      `${PATHS.mp} KID_MODE_DURATION_CHOICES`
    ),
    dart: pickIntList(
      dart,
      /kKidModeDurationChoices = <int>\[([^\]]*)\]/,
      `${PATHS.dart} kKidModeDurationChoices`
    )
  }

  if (choices.mp !== null && choices.dart !== null) {
    if (choices.mp.length === 0) fail('快捷时长列表为空（面板会没有任何可选值）')
    for (const [index, value] of choices.mp.entries()) {
      if (!Number.isInteger(value)) fail(`快捷时长第 ${index + 1} 项不是整数：${String(value)}`)
    }
    if (new Set(choices.mp).size !== choices.mp.length) fail('快捷时长列表有重复项')
    if (!sameArray(choices.mp, choices.dart)) {
      fail(`快捷时长列表不一致：\n    mp  : [${choices.mp.join(', ')}]\n    dart: [${choices.dart.join(', ')}]`)
    }
    if (min !== null && max !== null) {
      for (const value of choices.mp) {
        if (value < min || value > max) fail(`快捷时长 ${value} 越界（应在 ${min}–${max}）`)
      }
      if (!choices.mp.includes(max)) fail(`快捷时长列表必须包含上限 ${max}（否则"选满"就发不出去）`)
    }
    if (def !== null && !choices.mp.includes(def)) {
      fail(`默认值 ${def} 不在快捷时长列表里（面板初始值会没有任何 chip 被选中）`)
    }
  }

  if (failures.length === 0) {
    console.log(
      `PASS  孩子模式时长三端一致：${min}–${max} 分钟 / 默认 ${def} / 快捷 [${choices.mp.join(', ')}]`
    )
    console.log(`      backend: ${PATHS.backend}`)
    console.log(`      mp     : ${PATHS.mp}`)
    console.log(`      dart   : ${PATHS.dart}`)
  }
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

if (failures.length > 0) {
  console.error(`FAIL  孩子模式规则镜像漂移（${failures.length} 处）—— 会表现为"本地放行、服务端 400"：`)
  for (const message of failures) console.error(`  · ${message}`)
  console.error('\n  改哪一份都要同步另外两份（含 DTO 的 @Min/@Max，它们引用同一份常量）。')
  process.exit(1)
}

process.exit(0)


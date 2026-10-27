#!/usr/bin/env node
/**
 * onboarding-options-check.mjs —— 首启引导的**选项契约**守门人（W8-B）
 *
 * 存在理由：同一份「4 个学段 / 6 个关注点」被**手抄三遍** ——
 *   后端 `backend/src/contracts/onboarding.ts`（DTO `@IsIn` + 排序 + 种子自检的权威源）、
 *   Flutter `lib/models/onboarding.dart`（`AgeBand.wireName` + `kFocusAreas`）、
 *   小程序 `kids_points_mp/src/data/onboarding.ts`（`AGE_BAND_OPTIONS` + `FOCUS_AREA_OPTIONS`）。
 * 三处的编译器都管不到另外两处；漂移的表现是**静默的**：
 *   · 少一个关注点 ⇒ 第④步画不出那个胶囊，命中数为 0（孩子永远看不到最想改善的那类约定）；
 *   · 学段线值写错（`primaryLow` vs `primary_low`）⇒ 后端 `@IsIn` 回 400，
 *     而界面只会显示一句英文校验消息；
 *   · 顺序不一致 ⇒ 双端同一份数据排出两种卡片顺序（`04` §2 第⑤步的排序链解释不了）。
 * 这正是 D9（图标名三处手抄）的同款病灶，因此用同款手法钉死。
 *
 * 检查项（任一条红即退出码 1）：
 *   ① 三份文件都能读到、都能解析出非空数组；
 *   ② 学段**线值**集合与顺序三处逐字一致，且没有重复；
 *   ③ 关注点集合与顺序三处逐字一致，且没有重复；
 *   ④ Flutter 的每个枚举分支都必须给出线值（case 数 == return 数）。
 *
 * fail-closed：文件不存在、正则匹配不到、数组为空 —— 一律红，绝不静默跳过。
 *
 * 自测（一个永远通过的检查等于没有检查，见 D13）：
 *   KP_ONBOARDING_BACKEND=<被篡改的副本> node tools/onboarding-options-check.mjs → 必须红
 *   （KP_ONBOARDING_FLUTTER / KP_ONBOARDING_TARO 同理）
 *
 * 用法：node tools/onboarding-options-check.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const PATHS = {
  backend:
    process.env.KP_ONBOARDING_BACKEND ?? 'backend/src/contracts/onboarding.ts',
  flutter: process.env.KP_ONBOARDING_FLUTTER ?? 'lib/models/onboarding.dart',
  taro: process.env.KP_ONBOARDING_TARO ?? 'kids_points_mp/src/data/onboarding.ts'
}

const abs = (rel) => resolve(ROOT, rel)
const failures = []

function fail(message) {
  failures.push(message)
}

function read(rel, label) {
  const file = abs(rel)
  if (!existsSync(file)) {
    fail(`${label} 文件不存在：${rel}`)
    return ''
  }
  return readFileSync(file, 'utf8')
}

/** 取 `start` 之后到第一个 `end` 之间的片段；找不到就红。 */
function sliceBetween(source, start, end, label) {
  const from = source.indexOf(start)
  if (from < 0) {
    fail(`${label}：找不到起点 ${JSON.stringify(start)}`)
    return ''
  }
  const to = source.indexOf(end, from + start.length)
  if (to < 0) {
    fail(`${label}：找不到终点 ${JSON.stringify(end)}`)
    return ''
  }
  return source.slice(from + start.length, to)
}

/** 片段里的单引号字符串（保持出现顺序）。 */
function quotedValues(source) {
  return [...source.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

function duplicates(values) {
  const seen = new Set()
  const dup = new Set()
  for (const value of values) {
    if (seen.has(value)) dup.add(value)
    seen.add(value)
  }
  return [...dup]
}

/** 逐字比较两个数组（顺序也要一致）。 */
function compare(label, expected, actual, expectedName, actualName) {
  const dupExpected = duplicates(expected)
  const dupActual = duplicates(actual)
  if (dupExpected.length > 0) {
    fail(`${expectedName} 有重复项：${dupExpected.join('、')}`)
  }
  if (dupActual.length > 0) {
    fail(`${actualName} 有重复项：${dupActual.join('、')}`)
  }
  if (expected.length !== actual.length) {
    fail(
      `${label} 数量不一致：${expectedName} ${expected.length} 个，` +
        `${actualName} ${actual.length} 个`
    )
  }
  const mismatch = expected.findIndex((value, index) => value !== actual[index])
  if (mismatch >= 0) {
    fail(
      `${label} 第 ${mismatch + 1} 项不一致：` +
        `${expectedName}=${JSON.stringify(expected[mismatch])}，` +
        `${actualName}=${JSON.stringify(actual[mismatch])}`
    )
  }
  if (expected.length === 0) fail(`${expectedName} 解析为空 —— 拒绝静默通过`)
}

// ---------------------------------------------------------------- 后端（权威源）

const backendSource = read(PATHS.backend, '后端契约')
const backendAgeBands = quotedValues(
  sliceBetween(
    backendSource,
    'export const AGE_BANDS = [',
    '] as const',
    '后端 AGE_BANDS'
  )
)
const backendFocusAreas = quotedValues(
  sliceBetween(
    backendSource,
    'export const FOCUS_AREAS = [',
    '] as const',
    '后端 FOCUS_AREAS'
  )
)

// ---------------------------------------------------------------- Flutter

const flutterSource = read(PATHS.flutter, 'Flutter 模型')
// 枚举里每个分支的 `return '<wire>'` —— 这是唯一允许出现在请求体里的写法。
const flutterWireBlock = sliceBetween(
  flutterSource,
  'String get wireName {',
  '  }',
  'Flutter wireName'
)
const flutterAgeBands = [...flutterWireBlock.matchAll(/return '([^']+)'/g)].map(
  (match) => match[1]
)
const flutterFocusAreas = quotedValues(
  sliceBetween(
    flutterSource,
    'const List<String> kFocusAreas = <String>[',
    '];',
    'Flutter kFocusAreas'
  )
)

const flutterCaseCount = (flutterWireBlock.match(/case AgeBand\./g) ?? []).length
if (flutterCaseCount !== flutterAgeBands.length) {
  fail(
    `Flutter：wireName 的 case 分支 ${flutterCaseCount} 个，但 return 只有 ` +
      `${flutterAgeBands.length} 个 —— 有分支没给出线值`
  )
}

// ---------------------------------------------------------------- 小程序

const taroSource = read(PATHS.taro, '小程序数据层')
const taroAgeBands = [
  ...sliceBetween(
    taroSource,
    'export const AGE_BAND_OPTIONS = [',
    '] as const',
    '小程序 AGE_BAND_OPTIONS'
  ).matchAll(/value: '([^']+)'/g)
].map((match) => match[1])
const taroFocusAreas = quotedValues(
  sliceBetween(
    taroSource,
    'export const FOCUS_AREA_OPTIONS = [',
    '] as const',
    '小程序 FOCUS_AREA_OPTIONS'
  )
)

// ---------------------------------------------------------------- 对账

if (backendAgeBands.length > 0) {
  compare(
    '学段',
    backendAgeBands,
    flutterAgeBands,
    '后端 AGE_BANDS',
    'Flutter wireName'
  )
  compare(
    '学段',
    backendAgeBands,
    taroAgeBands,
    '后端 AGE_BANDS',
    '小程序 AGE_BAND_OPTIONS'
  )
  compare(
    '关注点',
    backendFocusAreas,
    flutterFocusAreas,
    '后端 FOCUS_AREAS',
    'Flutter kFocusAreas'
  )
  compare(
    '关注点',
    backendFocusAreas,
    taroFocusAreas,
    '后端 FOCUS_AREAS',
    '小程序 FOCUS_AREA_OPTIONS'
  )
}

if (failures.length > 0) {
  console.error('✗ onboarding-options-check FAILED')
  for (const message of failures) console.error('  · ' + message)
  process.exit(1)
}

console.log('✓ onboarding-options-check PASS')
console.log(
  `  学段 ${backendAgeBands.length} 个：${backendAgeBands.join(' / ')}`
)
console.log(
  `  关注点 ${backendFocusAreas.length} 个：${backendFocusAreas.join(' / ')}`
)


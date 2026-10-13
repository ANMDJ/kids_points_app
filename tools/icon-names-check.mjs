#!/usr/bin/env node
/**
 * icon-names-check.mjs —— 图标名跨端契约守门人（阶段 C5，修 D9）
 *
 * 存在理由：**同一个图标名要手抄三份** ——
 *   小程序 `kids_points_mp/src/components/Icon/icons.ts` 的 `ICONS` 键集合、
 *   Flutter `lib/theme/app_icons.dart` 的 `appIcons` 键集合、
 *   后端 `backend/prisma/seed/templates.data.ts` 的 `ICON_NAMES`。
 * 后端那份**没法** import 小程序的 TS（跨包、跨工具链），只能手抄；手抄就会漂移，
 * 而漂移的表现是「某个图标在某一端悄悄变成占位 / 空白」—— 三端的编译器都不会说一句话。
 * 这正是 **D9** 的病灶形态：数据层存的是 `IconData`（字形），服务端给的是名字 `"book"`，
 * 落不进去、也没人喊。**没有守门人，这次修好也只是这一秒是对的。**
 *
 * 检查项（任一条红即退出码 1）：
 *   ① **三份名单集合相等**，且各自没有重复项（有重复项时「相等」本身就不可信）
 *   ② Flutter 的 `IconNames.X` 常量名必须等于它的字面量（`book = 'book'`），
 *      且 `appIcons` 的键集合 = 常量集合 —— 否则「常量名 / 字符串 / 映射表」三处真相各走各的
 *   ③ **数据层不得存字形**：`lib/models/**`、`lib/data/**` 里出现 `IconData` / `Icons.` 即红，
 *      也不得出现任何图标名字面量（名字必须经 `IconNames.*`）—— 数据层只有名字，与后端 `String` 同构
 *   ④ **渲染调用不得写死名字**：`iconDataFor('book')` / `getIcon('book')` 一律红
 *      （写死就等于绕过映射表，接 API 时又要逐处改界面 —— D9 的原病）
 *   ⑤ **渲染点必须在位且各只一处**：Flutter `rule_tile` / `record_tile` / `form_fields` 必须走
 *      `iconDataFor(`；Taro 只能经 `Icon/index.tsx` 的 `getIcon(`（不许直接读 `ICONS[`）
 *   ⑥ **两端选择器的图标清单同名同序**：同一张表单，不该长两个样
 *   ⑦ **逃生口在位且被接上**：Flutter `fallbackIcon` 必须**派生**自 `appIcons[IconNames.unknown]`
 *      （不许第二份真相）、`isKnownIconName` 必须被 `AppStore.addRule` 调用；
 *      Taro `getIcon` 必须有 `?? ICONS[FALLBACK_ICON_NAME]` 分支、`isKnownIconName`
 *      必须被 `store.addRule` 调用
 *
 * fail-closed：文件不存在、解析不出、名单为空 —— 一律红，绝不静默跳过。
 *
 * 自测（一个永远通过的检查等于没有检查，见 D13；逐例清单见 `03` §D9 现状）：
 *   KP_ICON_FLUTTER=<被篡改的副本> node tools/icon-names-check.mjs   → 必须红
 *   （KP_ICON_TARO / KP_ICON_BACKEND / KP_ICON_LIB_ROOT / KP_ICON_TARO_RENDER /
 *     KP_ICON_FLUTTER_PICKER / KP_ICON_FLUTTER_STORE 同理 —— 每一条都能被单独证伪）
 *
 * 用法：node tools/icon-names-check.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** 允许用环境变量覆盖（只为**证伪自测**：把篡改过的副本指进来，必须变红）。 */
const PATHS = {
  taro: process.env.KP_ICON_TARO ?? 'kids_points_mp/src/components/Icon/icons.ts',
  taroRender: process.env.KP_ICON_TARO_RENDER ?? 'kids_points_mp/src/components/Icon/index.tsx',
  taroPicker: process.env.KP_ICON_TARO_PICKER ?? 'kids_points_mp/src/components/FormFields/index.tsx',
  taroStore: process.env.KP_ICON_TARO_STORE ?? 'kids_points_mp/src/data/store.ts',
  flutter: process.env.KP_ICON_FLUTTER ?? 'lib/theme/app_icons.dart',
  flutterStore: process.env.KP_ICON_FLUTTER_STORE ?? 'lib/data/app_store.dart',
  flutterPicker: process.env.KP_ICON_FLUTTER_PICKER ?? 'lib/widgets/form_fields.dart',
  flutterRuleTile: process.env.KP_ICON_FLUTTER_RULE_TILE ?? 'lib/widgets/rule_tile.dart',
  flutterRecordTile: process.env.KP_ICON_FLUTTER_RECORD_TILE ?? 'lib/widgets/record_tile.dart',
  backend: process.env.KP_ICON_BACKEND ?? 'backend/prisma/seed/templates.data.ts',
  libRoot: process.env.KP_ICON_LIB_ROOT ?? 'lib',
}

const abs = (rel) => resolve(ROOT, rel)

function readRel(rel) {
  const p = abs(rel)
  if (!existsSync(p)) throw new Error(`文件不存在：${rel}`)
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
}

/** 剥掉注释：**证据只取代码**。仓库里每条已修缺陷都带一段「原先 xxx 如何错」的注释，
 *  把注释算成证据会让两侧同时被骗（`defect-status.mjs` 首跑即踩 2 次）。
 *  剥注释时保留换行，行号不漂移；`://` 视为 URL 而非注释起点。 */
function stripComments(src) {
  let out = ''
  let i = 0
  let block = false
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (block) {
      if (c === '*' && n === '/') {
        block = false
        i += 2
      } else {
        if (c === '\n') out += '\n'
        i += 1
      }
      continue
    }
    if (c === '/' && n === '*') {
      block = true
      i += 2
      continue
    }
    if (c === '/' && n === '/' && src[i - 1] !== ':') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}


// ── 解析器：三份名单各自的键 / 常量提取（写法变了就直接抛错，绝不静默返回空）─────

/** Taro：`export const ICONS = { ... } as const satisfies ...` 的**顶层**键。 */
function parseTaroKeys(src) {
  const block = src.match(/export const ICONS = \{([\s\S]*?)\n\} as const satisfies/)
  if (!block) throw new Error('解析不出 Taro 的 ICONS 对象（写法变了？）')
  return [...block[1].matchAll(/^ {2}([A-Za-z_$][\w$]*):\s*\{/gm)].map((m) => m[1])
}

/** Flutter：`static const String book = 'book';` 的 [常量名, 字面量]。 */
function parseFlutterConsts(src) {
  return [...src.matchAll(/static const String (\w+) = '([^']*)';/g)].map((m) => [m[1], m[2]])
}

/** Flutter：`appIcons` 映射表的键（`IconNames.book: Icons.menu_book_rounded,`）。 */
function parseFlutterMapKeys(src) {
  const block = src.match(/const Map<String, IconData> appIcons = <String, IconData>\{([\s\S]*?)\n\};/)
  if (!block) throw new Error('解析不出 Flutter 的 appIcons 映射表')
  return [...block[1].matchAll(/^ {2}IconNames\.(\w+):/gm)].map((m) => m[1])
}

/** 后端：`export const ICON_NAMES = [ 'book', ... ] as const`。 */
function parseBackendNames(src) {
  const block = src.match(/export const ICON_NAMES = \[([\s\S]*?)\] as const/)
  if (!block) throw new Error('解析不出后端的 ICON_NAMES')
  return [...stripComments(block[1]).matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** Flutter 选择器：`IconOption(IconNames.book, ...)` 的顺序清单。 */
function parseFlutterPicker(src) {
  return [...src.matchAll(/IconOption\(IconNames\.(\w+),/g)].map((m) => m[1])
}

/** Taro 选择器：`ruleIconOptions` 里 `{ icon: 'book', color: ... }` 的顺序清单。 */
function parseTaroPicker(src) {
  const block = src.match(/export const ruleIconOptions: IconOption\[\] = \[([\s\S]*?)\n\]/)
  if (!block) throw new Error('解析不出 Taro 的 ruleIconOptions（写法变了？）')
  return [...block[1].matchAll(/icon:\s*'(\w+)'/g)].map((m) => m[1])
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const dups = (list) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))]
const missing = (from, inList) => from.filter((x) => !inList.includes(x))
const extra = (base, inList) => inList.filter((x) => !base.includes(x))
const listText = (list) => (list.length === 0 ? '（无）' : list.join(', '))
const countOf = (src, re) => (src.match(re) || []).length

/** 递归收 .dart 文件（扫不到任何文件说明目录指错了 → 抛错，不静默通过）。 */
function dartFilesUnder(rel) {
  const root = abs(rel)
  if (!existsSync(root)) throw new Error(`目录不存在：${rel}`)
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.dart')) out.push(p)
    }
  }
  walk(root)
  if (out.length === 0) throw new Error(`${rel} 下一个 .dart 文件都没有（扫错目录了？）`)
  return out
}

// ── 取源 + 解析（fail-closed：读不到 / 解析不出 = 直接红，不静默跳过）─────────────
let SRC
let PARSED
try {
  SRC = {
    taro: readRel(PATHS.taro),
    taroRender: readRel(PATHS.taroRender),
    taroPicker: readRel(PATHS.taroPicker),
    taroStore: readRel(PATHS.taroStore),
    flutter: readRel(PATHS.flutter),
    flutterStore: readRel(PATHS.flutterStore),
    flutterPicker: readRel(PATHS.flutterPicker),
    flutterRuleTile: readRel(PATHS.flutterRuleTile),
    flutterRecordTile: readRel(PATHS.flutterRecordTile),
    backend: readRel(PATHS.backend),
  }
  PARSED = {
    taroKeys: parseTaroKeys(SRC.taro),
    flutterConsts: parseFlutterConsts(SRC.flutter),
    flutterMapKeys: parseFlutterMapKeys(SRC.flutter),
    backendNames: parseBackendNames(SRC.backend),
    flutterPickerNames: parseFlutterPicker(SRC.flutterPicker),
    taroPickerNames: parseTaroPicker(SRC.taroPicker),
  }
  const empty = Object.entries(PARSED).filter(([, v]) => v.length === 0).map(([k]) => k)
  if (empty.length > 0) throw new Error(`这些名单解析为空：${empty.join(', ')} —— 解析器失效（比漏检更危险）`)
} catch (err) {
  console.log('FAIL  准备阶段（取源 / 解析）')
  console.log(`        - ${err.message}`)
  console.log('\nFAILED 1 项  （取源或解析失败：宁可红，不静默通过）')
  process.exit(1)
}

const { taroKeys, flutterConsts, flutterMapKeys, backendNames, flutterPickerNames, taroPickerNames } = PARSED
const flutterNames = flutterConsts.map(([name]) => name)
const asCode = (text) => stripComments(text)

// ── 断言运行器 ────────────────────────────────────────────────────────────
let passed = 0
let failed = 0

function run(label, fn) {
  let result = {}
  try {
    result = fn() ?? {}
  } catch (err) {
    result = { problems: [`抛错：${err.message}`] }
  }
  const problems = result.problems ?? []
  if (problems.length === 0) {
    passed += 1
    console.log(`PASS  ${label}`)
    if (result.note) console.log(`        · ${result.note}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}`)
    for (const p of problems) console.log(`        - ${p}`)
  }
}


console.log(`图标名跨端契约对账：\n  Taro   ${PATHS.taro}\n  Flutter ${PATHS.flutter}\n  后端   ${PATHS.backend}\n`)

// ① ────────────────────────────────────────────────────────────────────────
run('① 三份名单集合相等且各自无重复', () => {
  const problems = []
  for (const [label, list] of [
    ['Taro icons.ts', taroKeys],
    ['Flutter app_icons.dart', flutterNames],
    ['后端 templates.data.ts', backendNames],
  ]) {
    const d = dups(list)
    if (d.length > 0) problems.push(`${label} 有重复项：${listText(d)}（重复时「相等」本身就不可信）`)
  }
  if (taroKeys.length === 0 || flutterNames.length === 0 || backendNames.length === 0) {
    problems.push('有名单为空 —— 空集合永远「相等」，不能算通过')
  }
  const missingInFlutter = missing(taroKeys, flutterNames)
  const extraInFlutter = extra(taroKeys, flutterNames)
  if (missingInFlutter.length > 0 || extraInFlutter.length > 0) {
    problems.push(`Flutter 与 Taro 不一致 —— 缺：${listText(missingInFlutter)}／多：${listText(extraInFlutter)}`)
  }
  const missingInBackend = missing(taroKeys, backendNames)
  const extraInBackend = extra(taroKeys, backendNames)
  if (missingInBackend.length > 0 || extraInBackend.length > 0) {
    problems.push(`后端与 Taro 不一致 —— 缺：${listText(missingInBackend)}／多：${listText(extraInBackend)}`)
  }
  return { problems, note: `三份各 ${taroKeys.length} 个名字` }
})

// ② ────────────────────────────────────────────────────────────────────────
run('② Flutter：常量名 = 字面量，且映射表键集合 = 常量集合', () => {
  const problems = []
  const mismatched = flutterConsts.filter(([name, literal]) => name !== literal)
  if (mismatched.length > 0) {
    problems.push(
      `常量名与字面量不一致：${mismatched.map(([n, l]) => `${n} = '${l}'`).join('、')} —— 两处真相会各走各的`
    )
  }
  const missingInMap = missing(flutterNames, flutterMapKeys)
  const extraInMap = extra(flutterNames, flutterMapKeys)
  if (missingInMap.length > 0 || extraInMap.length > 0) {
    problems.push(`appIcons 与 IconNames 对不上 —— 缺：${listText(missingInMap)}／多：${listText(extraInMap)}`)
  }
  return { problems, note: `常量 ${flutterNames.length} 个／映射表 ${flutterMapKeys.length} 项` }
})

// ③ ────────────────────────────────────────────────────────────────────────
run('③ 数据层不得存字形（IconData / Icons. / 图标名字面量）', () => {
  const problems = []
  const files = [
    ...dartFilesUnder(join(PATHS.libRoot, 'models')),
    ...dartFilesUnder(join(PATHS.libRoot, 'data')),
  ]
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
    const code = asCode(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    if (/\bIconData\b/.test(code)) problems.push(`${rel} 出现 IconData —— 数据层只能存图标名字（与后端 String 同构）`)
    if (/\bIcons\./.test(code)) problems.push(`${rel} 出现 Icons. —— 字形属于渲染层，不属于数据层`)
    if (/\biconDataFor\(|\bgetIcon\(/.test(code)) problems.push(`${rel} 自己解析字形 —— 查表只允许发生在渲染层`)
    for (const name of taroKeys) {
      if (new RegExp(`'${name}'`).test(code)) {
        problems.push(`${rel} 出现图标名字面量 '${name}' —— 必须经 IconNames（Dart 没有字面量联合类型，只能靠这条）`)
      }
    }
  }
  return { problems, note: `扫了 ${files.length} 个数据层文件` }
})


// ④ ────────────────────────────────────────────────────────────────────────
run('④ 渲染调用不得写死图标名（iconDataFor(  /  getIcon( 不许带字面量）', () => {
  const problems = []
  const files = dartFilesUnder(PATHS.libRoot)
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/')
    const code = asCode(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
    if (/(iconDataFor|getIcon)\(\s*'/.test(code)) {
      problems.push(`${rel} 把图标名写死在调用处 —— 应经 IconNames / ruleIconOptions，写死就等于绕过映射表`)
    }
  }
  for (const rel of [PATHS.taroRender, PATHS.taroPicker]) {
    if (/getIcon\(\s*'/.test(asCode(readRel(rel)))) {
      problems.push(`${rel} 把图标名写死在调用处 —— 同上`)
    }
  }
  return { problems, note: `扫了 ${files.length} 个 .dart + 2 个 .tsx` }
})

// ⑤ ────────────────────────────────────────────────────────────────────────
run('⑤ 渲染点必须在位且各只一处', () => {
  const problems = []
  const sites = [
    [PATHS.flutterRuleTile, asCode(SRC.flutterRuleTile), '规则卡片'],
    [PATHS.flutterRecordTile, asCode(SRC.flutterRecordTile), '流水卡片'],
    [PATHS.flutterPicker, asCode(SRC.flutterPicker), '图标选择器'],
  ]
  for (const [rel, code, what] of sites) {
    const n = countOf(code, /iconDataFor\(/g)
    if (n !== 1) {
      problems.push(`${rel} 通映射表 ${n} 次（应为 1）—— ${what}必须经 iconDataFor 画图标（回退成硬编码字形即红）`)
    }
  }
  const taroRender = asCode(SRC.taroRender)
  const n = countOf(taroRender, /getIcon\(/g)
  if (n !== 1) problems.push(`${PATHS.taroRender} 调 getIcon( ${n} 次（应为 1）—— 图标渲染只该有这一处出口`)
  if (/\bICONS\[/.test(taroRender)) {
    problems.push(`${PATHS.taroRender} 直接读 ICONS[ —— 绕过 getIcon 就没有兜底，未登记的名字会画成空白`)
  }
  return { problems, note: 'Flutter 三处卡片/选择器 + Taro 单一出口' }
})

// ⑥ ────────────────────────────────────────────────────────────────────────
run('⑥ 两端图标选择器清单同名同序', () => {
  const problems = []
  if (flutterPickerNames.join(',') !== taroPickerNames.join(',')) {
    problems.push(
      `Flutter [${listText(flutterPickerNames)}] ≠ Taro [${listText(taroPickerNames)}] —— 同一张表单不该长两个样`
    )
  }
  return { problems, note: `共 ${flutterPickerNames.length} 枚：${listText(flutterPickerNames)}` }
})

// ⑦ ────────────────────────────────────────────────────────────────────────
run('⑦ 逃生口在位且被接上（渲染兜底 + 写入口白名单）', () => {
  const problems = []
  const flutter = asCode(SRC.flutter)
  if (!/IconData get fallbackIcon => appIcons\[IconNames\.unknown\]!;/.test(flutter)) {
    problems.push('Flutter 的 fallbackIcon 不是从 appIcons[IconNames.unknown] 派生的 —— 兜底成了第二份真相')
  }
  if (!/bool isKnownIconName\(String name\) => appIcons\.containsKey\(name\);/.test(flutter)) {
    problems.push('Flutter 缺少 isKnownIconName 的白名单判定（写入口就没得校验）')
  }
  if (!/isKnownIconName\(iconName\)/.test(asCode(SRC.flutterStore))) {
    problems.push(`${PATHS.flutterStore} 没有调用 isKnownIconName —— AppStore.addRule 的写入口不设防`)
  }

  const taro = asCode(SRC.taro)
  const fallback = taro.match(/export const FALLBACK_ICON_NAME: IconName = '(\w+)'/)
  if (!fallback) problems.push('Taro 缺少 FALLBACK_ICON_NAME 常量')
  else if (!taroKeys.includes(fallback[1])) {
    problems.push(`Taro 的 FALLBACK_ICON_NAME = '${fallback[1]}' 不在白名单里 —— 兜底自己就是未登记的名字`)
  }
  if (!/return defs\[name\] \?\? ICONS\[FALLBACK_ICON_NAME\]/.test(taro)) {
    problems.push('Taro 的 getIcon 没有兜底分支（未登记的名字会画成空白，而不是“未知”占位）')
  }
  if (!/Object\.prototype\.hasOwnProperty\.call\(ICONS, name\)/.test(taro)) {
    problems.push('Taro 的 isKnownIconName 不再是白名单查表（判定被改）')
  }
  if (!/isKnownIconName\(icon\)/.test(asCode(SRC.taroStore))) {
    problems.push(`${PATHS.taroStore} 没有调用 isKnownIconName —— store.addRule 的写入口不设防`)
  }
  return { problems }
})

// ── 汇总 ──────────────────────────────────────────────────────────────────
const total = passed + failed
console.log(
  `\n${failed === 0 ? 'ALL PASS' : `FAILED ${failed} 项`}  （共 ${total} 项检查${
    failed === 0 ? '，三份名单逐字相等、逃生口全部接上' : ''
  }）`
)
process.exitCode = failed === 0 ? 0 : 1


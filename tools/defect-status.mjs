#!/usr/bin/env node
/**
 * defect-status.mjs —— 缺陷台账一致性守门人（阶段 A5）
 *
 * 存在理由：`03` §0 的状态列**曾经长期失实** —— 18 条里有 **8 条其实早已修好**却仍标「待修」，
 * 而 E18 是真实生产缺陷、D13 只做到 9/10 也没写出来。照那份表排计划，等于把错误前提当事实。
 * 它和 **D12** 是同一类失败：**文档说 A、代码是 B，而没有人对账。**
 *
 * 本工具只做一件事：**把 `03` §0 里每一条状态声明，逐条拿到代码里验证。**
 *   - 声明「已修」，但代码里找不到修复痕迹   → 红（声明是假的，或修复被回退）
 *   - 声明「未修」，但代码里缺陷已经消失     → 红（台账过期 —— 正是当初那 8 条的病）
 *   - 声明「半修」，则守卫与残留必须**同时**存在，否则红
 *   - 证据**只取代码**：注释被剥掉（见 `stripComments`）。仓库里每条已修缺陷都带一段
 *     「原先 `xxx` 如何错」的注释，把注释算成证据会让两侧同时被骗 —— 本工具首跑即踩 2 次（A1/A5）。
 *
 * fail-closed：台账解析不出某条、目标文件缺失、正则未命中、台账新增了条目却没有验证器
 * —— 一律红，绝不静默跳过。
 *
 * 自测（一个永远通过的检查等于没有检查，见 D13）：
 *   DEFECT_DOC_PATH=<被篡改的台账副本> node tools/defect-status.mjs   → 必须红
 *
 * 用法：
 *   node tools/defect-status.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const MP = 'kids_points_mp/src/data'
const FL = 'lib'
const T_STORE = `${MP}/store.ts`
const T_TYPES = `${MP}/types.ts`
const F_STORE = `${FL}/data/app_store.dart`
const F_HABIT = `${FL}/models/habit.dart`
const F_RECORD = `${FL}/models/point_record.dart`
const T_RUNNER = 'kids_points_mp/.tmp_test/run.js'
const T_SEED = `${MP}/seed.ts`
const T_HOME = 'kids_points_mp/src/pages/home/index.tsx'
const T_RULE_SHEET = 'kids_points_mp/src/sheets/AddRuleSheet.tsx'
const F_TESTS = 'test/app_test.dart'
const F_RULE = `${FL}/models/point_rule.dart`
const F_SEED = `${FL}/data/seed_data.dart`
const F_HOME = `${FL}/screens/home_screen.dart`
const F_RULE_SHEET = `${FL}/screens/sheets/add_rule_sheet.dart`
const T_CARD = 'kids_points_mp/src/components/WishCard/index.tsx'
const F_WISH = `${FL}/models/wish.dart`
const F_CARD = `${FL}/widgets/wish_card.dart`
const D12_FIXTURE = 'backend/scripts/__fixtures__/d12-misnested-runner.js'

const DOC = process.env.DEFECT_DOC_PATH
  ? resolve(process.env.DEFECT_DOC_PATH)
  : resolve(ROOT, 'docs/design/03-existing-defects.md')

const LABEL = {
  fixed: '✅ 已修',
  partial: '⚠️ 半修',
  'd13-partial': '⚠️ 已改 9/10',
  unfixed: '❌ 未修',
}

// ── 只读助手（任何读不到的文件都抛错 → 上层记为失败，不静默跳过）────────────
function read(rel) {
  const abs = resolve(ROOT, rel)
  if (!existsSync(abs)) throw new Error(`文件不存在：${rel}`)
  return readFileSync(abs, 'utf8')
}
/**
 * 只保留「代码」——**注释里的旧代码片段与「修 X：原先 …」说明都不算证据**。
 * 这不是洁癖：仓库里每条已修缺陷都带一段「原先 `xxx` 如何错」的注释，
 * 若把注释算进证据，两侧会同时被骗 ——
 *   注释里留着旧代码 → 「已修」被误报成「回退」（本工具首跑就踩了 2 次：A1 / A5）；
 *   注释里写着新符号 → 「未修」被误报成「已修」。
 * 剥注释时保留换行，行号不漂移；`://` 视为 URL 而非注释起点。
 */
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

/** 读源码并剥掉注释。 */
const readCode = (rel) => stripComments(read(rel))
/** 命中次数（只数代码）。 */
const count = (rel, re) => (readCode(rel).match(re) || []).length

// ── 断言构造器 ────────────────────────────────────────────────────────────
const A = {
  has: (file, re, msg) => ({ op: 'has', file, re, msg }),
  lack: (file, re, msg) => ({ op: 'lack', file, re, msg }),
  countIs: (file, re, n, msg) => ({ op: 'countIs', file, re, n, msg }),
  derivedAll: (file, total, subset, msg) => ({ op: 'derivedAll', file, total, subset, msg }),
}

/** 逐条求值；返回失败原因数组（空数组 = 与台账声明一致）。 */
function evalAssertions(assertions) {
  const problems = []
  for (const a of assertions) {
    if (a.op === 'has' && !a.re.test(readCode(a.file))) problems.push(`${a.file} 未命中 /${a.re.source}/ —— ${a.msg}`)
    if (a.op === 'lack' && a.re.test(readCode(a.file))) problems.push(`${a.file} 命中 /${a.re.source}/ —— ${a.msg}`)
    if (a.op === 'countIs') {
      const n = count(a.file, a.re)
      if (n !== a.n) problems.push(`${a.file} 命中 ${n} 次（应为 ${a.n}）—— ${a.msg}`)
    }
    if (a.op === 'derivedAll') {
      const total = count(a.file, a.total)
      const subset = count(a.file, a.subset)
      if (total === 0 || total !== subset) problems.push(`${a.file} 派生率 ${subset}/${total} —— ${a.msg}`)
    }
  }
  return problems
}

/** D12 专用：花括号必须平衡，且退出码/汇总必须位于顶层（回退即红）。 */
function checkD12() {
  const problems = []
  if (!existsSync(resolve(ROOT, D12_FIXTURE))) problems.push(`缺少反向对照夹具 ${D12_FIXTURE}`)
  const lines = readCode(T_RUNNER).split(/\r?\n/)
  let depth = 0
  lines.forEach((line, i) => {
    if (/process\.exitCode\s*=|ALL PASS|ANY FAIL/.test(line) && depth !== 0) {
      problems.push(`${T_RUNNER} 第 ${i + 1} 行嵌套在深度 ${depth} —— D12 回退`)
    }
    const code = line.replace(/\/\/.*$/, '')
    for (const ch of code) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
  })
  if (depth !== 0) problems.push(`${T_RUNNER} 花括号不平衡（末态深度 ${depth}）`)
  return problems
}

// ── 18 条缺陷的代码验证器（与 `03` §0 表一一对应）──────────────────────────
const DEFECTS = [
  { id: 'A1', status: 'fixed', what: '负分规则被 Math.abs() 抹平', assertions: () => [
    A.has(T_STORE, /rule\.points < 0/, '缺少「负分规则 → 拒绝」判定'),
    A.has(T_STORE, /不能加入今天的习惯/, '缺少拒绝文案'),
    A.lack(T_STORE, /points:\s*Math\.abs\(/, '又在 Math.abs() 抹平负分（回退）'),
    A.has(F_STORE, /rule\.points < 0/, '缺少「负分规则 → 拒绝」判定'),
    A.lack(F_STORE, /points:\s*rule\.points\.abs\(\)/, '又在 .abs() 抹平负分（回退）'),
  ] },
  { id: 'A2', status: 'fixed', what: 'Habit 曾无每日上限字段（频次是自由文本）', assertions: () => [
    A.has(T_TYPES, /dailyLimit: number/, '缺少每日上限结构字段'),
    A.has(F_HABIT, /final int dailyLimit;/, '缺少每日上限结构字段'),
    A.has(T_TYPES, /export function limitTextOf\(/, '频次未降级为派生函数'),
    A.has(F_HABIT, /String limitTextOf\(int dailyLimit\)/, '频次未降级为派生函数'),
    A.lack(T_SEED, /limitText:/, 'seed 仍在手写频次展示串（回退）'),
    A.lack(F_SEED, /limitText:/, 'seed 仍在手写频次展示串（回退）'),
    A.has(T_STORE, /isDailyLimitValid\(dailyLimit\)/, '新增规则未校验频次边界'),
    A.has(F_STORE, /isDailyLimitValid\(dailyLimit\)/, '新增规则未校验频次边界'),
    A.has(T_RUNNER, /真的可以打卡 2 次/, 'run.js 缺少「承诺几次就能打几次」回归用例'),
    A.has(F_TESTS, /真的可以打卡 2 次，第 3 次才被拦/, 'app_test.dart 缺少「承诺几次就能打几次」回归用例'),
    A.has(F_TESTS, /频次越界被拒绝/, 'app_test.dart 缺少频次边界回归用例'),
  ] },
  { id: 'A3', status: 'fixed', what: 'checked: boolean 与「每天最多 N 次」矛盾', assertions: () => [
    A.has(T_TYPES, /export function checkedCountToday\(/, '缺少「当天完成次数」派生函数'),
    A.has(F_HABIT, /int checkedCountToday\(/, '缺少「当天完成次数」派生函数'),
    A.has(T_STORE, /checkedCountToday\(this\.records, live\.id\)/, '打卡上限判定未改走当天流水'),
    A.has(F_STORE, /checkedCountToday\(records, live\.id\)/, '打卡上限判定未改走当天流水'),
    A.has(F_HABIT, /bool get checked =>/, 'Dart 侧 checked 未降级为派生 getter'),
    // 反回退：checked 已不是可写字段，谁再写它就是把这个缺陷种回去
    A.countIs(T_STORE, /\.checked\s*=/g, 0, '仍在写 checked 字段（回退）'),
    A.countIs(F_STORE, /\.checked\s*=/g, 0, '仍在写 checked 字段（回退）'),
    A.countIs(F_HABIT, /\.checked\s*=/g, 0, '仍在写 checked 字段（回退）'),
    // `03` §A3 公式的漏洞：只排除 correction 不够，**已被冲正的原记录**也必须排除，
    // 否则撤销打卡后界面仍显示「已打卡」（撤销看起来没生效）
    A.has(T_TYPES, /reversedIds\.has\(record\.id\)/, '未排除已被冲正的原记录（撤销后仍会算作已完成）'),
    A.has(F_HABIT, /reversedIds\.contains\(record\.id\)/, '未排除已被冲正的原记录（撤销后仍会算作已完成）'),
    A.has(T_RUNNER, /被冲正的原记录不再计入/, 'run.js 缺少「冲正排除」回归用例'),
    A.has(F_TESTS, /被冲正的原记录不再计入/, 'app_test.dart 缺少「冲正排除」回归用例'),
  ] },
  { id: 'A4', status: 'fixed', what: '流水硬编码「家长记录」，无操作人', assertions: () => [
    A.derivedAll(T_STORE, /subtitle:/g, /subtitle:\s*recordSubtitle\(/g, '存在非 recordSubtitle() 派生的 subtitle'),
    A.derivedAll(F_STORE, /subtitle:/g, /subtitle:\s*recordSubtitle\(/g, '存在非 recordSubtitle() 派生的 subtitle'),
    A.has(T_STORE, /operatorRole: actor\.role/, '缺少 operatorRole'),
    A.has(F_STORE, /operatorRole: actor\.role/, '缺少 operatorRole'),
  ] },
  { id: 'A5', status: 'fixed', what: 'addQuickNote 错误递增 rewardCount', assertions: () => [
    A.countIs(T_STORE, /profile\.rewardCount \+= 1/g, 1, 'rewardCount 只能由 redeem 递增'),
    A.countIs(F_STORE, /profile\.rewardCount \+= 1/g, 1, 'rewardCount 只能由 redeem 递增'),
  ] },
  { id: 'B6', status: 'fixed', what: '扣分静默截断，账本不平', assertions: () => [
    A.has(T_STORE, /积分不足，当前只有/, '缺少「积分不足 → 拒绝」文案'),
    A.lack(T_STORE, /Math\.max\(0,/, '又出现 Math.max(0, ...) 截断写法（回退）'),
    A.has(F_STORE, /积分不足，当前只有/, '缺少「积分不足 → 拒绝」文案'),
  ] },
  { id: 'B7', status: 'fixed', what: 'undoCheckIn 物理删除流水', assertions: () => [
    A.has(T_STORE, /reversesRecordId: target\.id/, '未写入冲正记录'),
    A.has(F_STORE, /reversesRecordId: target\.id/, '未写入冲正记录'),
  ] },
  { id: 'B8', status: 'fixed', what: '兑换标题被 shortTitle 永久截断', assertions: () => [
    A.has(T_STORE, /title: `兑换：\$\{wish\.title\}`/, '兑换标题不是完整快照'),
    A.has(F_STORE, /title: '兑换：\$\{wish\.title\}'/, '兑换标题不是完整快照'),
  ] },
  { id: 'C9', status: 'unfixed', what: '全部物理删除，无软删除/回收站', assertions: () => [
    A.lack(T_STORE, /deletedAt|softDelete/, '已出现软删除痕迹 → 缺陷可能已修，台账应更新'),
    A.lack(F_STORE, /deletedAt|softDelete/, '已出现软删除痕迹'),
  ] },
  { id: 'C10', status: 'unfixed', what: '规则无法编辑（无 updateRule）', assertions: () => [
    A.lack(T_STORE, /updateRule/, '已出现 updateRule → 缺陷可能已修，台账应更新'),
    A.lack(F_STORE, /updateRule/, '已出现 updateRule'),
  ] },
  { id: 'C11', status: 'unfixed', what: '无 AuditLog，变更不可追溯', assertions: () => [
    A.lack(T_STORE, /auditLog|AuditLog/, '已出现审计痕迹 → 缺陷可能已修，台账应更新'),
    A.lack(T_TYPES, /auditLog|AuditLog/, '已出现审计痕迹'),
    A.lack(F_STORE, /auditLog|AuditLog/, '已出现审计痕迹'),
  ] },
  { id: 'D12', status: 'fixed', what: '测试器花括号嵌套错位 → CI 假通过', custom: checkD12 },
  { id: 'D13', status: 'fixed', what: '测试断言把缺陷固化为「正确行为」', assertions: () => [
    A.has(T_RUNNER, /手动加分不应增加奖励次数/, 'run.js 缺少改写后的 A5 断言'),
    A.has(F_TESTS, /被拒绝时余额不变/, 'app_test.dart 缺少改写后的 B6 断言'),
    // 第 10 条（`首启 124 分 / 324 好习惯`）已随 E18 改写为「首启空态 + seed 是显式夹具」
    A.has(T_RUNNER, /E18 首启必须为空态：不预置任何演示数据/, 'run.js 第 10 条断言未改写为「首启空态」'),
    A.has(F_TESTS, /首启为空态：不预置任何演示数据/, 'app_test.dart 第 10 条断言未改写为「首启空态」'),
    // 演示数据必须降级为**显式夹具**：靠构造函数偷偷种数据，就是 E18 本身
    A.has(T_RUNNER, /function seededStore\(\)/, 'run.js 的演示数据未降级为显式夹具'),
    A.has(F_TESTS, /AppStore seededStore\(\)/, 'app_test.dart 的演示数据未降级为显式夹具'),
    // 反回退：不得再出现「直接构造出来的 store + 断言首启 124 分」这种固化写法
    A.lack(
      F_TESTS,
      /AppStore\(\)(?:(?!resetToSeed)[\s\S]){0,200}?expect\(store\.points, 124\)/,
      '又出现「首启即 124 分」的固化断言（回退）'
    ),
  ] },
  { id: 'E15', status: 'fixed', what: '规则 detail 自由串靠 split 反解析', assertions: () => [
    A.has(T_TYPES, /export function ruleDetail\(/, '缺少由结构字段拼出的 ruleDetail()'),
    A.has(F_RULE, /String ruleDetail\(PointRule rule\)/, '缺少由结构字段拼出的 ruleDetail()'),
    A.lack(T_TYPES, /^\s*detail: string/m, '仍存在可写的 detail 自由字段（回退）'),
    A.lack(F_RULE, /final String detail;/, '仍存在可写的 detail 自由字段（回退）'),
    A.lack(T_STORE, /\.split\(' · '\)/, '又在靠 split 反解析展示串（回退）'),
    A.lack(F_STORE, /\.split\(' · '\)/, '又在靠 split 反解析展示串（回退）'),
    A.has(T_STORE, /condition: rule\.condition/, '规则→习惯未直取结构字段（条件）'),
    A.has(T_STORE, /dailyLimit: rule\.dailyLimit/, '规则→习惯未直取结构字段（频次）'),
    A.has(F_STORE, /condition: rule\.condition/, '规则→习惯未直取结构字段（条件）'),
    A.has(F_STORE, /dailyLimit: rule\.dailyLimit/, '规则→习惯未直取结构字段（频次）'),
    A.has(T_RULE_SHEET, /store\.addRule\(\s*trimmed,\s*condition,\s*dailyLimit,/, '新增规则表单未收集结构字段'),
    A.has(F_RULE_SHEET, /condition: conditionController\.text,/, '新增规则表单未收集结构字段'),
    A.has(T_RUNNER, /展示串一律由结构字段派生/, 'run.js 缺少 E15 回归用例'),
    A.has(F_TESTS, /结构字段是唯一真相/, 'app_test.dart 缺少 E15 回归用例'),
  ] },
  { id: 'E16', status: 'fixed', what: '心愿配色用数组下标（背景色会随删除漂移）', assertions: () => [
    // ① 结构：配色成为**受控枚举**（与后端 enum WishCoverStyle 对齐），不再是任意整数
    A.has(T_TYPES, /export type WishCoverStyle = 'A' \| 'B' \| 'C' \| 'D'/, '缺少稳定枚举类型'),
    A.has(F_WISH, /enum WishCoverStyle \{ a, b, c, d \}/, '缺少稳定枚举类型'),
    A.countIs(T_TYPES, /wishCoverStyles: WishCoverStyle\[\] = \['A', 'B', 'C', 'D'\]/g, 1, '枚举取值表缺失或重复'),
    A.has(T_STORE, /coverStyle: pickCoverStyle\(/, '新增心愿未走 pickCoverStyle()'),
    A.has(F_STORE, /coverStyle: pickCoverStyle\(/, '新增心愿未走 pickCoverStyle()'),
    // ② 反回退：任何写入点都不许再出现「下标配色」
    A.lack(T_TYPES, /backgroundIndex: number/, 'Wish 模型又出现 backgroundIndex（回退）'),
    A.lack(F_WISH, /backgroundIndex:/, 'Wish 模型又出现 backgroundIndex 字段（回退）'),
    A.countIs(T_STORE, /wishes\.length % 4/g, 0, '又在用列表长度算配色（回退）'),
    A.countIs(F_STORE, /wishes\.length % 4/g, 0, '又在用列表长度算配色（回退）'),
    A.countIs(T_SEED, /backgroundIndex/g, 0, 'seed 又在下标配色（回退）'),
    A.countIs(F_SEED, /backgroundIndex/g, 0, 'seed 又在下标配色（回退）'),
    // ③ 取色按枚举，且**编译期穷尽**（Taro 用 Record，Flutter 用 switch 表达式）
    A.has(T_CARD, /Record<WishCoverStyle, \[string, string\]>/, '插画配色表未按键穷尽（Taro）'),
    A.has(F_CARD, /List<Color> wishGradientOf\(WishCoverStyle style\) => switch \(style\)/, '插画配色表未按键穷尽（Flutter）'),
    A.lack(T_CARD, /\[wish\.backgroundIndex/, '取色又走数组下标（回退）'),
    A.lack(F_CARD, /wishGradients\[/, '取色又走数组下标（回退）'),
    // ④ 回归用例：删项不漂移 / 有空档先补空档 / 跨端同源哈希被钉死
    A.has(T_RUNNER, /E16：心愿配色是稳定枚举/, 'run.js 缺少 E16 回归用例'),
    A.has(T_RUNNER, /wishCoverHash\('wish-9'\), 355514/, 'run.js 缺少「哈希算式被钉死」断言'),
    A.has(F_TESTS, /心愿配色稳定枚举（修 E16）/, 'app_test.dart 缺少 E16 回归用例'),
    A.has(F_TESTS, /wishCoverHash\('wish-9'\), 355514/, 'app_test.dart 缺少「跨端同源哈希」断言'),
  ] },
  { id: 'E17', status: 'fixed', what: 'doneText / limitText 曾被外部写入（已降级为派生值）', assertions: () => [
    A.has(T_TYPES, /export function doneTextOf\(/, '缺少 doneTextOf() 派生函数'),
    A.has(F_HABIT, /String doneTextOf\(/, '缺少 doneTextOf() 派生函数'),
    A.has(T_TYPES, /export function habitView\(/, '缺少 habitView() 派生视图'),
    A.has(F_HABIT, /HabitView habitView\(/, '缺少 habitView() 派生视图'),
    A.lack(F_HABIT, /final String limitText;/, 'limitText 仍是可写字段（回退）'),
    A.lack(F_HABIT, /final String doneText;/, 'doneText 仍是可写字段（回退）'),
    A.lack(T_SEED, /doneText:/, 'seed 仍在手写完成串（回退）'),
    A.lack(F_SEED, /doneText:/, 'seed 仍在手写完成串（回退）'),
    // 页面只消费派生视图：拿不到可写展示串，想改文案只能改派生函数（一处改、两端同步）
    A.has(T_HOME, /store\.habitViews\(\)/, '首页未消费派生视图'),
    A.has(F_HOME, /store\.habitViews/, '首页未消费派生视图'),
    A.has(T_RUNNER, /展示串一律由结构字段派生/, 'run.js 缺少 E17 回归用例'),
    A.has(F_TESTS, /展示串一律派生/, 'app_test.dart 缺少 E17 回归用例'),
  ] },
  { id: 'E18', status: 'fixed', what: 'resetToSeed 生产可达 + 首启即假数据', assertions: () => [
    // ① 生产闸门：编译期常量（可 DCE）+ 可测判据（两侧必须同源，漂移即红）
    A.has(T_STORE, /export function demoResetAllowed\(/, '缺少可测的生产判据'),
    A.has(T_STORE, /ALLOW_DEMO_RESET = demoResetAllowed\(\)/, '守卫常量必须由判据派生（否则两处语义会漂移）'),
    A.has(T_STORE, /if \(!ALLOW_DEMO_RESET\) return false/, 'resetToSeed 未被生产闸门拦住'),
    A.has(F_STORE, /bool demoResetAllowed\(\{bool isRelease = _isReleaseBuild\}\)/, '缺少可测的生产判据'),
    A.has(F_STORE, /const bool allowDemoReset = !_isReleaseBuild;/, '守卫常量必须是可常量折叠的 !_isReleaseBuild（与判据同源）'),
    A.has(F_STORE, /if \(!allowDemoReset\) return false;/, 'resetToSeed 未被生产闸门拦住'),
    // ② 首启空态：构造函数只走空态，不再注入 seed（E18 第二半）
    A.has(T_STORE, /constructor\(\) \{\s*this\.resetToEmpty\(\)/, '构造函数未改为空态初始化'),
    A.lack(T_STORE, /constructor\(\)[^}]*buildSeedData\(\)/, '构造函数仍在注入演示数据（回退）'),
    A.has(T_STORE, /resetToEmpty\(\): void \{[\s\S]{0,200}?this\.points = 0/, '空态初始化不完整'),
    A.has(F_STORE, /AppStore\(\) \{\s*_resetToEmpty\(\);/, '构造函数未改为空态初始化'),
    A.lack(F_STORE, /AppStore\(\)[^}]*buildSeedData\(\)/, '构造函数仍在注入演示数据（回退）'),
    A.has(F_STORE, /_resetToEmpty\(\) \{[\s\S]{0,200}?_points = 0;/, '空态初始化不完整'),
    A.has(T_STORE, /resetToSeed\(\): boolean \{[\s\S]{0,120}?this\.applySeed\(\)/, 'seed 不是唯一显式入口'),
    // ③ 回归用例：两套测试都必须有「能失败」的首启空态 / 生产不可达断言
    A.has(T_RUNNER, /E18 首启必须为空态：不预置任何演示数据/, 'run.js 缺少首启空态回归用例'),
    A.has(T_RUNNER, /demoResetAllowed\('production'\), false/, 'run.js 缺少生产判据断言'),
    A.has(T_RUNNER, /prod\.ALLOW_DEMO_RESET, false/, 'run.js 缺少「真实生产模块拒绝」断言'),
    A.has(F_TESTS, /首启为空态：不预置任何演示数据/, 'app_test.dart 缺少首启空态回归用例'),
    A.has(F_TESTS, /demoResetAllowed\(isRelease: true\), isFalse/, 'app_test.dart 缺少 release 判据断言'),
    A.has(F_TESTS, /allowDemoReset, demoResetAllowed\(\)/, '缺少「闸门常量与判据不得漂移」断言'),
  ] },
  { id: 'E19', status: 'fixed', what: '小标题串接方式不统一', assertions: () => [
    A.has(T_TYPES, /export function recordSubtitle/, '缺少 recordSubtitle()'),
    A.has(F_RECORD, /String recordSubtitle\(/, '缺少 recordSubtitle()'),
  ] },
]

// ── 台账解析（fail-closed：读不懂就红，不猜）───────────────────────────────
function parseLedger() {
  const lines = readFileSync(DOC, 'utf8').split(/\r?\n/)
  const claims = new Map()
  let inTable = false
  let idCol = -1
  let statusCol = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!inTable) {
      // 表头决定列号：**按名字定位**，不写死列号 —— 写死列号在列被调换时会静默读错列。
      if (/^\|\s*编号\s*\|/.test(line)) {
        const header = line.split('|').map((c) => c.trim())
        idCol = header.indexOf('编号')
        statusCol = header.findIndex((c) => /状态/.test(c))
        if (idCol < 0) throw new Error('§0 表头里找不到「编号」列 —— fail-closed')
        if (statusCol < 0) throw new Error('§0 表头里找不到「状态」列 —— fail-closed')
        inTable = true
      }
      continue
    }
    if (!line.startsWith('|')) break
    const cells = line.split('|').map((c) => c.trim())
    const id = cells[idCol]
    if (!/^[A-E]\d+$/.test(id)) continue
    const cell = cells[statusCol] || ''
    const status = /9\/10/.test(cell)
      ? 'd13-partial'
      : /半修/.test(cell)
        ? 'partial'
        : /已修/.test(cell)
          ? 'fixed'
          : /未修/.test(cell)
            ? 'unfixed'
            : null
    if (status === null) {
      throw new Error(`第 ${i + 1} 行（${id}）第 ${statusCol} 列状态无法识别：「${cell}」`)
    }
    if (claims.has(id)) throw new Error(`第 ${i + 1} 行出现重复编号 ${id}`)
    claims.set(id, status)
  }
  if (claims.size === 0) throw new Error('找不到 §0 状态表（表头须含「编号」与「状态」列）')
  return claims
}

// ── 主流程（汇总与退出码必须在所有检查之后、顶层结算 —— 见 D12）───────────
let failures = 0
const results = []

function report(id, claimed, ok, notes, what) {
  results.push({ id, ok })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  台账=${claimed ? LABEL[claimed] : '（无此行）'}  ${what}`)
  for (const n of notes) console.log(`        - ${n}`)
}

console.log(`缺陷台账对账：${DOC}\n`)

let claims
let parseError = null
try {
  claims = parseLedger()
} catch (err) {
  parseError = err
}

if (parseError) {
  // 台账结构看不懂 → 立刻红。若在此放行，所有状态声明就都成了不可验证的断言。
  console.error(`FAIL  台账解析失败（fail-closed）：${parseError.message}`)
  process.exit(1)
}

// 1) 逐条比对：台账声明 vs 代码实测
for (const d of DEFECTS) {
  if (!claims.has(d.id)) {
    report(d.id, null, false, [`台账 §0 缺少 ${d.id} —— fail-closed，不跳过`], d.what)
    continue
  }
  const claimed = claims.get(d.id)
  let problems = []
  try {
    problems = d.custom ? d.custom() : evalAssertions(d.assertions())
  } catch (err) {
    problems = [`验证过程抛错：${err.message}`]
  }
  const agree = claimed === d.status
  const notes = []
  if (!agree) notes.push(`台账声明「${LABEL[claimed]}」，代码只符合「${LABEL[d.status]}」`)
  notes.push(...problems.slice(0, 3))
  if (problems.length > 3) notes.push(`…另有 ${problems.length - 3} 条代码证据未列出`)
  report(d.id, claimed, agree && problems.length === 0, notes, d.what)
}

// 2) 台账有、验证器没有的条目也不许放过（防止台账偷偷加行躲过检查）
for (const id of [...claims.keys()]) {
  if (!DEFECTS.some((d) => d.id === id)) {
    report(id, claims.get(id), false, ['本工具没有该编号的验证器 —— fail-closed，请补上'], '（台账新增条目）')
  }
}

console.log(
  `\n${failures === 0 ? 'ALL PASS' : `FAILED ${failures} 项`}  （共对账 ${results.length} 条${failures === 0 ? '，台账声明与代码实测一致' : ''}）`
)
process.exitCode = failures === 0 ? 0 : 1

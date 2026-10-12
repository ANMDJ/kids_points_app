/**
 * 运行时冒烟测试：直接 require tsc 编译后的 data / utils 模块，
 * 校验 dayLabel、clockText、withAlpha 以及 AppStore 的关键行为是否与
 * Flutter lib/data/app_store.dart + lib/data/seed_data.dart 一致。
 */
const assert = require('assert')

/**
 * ⚠️ 纯 Node 无法 require 真实的 @tarojs/taro：
 * @tarojs/runtime 的入口是 dist/runtime.esm.js，里面用到 webpack DefinePlugin 注入的
 * ENABLE_INNER_HTML / ENABLE_SIZE_APIS 等常量（Node 26 支持同步 require ESM），
 * 直接加载会抛 “ReferenceError: ENABLE_INNER_HTML is not defined”。
 * 被测模块只用到 useDidShow 这个 hook，注入一个壳即可（断言逻辑不受影响）。
 */
const taroPath = require.resolve('@tarojs/taro', { paths: [__dirname] })
require.cache[taroPath] = {
  id: taroPath,
  filename: taroPath,
  loaded: true,
  exports: {
    __esModule: true,
    default: {},
    useDidShow: () => undefined,
    useReady: () => undefined
  },
  children: [],
  paths: []
}

const {
  dayLabel,
  clockText,
  recordCategoryLabels,
  isGain,
  recordSubtitle,
  // ── 阶段 C2：结构字段化 + 展示串降级为派生（修 E15 / E17 / A2 / A3）──
  checkedCountToday,
  doneTextOf,
  isDailyLimitValid,
  limitTextOf,
  habitView,
  ruleDetail,
  dailyLimitMin,
  dailyLimitMax
} = require('./dist/data/types.js')
const { buildSeedData } = require('./dist/data/seed.js')
const { AppStore, demoResetAllowed } = require('./dist/data/store.js')
const { withAlpha } = require('./dist/utils/color.js')

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + error.message)
  }
}

/**
 * 演示数据是**测试夹具**（修 E18 / D13 第 10 条）：
 * 应用首启必须是**空态**，seed 只能被**显式载入** —— 测试里也一样。
 * 不写这个 helper，用例就会悄悄依赖「构造函数替我们种数据」，
 * 而那正是 E18 描述的错误行为本身。
 */
function seededStore() {
  const store = new AppStore()
  assert.strictEqual(store.resetToSeed(), true, '调试构建下应可显式载入演示数据夹具')
  return store
}

check('dayLabel: 今天 / 昨天 / 前天 / M 月 d 日', () => {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  const at = (day, hour, minute) => new Date(y, m, day, hour, minute).getTime()
  assert.strictEqual(dayLabel(at(d, 19, 30)), '今天')
  assert.strictEqual(dayLabel(at(d, 0, 5)), '今天')
  assert.strictEqual(dayLabel(at(d, 23, 59)), '今天')
  assert.strictEqual(dayLabel(at(d - 1, 20, 0)), '昨天')
  assert.strictEqual(dayLabel(at(d - 2, 8, 0)), '前天')
  const five = new Date(y, m, d - 5, 9, 0)
  assert.strictEqual(dayLabel(five.getTime()), `${five.getMonth() + 1} 月 ${five.getDate()} 日`)
  const fixed = new Date(2020, 0, 3, 9, 0)
  assert.strictEqual(dayLabel(fixed.getTime()), '1 月 3 日')
})

check('clockText: 补零的 HH:mm', () => {
  assert.strictEqual(clockText(new Date(2020, 0, 1, 9, 5).getTime()), '09:05')
  assert.strictEqual(clockText(new Date(2020, 0, 1, 19, 30).getTime()), '19:30')
})

check('recordCategoryLabels / isGain / withAlpha', () => {
  assert.deepStrictEqual(recordCategoryLabels, { praise: '表扬', exchange: '兑换', adjust: '调整' })
  assert.strictEqual(isGain(0), true)
  assert.strictEqual(isGain(-1), false)
  // Flutter: color.withAlpha(34) -> rgba(127, 191, 85, 0.133)
  assert.strictEqual(withAlpha('#7fbf55', 34 / 255), 'rgba(127, 191, 85, 0.133)')
  assert.strictEqual(withAlpha('#fff', 1), 'rgba(255, 255, 255, 1)')
})

check('seed: 124 积分 / 324 好习惯 / 4 次奖励', () => {
  const seed = buildSeedData()
  assert.strictEqual(seed.points, 124)
  assert.strictEqual(seed.profile.name, '萌新铲屎官的小可爱')
  assert.strictEqual(seed.profile.childId, '38038532')
  assert.strictEqual(seed.profile.goodHabitCount, 324)
  // ↓ 以下断言原先散落在文件尾部（D12：花括号嵌套错位把它们挤出了本检查），现归位。
  assert.strictEqual(seed.profile.rewardCount, 4)
  assert.strictEqual(seed.habits.length, 3)
  assert.strictEqual(seed.wishes.length, 4)
  assert.strictEqual(seed.records.length, 4)
  assert.strictEqual(seed.rules.length, 4)
  // ── 修 A2 / E17：习惯只存**结构字段**，checked / limitText / doneText 一律派生 ──
  //    seed 里再写死「今日已完成 1 次」就是 E17 本身（展示串被外部写入、必然与真实状态脱节）。
  assert.strictEqual(seed.habits[0].dailyLimit, 2, '番茄钟承诺每天 2 次')
  assert.strictEqual(seed.habits[1].dailyLimit, 1)
  assert.strictEqual(seed.habits[2].dailyLimit, 1)
  for (const habit of seed.habits) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(habit, 'checked'),
      false,
      'checked 必须是派生值，不能是被写入的字段（修 A3）'
    )
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(habit, 'limitText'),
      false,
      'limitText 必须是派生值（修 E17）'
    )
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(habit, 'doneText'),
      false,
      'doneText 必须是派生值（修 E17）'
    )
  }
  // 修 A4：subtitle 由结构化字段派生，孩子自助完成的流水**不再谎称“家长记录”**
  assert.strictEqual(seed.records[0].source, 'child_self')
  assert.strictEqual(seed.records[0].subtitle, '19:30 · 自己完成')
  assert.strictEqual(seed.records[0].subtitle, recordSubtitle(seed.records[0]))
  assert.strictEqual(seed.records[2].source, 'guardian')
  assert.strictEqual(seed.records[2].subtitle, '20:00 · 家长记录')
  // 修 B8：完整标题快照
  assert.strictEqual(seed.records[3].title, '兑换：小饼干')
  assert.strictEqual(seed.records[3].wishId, null)
  // ── 修 E15：规则只存 condition + dailyLimit，detail 是派生串 ──
  for (const rule of seed.rules) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(rule, 'detail'),
      false,
      'detail 必须是派生值，不能是自由字符串字段（修 E15）'
    )
  }
  assert.strictEqual(seed.rules[0].condition, '专注 25 分钟')
  assert.strictEqual(ruleDetail(seed.rules[0]), '专注 25 分钟 · 每天最多 2 次')
  assert.strictEqual(dayLabel(seed.records[0].time), '今天')
  assert.strictEqual(dayLabel(seed.records[2].time), '昨天')
})

check('recordsOf / canRedeem / gapOf', () => {
  const store = seededStore()
  assert.strictEqual(store.recordsOf(null).length, 4)
  assert.strictEqual(store.recordsOf('exchange').length, 1)
  assert.strictEqual(store.recordsOf('adjust').length, 0)
  const copy = store.recordsOf(null)
  copy.pop()
  assert.strictEqual(store.recordsOf(null).length, 4, 'recordsOf 应返回副本')
  assert.strictEqual(store.canRedeem(store.wishes[0]), true)
  assert.strictEqual(store.canRedeem(store.wishes[2]), false)
  assert.strictEqual(store.gapOf(store.wishes[2]), 445 - 124)
  assert.strictEqual(store.gapOf(store.wishes[0]), 0)
})

check('checkIn / undoCheckIn', () => {
  const store = seededStore()
  const reading = store.habits[2]
  assert.strictEqual(store.checkIn(reading), null)
  assert.strictEqual(store.points, 126)
  assert.strictEqual(store.profile.goodHabitCount, 325)
  assert.strictEqual(store.records.length, 5)
  assert.strictEqual(store.records[0].title, '自主阅读')
  assert.strictEqual(store.records[0].category, 'praise')
  assert.strictEqual(store.records[0].points, 2)
  assert.ok(store.records[0].subtitle.endsWith('· 家长记录'))
  assert.strictEqual(dayLabel(store.records[0].time), '今天')
  const again = store.checkIn(reading)
  assert.strictEqual(again, '“自主阅读”今天已经完成 1 次啦，明天继续加油～')
  assert.strictEqual(store.points, 126, '重复打卡不应加分')
  assert.strictEqual(store.records.length, 5)
  // 修 B7：撤销**保留**原记录并新增一条冲正记录 → 条数 +1 而非 −1
  assert.strictEqual(store.undoCheckIn(reading), null)
  assert.strictEqual(
    habitView(reading, store.records).checked,
    false,
    '撤销后派生状态必须回到未打卡（checked 不再是可写字段）'
  )
  assert.strictEqual(store.points, 124)
  assert.strictEqual(store.profile.goodHabitCount, 324)
  assert.strictEqual(store.records.length, 6, '撤销打卡应写入冲正记录，原记录保留')
  const correction = store.records[0]
  assert.strictEqual(correction.source, 'correction')
  assert.strictEqual(correction.reversesRecordId, store.records[1].id, '冲正必须指向原记录')
  assert.strictEqual(correction.points, -2, '冲正金额应为原记录的反数')
  assert.ok(correction.subtitle.includes('撤销'), correction.subtitle)
  assert.strictEqual(store.records[1].source, 'guardian', '原记录必须原样保留')

  // 未打卡时撤销：返回可读文案，不改余额、不写流水
  const notCheckedMessage = store.undoCheckIn(reading)
  assert.ok(typeof notCheckedMessage === 'string' && notCheckedMessage.length > 0)
  assert.strictEqual(store.points, 124, '未打卡时撤销不应扣分')
  assert.strictEqual(store.records.length, 6)

  // 修 B7：撤销种子数据里已打卡的习惯 —— 按 habitId（唯一）匹配，且不再删除记录
  const seeded = seededStore()
  assert.strictEqual(seeded.undoCheckIn(seeded.habits[0]), null)
  assert.strictEqual(seeded.points, 123)
  assert.strictEqual(seeded.records.length, 5, '原 4 条 + 1 条冲正')
  assert.strictEqual(
    seeded.records.filter((r) => r.id === 'rec-1').length,
    1,
    '原记录必须保留（不可物理删除）'
  )
})

check('addQuickNote：加分 / 扣分 / 清零 / 文案', () => {
  const store = seededStore()
  assert.strictEqual(store.addQuickNote(5, '', ''), null)
  assert.strictEqual(store.points, 129)
  // 修 A5：rewardCount 语义是“奖励兑换次数”，手动加分**不得**递增
  assert.strictEqual(store.profile.rewardCount, 4, '手动加分不应增加奖励次数')
  assert.strictEqual(store.records[0].title, '额外奖励')
  assert.strictEqual(store.records[0].category, 'adjust')
  assert.strictEqual(store.records[0].icon, 'plus')
  assert.strictEqual(store.records[0].color, '#6fbf4b')
  assert.strictEqual(store.records[0].source, 'guardian')
  assert.strictEqual(store.records[0].balanceAfter, 129, 'balanceAfter 应为记完后的余额')

  assert.strictEqual(store.addQuickNote(-9, ' 粗心 ', ' 因为马虎 '), null)
  assert.strictEqual(store.points, 120)
  assert.strictEqual(store.records[0].title, '粗心')
  // 修 E19：note 作为**附加段**，不再替换掉操作来源
  assert.ok(
    store.records[0].subtitle.endsWith('· 家长记录 · 因为马虎'),
    store.records[0].subtitle
  )
  assert.strictEqual(store.records[0].icon, 'minus')
  assert.strictEqual(store.records[0].color, '#e9834b')
  assert.strictEqual(store.profile.rewardCount, 4, '扣分不应增加奖励次数')

  // delta 为 0：给出可读文案且不写流水
  const zeroMessage = store.addQuickNote(0, '无效', '')
  assert.ok(typeof zeroMessage === 'string' && zeroMessage.length > 0)
  assert.strictEqual(store.records.length, 6, 'delta 为 0 时不应写流水')

  // 修 B6：超额扣分必须被**拒绝**，而不是静默把余额截断为 0（否则账本不平）
  const overDeduct = store.addQuickNote(-9999, '扣光', '')
  assert.ok(typeof overDeduct === 'string' && overDeduct.length > 0, '应返回拒绝原因')
  assert.strictEqual(store.points, 120, '被拒绝时余额不变（禁止静默截断）')
  assert.strictEqual(store.records.length, 6, '被拒绝时不写流水')
  assert.ok(store.records[0].title !== '扣光')

  // 边界：恰好扣光应当允许，且余额为 0
  assert.strictEqual(store.addQuickNote(-120, '全扣', ''), null)
  assert.strictEqual(store.points, 0)
  assert.strictEqual(store.records[0].balanceAfter, 0, '扣光后 balanceAfter 为 0')
  assert.strictEqual(store.records[0].points, -120, '流水金额与实际变动一致（账本平）')
})

check('redeem：兑换成功 / 完整标题快照 / 积分不足', () => {
  const store = seededStore()
  const cheap = store.wishes[0]
  assert.strictEqual(store.redeem(cheap), true)
  assert.strictEqual(store.points, 84)
  assert.strictEqual(cheap.redeemed, true)
  assert.strictEqual(
    store.profile.rewardCount,
    5,
    '兑换是唯一应递增 rewardCount 的路径（修 A5）'
  )
  assert.strictEqual(store.records[0].category, 'exchange')
  assert.strictEqual(store.records[0].points, -40)
  // 修 A4 / E19：subtitle 由结构化字段派生（含时间），且与派生函数一致
  assert.strictEqual(store.records[0].subtitle, recordSubtitle(store.records[0]))
  assert.ok(store.records[0].subtitle.includes('兑换奖励'), store.records[0].subtitle)
  assert.strictEqual(store.records[0].operatorRole, 'guardian')
  // 修 B8：完整标题快照，不再 shortTitle 截断
  assert.strictEqual(store.records[0].title, `兑换：${cheap.title}`)
  assert.ok(!store.records[0].title.endsWith('…'), '标题不应被截断')
  // 修 B8：回指心愿 —— 即使心愿被删除也能解释这笔扣分
  assert.strictEqual(store.records[0].wishId, cheap.id)
  assert.strictEqual(store.records[0].balanceAfter, 84)
  assert.strictEqual(store.redeem(cheap), false, '已兑换的不能再换')
  const expensive = store.wishes[2]
  assert.strictEqual(store.redeem(expensive), false)
  assert.strictEqual(store.points, 84)
  assert.strictEqual(store.records.length, 5, '只有成功那次会写流水')
})

check('addWish / removeWish', () => {
  const store = seededStore()
  store.addWish('  新愿望  ', 12, '🎁')
  assert.strictEqual(store.wishes.length, 5)
  assert.strictEqual(store.wishes[0].title, '新愿望')
  assert.strictEqual(store.wishes[0].cost, 12)
  assert.strictEqual(store.wishes[0].emoji, '🎁')
  assert.strictEqual(store.wishes[0].redeemed, false)
  assert.strictEqual(store.wishes[0].backgroundIndex, 0)
  const added = store.wishes[0]
  store.removeWish(added)
  assert.strictEqual(store.wishes.length, 4)
  assert.strictEqual(store.wishes.indexOf(added), -1)
})

check('addRule / removeRule：空条件兜底 + 频次必须是 1–5 整数（修 A2 / E15）', () => {
  const store = seededStore()
  assert.strictEqual(store.addRule(' 收拾玩具 ', '   ', 2, 3, 'star', '#f6c64a'), null)
  assert.strictEqual(store.rules.length, 5)
  assert.strictEqual(store.rules[0].title, '收拾玩具')
  assert.strictEqual(store.rules[0].condition, '家长约定', '空条件兜底为「家长约定」')
  assert.strictEqual(store.rules[0].dailyLimit, 2)
  assert.strictEqual(store.rules[0].points, 3)
  assert.strictEqual(ruleDetail(store.rules[0]), '家长约定 · 每天最多 2 次')

  // 频次越界必须被**拒绝**（而不是悄悄夹到边界）——静默改写会让家长以为约定已生效
  for (const bad of [0, 6, -1, 1.5, Number.NaN]) {
    const message = store.addRule('越界频次', '条件', bad, 1, 'star', '#f6c64a')
    assert.ok(
      typeof message === 'string' && message.length > 0,
      'dailyLimit=' + bad + ' 应被拒绝'
    )
  }
  assert.strictEqual(store.rules.length, 5, '被拒绝时不写规则')
  assert.strictEqual(isDailyLimitValid(dailyLimitMin), true)
  assert.strictEqual(isDailyLimitValid(dailyLimitMax), true)
  assert.strictEqual(isDailyLimitValid(dailyLimitMax + 1), false)

  const added = store.rules[0]
  store.removeRule(added)
  assert.strictEqual(store.rules.length, 4)
})

check('addHabitFromRule：结构字段直传 + 去重（修 E15：不再 split 反解析）', () => {
  const store = seededStore()
  // rules[2] = 围棋课后作业（condition='完成并检查'，dailyLimit=1；首页还没有同名习惯）
  store.addHabitFromRule(store.rules[2])
  assert.strictEqual(store.habits.length, 4)
  const added = store.habits[3]
  assert.strictEqual(added.title, '围棋课后作业')
  assert.strictEqual(added.points, 5)
  assert.strictEqual(added.condition, '完成并检查', '条件应原样取自规则的结构字段')
  assert.strictEqual(added.dailyLimit, 1, '频次应原样取自规则的结构字段')
  assert.strictEqual(habitView(added, store.records).checked, false)
  store.addHabitFromRule(store.rules[2])
  assert.strictEqual(store.habits.length, 4, '同名习惯不应重复添加')

  // 已有同名习惯（rules[1] 自己收书包）时直接跳过
  store.addHabitFromRule(store.rules[1])
  assert.strictEqual(store.habits.length, 4, '同名习惯不应重复添加')

  store.addRule('倒垃圾', '', 1, 2, 'star', '#f6c64a')
  store.addHabitFromRule(store.rules[0])
  const noDetail = store.habits[store.habits.length - 1]
  assert.strictEqual(noDetail.condition, '家长约定')
  assert.strictEqual(noDetail.dailyLimit, 1)

  // 修 A1：扣分规则**不得**生成可打卡习惯
  // （原先 Math.abs 会把「打人 −3 分」静默变成「打人 +3 分」，属产品性质级错误）
  store.addRule('负分规则', '打人', 1, -3, 'star', '#f6c64a')
  const negativeRule = store.rules[0]
  assert.ok(negativeRule.points < 0)
  const habitsBefore = store.habits.length
  const rejectMessage = store.addHabitFromRule(negativeRule)
  assert.ok(typeof rejectMessage === 'string' && rejectMessage.length > 0, '应返回拒绝原因')
  assert.strictEqual(store.habits.length, habitsBefore, '扣分规则不得生成习惯')
  assert.ok(!store.habits.some((h) => h.points < 0), '习惯积分恒为正')
})

check('renameChild / resetToSeed', () => {
  const store = seededStore()
  store.renameChild('  小明  ')
  assert.strictEqual(store.profile.name, '小明')
  store.renameChild('   ')
  assert.strictEqual(store.profile.name, '小明', '空名字不应覆盖')
  store.checkIn(store.habits[2])
  store.resetToSeed()
  assert.strictEqual(store.points, 124)
  assert.strictEqual(store.profile.name, '萌新铲屎官的小可爱')
  assert.strictEqual(store.habits.length, 3)
  assert.strictEqual(store.wishes.length, 4)
  assert.strictEqual(store.records.length, 4)
  assert.strictEqual(store.rules.length, 4)
  assert.strictEqual(habitView(store.habits[2], store.records).checked, false)
})

check('subscribe：变更会通知订阅者', () => {
  const store = seededStore()
  let calls = 0
  const off = store.subscribe(() => {
    calls += 1
  })
  store.checkIn(store.habits[2])
  assert.strictEqual(calls, 1)
  store.renameChild('小明')
  assert.strictEqual(calls, 2)
  off()
  store.resetToSeed()
  assert.strictEqual(calls, 2)
})

check('A4 真实操作人 / I2 余额链自洽 / I6 冲正关系', () => {
  const store = seededStore()
  const habit = store.habits[2] // 自主阅读 +2

  // ── A4：孩子自助打卡 → source=child_self，subtitle 不得谎称“家长”
  assert.strictEqual(store.checkIn(habit, { role: 'child' }), null)
  const childRecord = store.records[0]
  assert.strictEqual(childRecord.source, 'child_self')
  assert.strictEqual(childRecord.operatorRole, 'child')
  assert.ok(!childRecord.subtitle.includes('家长'), childRecord.subtitle)
  assert.ok(childRecord.subtitle.endsWith('· 自己完成'), childRecord.subtitle)
  assert.strictEqual(
    childRecord.subtitle,
    recordSubtitle(childRecord),
    'subtitle 必须与派生函数一致（防止有人重新手写文案）'
  )
  assert.strictEqual(childRecord.balanceAfter, 126)

  // ── A4：家长操作 → source=guardian
  assert.strictEqual(store.addQuickNote(3, '家长奖励'), null)
  assert.strictEqual(store.records[0].source, 'guardian')
  assert.ok(store.records[0].subtitle.includes('家长记录'))

  // ── I6：撤销写入冲正记录，原记录保留
  assert.strictEqual(store.undoCheckIn(habit), null)
  const revert = store.records[0]
  assert.strictEqual(revert.source, 'correction')
  assert.strictEqual(revert.reversesRecordId, childRecord.id)
  assert.strictEqual(revert.points, -2)
  assert.strictEqual(revert.balanceAfter, 127)
  assert.strictEqual(
    store.records.filter((r) => r.id === childRecord.id).length,
    1,
    '原记录不可被删除'
  )

  // ── I2：余额链自洽
  // 注意：链按**写入顺序**成立（records 最新在前，反转即写入顺序）。
  // 演示数据的 time 是回填的历史时间，故不能按 time 排序来验证链。
  const byInsertion = store.records.slice().reverse()
  for (let i = 1; i < byInsertion.length; i += 1) {
    assert.strictEqual(
      byInsertion[i].balanceAfter,
      byInsertion[i - 1].balanceAfter + byInsertion[i].points,
      `余额链断裂于「${byInsertion[i].title}」`
    )
  }
  assert.strictEqual(
    store.records[0].balanceAfter,
    store.points,
    '最新一条的 balanceAfter 必须等于当前余额'
  )
})

// ── 阶段 C2：E15 ＋ E17 ＋ A2 ＋ A3（结构字段化，展示串降级为派生）────────
check('A2/A3：「每天最多 2 次」真的可以打卡 2 次，第 3 次才被拦', () => {
  const store = seededStore()
  const pomodoro = store.habits[0]

  // 演示流水中番茄钟今天已有 1 条 → 派生态是 1/2（不是「已完成」）
  const before = habitView(pomodoro, store.records)
  assert.strictEqual(before.checkedCountToday, 1)
  assert.strictEqual(before.limitText, '每天最多 2 次')
  assert.strictEqual(before.doneText, '今日已完成 1 次')
  assert.strictEqual(before.checked, false, '1 < 2：还没到上限，必须还能打卡（A3 的核心）')

  // 第 2 次打卡必须成功 —— 修前 checked=true 会在这里拦下，规则承诺的 2 次永远不可达
  assert.strictEqual(store.checkIn(pomodoro), null)
  const after = habitView(pomodoro, store.records)
  assert.strictEqual(after.checkedCountToday, 2)
  assert.strictEqual(after.doneText, '今日已完成 2 次')
  assert.strictEqual(after.checked, true)
  assert.strictEqual(store.points, 125)

  // 第 3 次才该被拦
  assert.strictEqual(
    store.checkIn(pomodoro),
    '“番茄钟写作业”今天已经完成 2 次啦，明天继续加油～'
  )
  assert.strictEqual(store.records.length, 5, '被拦时不写流水')

  // 每天 1 次的习惯：1 次即到上限
  const backpack = habitView(store.habits[1], store.records)
  assert.strictEqual(backpack.checked, true)
  assert.strictEqual(backpack.doneText, '今日已完成 1 次')
})

check('A3：已打卡次数由当天流水派生，被冲正的原记录不再计入', () => {
  const store = seededStore()
  const reading = store.habits[2]
  const empty = habitView(reading, store.records)
  assert.strictEqual(empty.checkedCountToday, 0)
  assert.strictEqual(empty.doneText, '今日已完成 0 次')
  assert.strictEqual(empty.limitText, '每天 1 次')

  assert.strictEqual(store.checkIn(reading), null)
  assert.strictEqual(habitView(reading, store.records).checkedCountToday, 1)

  // 撤销写入冲正记录（原记录保留）→ 派生的「今天完成几次」必须回到 0。
  // 03 的 A3 公式只排除 correction，会漏掉「被冲正的原记录」，撤销后会卡在「已打卡」。
  assert.strictEqual(store.undoCheckIn(reading), null)
  const undone = habitView(reading, store.records)
  assert.strictEqual(undone.checkedCountToday, 0, '被冲正的原记录不得再计入')
  assert.strictEqual(undone.checked, false)
  assert.strictEqual(store.checkIn(reading), null, '撤销后应当可以重新打卡')

  // 昨天的打卡不算今天（seed 里 rec-3 / rec-4 属于昨天，且不回指任何习惯）
  assert.strictEqual(checkedCountToday(store.records, 'habit-backpack'), 1)
})

check('E15/E17：展示串一律由结构字段派生', () => {
  assert.strictEqual(limitTextOf(1), '每天 1 次')
  assert.strictEqual(limitTextOf(2), '每天最多 2 次')
  assert.strictEqual(limitTextOf(5), '每天最多 5 次')
  assert.strictEqual(doneTextOf(0), '今日已完成 0 次')
  assert.strictEqual(doneTextOf(3), '今日已完成 3 次')

  const rule = {
    id: 'r-x',
    title: '练琴',
    condition: '连续练习 30 分钟',
    dailyLimit: 2,
    points: 4,
    icon: 'music',
    color: '#f5a24b'
  }
  assert.strictEqual(ruleDetail(rule), '连续练习 30 分钟 · 每天最多 2 次')

  // E15 的原始故障：'连续 3 天 · 每天 1 次 · 需要家长确认' 被 split 后丢掉第三段。
  // 现在没有 free-text 入口 —— detail 由结构字段拼出，结构信息无处可丢。
  const store = seededStore()
  assert.strictEqual(store.addRule('练琴', '连续 3 天', 1, 4, 'music', '#f5a24b'), null)
  assert.strictEqual(store.rules[0].condition, '连续 3 天', '条件原样保留，不被 split 切碎')
  assert.strictEqual(ruleDetail(store.rules[0]), '连续 3 天 · 每天 1 次')
})

// ── E18 第二半：首启空态（修前必然失败）────────────────────────────────
check('E18 首启必须为空态：不预置任何演示数据', () => {
  const fresh = new AppStore()
  assert.strictEqual(fresh.points, 0, '首启不得预置 124 分假数据')
  assert.strictEqual(fresh.profile.name, '', '首启不得有假昵称')
  assert.strictEqual(fresh.profile.childId, '', '首启不得有假孩子 ID')
  assert.strictEqual(fresh.profile.goodHabitCount, 0, '首启不得声称完成过 324 个好习惯')
  assert.strictEqual(fresh.profile.rewardCount, 0, '首启不得声称兑换过 4 次')
  assert.deepStrictEqual(fresh.habits, [], '首启不得预置习惯')
  assert.deepStrictEqual(fresh.wishes, [], '首启不得预置心愿')
  assert.deepStrictEqual(fresh.records, [], '首启不得预置流水')
  assert.deepStrictEqual(fresh.rules, [], '首启不得预置规则')

  // 首启用户第一眼就是空态：查询与写入都不能崩
  assert.strictEqual(fresh.recordsOf(null).length, 0)
  assert.strictEqual(fresh.addQuickNote(2, '开局奖励'), null)
  assert.strictEqual(fresh.points, 2)
  assert.strictEqual(fresh.records.length, 1)
  assert.strictEqual(fresh.records[0].balanceAfter, 2, '空态起步的余额链必须自洽')

  // 演示数据仍在，但它是「一次显式操作」，不是首启默认值
  assert.strictEqual(fresh.resetToSeed(), true)
  assert.strictEqual(fresh.points, 124)
})

check('E18 生产构建不可达：判据语义 + 真实生产模块双证', () => {
  // ① 判据层：不依赖「恰好跑在哪个环境」，production 必须被拒
  assert.strictEqual(demoResetAllowed('production'), false, 'NODE_ENV=production 必须禁止')
  assert.strictEqual(demoResetAllowed('development'), true, '开发环境可用')
  assert.strictEqual(demoResetAllowed(''), true, '未设 NODE_ENV（本地/测试）可用')

  // ② 真实模块层：以 NODE_ENV=production 重新加载 → 守卫与行为都必须为「拒绝」
  const storePath = require.resolve('./dist/data/store.js')
  const cached = require.cache[storePath]
  const prevEnv = process.env.NODE_ENV
  let prod
  try {
    process.env.NODE_ENV = 'production'
    delete require.cache[storePath]
    prod = require('./dist/data/store.js')
  } finally {
    process.env.NODE_ENV = prevEnv
    require.cache[storePath] = cached
  }

  assert.strictEqual(prod.ALLOW_DEMO_RESET, false, '生产构建的守卫必须是 false（否则可被 DCE）')
  const guarded = new prod.AppStore()
  guarded.renameChild('小明')
  guarded.addQuickNote(5, '真实数据')
  assert.strictEqual(guarded.resetToSeed(), false, '生产构建必须拒绝恢复演示数据')
  assert.strictEqual(guarded.profile.name, '小明', '被拒绝时不得清空真实数据')
  assert.strictEqual(guarded.points, 5, '被拒绝时余额不得被改成 124')
})

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1




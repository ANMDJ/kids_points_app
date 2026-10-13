#!/usr/bin/env node
/**
 * prototype/verify.mjs —— 高保真原型的**自检**（原型侧的唯一闸门）
 *
 * 存在理由：原型是给评审者看的「事实源之一」，一旦它与仓库的派生规则脱节
 * （「每天最多 2 次」写成「每天 2 次」、撤销后流水条数 -1、兑换不足还能扣成负数），
 * 评审结论就会建立在一个假的界面上 —— 与 `03` §E17 / §E19 的病同源：
 * **界面里的展示串没人对账。**
 *
 * 本工具只做一件事：**在 jsdom 里真跑一遍原型，逐条断言「界面上究竟显示了什么」**。
 * 它不测像素，测的是**语义**：金额、派生文案、上限拦截、冲正而非删除、软删与恢复。
 *
 * 依赖：`jsdom`（复用 kids_points_mp/node_modules 里已有的那份，不新增依赖）。
 *
 * 用法：
 *   node prototype/verify.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'

const ROOT = resolve(import.meta.dirname, '..')
/* jsdom 装在 kids_points_mp 里：用它的 package.json 作为解析基准，避免重复安装 */
const requireFromMp = createRequire(resolve(ROOT, 'kids_points_mp/package.json'))
const jsdom = requireFromMp('jsdom')
const { JSDOM, VirtualConsole } = jsdom

const HTML = readFileSync(resolve(ROOT, 'prototype/index.html'), 'utf8')
const APP = readFileSync(resolve(ROOT, 'prototype/app.js'), 'utf8')

// ------------------------------------------------------------------ 工具

/** 每个实例捕获到的「未捕获异常」（弹窗里抛错不会冒泡到调用方，只能从虚拟控制台捞）。 */
const ERROR_SINKS = new Map()

/** 开一个全新的原型实例（每个用例都从「124 分 / 4 条流水」的初始态开始）。 */
function boot() {
  const errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => {
    errors.push(error && error.message ? error.message : String(error))
  })
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole
  })
  dom.window.eval(APP)
  ERROR_SINKS.set(dom.window, errors)
  return dom.window
}

function errorsOf(window) {
  return ERROR_SINKS.get(window) || []
}

const wait = (ms = 80) => new Promise((done) => setTimeout(done, ms))

function click(window, el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
}

/** 长按：按下 550ms 才触发，所以这里要真的等过去。 */
async function longPress(window, el) {
  el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))
  await wait(650)
}

function one(window, selector) {
  return window.document.querySelector(selector)
}

function all(window, selector) {
  return Array.from(window.document.querySelectorAll(selector))
}

function textOf(window, selector) {
  const el = one(window, selector)
  return el ? el.textContent.trim() : '（元素不存在）'
}

function textsOf(window, selector) {
  return all(window, selector).map((el) => el.textContent.trim())
}

/** 按可见文案找一个元素（原型里的按钮大多没有 id）。 */
function byText(window, selector, text) {
  return all(window, selector).filter((el) => el.textContent.trim().indexOf(text) >= 0)[0]
}

function habitCard(window, title) {
  return byText(window, '#home-habits .kp-habit', title)
}

function expect(problems, actual, expected, label) {
  if (actual !== expected) {
    problems.push(`${label}：期望「${expected}」，实际「${actual}」`)
  }
}

function expectContains(problems, actual, expected, label) {
  if (String(actual).indexOf(expected) < 0) {
    problems.push(`${label}：期望包含「${expected}」，实际「${actual}」`)
  }
}

// ------------------------------------------------------------------ 用例

const CASES = [
  {
    id: 'P1',
    what: '首页初始态：124 分 / 已完成 1-3 / 三条习惯的副标题全部由派生函数给出',
    async run() {
      const problems = []
      const w = boot()
      expect(problems, textOf(w, '#home-points'), '124', '当前可用积分')
      expect(problems, textOf(w, '#home-progress'), '已完成 1/3', '完成进度')
      const subtitles = textsOf(w, '.kp-habit__subtitle')
      expect(problems, subtitles[0], '专注 25 分钟 · 每天最多 2 次', '番茄钟（1/2，未达上限 → 显示频次）')
      expect(problems, subtitles[1], '睡前整理好 · 今日已完成 1 次', '自己收书包（1/1，已达上限 → 显示完成次数）')
      expect(problems, subtitles[2], '阅读 20 分钟 · 每天 1 次', '自主阅读（0/1 → 1 次要写成「每天 1 次」）')
      expect(problems, all(w, '.kp-habit__check.is-done').length, 1, '只有达上限的习惯才画绿勾')
      return problems
    }
  },
  {
    id: 'P2',
    what: '打卡上限：每天最多 2 次的习惯打完第 2 次后被拒绝，且分值不变',
    async run() {
      const problems = []
      const w = boot()
      click(w, habitCard(w, '番茄钟写作业'))
      expect(problems, textOf(w, '#home-points'), '125', '第 1 次打卡后积分')
      expect(problems, textOf(w, '#home-progress'), '已完成 2/3', '第 1 次打卡后进度')
      expect(problems, textsOf(w, '.kp-habit__subtitle')[0], '专注 25 分钟 · 今日已完成 2 次', '达上限后的副标题')
      click(w, habitCard(w, '番茄钟写作业'))
      expectContains(problems, textOf(w, '#toast'), '今天已经完成 2 次啦', '第 2 次打卡的拒绝文案')
      expect(problems, textOf(w, '#home-points'), '125', '被拒绝后积分不变')
      return problems
    }
  },
  {
    id: 'P3',
    what: '撤销写成冲正流水（原记录保留）：记录页条数 +1 而不是 −1',
    async run() {
      const problems = []
      const w = boot()
      expect(problems, textOf(w, '#record-count'), '共 4 条', '初始流水条数')
      await longPress(w, habitCard(w, '自己收书包'))
      expectContains(problems, textOf(w, '#toast'), '已撤销“自己收书包”的打卡', '撤销成功提示')
      expect(problems, textOf(w, '#home-points'), '122', '撤销后积分（124 − 2）')
      expect(problems, textOf(w, '#record-count'), '共 5 条', '撤销后流水条数（冲正记录也是流水）')
      expectContains(problems, textsOf(w, '#record-list .kp-tile__title').join('|'), '撤销：自己收书包', '冲正记录出现在账上')
      return problems
    }
  },
  {
    id: 'P4',
    what: '积分记录：按天分组 + 副标题由 time/source/category/note 派生（修 A4 / E19）',
    async run() {
      const problems = []
      const w = boot()
      expect(problems, textsOf(w, '.kp-record__day-label').join('|'), '今天|昨天', '日期分组标题')
      const titles = textsOf(w, '#record-list .kp-tile__title')
      const subtitles = textsOf(w, '#record-list .kp-tile__subtitle')
      expect(problems, titles[0], '番茄钟写作业', '当天第一条记录')
      expect(problems, subtitles[0], '19:30 · 家长记录', '来源是家长记录，时间取自流水')
      expect(problems, subtitles[1], '18:50 · 家长记录', '第二条记录')
      expectContains(problems, subtitles[3], '19:10 · 兑换奖励 · 已兑换', '兑换流水：来源词 + 备注作为附加段')
      expect(problems, textsOf(w, '#record-list .kp-tile__amount').join('|'), '+1|+2|+5|-30', '金额带符号')
      return problems
    }
  },
  {
    id: 'P5',
    what: '记录页筛选：兑换只有 1 条，条数文案同步',
    async run() {
      const problems = []
      const w = boot()
      click(w, byText(w, '#record-chips .kp-chip', '兑换'))
      expect(problems, textOf(w, '#record-count'), '共 1 条', '按兑换筛选后的条数')
      expect(problems, textsOf(w, '#record-list .kp-tile__title').join('|'), '兑换：小饼干', '筛选后的记录')
      click(w, byText(w, '#record-chips .kp-chip', '全部'))
      expect(problems, textOf(w, '#record-count'), '共 4 条', '切回全部')
      return problems
    }
  },
  {
    id: 'P6',
    what: '心愿兑换：扣分 + 完整标题快照 + wishId 回指 + 奖励次数 +1',
    async run() {
      const problems = []
      const w = boot()
      const title = textOf(w, '#wish-grid .kp-wish__title')
      click(w, one(w, '#wish-grid [data-redeem]'))
      expect(problems, textOf(w, '#wish-points'), '84', '兑换 40 分后的可用积分')
      expect(problems, textOf(w, '#home-points'), '84', '首页积分同步')
      expect(problems, textOf(w, '#profile-rewards'), '5', '奖励次数 +1（4 → 5）')
      expect(problems, textOf(w, '#record-count'), '共 5 条', '流水条数 +1')
      /*
       * ⚠️ 这里断言的是「账上有这笔」，不是「排在第一条」——
       *    seed.ts 的「今天」是**固定钟点**（19:30 / 18:50），而新流水用的是真实当前时刻，
       *    所以上午演示时新记录会排在 19:30 那条**下面**（列表按时间倒序，不按写入顺序）。
       *    这是演示数据的既有口径，见 prototype/README.md 的「已知差异与观感说明」。
       */
      const titles = textsOf(w, '#record-list .kp-tile__title')
      expect(problems, titles.indexOf('兑换：' + title) >= 0, true, '完整标题快照（不截断）')
      expect(problems, textOf(w, '#wish-grid .kp-pill__label'), '已兑换', '卡片进入已兑换态')
      return problems
    }
  },
  {
    id: 'P7',
    what: '积分规则：细则由 condition + dailyLimit 派生（修 E15，没有可写入的展示串）',
    async run() {
      const problems = []
      const w = boot()
      expect(
        problems,
        textsOf(w, '#rule-list .kp-tile__title').join('|'),
        '番茄钟写作业|自己收书包|围棋课后作业|自主阅读',
        '规则条数与顺序'
      )
      const details = textsOf(w, '#rule-list .kp-tile__subtitle')
      expect(problems, details[0], '专注 25 分钟 · 每天最多 2 次', 'ruleDetail 派生串')
      expect(problems, details[2], '完成并检查 · 每天 1 次', '「每周」表达不了 → 现状是「每天 1 次」')
      await longPress(w, byText(w, '#rule-list .kp-tile', '自主阅读'))
      await wait(120)
      expect(problems, one(w, '.kp-sheet__title') ? one(w, '.kp-sheet__title').textContent.trim() : '', '自主阅读', '长按规则打开操作菜单')
      expect(
        problems,
        textsOf(w, '.kp-sheet-row__label').join('|'),
        '编辑这条规则（当前第 1 版）|加入今天的习惯|移到回收站',
        '操作菜单三行'
      )
      return problems
    }
  },
  {
    id: 'P8',
    what: '软删除与回收站：删除只改状态位，回收站可恢复（修 C9）',
    async run() {
      const problems = []
      const w = boot()
      expect(problems, textOf(w, '#trash-label'), '回收站', '初始回收站为空（seed 不预置）')
      await longPress(w, one(w, '#wish-grid .kp-wish'))
      await wait(120)
      expect(problems, textOf(w, '#confirm-text').indexOf('移到回收站吗') >= 0, true, '删除前有二次确认')
      click(w, one(w, '#confirm-ok'))
      await wait(120)
      expect(problems, textOf(w, '#trash-label'), '回收站（1）', '入口显示条数')
      expect(problems, all(w, '#wish-grid .kp-wish').length, 3, '列表里少了一张心愿卡')
      click(w, byText(w, '.proto-nav__item', '回收站'))
      await wait(150)
      expect(problems, textOf(w, '.kp-trash__meta'), '心愿 · 还能恢复 90 天', '保留期文案由 deletedAt 派生')
      click(w, byText(w, '.kp-trash__chip', '恢复'))
      await wait(320)
      expect(problems, textOf(w, '#trash-label'), '回收站', '恢复后计数归零')
      expect(problems, all(w, '#wish-grid .kp-wish').length, 4, '恢复后列表回到 4 张卡')
      return problems
    }
  },
  {
    id: 'P9',
    what: '记一笔：快选额度 + 事由标签拼装 + 保存回执（修 B6 禁止静默截断）',
    async run() {
      const problems = []
      const w = boot()
      click(w, byText(w, '#screen-home .kp-soft-button', '记一笔'))
      await wait(150)
      expect(problems, one(w, '.kp-sheet.is-visible') !== null, true, '弹窗已展开')
      click(w, one(w, '[data-tag-kind="amount"][data-tag="5"]'))
      click(w, byText(w, '#sheet-layer .kp-tag', '主动帮忙做家务'))
      expect(
        problems,
        textOf(w, '.kp-sheet__action-label'),
        '保存（+5 积分）',
        '底部按钮文案随额度实时变化'
      )
      click(w, one(w, '[data-sheet-action]'))
      await wait(120)
      expect(problems, textOf(w, '#home-points'), '129', '积分 124 + 5')
      expectContains(problems, textOf(w, '#toast'), '已加 5 积分：主动帮忙做家务', '保存回执')
      expectContains(problems, textOf(w, '#record-count'), '共 5 条', '流水条数 +1')
      return problems
    }
  },
  {
    id: 'P10',
    what: '新增规则：空标题被拦下、频次越界由步进器夹在 1–5、条件留空落到「家长约定」',
    async run() {
      const problems = []
      const w = boot()
      click(w, byText(w, '#screen-rule .kp-soft-button', '新增规则'))
      await wait(150)
      click(w, one(w, '[data-sheet-action]'))
      expect(problems, textOf(w, '#toast'), '规则名称不能为空哦', '空标题被拦下')
      const limit = one(w, '[data-stepper="limit"]')
      expect(problems, limit.querySelector('.kp-stepper__value').textContent, '1', '频次默认 1 次/天')
      expect(
        problems,
        limit.querySelector('.kp-stepper__suffix').textContent,
        '次/天',
        '频次的单位是「次/天」，不是展示串'
      )
      click(w, limit.querySelector('[data-step="-1"]'))
      expect(problems, limit.querySelector('.kp-stepper__value').textContent, '1', '下界夹在 1')
      const title = one(w, '#ar-title')
      title.value = '整理书桌'
      title.dispatchEvent(new w.Event('input', { bubbles: true }))
      click(w, one(w, '[data-sheet-action]'))
      await wait(120)
      expectContains(problems, textOf(w, '#toast'), '已新增规则：整理书桌', '新增成功回执')
      expect(problems, textsOf(w, '#rule-list .kp-tile__title')[0], '整理书桌', '新规则排在最前')
      expect(problems, textsOf(w, '#rule-list .kp-tile__subtitle')[0], '家长约定 · 每天 1 次', 'condition 留空 → 家长约定')
      return problems
    }
  },
  {
    id: 'P11',
    what: '全屏冒烟：5 个页面 + 6 张弹窗都能打开，全程无未捕获异常',
    async run() {
      const problems = []
      const w = boot()

      expect(problems, all(w, '.kp-screen').length, 5, '页面数量')
      expect(problems, all(w, '.proto-nav__item[data-goto]').length, 5, '页面入口数量')
      expect(problems, all(w, '.proto-nav__item[data-goto-sheet]').length, 6, '弹窗入口数量')

      for (const label of ['首页', '心愿单', '我的', '积分记录', '积分规则']) {
        const button = byText(w, '.proto-nav__item[data-goto]', label)
        if (!button) {
          problems.push(`原型导航里找不到页面「${label}」`)
          continue
        }
        click(w, button)
        await wait(30)
        const active = one(w, '.kp-screen.is-active')
        if (!active) problems.push(`切到「${label}」后没有任何页面处于激活态`)
      }

      for (const label of ['记一笔', '新增心愿', '新增规则', '编辑规则', '规则操作菜单', '回收站']) {
        const button = byText(w, '.proto-nav__item[data-goto-sheet]', label)
        if (!button) {
          problems.push(`原型导航里找不到弹窗「${label}」`)
          continue
        }
        click(w, button)
        await wait(100)
        const sheet = one(w, '#sheet-layer .kp-sheet.is-visible')
        if (!sheet) {
          problems.push(`弹窗「${label}」没有展开`)
          continue
        }
        click(w, sheet.querySelector('.kp-sheet__close'))
        await wait(280)
        if (one(w, '#sheet-layer .kp-sheet.is-visible')) {
          problems.push(`弹窗「${label}」没有收起`)
        }
      }

      /* 弹窗里的异常不会冒泡到调用方，只能从虚拟控制台捞 —— 有就一律算红 */
      errorsOf(w).forEach((message) => problems.push('未捕获异常：' + message))
      return problems
    }
  }
]

// ------------------------------------------------------------------ 运行

let failures = 0

for (const item of CASES) {
  let problems = []
  try {
    problems = await item.run()
  } catch (error) {
    problems = [`用例抛错：${error && error.message ? error.message : error}`]
  }
  const ok = problems.length === 0
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${item.id}  ${item.what}`)
  problems.slice(0, 4).forEach((note) => console.log(`        · ${note}`))
  if (problems.length > 4) console.log(`        · …另有 ${problems.length - 4} 条`)
}

console.log(
  `\n${failures === 0 ? 'ALL PASS' : `FAILED ${failures} 项`}  （共 ${CASES.length} 条用例${
    failures === 0 ? '，界面上的每个数字与文案都与仓库派生态一致' : ''
  }）`
)
process.exitCode = failures === 0 ? 0 : 1

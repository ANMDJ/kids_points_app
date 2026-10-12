import { useEffect, useState } from 'react'
import { useDidShow } from '@tarojs/taro'

import { buildSeedData } from './seed'
import type {
  ActorContext,
  ChildProfile,
  Habit,
  IconOption,
  PointRecord,
  PointRule,
  RecordCategory,
  RecordSource,
  Wish
} from './types'
import { recordSubtitle } from './types'

/**
 * 是否允许“恢复演示数据”（修 E18）。
 *
 * 该方法原先是**生产可达**的公开 API，“我的”页按钮直接调用 ——
 * 用户可一键清空真实数据并恢复假演示数据（124 分 / 324 好习惯 / 4 次奖励）。
 * 生产构建必须为 false；Taro 打包时 DefinePlugin 会替换掉 NODE_ENV。
 */
export const ALLOW_DEMO_RESET = process.env.NODE_ENV !== 'production'

/**
 * 应用状态中心：积分余额、习惯、心愿、流水、规则。
 *
 * 与 Flutter 版 lib/data/app_store.dart 一一对应，模块级单例，
 * 页面之间用 redirectTo / navigateTo 跳转时数据依然保留。
 * 要落地持久化时只需在 [persist] 里接入 Taro.setStorageSync 即可，UI 层无需改动。
 */
export class AppStore {
  points = 0
  profile: ChildProfile = {
    name: '',
    childId: '',
    goodHabitCount: 0,
    rewardCount: 0
  }
  habits: Habit[] = []
  wishes: Wish[] = []
  records: PointRecord[] = []
  rules: PointRule[] = []

  private seq = 0
  private listeners = new Set<() => void>()

  constructor() {
    this.reset()
  }

  // ------------------------------------------------------------- 订阅 / 通知

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private persist(): void {
    this.listeners.forEach((listener) => listener())
  }

  private reset(): void {
    const seed = buildSeedData()
    this.points = seed.points
    this.profile = seed.profile
    this.habits = seed.habits
    this.wishes = seed.wishes
    this.records = seed.records
    this.rules = seed.rules
  }

  /**
   * 恢复演示数据（“我的”页的“恢复演示数据”按钮）。
   * 返回是否真的执行了恢复。
   *
   * **修 E18**：原先是**生产可达**的公开方法 —— 用户可一键清空真实数据并恢复假演示数据。
   * 现由 [ALLOW_DEMO_RESET] 守卫，仅开发环境可用。
   */
  resetToSeed(): boolean {
    if (!ALLOW_DEMO_RESET) return false
    this.reset()
    this.persist()
    return true
  }

  // ------------------------------------------------------------------- 查询

  /** 按分类过滤流水，[category] 为 null 表示“全部”。 */
  recordsOf(category: RecordCategory | null): PointRecord[] {
    if (category === null) return this.records.slice()
    return this.records.filter((record) => record.category === category)
  }

  canRedeem(wish: Wish): boolean {
    return !wish.redeemed && this.points >= wish.cost
  }

  gapOf(wish: Wish): number {
    const gap = wish.cost - this.points
    return gap > 0 ? gap : 0
  }

  // ------------------------------------------------------------------- 打卡

  /**
   * 首页习惯打卡。成功返回 null，失败返回提示文案。
   *
   * [actor] 记录**真实操作人** —— 修 A4：原先无论谁打卡都写死“家长记录”，
   * 孩子自己完成也显示“家长记录”，流水在撒谎且责任链断裂。
   */
  checkIn(
    habit: Habit,
    actor: ActorContext = { role: 'guardian' }
  ): string | null {
    if (habit.checked) {
      return `“${habit.title}”今天已经完成过啦，明天继续加油～`
    }
    const source: RecordSource = actor.role === 'child' ? 'child_self' : 'guardian'
    habit.checked = true
    this.points += habit.points
    this.profile.goodHabitCount += 1
    const time = Date.now()
    this.records.unshift({
      id: this.newId('rec'),
      title: habit.title,
      subtitle: recordSubtitle({ time, source }),
      points: habit.points,
      time,
      category: 'praise',
      icon: habit.icon,
      color: habit.color,
      source,
      operatorRole: actor.role,
      note: '',
      habitId: habit.id,
      ruleId: null,
      wishId: null,
      reversesRecordId: null,
      balanceAfter: this.points
    })
    this.persist()
    return null
  }

  /**
   * 撤销今天的打卡（长按习惯卡片）。成功返回 null，失败返回提示文案。
   *
   * **修 B7**：原先直接 `filter` 掉今天的流水 —— 历史被物理抹掉（违背账本不可变原则），
   * 且按 `title` 匹配会**误删同名习惯**的记录（改过名的习惯与新习惯同名时必然出错）。
   *
   * 现改为两件事：
   * 1. 按 `habitId`（唯一）定位原记录，跳过已被冲正的记录与冲正记录本身；
   * 2. 写入一条**冲正记录**（`source='correction'`、`reversesRecordId` 指向原记录），
   *    **原记录保留不动** —— 见 docs/design/02 §5。
   *
   * 因此撤销后流水条数 **+1 而非 −1**。
   */
  undoCheckIn(
    habit: Habit,
    actor: ActorContext = { role: 'guardian' }
  ): string | null {
    if (!habit.checked) {
      return `“${habit.title}”今天还没有打卡，不用撤销`
    }
    const reversedIds = new Set(
      this.records
        .filter((record) => record.reversesRecordId !== null)
        .map((record) => record.reversesRecordId)
    )
    const target = this.records.find(
      (record) =>
        record.habitId === habit.id &&
        record.category === 'praise' &&
        record.source !== 'correction' &&
        !reversedIds.has(record.id) &&
        this.isToday(record.time)
    )
    if (!target) {
      return `没有找到“${habit.title}”今天的打卡记录`
    }
    // 修 B6 同类保护：扣回不得超过当前余额（禁止静默截断，否则账本不平）
    if (target.points > this.points) {
      return `积分不足，无法撤销（需扣回 ${target.points} 分，当前只有 ${this.points} 分）`
    }
    habit.checked = false
    this.points -= target.points
    if (this.profile.goodHabitCount > 0) this.profile.goodHabitCount -= 1
    const time = Date.now()
    this.records.unshift({
      id: this.newId('rec'),
      title: `撤销：${target.title}`,
      subtitle: recordSubtitle({
        time,
        source: 'correction',
        note: target.title
      }),
      points: -target.points,
      time,
      category: 'adjust',
      icon: 'minus',
      color: '#e9834b',
      source: 'correction',
      operatorRole: actor.role,
      note: target.title,
      habitId: habit.id,
      ruleId: target.ruleId,
      wishId: null,
      reversesRecordId: target.id,
      balanceAfter: this.points
    })
    this.persist()
    return null
  }

  // ----------------------------------------------------------------- 记一笔

  /**
   * “记一笔”：家长手动加/减分。[delta] 为负表示扣分。
   * 成功返回 null，失败返回提示文案。
   *
   * **修 B6**：原先 `this.points += delta; if (this.points < 0) this.points = 0`
   * 会**静默截断**余额，而流水照记原始 `delta` —— 例如余额 124、`delta=-9999` 时
   * 余额变 0（实际变动 −124）却记 −9999，**Σ流水 ≠ 余额，账本无法对账**。
   * 现改为**拒绝超额扣分**，与 `redeem` 的语义保持一致。
   *
   * **修 A5**：原先 `if (gain) rewardCount += 1` —— 手动加分被计成一次“奖励兑换”，
   * 但 `rewardCount` 的语义是**累计兑换次数**，只应由 `redeem` 递增。
   */
  addQuickNote(
    delta: number,
    reason: string,
    note = '',
    actor: ActorContext = { role: 'guardian' }
  ): string | null {
    if (delta === 0) {
      return '调整金额不能为 0'
    }
    if (delta < 0 && Math.abs(delta) > this.points) {
      return `积分不足，当前只有 ${this.points} 分，最多可扣 ${this.points} 分`
    }
    const gain = delta > 0
    const source: RecordSource = actor.role === 'child' ? 'child_self' : 'guardian'
    this.points += delta
    const title =
      reason.trim() === '' ? (gain ? '额外奖励' : '扣除积分') : reason.trim()
    const time = Date.now()
    this.records.unshift({
      id: this.newId('rec'),
      title,
      subtitle: recordSubtitle({ time, source, note }),
      points: delta,
      time,
      category: 'adjust',
      icon: gain ? 'plus' : 'minus',
      color: gain ? '#6fbf4b' : '#e9834b',
      source,
      operatorRole: actor.role,
      note: note.trim(),
      habitId: null,
      ruleId: null,
      wishId: null,
      reversesRecordId: null,
      balanceAfter: this.points
    })
    this.persist()
    return null
  }

  // ----------------------------------------------------------------- 心愿单

  /**
   * 兑换心愿。成功返回 true，积分不足或已兑换返回 false。
   *
   * **修 B8**：原先 `title: \`兑换：${this.shortTitle(wish.title)}\`` 把标题截断到 10 字符后
   * **永久写进流水**（「周末去游乐园玩一整天（亲子票）」→「兑换：周末去游乐园玩一…」），
   * 且没有 `wishId` 回指 —— 心愿删除后这笔扣分再也无法解释。
   * 现改为**完整标题快照 + wishId 回指**，截断交给渲染层的 ellipsis。
   */
  redeem(wish: Wish, actor: ActorContext = { role: 'guardian' }): boolean {
    if (!this.canRedeem(wish)) return false
    const source: RecordSource = actor.role === 'child' ? 'child_self' : 'guardian'
    this.points -= wish.cost
    wish.redeemed = true
    this.profile.rewardCount += 1
    const time = Date.now()
    this.records.unshift({
      id: this.newId('rec'),
      // 修 B8：完整标题，不截断
      title: `兑换：${wish.title}`,
      subtitle: recordSubtitle({ time, source, category: 'exchange' }),
      points: -wish.cost,
      time,
      category: 'exchange',
      icon: 'gift',
      color: '#f5a24b',
      source,
      operatorRole: actor.role,
      note: '',
      habitId: null,
      ruleId: null,
      // 修 B8：回指心愿，即使心愿被删除也能解释这笔支出
      wishId: wish.id,
      reversesRecordId: null,
      balanceAfter: this.points
    })
    this.persist()
    return true
  }

  addWish(title: string, cost: number, emoji: string): void {
    this.wishes.unshift({
      id: this.newId('wish'),
      title: title.trim(),
      cost,
      emoji,
      backgroundIndex: this.wishes.length % 4,
      redeemed: false
    })
    this.persist()
  }

  removeWish(wish: Wish): void {
    this.wishes = this.wishes.filter((item) => item !== wish)
    this.persist()
  }

  // --------------------------------------------------------------- 积分规则

  addRule(
    title: string,
    detail: string,
    points: number,
    icon: IconOption['icon'],
    color: string
  ): void {
    this.rules.unshift({
      id: this.newId('rule'),
      title: title.trim(),
      detail: detail.trim() === '' ? '家长约定' : detail.trim(),
      points,
      icon,
      color
    })
    this.persist()
  }

  removeRule(rule: PointRule): void {
    this.rules = this.rules.filter((item) => item !== rule)
    this.persist()
  }

  /**
   * 按规则生成一个首页习惯（规则页“加入今天的习惯”用）。
   * 成功返回 null，失败返回提示文案。
   *
   * **修 A1**：原先 `points: Math.abs(rule.points)` 把扣分规则**静默转成加分习惯** ——
   * 家长定「打人 −3 分」，孩子打人后打卡反而 **+3 分**。属产品性质级错误。
   * 扣分规则不应生成可打卡习惯，直接拒绝并给出可读文案。
   */
  addHabitFromRule(rule: PointRule): string | null {
    if (this.habits.some((habit) => habit.title === rule.title)) {
      return `“${rule.title}”已经在今天的习惯里了`
    }
    if (rule.points < 0) {
      return `“${rule.title}”是扣分规则，不能加入今天的习惯`
    }
    const parts = rule.detail.split(' · ')
    this.habits.push({
      id: this.newId('habit'),
      title: rule.title,
      points: rule.points,
      condition: parts.length > 0 ? parts[0] : rule.detail,
      limitText: parts.length > 1 ? parts[1] : '每天 1 次',
      doneText: '已完成',
      icon: rule.icon,
      color: rule.color,
      checked: false
    })
    this.persist()
    return null
  }

  // ------------------------------------------------------------------ 档案

  renameChild(name: string): void {
    const trimmed = name.trim()
    if (trimmed === '') return
    this.profile.name = trimmed
    this.persist()
  }

  // -------------------------------------------------------------- 内部工具

  private newId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${Date.now()}-${this.seq}`
  }

  private isToday(time: number): boolean {
    const date = new Date(time)
    const now = new Date()
    return (
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    )
  }

}

/** 全局唯一的状态中心。 */
export const store = new AppStore()

/**
 * 订阅状态中心的 Hook（只在页面组件里调用），
 * 页面每次 show 时也会刷新一次，保证从二级页返回后展示最新数据。
 */
export function useStore(): AppStore {
  const [, setTick] = useState(0)
  useEffect(() => store.subscribe(() => setTick((tick) => tick + 1)), [])
  useDidShow(() => setTick((tick) => tick + 1))
  return store
}

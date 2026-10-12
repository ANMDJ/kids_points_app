import type { ChildProfile, Habit, PointRecord, PointRule, Wish } from './types'
import { recordSubtitle } from './types'

/**
 * 首次启动的演示数据，数值与设计稿一致
 * （124 积分、324 好习惯、4 次奖励）。对应 Flutter lib/data/seed_data.dart。
 */
export interface SeedBundle {
  points: number
  profile: ChildProfile
  habits: Habit[]
  wishes: Wish[]
  records: PointRecord[]
  rules: PointRule[]
}

export function buildSeedData(): SeedBundle {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  const today1930 = new Date(y, m, d, 19, 30).getTime()
  const today1850 = new Date(y, m, d, 18, 50).getTime()
  const yesterday2000 = new Date(y, m, d - 1, 20, 0).getTime()
  const yesterday1910 = new Date(y, m, d - 1, 19, 10).getTime()

  // 修 A2 / A3 / E17：这里只写**结构字段**，checked / limitText / doneText 全部删除。
  // 「今天完成几次」由 records 派生（types.ts 的 habitView）：
  // 番茄钟 1/2（还能再打一次）、收书包 1/1（已达上限）、自主阅读 0/1（还没打）。
  const habits: Habit[] = [
    {
      id: 'habit-pomodoro',
      title: '番茄钟写作业',
      points: 1,
      condition: '专注 25 分钟',
      dailyLimit: 2,
      icon: 'book',
      color: '#7fbf55'
    },
    {
      id: 'habit-backpack',
      title: '自己收书包',
      points: 2,
      condition: '睡前整理好',
      dailyLimit: 1,
      icon: 'backpack',
      color: '#f5a24b'
    },
    {
      id: 'habit-reading',
      title: '自主阅读',
      points: 2,
      condition: '阅读 20 分钟',
      dailyLimit: 1,
      icon: 'stories',
      color: '#7bb0e8'
    }
  ]

  const wishes: Wish[] = [
    {
      id: 'wish-1',
      title: '限定商品 30 元优惠券（满 300 减 100）',
      cost: 40,
      emoji: '🍖',
      backgroundIndex: 0,
      redeemed: false
    },
    {
      id: 'wish-2',
      title: '汪汪零食大礼包 · 周末加餐',
      cost: 40,
      emoji: '🐶',
      backgroundIndex: 1,
      redeemed: false
    },
    {
      id: 'wish-3',
      title: '一起去游乐园玩一整天（亲子票）',
      cost: 445,
      emoji: '🎡',
      backgroundIndex: 2,
      redeemed: false
    },
    {
      id: 'wish-4',
      title: '新款积木套装（1000+ 颗粒）',
      cost: 445,
      emoji: '🧩',
      backgroundIndex: 3,
      redeemed: false
    }
  ]

  const records: PointRecord[] = [
    {
      id: 'rec-1',
      title: '番茄钟写作业',
      subtitle: recordSubtitle({
        time: today1930,
        source: 'child_self'
      }),
      points: 1,
      time: today1930,
      category: 'praise',
      icon: 'book',
      color: '#7fbf55',
      source: 'child_self',
      operatorRole: 'child',
      note: '',
      habitId: 'habit-pomodoro',
      ruleId: 'rule-1',
      wishId: null,
      reversesRecordId: null,
      balanceAfter: 124
    },
    {
      id: 'rec-2',
      title: '自己收书包',
      subtitle: recordSubtitle({
        time: today1850,
        source: 'child_self'
      }),
      points: 2,
      time: today1850,
      category: 'praise',
      icon: 'backpack',
      color: '#f5a24b',
      source: 'child_self',
      operatorRole: 'child',
      note: '',
      habitId: 'habit-backpack',
      ruleId: 'rule-2',
      wishId: null,
      reversesRecordId: null,
      balanceAfter: 123
    },
    {
      id: 'rec-3',
      title: '围棋课后作业',
      subtitle: recordSubtitle({
        time: yesterday2000,
        source: 'guardian'
      }),
      points: 5,
      time: yesterday2000,
      category: 'praise',
      icon: 'clipboard',
      color: '#8fbf6a',
      source: 'guardian',
      operatorRole: 'guardian',
      note: '',
      habitId: null,
      ruleId: 'rule-3',
      wishId: null,
      reversesRecordId: null,
      balanceAfter: 121
    },
    {
      id: 'rec-4',
      title: '兑换：小饼干',
      subtitle: recordSubtitle({
        time: yesterday1910,
        source: 'guardian',
        category: 'exchange'
      }),
      points: -30,
      time: yesterday1910,
      category: 'exchange',
      icon: 'gift',
      color: '#f5a24b',
      source: 'guardian',
      operatorRole: 'guardian',
      note: '',
      habitId: null,
      ruleId: null,
      wishId: null,
      reversesRecordId: null,
      balanceAfter: 116
    }
  ]

  // 修 E15：规则同样只存 condition ＋ dailyLimit（detail 由 ruleDetail 派生）。
  // ⚠️ 语义变更（**必须留档**）：rule-3 原为「完成并检查 · 每周 1 次」——
  // 权威 schema（backend/prisma/schema.prisma 的 PointRule/RuleTemplate）只有 dailyLimit，
  // **没有周期字段**，后端模板库同样把周意涵放在标题/条件里（如「周末大扫除」也是 dailyLimit=1）。
  // 因此这里改为 dailyLimit: 1，派生出来的展示串是「完成并检查 · 每天 1 次」——
  // 「每周」不再被表达，不是漏改，是当前模型表达不了（见 docs/design/03 §E15「限制」）。
  const rules: PointRule[] = [
    {
      id: 'rule-1',
      title: '番茄钟写作业',
      condition: '专注 25 分钟',
      dailyLimit: 2,
      points: 1,
      icon: 'book',
      color: '#f6c64a'
    },
    {
      id: 'rule-2',
      title: '自己收书包',
      condition: '睡前整理好',
      dailyLimit: 1,
      points: 2,
      icon: 'backpack',
      color: '#e9834b'
    },
    {
      id: 'rule-3',
      title: '围棋课后作业',
      condition: '完成并检查',
      dailyLimit: 1,
      points: 5,
      icon: 'clipboard',
      color: '#7fbf55'
    },
    {
      id: 'rule-4',
      title: '自主阅读',
      condition: '阅读 20 分钟',
      dailyLimit: 1,
      points: 2,
      icon: 'stories',
      color: '#7fbf55'
    }
  ]

  return {
    points: 124,
    profile: {
      name: '萌新铲屎官的小可爱',
      childId: '38038532',
      goodHabitCount: 324,
      rewardCount: 4
    },
    habits,
    wishes,
    records,
    rules
  }
}

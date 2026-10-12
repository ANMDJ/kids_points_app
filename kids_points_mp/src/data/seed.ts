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

  const habits: Habit[] = [
    {
      id: 'habit-pomodoro',
      title: '番茄钟写作业',
      points: 1,
      condition: '专注 25 分钟',
      limitText: '每天最多 2 次',
      doneText: '今日已完成 1 次',
      icon: 'book',
      color: '#7fbf55',
      checked: true
    },
    {
      id: 'habit-backpack',
      title: '自己收书包',
      points: 2,
      condition: '睡前整理好',
      limitText: '每天 1 次',
      doneText: '已完成',
      icon: 'backpack',
      color: '#f5a24b',
      checked: true
    },
    {
      id: 'habit-reading',
      title: '自主阅读',
      points: 2,
      condition: '阅读 20 分钟',
      limitText: '每天 1 次',
      doneText: '已完成',
      icon: 'stories',
      color: '#7bb0e8',
      checked: false
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

  const rules: PointRule[] = [
    {
      id: 'rule-1',
      title: '番茄钟写作业',
      detail: '专注 25 分钟 · 每天最多 2 次',
      points: 1,
      icon: 'book',
      color: '#f6c64a'
    },
    {
      id: 'rule-2',
      title: '自己收书包',
      detail: '睡前整理好 · 每天 1 次',
      points: 2,
      icon: 'backpack',
      color: '#e9834b'
    },
    {
      id: 'rule-3',
      title: '围棋课后作业',
      detail: '完成并检查 · 每周 1 次',
      points: 5,
      icon: 'clipboard',
      color: '#7fbf55'
    },
    {
      id: 'rule-4',
      title: '自主阅读',
      detail: '阅读 20 分钟 · 每天 1 次',
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

import { View, Text } from '@tarojs/components'
import { redirectTo, stopPullDownRefresh, usePullDownRefresh } from '@tarojs/taro'
import { useEffect } from 'react'

import AppBottomNav from '../../components/AppBottomNav'
import GradientPage from '../../components/GradientPage'
import HabitTile from '../../components/HabitTile'
import AnimatedPointText from '../../components/AnimatedPointText'
import PointsJar from '../../components/PointsJar'
import SoftButton from '../../components/SoftButton'
import ReadStatusBanner from '../../components/ReadStatusBanner'
import { SectionTitle } from '../../components/PageHeader'
import QuickNoteSheet from '../../sheets/QuickNoteSheet'
import { useStore } from '../../data/store'
import type { Habit } from '../../data/types'
import { toast } from '../../utils/toast'
import { switchTab } from '../../utils/nav'
import { useAuthGate } from '../../utils/useAuthGate'
import { useSheet } from '../../utils/useSheet'
import './index.scss'

/** 首页：当前可用积分 + 积分罐 + 今天的习惯 + 记一笔。 */
export default function Home() {
  const store = useStore()
  const sheet = useSheet()

  // W9-B：登录闸门。会话没就绪时 **先** 离开这一屏 —— 下面任何渲染都可能
  // 把"还没确认身份"的数据画成用户的积分。
  useAuthGate()

  // W8-B：引导闸门。只有服务端明确说 `onboarded: false` 才重定向
  // （`needsOnboarding` 在状态未知 / 拉取失败时是 false —— 一次超时不该把人
  // 锁进一个完不成的引导）。`redirectTo` 让页面栈只留一层，与底部导航同策略。
  useEffect(() => {
    if (!store.needsOnboarding) return
    void redirectTo({ url: '/pages/onboarding/index' })
  }, [store.needsOnboarding])

  // 与 Flutter 首页一致：下拉是新数据入口；失败时由 ReadStatusBanner 显示原因，
  // 已有内容保留（store 内部保证），这里只负责收起原生下拉动画。
  usePullDownRefresh(() => {
    void store.refreshFromServer().finally(() => {
      stopPullDownRefresh()
    })
  })

  // 修 A2 / A3 / E17：首页消费**派生视图**（checked / limitText / doneText 都由
  // 结构字段 ＋ 当天流水现算），习惯上那些状态字段已不复存在。
  const habits = store.habitViews()
  const doneCount = habits.filter((habit) => habit.checked).length

  const handleCheckIn = async (habit: Habit) => {
    const message = await store.submitCheckIn(habit)
    if (message) {
      toast(message)
    } else {
      toast(`太棒了！“${habit.title}”+${habit.points} 积分`)
    }
  }

  const handleUndo = async (habit: Habit) => {
    // 修 B7：撤销改为写入一条冲正流水（原记录保留），失败时给出可读原因。
    // 这里不再预读 `habit.checked` —— 能不能撤销由 store 按当天流水判定（修 A3）。
    const message = await store.submitUndoCheckIn(habit)
    toast(message ?? `已撤销“${habit.title}”的打卡`)
  }

  return (
    <>
      <GradientPage
        safeBottom
        footer={
          <AppBottomNav
            currentIndex={0}
            onChanged={(index) => switchTab(index, 0)}
          />
        }
      >
        <View className='kp-home'>
          <ReadStatusBanner />
          <Text className='kp-home__caption'>当前可用积分</Text>
          <View className='kp-home__points'>
            <AnimatedPointText
              value={store.points}
              className='kp-home__points-text'
            />
          </View>
          <View className='kp-home__jar'>
            <PointsJar width={168} />
          </View>
          <SectionTitle
            title='今天的习惯'
            trailing={
              <Text className='kp-home__progress'>
                {`已完成 ${doneCount}/${habits.length}`}
              </Text>
            }
          />
          {habits.map((habit) => (
            <HabitTile
              key={habit.id}
              habit={habit}
              onClick={() => handleCheckIn(habit)}
              onLongPress={() => handleUndo(habit)}
            />
          ))}
          <View className='kp-home__button'>
            <SoftButton
              label='记一笔'
              icon='editNote'
              onClick={() => {
                if (store.isAdjustReadOnly) {
                  toast(store.adjustReadOnlyWriteMessage)
                  return
                }
                sheet.show()
              }}
            />
          </View>
          <View className='kp-home__hint'>
            <Text className='kp-home__hint-text'>
              点习惯卡片打卡 · 长按可撤销
            </Text>
          </View>
          <View className='kp-nav-space' />
        </View>
      </GradientPage>
      {/* 弹窗放在 GradientPage 外面：内容层 z-index 低于底部导航，
          放在里面会被导航栏盖住，拆成兄弟节点才能整屏遮罩 */}
      {sheet.open ? (
        <QuickNoteSheet visible={sheet.visible} onClose={() => sheet.hide()} />
      ) : null}
    </>
  )
}

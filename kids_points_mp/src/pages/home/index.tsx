import { View, Text } from '@tarojs/components'
import { stopPullDownRefresh, usePullDownRefresh } from '@tarojs/taro'

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
import { useSheet } from '../../utils/useSheet'
import './index.scss'

/** 首页：当前可用积分 + 积分罐 + 今天的习惯 + 记一笔。 */
export default function Home() {
  const store = useStore()
  const sheet = useSheet()

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

  const handleCheckIn = (habit: Habit) => {
    if (store.isReadOnly) {
      toast(store.readOnlyWriteMessage)
      return
    }
    const message = store.checkIn(habit)
    if (message) {
      toast(message)
    } else {
      toast(`太棒了！“${habit.title}”+${habit.points} 积分`)
    }
  }

  const handleUndo = (habit: Habit) => {
    if (store.isReadOnly) {
      toast(store.readOnlyWriteMessage)
      return
    }
    // 修 B7：撤销改为写入一条冲正流水（原记录保留），失败时给出可读原因。
    // 这里不再预读 `habit.checked` —— 能不能撤销由 store 按当天流水判定（修 A3）。
    const message = store.undoCheckIn(habit)
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
                if (store.isReadOnly) {
                  toast(store.readOnlyWriteMessage)
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

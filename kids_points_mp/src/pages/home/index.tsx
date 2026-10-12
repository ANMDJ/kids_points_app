import { View, Text } from '@tarojs/components'

import AppBottomNav from '../../components/AppBottomNav'
import GradientPage from '../../components/GradientPage'
import HabitTile from '../../components/HabitTile'
import AnimatedPointText from '../../components/AnimatedPointText'
import PointsJar from '../../components/PointsJar'
import SoftButton from '../../components/SoftButton'
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

  const doneCount = store.habits.filter((habit) => habit.checked).length

  const handleCheckIn = (habit: Habit) => {
    const message = store.checkIn(habit)
    if (message) {
      toast(message)
    } else {
      toast(`太棒了！“${habit.title}”+${habit.points} 积分`)
    }
  }

  const handleUndo = (habit: Habit) => {
    if (!habit.checked) return
    // 修 B7：撤销改为写入一条冲正流水（原记录保留），失败时给出可读原因
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
                {`已完成 ${doneCount}/${store.habits.length}`}
              </Text>
            }
          />
          {store.habits.map((habit) => (
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
              onClick={() => sheet.show()}
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

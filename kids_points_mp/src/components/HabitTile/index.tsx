import { View, Text } from '@tarojs/components'

import AppCard from '../AppCard'
import Icon from '../Icon'
import type { HabitView } from '../../data/types'
import './index.scss'

export interface HabitTileProps {
  /** 派生视图：`checked` / `limitText` / `doneText` 都由结构字段 ＋ 当天流水现算（修 A2 / A3 / E17） */
  habit: HabitView
  onClick: () => void
  onLongPress?: () => void
}

/** 首页“今天的习惯”列表项：左侧打卡圆勾 + 名称/细则 + 右侧分值。 */
export default function HabitTile({
  habit,
  onClick,
  onLongPress
}: HabitTileProps) {
  // 2026-11-10（用户第 10 条）：进度由派生视图给（`0/2 → 1/2 → 2/2`），
  // 组件不再自己拼「达上限才显示已完成」—— 那正是「完成一个也看不出来」的成因。
  const subtitle = `${habit.condition} · ${habit.progressText}`

  return (
    <AppCard
      marginBottom={12}
      onClick={onClick}
      onLongPress={onLongPress}
      className='kp-habit'
    >
      <View className='kp-habit__row'>
        <View className={`kp-habit__check ${habit.checked ? 'is-done' : ''}`}>
          <Icon
            name='check'
            size={17}
            color={habit.checked ? '#ffffff' : '#cbd2c2'}
          />
        </View>
        <View className='kp-habit__body'>
          <Text className='kp-habit__title kp-ellipsis'>{habit.title}</Text>
          <Text className='kp-habit__subtitle kp-ellipsis'>{subtitle}</Text>
        </View>
        <Text className='kp-habit__amount'>{`+${habit.points}`}</Text>
      </View>
    </AppCard>
  )
}

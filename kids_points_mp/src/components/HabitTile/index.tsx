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
  const subtitle = habit.checked
    ? `${habit.condition} · ${habit.doneText}`
    : `${habit.condition} · ${habit.limitText}`

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

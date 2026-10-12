import { View, Text } from '@tarojs/components'

import Icon from '../Icon'
import type { IconName } from '../Icon/icons'
import './index.scss'

interface NavItem {
  icon: IconName
  activeIcon: IconName
  label: string
}

/** 首页 / 心愿单 / 我的，与 Flutter AppBottomNav 一致。 */
const ITEMS: NavItem[] = [
  { icon: 'home', activeIcon: 'homeFill', label: '首页' },
  { icon: 'heart', activeIcon: 'heartFill', label: '心愿单' },
  { icon: 'smile', activeIcon: 'smile', label: '我的' }
]

export interface AppBottomNavProps {
  currentIndex: number
  onChanged: (index: number) => void
}

/** 底部导航：白底 + 上圆角 + 上投影，选中项为薄荷绿。 */
export default function AppBottomNav({
  currentIndex,
  onChanged
}: AppBottomNavProps) {
  return (
    <View className='kp-nav'>
      <View className='kp-nav__row'>
        {ITEMS.map((item, index) => {
          const active = index === currentIndex
          return (
            <View
              key={item.label}
              className={`kp-nav__item ${active ? 'is-active' : ''}`}
              onClick={() => onChanged(index)}
            >
              <Icon
                name={active ? item.activeIcon : item.icon}
                size={23}
                color={active ? '#7fbf55' : '#b9c2b0'}
              />
              <Text className='kp-nav__label'>{item.label}</Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}

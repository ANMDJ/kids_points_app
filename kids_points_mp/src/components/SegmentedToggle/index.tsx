import { View, Text } from '@tarojs/components'

import { rpx } from '../../utils/unit'
import './index.scss'

export interface SegmentedToggleProps {
  leftLabel: string
  rightLabel: string
  leftSelected: boolean
  onChanged: (leftSelected: boolean) => void
}

/** 二选一分段控件（奖励 / 扣除）。 */
export default function SegmentedToggle({
  leftLabel,
  rightLabel,
  leftSelected,
  onChanged
}: SegmentedToggleProps) {
  return (
    <View className='kp-segment'>
      <View
        className={`kp-segment__item ${leftSelected ? 'is-selected' : ''}`}
        style={{ borderRadius: rpx(999) }}
        onClick={() => onChanged(true)}
      >
        <Text className='kp-segment__label kp-segment__label--gain'>
          {leftLabel}
        </Text>
      </View>
      <View
        className={`kp-segment__item ${leftSelected ? '' : 'is-selected'}`}
        style={{ borderRadius: rpx(999) }}
        onClick={() => onChanged(false)}
      >
        <Text className='kp-segment__label kp-segment__label--spend'>
          {rightLabel}
        </Text>
      </View>
    </View>
  )
}

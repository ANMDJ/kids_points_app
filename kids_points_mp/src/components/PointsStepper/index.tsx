import { View, Text } from '@tarojs/components'

import Icon from '../Icon'
import { rpx } from '../../utils/unit'
import './index.scss'

export interface PointsStepperProps {
  value: number
  onChanged: (value: number) => void
  min?: number
  max?: number
  suffix?: string
}

/** 圆形加减按钮 + 数值，用于编辑积分值。 */
export default function PointsStepper({
  value,
  onChanged,
  min = 1,
  max = 999,
  suffix = '积分'
}: PointsStepperProps) {
  const canMinus = value > min
  const canPlus = value < max

  return (
    <View className='kp-stepper'>
      <View
        className={`kp-stepper__button ${canMinus ? '' : 'is-disabled'}`}
        onClick={() => {
          if (canMinus) onChanged(value - 1)
        }}
      >
        <Icon name='minus' size={22} color={canMinus ? '#3f6b2e' : '#b6bdb0'} />
      </View>
      <View className='kp-stepper__center'>
        <Text className='kp-stepper__value'>{value}</Text>
        <Text className='kp-stepper__suffix'>{suffix}</Text>
      </View>
      <View
        className={`kp-stepper__button ${canPlus ? '' : 'is-disabled'}`}
        onClick={() => {
          if (canPlus) onChanged(value + 1)
        }}
      >
        <Icon name='plus' size={22} color={canPlus ? '#3f6b2e' : '#b6bdb0'} />
      </View>
    </View>
  )
}

// 供外部复用按钮尺寸（保持与设计稿一致）
export const STEPPER_BUTTON_SIZE = rpx(42)

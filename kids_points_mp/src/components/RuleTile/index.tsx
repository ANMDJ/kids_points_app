import { View, Text } from '@tarojs/components'

import AppCard from '../AppCard'
import Icon from '../Icon'
import type { PointRule } from '../../data/types'
import { amountText } from '../../data/types'
import { withAlpha } from '../../utils/color'
import '../RecordTile/index.scss'
import './index.scss'

export interface RuleTileProps {
  rule: PointRule
  onClick?: () => void
  onLongPress?: () => void
}

/** 积分规则列表项：图标 + 名称/细则 + 分值。 */
export default function RuleTile({ rule, onClick, onLongPress }: RuleTileProps) {
  const gain = rule.points >= 0

  return (
    <AppCard
      radius={16}
      marginBottom={10}
      onClick={onClick}
      onLongPress={onLongPress}
      className='kp-tile kp-rule'
    >
      <View className='kp-tile__row'>
        <View
          className='kp-tile__icon'
          style={{ backgroundColor: withAlpha(rule.color, 34 / 255) }}
        >
          <Icon name={rule.icon} size={20} color={rule.color} />
        </View>
        <View className='kp-tile__body'>
          <Text className='kp-tile__title kp-ellipsis'>{rule.title}</Text>
          <Text className='kp-tile__subtitle kp-ellipsis'>{rule.detail}</Text>
        </View>
        <Text
          className='kp-tile__amount'
          style={{ color: gain ? '#6fbf4b' : '#e9834b' }}
        >
          {amountText(rule.points)}
        </Text>
      </View>
    </AppCard>
  )
}

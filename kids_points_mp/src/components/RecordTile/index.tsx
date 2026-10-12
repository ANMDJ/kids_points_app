import { View, Text } from '@tarojs/components'

import AppCard from '../AppCard'
import Icon from '../Icon'
import type { PointRecord } from '../../data/types'
import { amountText } from '../../data/types'
import { withAlpha } from '../../utils/color'
import './index.scss'

export interface RecordTileProps {
  record: PointRecord
}

/** 积分记录的一条流水。 */
export default function RecordTile({ record }: RecordTileProps) {
  const gain = record.points >= 0

  return (
    <AppCard
      radius={16}
      padding={[14, 12]}
      marginBottom={10}
      className='kp-tile'
    >
      <View className='kp-tile__row'>
        <View
          className='kp-tile__icon'
          style={{ backgroundColor: withAlpha(record.color, 32 / 255) }}
        >
          <Icon name={record.icon} size={20} color={record.color} />
        </View>
        <View className='kp-tile__body'>
          <Text className='kp-tile__title kp-ellipsis'>{record.title}</Text>
          <Text className='kp-tile__subtitle kp-ellipsis'>
            {record.subtitle}
          </Text>
        </View>
        <Text
          className='kp-tile__amount'
          style={{ color: gain ? '#6fbf4b' : '#e9834b' }}
        >
          {amountText(record.points)}
        </Text>
      </View>
    </AppCard>
  )
}

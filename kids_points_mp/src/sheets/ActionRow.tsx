import { Text, View } from '@tarojs/components'

import Icon from '../components/Icon'
import type { IconName } from '../components/Icon/icons'
import './sheets.scss'

export interface ActionRowProps {
  icon: IconName
  label: string
  danger?: boolean
  onClick: () => void
}

/** 规则长按菜单里的一行操作。 */
export default function ActionRow({
  icon,
  label,
  danger = false,
  onClick
}: ActionRowProps) {
  return (
    <View
      className={`kp-sheet-row ${danger ? 'is-danger' : ''}`}
      onClick={onClick}
    >
      <Icon name={icon} size={20} color={danger ? '#e9834b' : '#3f6b2e'} />
      <Text className='kp-sheet-row__label'>{label}</Text>
    </View>
  )
}

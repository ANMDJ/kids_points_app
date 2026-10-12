import { View, Text } from '@tarojs/components'

import Icon from '../Icon'
import type { IconName } from '../Icon/icons'
import { rpx } from '../../utils/unit'
import './index.scss'

export interface SoftButtonProps {
  label: string
  icon?: IconName
  onClick?: () => void
  enabled?: boolean
  /** 设计稿 px，默认 52 */
  height?: number
  className?: string
}

/**
 * 主操作按钮：浅绿渐变胶囊（“记一笔”“新增心愿”“新增规则”）。
 * 对应 Flutter lib/widgets/soft_button.dart。
 */
export default function SoftButton({
  label,
  icon,
  onClick,
  enabled = true,
  height = 52,
  className = ''
}: SoftButtonProps) {
  const active = enabled && Boolean(onClick)

  return (
    <View
      className={`kp-soft-button ${active ? '' : 'is-disabled'} ${className}`}
      style={{ height: rpx(height), borderRadius: rpx(height / 2) }}
      onClick={() => {
        if (active && onClick) onClick()
      }}
    >
      {icon ? <Icon name={icon} size={19} color='#3f6b2e' /> : null}
      <Text className='kp-soft-button__label'>{label}</Text>
    </View>
  )
}

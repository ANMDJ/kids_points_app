import { View } from '@tarojs/components'
import type { CSSProperties, ReactNode } from 'react'

import { rpx, symmetricPadding } from '../../utils/unit'
import './index.scss'

export interface AppCardProps {
  children: ReactNode
  /** Flutter EdgeInsets.symmetric：padding=[horizontal, vertical] */
  padding?: [number, number]
  /** Flutter EdgeInsets.fromLTRB：[left, top, right, bottom] */
  paddingLtrb?: [number, number, number, number]
  /** 底部外边距（列表间距） */
  marginBottom?: number
  radius?: number
  color?: string
  border?: boolean
  onClick?: () => void
  onLongPress?: () => void
  className?: string
  style?: CSSProperties
}

/**
 * 统一的白色圆角卡片容器（列表项、战绩卡都用它）。
 * 对应 Flutter lib/widgets/app_card.dart。
 */
export default function AppCard({
  children,
  padding = [14, 13],
  paddingLtrb,
  marginBottom = 0,
  radius = 18,
  color = '#ffffff',
  border = true,
  onClick,
  onLongPress,
  className = '',
  style
}: AppCardProps) {
  const paddingCss = paddingLtrb
    ? `${rpx(paddingLtrb[1])} ${rpx(paddingLtrb[2])} ${rpx(paddingLtrb[3])} ${rpx(paddingLtrb[0])}`
    : symmetricPadding(padding[0], padding[1])

  return (
    <View
      className={`kp-card ${border ? 'is-border' : ''} ${className}`}
      style={{
        padding: paddingCss,
        marginBottom: rpx(marginBottom),
        borderRadius: rpx(radius),
        backgroundColor: color,
        ...style
      }}
      onClick={onClick}
      onLongPress={onLongPress}
    >
      {children}
    </View>
  )
}

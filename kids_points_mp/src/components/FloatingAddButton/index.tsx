import { View, Text } from '@tarojs/components'

import Icon from '../Icon'
import type { IconName } from '../Icon/icons'
import { rpx } from '../../utils/unit'
import './index.scss'

export interface FloatingAddButtonProps {
  label: string
  icon?: IconName
  /** 展开成整行胶囊按钮（滚动到底部时） */
  expanded: boolean
  /** 展开后的宽度，由页面按左右留白算好后传入 */
  expandedWidth: number
  onClick?: () => void
  /** 按钮高度，收起时也是宽度（正圆） */
  height?: number
}

/**
 * 右下角的悬浮“新增”按钮：收起时是圆形悬浮按钮，展开时是整行胶囊按钮。
 * 宽度、阴影、图标大小、文字都做补间动画（对应 Flutter FloatingAddButton）。
 */
export default function FloatingAddButton({
  label,
  icon,
  expanded,
  expandedWidth,
  onClick,
  height = 52
}: FloatingAddButtonProps) {
  const active = !!onClick

  return (
    <View
      className={`kp-fab ${expanded ? 'is-expanded' : ''}`}
      style={{
        width: rpx(expanded ? expandedWidth : height),
        height: rpx(height),
        borderRadius: rpx(height / 2),
        opacity: active ? 1 : 0.55,
        boxShadow: expanded
          ? `0 ${rpx(8)} ${rpx(16)} rgba(127, 191, 85, 0.2)`
          : `0 ${rpx(10)} ${rpx(22)} ${rpx(1)} rgba(107, 174, 72, 0.3)`
      }}
      onClick={onClick}
    >
      {icon ? (
        <View
          className={`kp-fab__icon ${expanded ? '' : 'is-collapsed'}`}
          style={{ marginRight: expanded ? rpx(8) : 0 }}
        >
          <Icon name={icon} size={19} color='#3f6b2e' />
        </View>
      ) : null}
      <Text className={`kp-fab__label ${expanded ? 'is-visible' : ''}`}>
        {label}
      </Text>
    </View>
  )
}

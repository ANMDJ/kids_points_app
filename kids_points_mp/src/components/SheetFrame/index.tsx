import { View, Text } from '@tarojs/components'
import type { ReactNode } from 'react'

import Icon from '../Icon'
import type { IconName } from '../Icon/icons'
import { getSafeBottom } from '../../utils/layout'
import { DESIGN_WIDTH, getWindowSize, rpx } from '../../utils/unit'
import './index.scss'

export interface SheetFrameProps {
  /** 是否展开（关闭时先播放收起动画，由页面在动画结束后卸载） */
  visible: boolean
  title: string
  subtitle?: string
  children: ReactNode
  onClose?: () => void
  actionLabel?: string
  actionIcon?: IconName
  onAction?: () => void
}

/**
 * 面板底部内边距：设计稿的 18 + 全面屏的底部安全区。
 *
 * 安全区拿到的是屏幕 px，这里换算回设计稿 px 再交给 rpx()，
 * 避免在 calc() 里混用 rpx 与 px（小程序端的 calc 解析容易踩坑）。
 */
function bottomPadding(): number {
  const bottom = getSafeBottom()
  if (bottom <= 0) return 18
  return 18 + (bottom * DESIGN_WIDTH) / getWindowSize().windowWidth
}

/**
 * 底部弹窗统一外壳：遮罩 + 圆角白底 + 标题 + 关闭按钮 + 底部主按钮。
 * 对应 Flutter lib/widgets/sheet_frame.dart（showModalBottomSheet 的替代）。
 */
export default function SheetFrame({
  visible,
  title,
  subtitle,
  children,
  onClose,
  actionLabel,
  actionIcon,
  onAction
}: SheetFrameProps) {
  return (
    <View
      className={`kp-sheet ${visible ? 'is-visible' : ''}`}
      catchMove
    >
      <View className='kp-sheet__mask' onClick={onClose} />
      <View
        className='kp-sheet__panel'
        style={{ paddingBottom: rpx(bottomPadding()) }}
      >
        <View className='kp-sheet__handle' />
        <View className='kp-sheet__header'>
          <View className='kp-sheet__titles'>
            <Text className='kp-sheet__title'>{title}</Text>
            {subtitle ? (
              <Text className='kp-sheet__subtitle'>{subtitle}</Text>
            ) : null}
          </View>
          <View className='kp-sheet__close' onClick={onClose}>
            <Icon name='close' size={20} color='#6e7568' />
          </View>
        </View>
        <View className='kp-sheet__body'>
          <View className='kp-sheet__scroll'>
            <View className='kp-sheet__content'>{children}</View>
          </View>
        </View>
        {actionLabel ? (
          <View
            className='kp-sheet__action'
            style={{ height: rpx(50), borderRadius: rpx(26) }}
            onClick={onAction}
          >
            {actionIcon ? (
              <View className='kp-sheet__action-icon'>
                <Icon name={actionIcon} size={18} color='#3f6b2e' />
              </View>
            ) : null}
            <Text className='kp-sheet__action-label'>{actionLabel}</Text>
          </View>
        ) : null}
      </View>
    </View>
  )
}

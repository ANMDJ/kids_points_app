import { View } from '@tarojs/components'
import type { ReactNode } from 'react'

import LeafDecoration from '../LeafDecoration'
import './index.scss'

export interface GradientPageProps {
  children: ReactNode
  /** 右下角叶子装饰（Flutter GradientPage.showLeaves） */
  showLeaves?: boolean
  safeTop?: boolean
  safeBottom?: boolean
  /** 固定在底部的内容（自定义导航栏 / 底部操作条） */
  footer?: ReactNode
  className?: string
}

/**
 * 页面统一背景：浅绿到奶白渐变 + 顶部安全区 + 右下角手绘叶子装饰。
 *
 * 渐变层和叶子都用 position: fixed 铺满视口，所以页面滚动时背景不动，
 * 与 Flutter 里“背景固定在容器上、列表在容器内滚动”的观感一致。
 */
export default function GradientPage({
  children,
  showLeaves = true,
  safeTop = true,
  safeBottom = false,
  footer,
  className = ''
}: GradientPageProps) {
  const contentClass = [
    'kp-gradient__content',
    safeTop ? 'is-safe-top' : '',
    safeBottom ? 'is-safe-bottom' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <View className={`kp-gradient ${className}`}>
      <View className='kp-gradient__bg' />
      {showLeaves ? <LeafDecoration size={132} /> : null}
      <View className={contentClass}>{children}</View>
      {footer ? <View className='kp-gradient__footer'>{footer}</View> : null}
    </View>
  )
}

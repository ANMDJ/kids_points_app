import { View, Text } from '@tarojs/components'
import type { ReactNode } from 'react'

import Icon from '../Icon'
import './index.scss'

export interface PageHeaderProps {
  title: string
  onBack?: () => void
  /** 右侧按钮区（宽度固定 56，与左侧对齐） */
  trailing?: ReactNode
  className?: string
}

/** 二级页顶部栏：返回箭头 + 居中标题 + 可选右侧按钮。 */
export default function PageHeader({
  title,
  onBack,
  trailing,
  className = ''
}: PageHeaderProps) {
  return (
    <View className={`kp-header ${className}`}>
      <View className='kp-header__side'>
        {onBack ? (
          <View className='kp-header__back' onClick={onBack}>
            <Icon name='chevronLeft' size={20} color='#33382f' />
          </View>
        ) : null}
      </View>
      <View className='kp-header__center'>
        <Text className='kp-header__title'>{title}</Text>
      </View>
      <View className='kp-header__side kp-header__side--right'>{trailing}</View>
    </View>
  )
}

export interface SectionTitleProps {
  title: string
  trailing?: ReactNode
  className?: string
}

/** 小节标题，例如“今天的习惯”。 */
export function SectionTitle({
  title,
  trailing,
  className = ''
}: SectionTitleProps) {
  return (
    <View className={`kp-section-title ${className}`}>
      <Text className='kp-section-title__text'>{title}</Text>
      <View className='kp-section-title__trailing'>{trailing}</View>
    </View>
  )
}

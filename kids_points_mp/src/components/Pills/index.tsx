import { View, Text } from '@tarojs/components'

import { rpx, symmetricPadding } from '../../utils/unit'
import './index.scss'

export interface SmallPillProps {
  label: string
  /** 实心（薄荷绿）样式，用于“兑换” */
  filled?: boolean
  onClick?: () => void
  /** Flutter EdgeInsets.symmetric，默认 [14, 6] */
  padding?: [number, number]
}

/** 小胶囊标签：心愿卡上的“兑换 / 还差 N / 已兑换”。 */
export function SmallPill({
  label,
  filled = false,
  onClick,
  padding = [14, 6]
}: SmallPillProps) {
  return (
    <View
      className={`kp-pill ${filled ? 'is-filled' : ''}`}
      style={{
        padding: symmetricPadding(padding[0], padding[1]),
        borderRadius: rpx(999)
      }}
      onClick={onClick}
    >
      <Text className='kp-pill__label'>{label}</Text>
    </View>
  )
}

export interface SoftChipProps {
  label: string
  selected: boolean
  onClick: () => void
}

/** 可选择的筛选胶囊（记录页的“全部 / 表扬 / 兑换 / 调整”）。 */
export function SoftChip({ label, selected, onClick }: SoftChipProps) {
  return (
    <View
      className={`kp-chip ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
    >
      <Text className='kp-chip__label'>{label}</Text>
    </View>
  )
}

export interface QuickTagProps {
  label: string
  selected: boolean
  onClick: () => void
}

/** 快捷标签（“记一笔”弹窗里的常用事由 / 快选额度）。 */
export function QuickTag({ label, selected, onClick }: QuickTagProps) {
  return (
    <View
      className={`kp-tag ${selected ? 'is-selected' : ''}`}
      onClick={onClick}
    >
      <Text className='kp-tag__label'>{label}</Text>
    </View>
  )
}

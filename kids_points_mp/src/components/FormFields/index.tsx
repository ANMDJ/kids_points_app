import { Input, Text, Textarea, View } from '@tarojs/components'

import Icon from '../Icon'
import type { IconOption } from '../../data/types'
import { withAlpha } from '../../utils/color'
import { rpx } from '../../utils/unit'
import './index.scss'

// --------------------------------------------------------------------- 标签

export interface FieldLabelProps {
  text: string
}

/** 表单小节标题。 */
export function FieldLabel({ text }: FieldLabelProps) {
  return <Text className='kp-field__label'>{text}</Text>
}

// ------------------------------------------------------------------- 输入框

export interface SoftTextFieldProps {
  value: string
  onChange: (value: string) => void
  hint?: string
  /** 1 = 单行输入，>1 = 多行文本域 */
  maxLines?: number
  /** 数字键盘（积分值等） */
  digit?: boolean
  /** 密码输入（家长 PIN）：内容以圆点显示 */
  password?: boolean
  /** 最大输入长度；不传则沿用平台默认（140），**不改**既有输入框的行为 */
  maxLength?: number
  className?: string
}

/** 圆角无边框输入框，和整体风格统一。 */
export function SoftTextField({
  value,
  onChange,
  hint,
  maxLines = 1,
  digit = false,
  password = false,
  maxLength,
  className = ''
}: SoftTextFieldProps) {
  const shared = {
    value,
    placeholder: hint,
    placeholderClass: 'kp-field__placeholder'
  }
  // ★ 单行 / 多行的「文字垂直居中」对策不同，类名必须分开（原因见 index.scss 顶部注释）：
  //   单行走 `--line`（height ＝ line-height ⇒ 行盒铺满整框，小程序里也居中），
  //   多行走 `--area`（上下 padding + 正文行高，第一行贴着顶部才对）。
  const lineClassName = `kp-field__input kp-field__input--line ${className}`
  const areaClassName = `kp-field__input kp-field__input--area ${className}`

  if (maxLines > 1) {
    return (
      <Textarea
        {...shared}
        className={areaClassName}
        maxlength={-1}
        autoHeight
        disableDefaultPadding
        style={{ minHeight: rpx(24 * maxLines) }}
        onInput={(event) => onChange(event.detail.value)}
      />
    )
  }

  return (
    <Input
      {...shared}
      className={lineClassName}
      type={digit ? 'number' : 'text'}
      password={password}
      {...(maxLength !== undefined ? { maxlength: maxLength } : {})}
      onInput={(event) => onChange(event.detail.value)}
    />
  )
}

// ------------------------------------------------------------- 图标 / emoji

/** 规则可选图标（也是新习惯的默认图标来源）。 */
export const ruleIconOptions: IconOption[] = [
  { icon: 'book', color: '#f6c64a' },
  { icon: 'backpack', color: '#e9834b' },
  { icon: 'clipboard', color: '#7fbf55' },
  { icon: 'stories', color: '#7bb0e8' },
  { icon: 'palette', color: '#e58fb0' },
  { icon: 'music', color: '#9b8be8' },
  { icon: 'basketball', color: '#f5a24b' },
  { icon: 'spray', color: '#62c1b8' }
]

export const wishEmojis = [
  '🎁',
  '🍖',
  '🐶',
  '🍦',
  '🧩',
  '🎡',
  '📚',
  '🚲',
  '🎮',
  '🍿',
  '⚽',
  '🎨'
]

export interface IconPickerProps {
  selectedIndex: number
  onSelected: (index: number) => void
}

/** 图标选择器。 */
export function IconPicker({ selectedIndex, onSelected }: IconPickerProps) {
  return (
    <View className='kp-picker'>
      {ruleIconOptions.map((option, index) => {
        const selected = index === selectedIndex
        return (
          <View
            key={option.icon}
            className={`kp-picker__item ${selected ? 'is-selected' : ''}`}
            style={{
              backgroundColor: withAlpha(option.color, (selected ? 60 : 30) / 255),
              borderColor: selected ? option.color : 'transparent'
            }}
            onClick={() => onSelected(index)}
          >
            <Icon name={option.icon} size={21} color={option.color} />
          </View>
        )
      })}
    </View>
  )
}

export interface EmojiPickerProps {
  selected: string
  onSelected: (emoji: string) => void
}

/** 心愿插画的 emoji 选择器。 */
export function EmojiPicker({ selected, onSelected }: EmojiPickerProps) {
  return (
    <View className='kp-picker'>
      {wishEmojis.map((emoji) => {
        const isSelected = emoji === selected
        return (
          <View
            key={emoji}
            className={`kp-picker__item kp-picker__item--emoji ${
              isSelected ? 'is-selected-soft' : ''
            }`}
            onClick={() => onSelected(emoji)}
          >
            <Text className='kp-picker__emoji'>{emoji}</Text>
          </View>
        )
      })}
    </View>
  )
}

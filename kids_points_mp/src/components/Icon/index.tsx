import { View } from '@tarojs/components'
import type { CSSProperties } from 'react'

import { getIcon } from './icons'
import type { IconName } from './icons'
import { svgDataUri } from '../../utils/base64'
import { rpx } from '../../utils/unit'
import './index.scss'

export interface IconProps {
  name: IconName
  /** 图标尺寸，单位是 Flutter 设计稿的 px（例如 23 对应 Material 的 size 23） */
  size?: number
  color?: string
  className?: string
  style?: CSSProperties
}

/**
 * 图标：把 SVG 编码成 data URI 作为背景图，颜色在运行时注入，
 * 因此不用为每种颜色准备一份图片资源。
 */
export default function Icon({
  name,
  size = 20,
  color = '#33382f',
  className = '',
  style
}: IconProps) {
  const def = getIcon(name)
  const mode = def.mode ?? 'stroke'
  const weight = def.weight ?? 1.9
  const paths = def.d
    .map(
      (d) =>
        `<path d="${d}" fill="${mode === 'fill' ? color : 'none'}" stroke="${
          mode === 'fill' ? 'none' : color
        }" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${paths}</svg>`
  const side = rpx(size)

  return (
    <View
      className={`kp-icon ${className}`}
      style={{
        width: side,
        height: side,
        backgroundImage: `url("${svgDataUri(svg)}")`,
        ...style
      }}
    />
  )
}

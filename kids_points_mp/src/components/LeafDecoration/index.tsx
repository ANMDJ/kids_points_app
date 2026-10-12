import { View } from '@tarojs/components'

import { svgDataUri } from '../../utils/base64'
import { rpx } from '../../utils/unit'
import './index.scss'

export interface LeafDecorationProps {
  /** 设计稿 px（Flutter 里 GradientPage 用 132） */
  size?: number
  color?: string
  opacity?: number
  className?: string
}

/**
 * 手绘两片小叶子，作为页面右下角的装饰（无需图片资源）。
 * 路径取自 Flutter 的 _LeafPainter：viewBox 0 0 132 132。
 */
export default function LeafDecoration({
  size = 132,
  color = '#dcefc8',
  opacity = 0.85,
  className = ''
}: LeafDecorationProps) {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 132">`,
    `<path d="M15.84 126.72Q55.44 87.12 87.12 23.76" fill="none" stroke="${color}" stroke-width="2.9" stroke-linecap="round"/>`,
    `<path d="M60.72 79.2Q124.08 71.28 126.72 29.04Q76.56 36.96 60.72 79.2Z" fill="${color}"/>`,
    `<path d="M44.88 100.32Q2.64 97.68 5.28 60.72Q39.6 66 44.88 100.32Z" fill="${color}"/>`,
    `</svg>`
  ].join('')
  const side = rpx(size)

  return (
    <View
      className={`kp-leaf ${className}`}
      style={{
        width: side,
        height: side,
        opacity,
        backgroundImage: `url("${svgDataUri(svg)}")`
      }}
    />
  )
}

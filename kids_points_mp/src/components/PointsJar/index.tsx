import { View } from '@tarojs/components'

import { svgDataUri } from '../../utils/base64'
import { rpx } from '../../utils/unit'
import './index.scss'

/** 设计稿尺寸（与 Flutter _JarPainter 的 180 x 196 一致）。 */
const DESIGN_WIDTH = 180
const DESIGN_HEIGHT = 196

/** 多角星：角度从正上方开始，隔一个点取内半径。 */
function starPoints(
  cx: number,
  cy: number,
  radius: number,
  points: number,
  innerRatio: number
): string {
  const coords: string[] = []
  for (let i = 0; i < points * 2; i += 1) {
    const r = i % 2 === 0 ? radius : radius * innerRatio
    const angle = -Math.PI / 2 + (i * Math.PI) / points
    coords.push(
      `${(cx + r * Math.cos(angle)).toFixed(2)},${(
        cy +
        r * Math.sin(angle)
      ).toFixed(2)}`
    )
  }
  return coords.join(' ')
}

/**
 * 首页的“积分罐”插画：薄荷绿罐盖 + 玻璃罐 + 柠檬小黄脸 + 星光。
 *
 * 原版是 Flutter CustomPainter 手绘，这里等比例翻译成内联 SVG，
 * 依然不依赖任何图片资源，任意分辨率下都清晰。
 */
export interface PointsJarProps {
  /** 设计稿宽度，首页用 168 */
  width?: number
  className?: string
}

export default function PointsJar({
  width = 180,
  className = ''
}: PointsJarProps) {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${DESIGN_WIDTH} ${DESIGN_HEIGHT}">`,
    // 渐变定义（坐标用 userSpaceOnUse，和 Flutter 的 shader 矩形一致）
    `<defs>`,
    `<linearGradient id="kpJarBody" gradientUnits="userSpaceOnUse" x1="30" y1="70" x2="150" y2="182">`,
    `<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.949"/>`,
    `<stop offset="1" stop-color="#EFF8E7"/>`,
    `</linearGradient>`,
    `<linearGradient id="kpJarBlob" gradientUnits="userSpaceOnUse" x1="57" y1="99" x2="123" y2="165">`,
    `<stop offset="0" stop-color="#FCEBA6"/>`,
    `<stop offset="1" stop-color="#F3D878"/>`,
    `</linearGradient>`,
    `</defs>`,
    // 1. 地面阴影
    `<ellipse cx="90" cy="186" rx="58" ry="8" fill="#7FBF55" fill-opacity="0.133"/>`,
    // 2. 玻璃罐主体 + 描边 + 高光
    `<rect x="30" y="70" width="120" height="112" rx="26" fill="url(#kpJarBody)"/>`,
    `<rect x="30" y="70" width="120" height="112" rx="26" fill="none" stroke="#CFE6BC" stroke-width="2.6"/>`,
    `<rect x="42" y="90" width="12" height="60" rx="6" fill="#FFFFFF" fill-opacity="0.6"/>`,
    // 3. 罐里的柠檬小黄脸
    `<rect x="57" y="99" width="66" height="66" rx="30" fill="url(#kpJarBlob)"/>`,
    `<rect x="67" y="106" width="18" height="15" rx="9" fill="#FFFFFF" fill-opacity="0.5"/>`,
    `<circle cx="76" cy="131" r="4" fill="#5F4B22"/>`,
    `<circle cx="104" cy="131" r="4" fill="#5F4B22"/>`,
    `<circle cx="64" cy="142" r="6.5" fill="#E88E6A" fill-opacity="0.2"/>`,
    `<circle cx="116" cy="142" r="6.5" fill="#E88E6A" fill-opacity="0.2"/>`,
    `<path d="M82 143Q90 152 98 143" fill="none" stroke="#7A5A22" stroke-width="2.4" stroke-linecap="round"/>`,
    // 4. 罐口 + 罐盖 + 盖顶 + 小叶子
    `<rect x="36" y="60" width="108" height="18" rx="10" fill="#9CCC79"/>`,
    `<rect x="30" y="40" width="120" height="30" rx="14" fill="#A9D98A"/>`,
    `<rect x="30" y="40" width="120" height="30" rx="14" fill="none" stroke="#8CC468" stroke-width="2.4"/>`,
    `<rect x="46" y="28" width="88" height="18" rx="10" fill="#C9ECAB"/>`,
    `<path d="M90 40Q78 22 62 26Q72 42 90 40Z" fill="#8CC468"/>`,
    // 5. 星光
    `<polygon points="${starPoints(139, 116, 12, 5, 0.45)}" fill="#F6C64A"/>`,
    `<polygon points="${starPoints(46, 96, 7, 4, 0.28)}" fill="#F8D98A"/>`,
    `<polygon points="${starPoints(132, 72, 5.5, 4, 0.28)}" fill="#F8D98A"/>`,
    `<polygon points="${starPoints(36, 140, 5, 4, 0.28)}" fill="#F3CFA0"/>`,
    `</svg>`
  ].join('')

  return (
    <View
      className={`kp-jar ${className}`}
      style={{
        width: rpx(width),
        height: rpx((width * DESIGN_HEIGHT) / DESIGN_WIDTH),
        backgroundImage: `url("${svgDataUri(svg)}")`
      }}
    />
  )
}

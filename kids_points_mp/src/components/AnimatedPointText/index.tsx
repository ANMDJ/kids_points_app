import { Text } from '@tarojs/components'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

/**
 * 积分数字滚动动画：数值变化时从旧值平滑过渡到新值
 * （对应 Flutter 的 AnimatedPointText + easeOutCubic 曲线）。
 *
 * 小程序的文本节点无法用 CSS 补间，这里用定时器在两端之间取值；
 * 只有当取整后的数字真正变化时才 setState，所以实际重渲染次数很少。
 */
export interface AnimatedPointTextProps {
  value: number
  className?: string
  style?: CSSProperties
  /** 动画时长，默认 500ms */
  duration?: number
}

export default function AnimatedPointText({
  value,
  className = '',
  style,
  duration = 500
}: AnimatedPointTextProps) {
  const [display, setDisplay] = useState(value)
  const displayRef = useRef(value)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const from = displayRef.current
    if (from === value) return undefined

    const start = Date.now()
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      const progress = Math.min(1, (Date.now() - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3) // easeOutCubic
      const current = Math.round(from + (value - from) * eased)
      if (current !== displayRef.current) {
        displayRef.current = current
        setDisplay(current)
      }
      if (progress >= 1 && timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }, 16)

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [value, duration])

  return (
    <Text className={className} style={style}>
      {display}
    </Text>
  )
}

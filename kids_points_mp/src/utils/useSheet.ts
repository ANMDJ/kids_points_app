import { useCallback, useRef, useState } from 'react'

/**
 * 底部弹窗的开关 + 过渡状态。
 *
 * 小程序没有 Navigator，弹窗是页面里的一层覆盖视图：为了既有入场动画
 * 又能在关闭时把表单状态重置，这里用 [open] 控制挂载、[visible] 控制动画。
 */
export interface SheetController {
  /** 是否挂载弹窗 */
  open: boolean
  /** 是否加上 is-visible（触发入场 / 收起过渡） */
  visible: boolean
  show: () => void
  hide: () => void
}

export function useSheet(): SheetController {
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const show = useCallback(() => {
    clear()
    setOpen(true)
    // 下一帧再加 is-visible，保证入场过渡能被触发
    timer.current = setTimeout(() => setVisible(true), 30)
  }, [])

  const hide = useCallback(() => {
    clear()
    setVisible(false)
    // 等收起动画播完再卸载，避免状态被提前清空
    timer.current = setTimeout(() => setOpen(false), 320)
  }, [])

  return { open, visible, show, hide }
}

/** 需要带一个数据的弹窗（例如“点某条规则 → 弹出操作菜单”）。 */
export interface PayloadSheetController<T> {
  /** 是否挂载弹窗 */
  open: boolean
  /** 是否加上 is-visible（触发入场 / 收起过渡） */
  visible: boolean
  /** 弹窗内容依赖的数据，关闭动画播完后才清空 */
  data: T | null
  show: (data: T) => void
  hide: () => void
}

export function usePayloadSheet<T>(): PayloadSheetController<T> {
  const [data, setData] = useState<T | null>(null)
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const show = useCallback((payload: T) => {
    clear()
    setData(payload)
    setOpen(true)
    timer.current = setTimeout(() => setVisible(true), 30)
  }, [])

  const hide = useCallback(() => {
    clear()
    setVisible(false)
    timer.current = setTimeout(() => {
      setOpen(false)
      setData(null)
    }, 320)
  }, [])

  return { open, visible, data, show, hide }
}

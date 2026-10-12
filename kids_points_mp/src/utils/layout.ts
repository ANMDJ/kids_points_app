import { useState } from 'react'
import Taro, { useReady } from '@tarojs/taro'

import { getWindowSize } from './unit'

export interface Viewport {
  /** 视口高度（px），做 100vh 固定布局的页面用它撑满一屏 */
  height: number
  /** 状态栏高度（px），自定义导航栏页面用它做顶部内边距 */
  safeTop: number
  /** 底部安全区高度（px），固定底部元素的页面用它做底部内边距 */
  safeBottom: number
}

/**
 * 测量真实视口与安全区。
 *
 * 不用 100vh：小程序的 webview 高度受状态栏 / 底部安全区影响，
 * 直接用 CSS 单位容易多出或少掉一截；这里去量 GradientPage 里那张
 * position: fixed 的背景层（正好等于视口），拿到的是准确值。
 */
export function useViewport(): Viewport {
  const [height, setHeight] = useState(0)

  useReady(() => {
    Taro.createSelectorQuery()
      .select('.kp-gradient__bg')
      .boundingClientRect()
      .exec((res) => {
        const rect = (res && res[0]) as { height?: number } | null
        if (rect && rect.height) setHeight(rect.height)
      })
  })

  return {
    height: height || getWindowSize().windowHeight,
    safeTop: getSafeTop(),
    safeBottom: getSafeBottom()
  }
}

interface SafeInfo {
  statusBarHeight?: number
  screenHeight?: number
  safeArea?: { top: number; bottom?: number; height?: number }
}

/**
 * 读取系统信息（状态栏 / 屏幕 / 安全区）。
 *
 * ⚠️ 必须写成 Taro.getWindowInfo() 这种「直接成员访问」：
 * H5 端 @tarojs/taro 的默认导出只是精简对象（只有路由 / pxTransform 等），
 * 业务 API 靠编译期 babel-plugin-transform-taroapi 把 `Taro.xxx` 改写成
 * `import { xxx } from '@tarojs/taro'`（H5 侧由 taro-h5 提供实现）。
 * 一旦写成 `const taro = Taro; taro.getWindowInfo()`，改写失效，
 * H5 运行时 taro.getWindowInfo 是 undefined，就会落到 getSystemInfoSync
 * 并抛 “getSystemInfoSync is not a function”。
 *
 * 老基础库没有 getWindowInfo 时降级到 getSystemInfoSync；都没有则返回空对象。
 */
function systemInfo(): SafeInfo {
  if (typeof Taro.getWindowInfo === 'function') {
    return Taro.getWindowInfo()
  }
  if (typeof Taro.getSystemInfoSync === 'function') {
    return Taro.getSystemInfoSync()
  }
  return {}
}

/**
 * H5 端把 CSS 环境变量安全区 env(safe-area-inset-*) 读成 px。
 *
 * H5 的 getWindowInfo() 返回的 safeArea 全是 0（taro-h5 的实现里写死的），
 * 真正的刘海 / Home 指示条尺寸只存在于浏览器自己的 env() 里，
 * 所以用一个脱离文档流的探针元素把计算后的值读出来。
 * 小程序端没有 document，直接返回 0（小程序走 safeArea，用不到它）。
 * 结果按方向做模块级缓存，避免每次渲染都操作 DOM。
 */
const envInsets: { top?: number; bottom?: number } = {}

function readEnvInset(side: 'top' | 'bottom'): number {
  const cached = envInsets[side]
  if (typeof cached === 'number') return cached
  if (typeof document === 'undefined' || !document.body) return 0

  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none;' +
    `padding-${side}:constant(safe-area-inset-${side});` +
    `padding-${side}:env(safe-area-inset-${side});`
  document.body.appendChild(probe)
  const computed = window.getComputedStyle(probe)
  const raw = side === 'top' ? computed.paddingTop : computed.paddingBottom
  document.body.removeChild(probe)

  const value = Number.parseFloat(raw)
  const inset = Number.isFinite(value) && value > 0 ? value : 0
  envInsets[side] = inset
  return inset
}

/** 状态栏 / 刘海高度（px）。 */
export function getSafeTop(): number {
  const info = systemInfo()
  const top = info.safeArea && info.safeArea.top
  if (typeof top === 'number' && top > 0) return top
  const statusBar = info.statusBarHeight
  if (typeof statusBar === 'number' && statusBar > 0) return statusBar
  return readEnvInset('top')
}

/**
 * 底部安全区高度（px，非全面屏为 0）。
 *
 * ⚠️ 不能直接算 screenHeight - safeArea.bottom：
 * H5 的 safeArea.bottom 是 0，会把整屏高度（如 812）当成安全区，
 * 把底部弹窗的 padding 撑爆，所以必须先要求 bottom > 0。
 * 小程序端 safeArea.bottom 等于 screenHeight（非全面屏 → 0）
 * 或略小于（全面屏 → 34 / 21），行为与旧实现完全一致。
 */
export function getSafeBottom(): number {
  const info = systemInfo()
  const area = info.safeArea
  if (area && typeof area.bottom === 'number' && area.bottom > 0) {
    const screenHeight = info.screenHeight || area.bottom
    return Math.max(0, screenHeight - area.bottom)
  }
  return readEnvInset('bottom')
}

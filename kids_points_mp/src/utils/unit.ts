import Taro from '@tarojs/taro'

/** Flutter 设计稿的逻辑宽度（iPhone 系列上是 400 左右的居中画布）。 */
export const DESIGN_WIDTH = 400

interface WindowSize {
  windowWidth: number
  windowHeight: number
}

/**
 * 屏幕可用宽高（带兜底，避免个别基础库缺少新 API 时报错）。
 *
 * ⚠️ 必须写成 Taro.getWindowInfo() 这种「直接成员访问」（原因详见 layout.ts 的 systemInfo()）：
 * H5 端 `const taro = Taro; taro.getWindowInfo()` 会绕过编译期改写，
 * 拿到精简版 Taro 对象并抛 “getSystemInfoSync is not a function”。
 */
export function getWindowSize(): WindowSize {
  if (typeof Taro.getWindowInfo === 'function') {
    const info = Taro.getWindowInfo()
    return {
      windowWidth: info.windowWidth || 375,
      windowHeight: info.windowHeight || 667
    }
  }
  if (typeof Taro.getSystemInfoSync === 'function') {
    const info = Taro.getSystemInfoSync()
    return {
      windowWidth: info.windowWidth || 375,
      windowHeight: info.windowHeight || 667
    }
  }
  return { windowWidth: 375, windowHeight: 667 }
}

/** Flutter 设计稿 px → 小程序真实 CSS px（用于需要精确比较的滚动计算）。 */
export function designToPx(value: number): number {
  return (value * getWindowSize().windowWidth) / DESIGN_WIDTH
}

/**
 * Flutter 设计稿 px → 内联样式用的长度字符串。
 *
 * - 小程序：直接用 rpx（750rpx = 屏宽，原生单位）；
 * - H5：**必须换算成 px**。浏览器不认识 rpx，而 JS 里的内联样式又不会被
 *   编译期的 postcss-pxtransform 处理（它只处理 .scss，把它编译成 rem），
 *   结果 `width: 97.5rpx` 这种声明会被浏览器整条丢弃：
 *   「新增心愿」悬浮按钮因此量到 width:0px / borderRadius:0px / box-shadow:none，
 *   既不是右下角的圆形悬浮按钮，也看不到宽度补间动画；图标（Icon 也用 rpx 内联尺寸）
 *   则统一变成 0×0 看不见。
 *
 * 换算出的 px 与 scss 里 f2r() 的 rem 结果完全一致（两者都等于 value * 屏宽 / 400），
 * 所以 H5 与小程序的比例一致。
 */
export function rpx(value: number): string {
  if (process.env.TARO_ENV === 'h5') {
    return `${designToPx(value)}px`
  }
  return `${value * (750 / DESIGN_WIDTH)}rpx`
}

/** 兼容旧命名，等同 [rpx]。 */
export const designToRpx = rpx

/** Flutter EdgeInsets.symmetric(horizontal, vertical) → CSS padding（rpx）。 */
export function symmetricPadding(horizontal: number, vertical: number): string {
  return `${rpx(vertical)} ${rpx(horizontal)}`
}

/** Flutter EdgeInsets.fromLTRB(left, top, right, bottom) → CSS padding（rpx）。 */
export function ltrbPadding(
  left: number,
  top: number,
  right: number,
  bottom: number
): string {
  return `${rpx(top)} ${rpx(right)} ${rpx(bottom)} ${rpx(left)}`
}

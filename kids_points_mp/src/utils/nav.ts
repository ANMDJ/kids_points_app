import Taro from '@tarojs/taro'

/** 四个 tab 页的路径，顺序和 AppBottomNav 一致。 */
export const TAB_PAGES = [
  '/pages/home/index',
  '/pages/wishlist/index',
  '/pages/approvals/index',
  '/pages/profile/index'
]

/**
 * 登录页（W9-B）。
 *
 * 不是 tab 页：用 `redirectTo` 进入，页面栈始终只有一层（与 `switchTab`
 * 同策略）—— 用户从登录页按返回键时不会回到一个没有身份的首页。
 */
export const LOGIN_PAGE = '/pages/login/index'

/**
 * 切换底部导航页。
 *
 * 用 redirectTo 而不是 navigateTo：小程序 tab 栏不是原生的，
 * 用重定向可以保证页面栈始终只有一层（和 Flutter 的 IndexedStack 观感一致），
 * 而状态中心是模块级单例，数据不会丢。
 */
export function switchTab(index: number, currentIndex: number): void {
  if (index === currentIndex) return
  const url = TAB_PAGES[index]
  if (!url) return
  Taro.redirectTo({ url })
}

/** 返回上一页（没有上一页时回首页）。 */
export function goBack(): void {
  const pages = Taro.getCurrentPages()
  if (pages.length > 1) {
    Taro.navigateBack()
  } else {
    Taro.redirectTo({ url: TAB_PAGES[0] })
  }
}

/** 打开二级页（积分记录 / 积分规则）。 */
export function pushPage(url: string): void {
  Taro.navigateTo({ url })
}

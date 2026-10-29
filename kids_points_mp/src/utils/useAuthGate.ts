import Taro, { useDidShow } from '@tarojs/taro'
import { useEffect } from 'react'

import { useStore } from '../data/store'
import { LOGIN_PAGE } from './nav'

/**
 * 登录闸门（W9-B）：只要 store 说「必须登录」，就把当前页换成登录页。
 *
 * ── 为什么是一个 hook 而不是 `app.tsx` 里的一次判断 ────────────────────────
 *   Taro 的 `App` 组件**不渲染任何页面**（`app.tsx` 只 `return children`），
 *   拿不到"当前页"，也没有可靠的"路由就绪"时机。而恢复会话是异步的：
 *   冷启动时首屏一定是 index 页先画出来，`GET /auth/session` 之后才知道
 *   要不要去登录页。所以判断必须挂在页面里，并跟随 store 的重绘重跑。
 *
 * ── 为什么用 `redirectTo` ──────────────────────────────────────────────────
 *   与 `switchTab` 一致：换掉当前页而不是叠一层，登录页返回时不会回到
 *   一个没有身份的首页（那种"退回去又能看到数据"的空档很危险）。
 *
 * ── 四个 tab 页都要调 ──────────────────────────────────────────────────────
 *   `switchTab` 是 `redirectTo`，任何一页都可能是冷启动首屏；
 *   少挂一个页面就等于少一个入口的闸门。
 */
export function useAuthGate(): void {
  const store = useStore()
  const state = store.authState

  useEffect(() => {
    if (state !== 'needs_login') return
    redirectToLogin()
  }, [state])

  // 回到前台再确认一次：token 可能在后台被服务端撤销 / 到期，
  // 而 store 状态还停在 `ready`（此时页面看起来一切正常）。
  useDidShow(() => {
    if (store.authState === 'needs_login') redirectToLogin()
  })
}

/** 进登录页（已经在登录页就什么都不做 —— 小程序不允许 redirectTo 同一页）。 */
export function redirectToLogin(): void {
  const pages = Taro.getCurrentPages()
  const top = pages.length > 0 ? pages[pages.length - 1] : null
  if (top !== null && `/${top.route ?? ''}` === LOGIN_PAGE) return
  void Taro.redirectTo({ url: LOGIN_PAGE })
}
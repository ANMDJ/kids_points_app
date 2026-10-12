import { PropsWithChildren } from 'react'

import './app.scss'

/**
 * 应用入口：状态中心是模块级单例（src/data/store.ts），
 * 所以跨页面（redirectTo / navigateTo）之后数据依然保留。
 */
function App({ children }: PropsWithChildren) {
  return children
}

export default App

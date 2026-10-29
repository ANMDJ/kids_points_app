export default definePageConfig({
  // 登录页是一屏静态内容，不需要下拉刷新（重试由页面上的按钮负责）。
  enablePullDownRefresh: false,
  backgroundTextStyle: 'light'
})

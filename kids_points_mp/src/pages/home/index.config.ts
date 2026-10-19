export default definePageConfig({
  // 与 Flutter 首页的 RefreshIndicator 对齐：下拉重新拉 /home + /records。
  // 预览模式下 refreshFromServer 是空操作，这里只是收起原生下拉动画。
  enablePullDownRefresh: true,
  backgroundTextStyle: 'dark'
})

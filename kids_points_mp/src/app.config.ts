export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/wishlist/index',
    'pages/approvals/index',
    'pages/profile/index',
    'pages/record/index',
    'pages/rule/index',
    // W8-B：首启引导。放在最后，首页在首屏即可决定 `redirectTo` 过来。
    'pages/onboarding/index'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#FDFFF9',
    navigationBarTitleText: '积分小管家',
    navigationBarTextStyle: 'black',
    navigationStyle: 'custom',
    backgroundColor: '#FDFFF9'
  }
})

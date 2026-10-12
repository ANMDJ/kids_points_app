// Taro 编译配置：React + TypeScript + webpack5
module.exports = {
  presets: [
    [
      'taro',
      {
        framework: 'react',
        ts: true,
        compiler: 'webpack5'
      }
    ]
  ]
}

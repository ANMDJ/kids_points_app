/**
 * Taro 编译配置。
 *
 * 单位约定：设计稿是 Flutter 的 400 逻辑宽度，750rpx = 全屏宽，
 * 因此 1 Flutter px = 1.875rpx，样式里统一用 styles/_vars.scss 的 f2r() 换算。
 */
const config = {
  projectName: 'kids_points_mp',
  date: '2026-10-11',
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    375: 2,
    828: 1.81 / 2
  },
  sourceRoot: 'src',
  outputRoot: 'dist',
  plugins: [],
  defineConstants: {},
  /**
   * 只读后端配置的**白名单**（W4-C）。
   *
   * Taro 只把 `env` 里列出的键注入 `process.env.*`；`.env` / `.env.local`
   * 中其余变量只在 Node 侧可见，运行时读不到。留空是正常的：三项缺一项时
   * 小程序继续使用本地预览数据（见 `src/data/read_api.ts`）。
   * `.env.local` 已在 `.gitignore` 里，凭据不会入库。
   */
  env: {
    TARO_APP_KP_API_BASE_URL: JSON.stringify(
      process.env.TARO_APP_KP_API_BASE_URL ?? ''
    ),
    TARO_APP_KP_DEVICE_ID: JSON.stringify(
      process.env.TARO_APP_KP_DEVICE_ID ?? ''
    ),
    TARO_APP_KP_CHILD_ID: JSON.stringify(
      process.env.TARO_APP_KP_CHILD_ID ?? ''
    )
  },
  copy: {
    patterns: [{ from: 'src/sitemap.json', to: 'dist/sitemap.json' }],
    options: {}
  },
  framework: 'react',
  compiler: 'webpack5',
  cache: {
    enable: false
  },
  mini: {
    /**
     * 各页面 import 组件的先后顺序不同，抽到 common 的样式顺序没法同时满足所有页面，
     * mini-css-extract-plugin 默认会因此报「Conflicting order」错误；样式都是全局类名，
     * 顺序不影响表现，这里直接忽略（否则构建直接失败）。
     */
    miniCssExtractPluginOption: {
      ignoreOrder: true
    },
    postcss: {
      pxtransform: {
        enable: true,
        config: {}
      },
      url: {
        enable: true,
        config: {
          limit: 1024
        }
      },
      cssModules: {
        enable: false
      }
    }
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    postcss: {
      autoprefixer: {
        enable: true,
        config: {}
      },
      cssModules: {
        enable: false
      }
    }
  }
}

export default config

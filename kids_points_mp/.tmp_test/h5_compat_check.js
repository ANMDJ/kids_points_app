/**
 * H5 兼容性回归验证（临时脚本，配合 run.js 一起跑）
 *
 * 覆盖两件事：
 * 1) 编译期：用 H5 平台真实使用的 babel-plugin-transform-taroapi + H5 的 definition.json，
 *    检查 src/utils/layout.ts / unit.ts 里的 Taro.getWindowInfo 是否被改写成具名导入
 *    （这是 H5 不抛 “getSystemInfoSync is not a function” 的前提）。
 * 2) 运行期：在 Node 里替换 @tarojs/taro，伪造 5 种环境，检查 getSafeTop / getSafeBottom /
 *    getWindowSize 的取值是否符合预期（含 H5 旧 bug「整屏高度被当成安全区」的回归）。
 */
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const babel = require('@babel/core')

const ROOT = path.resolve(__dirname, '..')
const COMPILED = path.join(__dirname, 'dist', 'utils')
const ALIAS_FILE = path.join(
  ROOT,
  'node_modules/@tarojs/plugin-platform-h5/dist/runtime/apis/index.js'
)
const H5_API_INDEX = path.join(ROOT, 'node_modules/@tarojs/taro-h5/dist/api/index.js')
const H5_API_SYSTEM = path.join(ROOT, 'node_modules/@tarojs/taro-h5/dist/api/base/system.js')

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + error.message)
  }
}

/* ---------------- 1. 编译期改写验证（H5） ---------------- */
process.env.TARO_ENV = 'h5'
const definition = require('@tarojs/plugin-platform-h5/dist/definition.json')

for (const file of ['src/utils/layout.ts', 'src/utils/unit.ts']) {
  const filename = path.resolve(ROOT, file)
  const result = babel.transformFileSync(filename, {
    filename,
    configFile: false,
    babelrc: false,
    comments: false,
    presets: [require.resolve('@babel/preset-typescript', { paths: [ROOT] })],
    plugins: [
      [
        require.resolve('babel-plugin-transform-taroapi', { paths: [ROOT] }),
        { packageName: '@tarojs/taro', definition }
      ]
    ]
  })
  const code = result.code
  const taroImport =
    code.split('\n').find((line) => line.includes("from '@tarojs/taro'")) || '(未生成 taro 导入)'

  check(`${file}: 具名导入 getWindowInfo（H5 靠它启动，而不是精简版默认导出）`, () => {
    assert.ok(
      /import\s+(?:Taro\s*,\s*)?\{[^}]*getWindowInfo as \w+/.test(taroImport.trim()),
      `实际导入语句: ${taroImport.trim()}`
    )
  })
  check(`${file}: 默认导入被保留（插件设计如此：源码里 import Taro 即 needDefault=true）`, () => {
    assert.ok(
      /^import\s+Taro\b/.test(taroImport.trim()),
      `实际导入语句: ${taroImport.trim()}`
    )
  })
  check(`${file}: H5 alias 模块确实具名导出 getWindowInfo（编译产物可被解析）`, () => {
    const alias = fs.readFileSync(ALIAS_FILE, 'utf8')
    assert.ok(
      /export \* from '@tarojs\/taro-h5\/dist\/api\/index'/.test(alias),
      'plugin-platform-h5 的 runtime/apis 未 re-export taro-h5 的 api'
    )
    const apiIndex = fs.readFileSync(H5_API_INDEX, 'utf8')
    assert.ok(
      /export \{[^}]*getWindowInfo[^}]*\} from '\.\/base\/system\.js'/.test(apiIndex),
      'taro-h5/dist/api/index 未导出 getWindowInfo'
    )
    const system = fs.readFileSync(H5_API_SYSTEM, 'utf8')
    assert.ok(/const getWindowInfo = /.test(system), 'taro-h5 未实现 getWindowInfo')
  })
  check(`${file}: 编译产物中无 Taro.getWindowInfo / Taro.getSystemInfoSync 成员访问`, () => {
    assert.ok(
      !/Taro\.(getWindowInfo|getSystemInfoSync)/.test(code),
      '仍存在运行时成员访问，H5 会拿到精简版 Taro 对象'
    )
  })
}

/* ---------------- 2. 运行期取值验证（伪造 5 种环境） ---------------- */

// 编译后的模块用 Node 规则解析 @tarojs/taro，这里把两种可能的落点都收集起来
const taroPaths = Array.from(
  new Set([
    require.resolve('@tarojs/taro', { paths: [COMPILED] }),
    require.resolve('@tarojs/taro', { paths: [ROOT] })
  ])
)

/**
 * 把 @tarojs/taro 换成本地假实现并重新加载被测模块。
 * ⚠️ 顺序：先清缓存（layout.ts 里的 envInsets 有模块级缓存，必须重载），再注入假实现，
 * 反了就相当于没注入（第一版脚本就踩了这个坑）。
 */
function loadUtils(getWindowInfo, getSystemInfoSync) {
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(COMPILED) || taroPaths.includes(id)) delete require.cache[id]
  }
  const fake = {
    __esModule: true,
    default: { getWindowInfo, getSystemInfoSync },
    useReady: () => undefined
  }
  for (const id of taroPaths) {
    require.cache[id] = {
      id,
      filename: id,
      loaded: true,
      exports: fake,
      children: [],
      paths: []
    }
  }
  return {
    layout: require(path.join(COMPILED, 'layout.js')),
    unit: require(path.join(COMPILED, 'unit.js'))
  }
}

const WEAPP_FULL_SCREEN = () => ({
  screenHeight: 812,
  screenWidth: 375,
  windowWidth: 375,
  windowHeight: 667,
  statusBarHeight: 44,
  safeArea: { left: 0, top: 44, right: 375, bottom: 778, width: 375, height: 734 }
})
const WEAPP_NORMAL = () => ({
  screenHeight: 667,
  screenWidth: 375,
  windowWidth: 375,
  windowHeight: 647,
  statusBarHeight: 20,
  safeArea: { left: 0, top: 20, right: 375, bottom: 667, width: 375, height: 647 }
})
// taro-h5 的 getWindowInfo 实现：safeArea 全 0、statusBarHeight 为 NaN
const H5_INFO = () => ({
  screenHeight: 844,
  screenWidth: 390,
  windowWidth: 390,
  windowHeight: 700,
  statusBarHeight: NaN,
  safeArea: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
})

check('小程序（全面屏）：safeTop=44 / safeBottom=34 / 窗口=375x667', () => {
  const { layout, unit } = loadUtils(WEAPP_FULL_SCREEN, WEAPP_FULL_SCREEN)
  assert.strictEqual(layout.getSafeTop(), 44)
  assert.strictEqual(layout.getSafeBottom(), 34)
  assert.deepStrictEqual(unit.getWindowSize(), { windowWidth: 375, windowHeight: 667 })
})

check('小程序（非全面屏）：safeTop=20 / safeBottom=0', () => {
  const { layout } = loadUtils(WEAPP_NORMAL, WEAPP_NORMAL)
  assert.strictEqual(layout.getSafeTop(), 20)
  assert.strictEqual(layout.getSafeBottom(), 0)
})

check('H5（无 DOM 探针）：safeBottom 不再是整屏高度 844', () => {
  const { layout, unit } = loadUtils(H5_INFO, H5_INFO)
  assert.strictEqual(layout.getSafeTop(), 0)
  assert.strictEqual(layout.getSafeBottom(), 0, '旧实现会返回 844')
  assert.deepStrictEqual(unit.getWindowSize(), { windowWidth: 390, windowHeight: 700 })
})

check('H5（有 DOM 探针，iPhone 刘海）：safeTop=47 / safeBottom=34', () => {
  global.document = {
    body: { appendChild: () => undefined, removeChild: () => undefined },
    createElement: () => ({ style: {} })
  }
  global.window = {
    getComputedStyle: () => ({ paddingTop: '47px', paddingBottom: '34px' })
  }
  try {
    const { layout } = loadUtils(H5_INFO, H5_INFO)
    assert.strictEqual(layout.getSafeTop(), 47)
    assert.strictEqual(layout.getSafeBottom(), 34)
  } finally {
    delete global.document
    delete global.window
  }
})

check('两个 API 都不可用：一律返回 0，不抛异常', () => {
  const { layout, unit } = loadUtils(undefined, undefined)
  assert.strictEqual(layout.getSafeTop(), 0)
  assert.strictEqual(layout.getSafeBottom(), 0)
  assert.deepStrictEqual(unit.getWindowSize(), { windowWidth: 375, windowHeight: 667 })
})

check('H5：内联尺寸换成 px（浏览器不认 rpx，整条声明会被丢弃）', () => {
  process.env.TARO_ENV = 'h5'
  const { unit } = loadUtils(H5_INFO, H5_INFO)
  // 52 设计稿 px 在 390 宽的视口上 = 52 * 390 / 400 = 50.7px
  assert.strictEqual(unit.rpx(52), '50.7px', '「新增心愿」按钮的 width/height 靠它')
  assert.strictEqual(unit.designToRpx(52), '50.7px', 'designToRpx 是 rpx 的别名')
  assert.strictEqual(unit.symmetricPadding(12, 8), '7.8px 11.7px')
  assert.strictEqual(unit.ltrbPadding(1, 2, 3, 4), '1.95px 2.925px 3.9px 0.975px')
  // 只要还有 rpx 出现在内联样式里，浏览器就会丢掉那条声明
  const inline = [
    unit.rpx(52),
    unit.rpx(999),
    unit.symmetricPadding(12, 8),
    unit.ltrbPadding(1, 2, 3, 4),
    `0 ${unit.rpx(10)} ${unit.rpx(22)} ${unit.rpx(1)} rgba(0, 0, 0, 0.1)`
  ].join(' ')
  assert.ok(!/rpx/.test(inline), `H5 内联样式里仍有 rpx: ${inline}`)
})

check('小程序：内联尺寸仍是 rpx（weapp 观感不变）', () => {
  process.env.TARO_ENV = 'weapp'
  const { unit } = loadUtils(WEAPP_FULL_SCREEN, WEAPP_FULL_SCREEN)
  assert.strictEqual(unit.rpx(52), '97.5rpx')
  assert.strictEqual(unit.designToRpx(52), '97.5rpx')
  assert.strictEqual(unit.symmetricPadding(12, 8), '15rpx 22.5rpx')
  assert.strictEqual(unit.ltrbPadding(1, 2, 3, 4), '3.75rpx 5.625rpx 7.5rpx 1.875rpx')
})

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`)
process.exitCode = failed === 0 ? 0 : 1

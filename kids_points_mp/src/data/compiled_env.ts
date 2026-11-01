/**
 * 编译期注入的环境变量（Taro `config/index.ts` 里 `env` 白名单的唯一读法）。
 *
 * ── 这个文件存在的唯一理由：DefinePlugin 只认**静态整段表达式** ──────────────
 *   Taro 用 webpack 的 `DefinePlugin` 注入配置，它替换的是**字面量表达式**
 *   `process.env.TARO_APP_X` 本身：
 *
 *     ✅ `process.env.TARO_APP_KP_API_BASE_URL`  ⇒ 编译成 `"http://..."` 字面量
 *     ❌ `process.env`（整体）                    ┐
 *     ❌ `process.env[key]`（动态键）             ├ 编译后仍是运行时的 `process.env`，
 *     ❌ `{ ...process.env }`（展开）             ┘ 而小程序里那只是 webpack 的
 *                                                  空 polyfill（`{}`）
 *
 *   ⇒ 后三种写法的结果**永远是 undefined**，无论 `.env.local` 填了什么。
 *
 * ── 2026-10-30 实测证据（为什么这一行注释值得留着）──────────────────────────
 *   修复前 `dist/common.js` 里 `defaultEnvironment()` 长这样：
 *     `function O(){return"undefined"!==typeof process&&process.env?process.env:{}}`
 *   而整个 `dist/` 里 `127.0.0.1:3000` 只出现 **1 次**，还是错误提示文案里的
 *   示例字符串 —— 配置值一次都没被注入。后果不是"某个面板不工作"，而是
 *   **七个 `defaultEnvironment()` 全部返回空对象**：
 *   `readApi` / `writeApi` / `authApi` / `accountBinder` 全是 `null`，
 *   小程序在真机上一直停在预览模式，一个请求都不发。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *   ① **只在这里**出现 `process.env.TARO_APP_*`，别处一律用
 *      [readCompiledEnvironment]。新增键 = 在这里加一行 + `config/index.ts`
 *      白名单加一行，两处缺一即读不到。
 *   ② 显式列出三个键、**不做** `...process.env` 透传：小程序里没有别的环境变量，
 *      透传只会让人以为"随便加个键就能读到"。
 *   ③ 返回值是所有配置读者共用的 **index signature** 形状（与
 *      `read_api.ts#ReadEnvironment` 结构一致），调用方不必断言。
 */
export interface CompiledEnvironment {
  [key: string]: string | undefined
}

/**
 * 读编译期注入的三项配置。
 *
 * 缺失的键是 `undefined`（**不是**空串）：空串意味着"作者显式写了空值"，
 * 而 `undefined` 才是"这一项没配"。两者在下游都被当成没配，但调试时能区分开。
 */
export function readCompiledEnvironment(): CompiledEnvironment {
  return {
    TARO_APP_KP_API_BASE_URL: process.env.TARO_APP_KP_API_BASE_URL,
    TARO_APP_KP_DEVICE_ID: process.env.TARO_APP_KP_DEVICE_ID,
    TARO_APP_KP_CHILD_ID: process.env.TARO_APP_KP_CHILD_ID
  }
}

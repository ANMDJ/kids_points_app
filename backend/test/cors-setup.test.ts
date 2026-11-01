/**
 * cors-setup.test.ts —— CORS 装配的单元测试（W10-A，2026-10-30）
 *
 * ── 为什么它值得存在（它不是「配置解析的单测」）───────────────────────────────
 *   CORS 的两个方向**都**会造成真实事故，而且症状都不指向本文件：
 *     · 放太松：`origin: true`（回显任意源）+ 凭据在 `authorization` 头 ⇒ 任何网站
 *       都能借用户浏览器读本接口（同源策略等于不存在）。
 *     · 放太紧：白名单漏了 `flutter run -d chrome` 的端口 ⇒ 浏览器预检失败，
 *       客户端只看到「连不上服务器」—— 这正是 `42` §5 反复要避免的假象。
 *   两条都无法靠"看一眼代码"保证，只能钉死在用例里。
 *
 * ── 全部通过 `env` 形参注入，**不改** `process.env` ──────────────────────────
 *   与 `auth-boot-config.test.ts` 同一纪律：改 `process.env` 会污染同进程里其它用例。
 *   形参注入同时也是「seam 存在」的证明 —— 有人把它改成只读 `process.env`，本文件
 *   立刻编译不过。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface'

import { resolveCorsOptions } from '../src/cors.setup'

type OriginResolver = (
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void
) => void

/** `cors` 包的 origin 回调只在这个形态下出现（开发默认那条分支）。 */
function expectsCallback(options: CorsOptions): boolean {
  return typeof options.origin === 'function'
}

/** 按浏览器的方式问一次「这个 Origin 放不放」，返回布尔结论。 */
function allows(options: CorsOptions | null, origin: string | undefined): boolean {
  assert.ok(options !== null, 'resolveCorsOptions 返回了 null（CORS 未启用），无法判断放行')
  if (!expectsCallback(options)) {
    throw new Error('这条分支的 origin 不是回调（白名单 / 通配），不该用 allows() 判断')
  }
  let allowed: boolean | undefined
  ;(options.origin as OriginResolver)(origin, (error, allow) => {
    assert.equal(error, null, 'origin 回调不该把错误当成"拒绝"传出去（那会变成 500）')
    allowed = allow
  })
  assert.notEqual(allowed, undefined, 'origin 回调没有给出结论')
  return allowed === true
}

/** 开发环境（未配置白名单）：只认本机任意端口。 */
function development(): CorsOptions {
  const options = resolveCorsOptions({ NODE_ENV: 'development' })
  assert.ok(options !== null)
  return options
}

describe('`resolveCorsOptions()`：默认只放行本机，生产缺配置则不启用', () => {
  it('★ 开发默认放行 localhost / 127.0.0.1 / [::1] 的**任意端口**', () => {
    const options = development()
    // 端口必须任意：`flutter run -d chrome` 每次挑的端口都不同，
    // 写死一个端口会让「换个端口就登不上」变成一次玄学排查。
    for (const origin of [
      'http://localhost:5173',
      'http://localhost:3000',
      'http://127.0.0.1:8080',
      'https://localhost:8443',
      'https://127.0.0.1:8443',
      'http://[::1]:9000'
    ]) {
      assert.equal(allows(options, origin), true, `${origin} 应当放行`)
    }
  })

  it('★ 开发默认**不**放行外部源（不是"开发就全放开"）', () => {
    const options = development()
    for (const origin of [
      'https://app.example.com',
      'http://localhost.evil.com:5173', // 前缀伪装：正则必须锚定结尾
      'http://notlocalhost:5173',
      'null' // file:// 页面的 Origin 字面量
    ]) {
      assert.equal(allows(options, origin), false, `${origin} 不该放行`)
    }
  })

  it('没有 Origin 头（curl / 服务端调用 / 同源）⇒ 放行（CORS 判据不适用）', () => {
    assert.equal(allows(development(), undefined), true)
  })

  it('★ 生产 + 未配置 ⇒ 返回 null（不启用），不是"默认放开"', () => {
    assert.equal(resolveCorsOptions({ NODE_ENV: 'production' }), null)
  })
})

describe('`CORS_ALLOWED_ORIGINS`：显式白名单优先于开发默认', () => {
  it('逗号分隔 + 两侧空白 ⇒ 精确白名单（trim 生效）', () => {
    const options = resolveCorsOptions({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: ' https://app.example.com , https://b.example.com '
    })
    assert.ok(options !== null)
    assert.deepEqual(options.origin, ['https://app.example.com', 'https://b.example.com'])
  })

  it('★ 开发环境下配了白名单 ⇒ 只认白名单（本机默认放行被覆盖）', () => {
    const options = resolveCorsOptions({
      NODE_ENV: 'development',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com'
    })
    assert.deepEqual(options?.origin, ['https://app.example.com'])
  })

  it('`*` ⇒ origin: true（只在明确要求时出现）', () => {
    const options = resolveCorsOptions({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: '*'
    })
    assert.equal(options?.origin, true)
  })

  it('生产 + 白名单 ⇒ 启用（不是一律关掉）', () => {
    const options = resolveCorsOptions({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com'
    })
    assert.notEqual(options, null)
  })
})

describe('预检放行的请求头 = 客户端**实际**发的那些', () => {
  it('★ `authorization` / `x-kp-device-id` / `x-kp-child-id` / `content-type` 必须在列表里', () => {
    // 漏掉任何一个的表现都是「浏览器预检失败」⇒ 客户端报「连不上服务器」，
    // 而服务端日志里**一条请求都没有**（预检就被拦了）—— 极难定位。
    const headers = development().allowedHeaders
    assert.ok(Array.isArray(headers))
    for (const header of ['content-type', 'authorization', 'x-kp-device-id', 'x-kp-child-id']) {
      assert.ok(headers.includes(header), `预检白名单缺 ${header}`)
    }
  })

  it('`credentials` 关闭：凭据走 authorization 头，不靠 cookie', () => {
    assert.equal(development().credentials, false)
  })
})

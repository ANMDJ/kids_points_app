/**
 * auth-boot-config.test.ts —— **启动期配置判据**的单元测试（W9-A，2026-10-29）
 *
 * ── 为什么这个文件值得存在（它不是"配置解析的单测"）─────────────────────────
 *   `AUTH_DEVICE_ID_FALLBACK` 打开时，`x-kp-device-id` 会被当成凭据 ——
 *   那在生产环境就是一条**提权后门**（改一个请求头即可成为别人）。
 *   它唯一的护栏是"进程起不来"。而\"进程起不来\"这条判据只会在**出事那天**被执行一次，
 *   所以它必须在这里被逐格钉死：生产 + 开 ⇒ 抛；值拼错 ⇒ 抛；非生产默认开 ⇒ 放。
 *
 * ── 全部通过 `env` 参数注入，**不改** `process.env` ──────────────────────────
 *   `assertAuthBootConfig()` / `deviceIdFallbackEnabled()` 都收 `env` 形参；
 *   直接改 `process.env` 会污染同进程里其它用例（本仓库串行跑，但"顺序依赖"是
 *   下一任维护者最容易踩的坑）。注入形参同时也是\"这个 seam 存在\"的证明 ——
 *   若哪天有人把形参删掉改成只读 `process.env`，本文件会立刻编译不过。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AUTH_DEVICE_ID_FALLBACK_ENV,
  AuthBootConfigError,
  assertAuthBootConfig,
  deviceIdFallbackEnabled,
  isProduction
} from '../src/identity/auth-config'

/** 一个"生产"环境：注意 `AUTH_DEVICE_ID_FALLBACK` 必须**显式**写 0（见下面第一条）。 */
function production(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'production', [AUTH_DEVICE_ID_FALLBACK_ENV]: '0', ...extra }
}

describe('`assertAuthBootConfig()`：会成为洞的配置 ⇒ 进程不该起来', () => {
  it('★ 生产 + `AUTH_DEVICE_ID_FALLBACK=1` ⇒ 抛错（提权后门）', () => {
    assert.throws(
      () => assertAuthBootConfig(production({ [AUTH_DEVICE_ID_FALLBACK_ENV]: '1' })),
      (error: unknown) => {
        assert.ok(error instanceof AuthBootConfigError, '抛的不是 AuthBootConfigError')
        // ★ 错误信息必须**点名**那个变量：这条日志是运维唯一能看到的线索。
        assert.match(error.message, /AUTH_DEVICE_ID_FALLBACK/)
        return true
      }
    )
  })

  it('★ 生产 + 未设置（缺省视为 1）⇒ 也抛错（fail-closed，不是"没配就不管"）', () => {
    // 这一条是刻意的：缺省值若被读成 "off"，那么"忘记配"就把洞打开了
    // （而忘记配是最常见的形态 —— `.env` 是手写的）。
    assert.throws(() => assertAuthBootConfig({ NODE_ENV: 'production' }), AuthBootConfigError)
  })

  it('生产 + 显式 `0` ⇒ 放行（这是唯一正确的生产配置）', () => {
    assert.doesNotThrow(() => assertAuthBootConfig(production()))
  })

  it('值拼错（`true` / `yes` / `on`）⇒ 抛错，且**不猜**它的意思', () => {
    for (const bad of ['true', 'yes', 'on', 'TRUE', ' 2 ', 'false']) {
      assert.throws(
        () => assertAuthBootConfig({ NODE_ENV: 'development', [AUTH_DEVICE_ID_FALLBACK_ENV]: bad }),
        AuthBootConfigError,
        `"${bad}" 被静默接受了 —— 猜错的方向决定它是洞还是故障`
      )
      // 运行期也不能悄悄当成"开"：同一个坏值在守卫里必须继续炸（而不是放行）。
      assert.throws(() =>
        deviceIdFallbackEnabled({ NODE_ENV: 'development', [AUTH_DEVICE_ID_FALLBACK_ENV]: bad })
      )
    }
  })

  it('缺省 / 空串 / 带空白 ⇒ 视为 `1`（双读期默认开）', () => {
    assert.doesNotThrow(() => assertAuthBootConfig({ NODE_ENV: 'development' }))
    assert.doesNotThrow(() => assertAuthBootConfig({ NODE_ENV: 'development', [AUTH_DEVICE_ID_FALLBACK_ENV]: '  ' }))
    assert.doesNotThrow(() => assertAuthBootConfig({ NODE_ENV: 'development', [AUTH_DEVICE_ID_FALLBACK_ENV]: ' 1 ' }))
  })

  it('★ 它**不**检查微信凭据：生产、旁路关、没有 WECHAT_MP_* ⇒ 仍然放行', () => {
    // 没配 secret 的正确表现是请求时 503 `WECHAT_NOT_CONFIGURED`（可观测、不牵连其它端点），
    // 而不是"预发环境起不来"。
    assert.doesNotThrow(() => assertAuthBootConfig(production()))
  })
})

describe('`deviceIdFallbackEnabled()`：生产恒 false，非生产默认 true', () => {
  it('生产恒 false —— 即使有人把开关写成 1', () => {
    // 双保险：那一格本该在启动时崩，但守卫本身也**不**放行。
    assert.equal(deviceIdFallbackEnabled(production({ [AUTH_DEVICE_ID_FALLBACK_ENV]: '1' })), false)
    assert.equal(deviceIdFallbackEnabled(production()), false)
  })

  it('非生产缺省 ⇒ true（旧用例不必逐个改装配）', () => {
    assert.equal(deviceIdFallbackEnabled({ NODE_ENV: 'development' }), true)
    assert.equal(deviceIdFallbackEnabled({}), true)
  })

  it('非生产 + `0` ⇒ false（想验证"完全靠 token"时用的那一格）', () => {
    assert.equal(
      deviceIdFallbackEnabled({ NODE_ENV: 'development', [AUTH_DEVICE_ID_FALLBACK_ENV]: '0' }),
      false
    )
  })

  it('只认 `NODE_ENV`：`APP_ENV=production` 不会被当成生产', () => {
    // 两个"环境名"会让"生产"有两个定义，而它们的交集永远比想象的小。
    assert.equal(isProduction({ APP_ENV: 'production' }), false)
    assert.equal(deviceIdFallbackEnabled({ APP_ENV: 'production' }), true)
    assert.equal(isProduction({ NODE_ENV: 'production' }), true)
  })
})

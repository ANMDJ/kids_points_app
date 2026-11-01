/**
 * W9-D 小程序端「App 登录账号」的异步运行时用例。
 *
 * 结构照抄 `run-w9a.mjs` / `run-w9b.mjs`（Taro stub → require 编译产物 → 汇总 → 退出码）。
 * 这一轮钉的是**两个入口的差别**与**"空"的语义**，它们全是"看起来对、实际会伤人"的：
 *   ① `GET` 回包三字段全空是**合法**的（还没有 App 登录账号），
 *      但 `PUT` 回包三字段全空是**畸形**（刚保存完不可能什么都没绑）——
 *      两个入口共用一份形状检查，只有这一条判据不同；
 *   ② `updateAccount` **只发填了的字段**：空手机号框若被当成"改成空手机号"发出去，
 *      轻则 400，重则清掉绑定；
 *   ③ token 是**编程前提**：空 token 必须本地就抛，不发一次注定 401 的请求；
 *   ④ 掩码与"能不能登"的判定（绑了号但没密码 ⇒ 还不能登）。
 *
 * 编译：./node_modules/.bin/tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w9d.mjs
 */
import assert from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 纯 Node 无法 require 真实的 `@tarojs/taro`（会去求值 `ENABLE_INNER_HTML`）。 */
const taroPath = require.resolve('@tarojs/taro', { paths: [__dirname] })
require.cache[taroPath] = {
  id: taroPath,
  filename: taroPath,
  loaded: true,
  exports: {
    __esModule: true,
    default: {
      request: async () => ({ statusCode: 200, data: null }),
      getStorageSync: () => '',
      setStorageSync: () => undefined,
      removeStorageSync: () => undefined
    }
  },
  children: [],
  paths: []
}

const { AuthApiClient, AuthApiConfig } = require('./dist/data/auth_api.js')
const { AuthApiException } = require('./dist/data/auth_api_errors.js')
const {
  checkAccountEmail,
  checkAccountPhone,
  checkAccountPassword,
  accountLoginReady,
  accountStatusText,
  maskEmail,
  maskPhone
} = require('./dist/data/account.js')

let failed = 0

async function checkAsync(name, fn) {
  try {
    await fn()
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + (error && error.message ? error.message : error))
  }
}

/** 记录每一次请求的假 transport（形状与 `WriteTransport` 一致）。 */
function makeTransport(responder) {
  const calls = []
  return {
    calls,
    async send(uri, headers, body, timeoutMs, method = 'POST') {
      calls.push({ uri, headers, body, method })
      return responder({ uri, headers, body, method })
    }
  }
}

const CONFIG = new AuthApiConfig('http://127.0.0.1:3000')

function client(responder) {
  const transport = makeTransport(responder)
  return { transport, api: new AuthApiClient({ config: CONFIG, transport }) }
}

console.log('W9-D：App 登录账号（小程序端）')
console.log('')

await checkAsync('GET /auth/account 带 Authorization、无 body、method 是 GET', async () => {
  const { transport, api } = client(() => ({
    statusCode: 200,
    body: { phone: '13800138000', email: null, hasPassword: true }
  }))

  const snapshot = await api.fetchAccount('tok-1')

  assert.equal(transport.calls.length, 1)
  const call = transport.calls[0]
  assert.equal(call.method, 'GET')
  assert.equal(call.uri, 'http://127.0.0.1:3000/auth/account')
  assert.equal(call.headers.Authorization, 'Bearer tok-1')
  assert.equal(call.body, null, 'GET 不许带请求体')
  assert.equal(call.headers['Content-Type'], undefined, '无体请求不许声明 Content-Type')
  assert.equal(snapshot.phone, '13800138000')
  assert.equal(snapshot.hasPassword, true)
})

await checkAsync('★ 全新账号（三字段全空）在 GET 里**合法** —— 不是畸形回包', async () => {
  const { api } = client(() => ({
    statusCode: 200,
    body: { phone: null, email: null, hasPassword: false }
  }))

  const snapshot = await api.fetchAccount('tok-1')

  assert.equal(snapshot.phone, null)
  assert.equal(snapshot.email, null)
  assert.equal(snapshot.hasPassword, false)
  // 界面上必须说成"还没有"，而不是"已保存"或"数据坏了"。
  assert.equal(accountLoginReady(snapshot), false)
  assert.match(accountStatusText(snapshot), /还没有 App 登录账号/)
})

await checkAsync('★ 同样的三空出现在 PUT 回包里 ⇒ 仍然 malformed（没有放松检查）', async () => {
  const { api } = client(() => ({
    statusCode: 200,
    body: { phone: null, email: null, hasPassword: false }
  }))

  await assert.rejects(
    () => api.updateAccount('tok-1', { phone: '13800138000' }),
    (error) => {
      assert.ok(error instanceof AuthApiException)
      assert.equal(error.code, 'MALFORMED_RESPONSE')
      return true
    }
  )
})

await checkAsync('空 token ⇒ 本地就抛，不发一次注定 401 的请求', async () => {
  const { transport, api } = client(() => ({ statusCode: 200, body: {} }))
  await assert.rejects(() => api.fetchAccount('   '))
  await assert.rejects(() => api.updateAccount('', { password: 'jiazhang2026' }))
  assert.equal(transport.calls.length, 0)
})


await checkAsync('★ updateAccount 只发填了的字段（不塞 undefined / 空串）', async () => {
  const { transport, api } = client(() => ({
    statusCode: 200,
    body: { phone: '13800138000', email: null, hasPassword: true }
  }))

  await api.updateAccount('tok-1', { password: 'jiazhang2026' })

  const body = transport.calls[0].body
  assert.deepEqual(Object.keys(body).sort(), ['password'], '多余字段会让后端当成"要清空"')
  assert.equal(body.password, 'jiazhang2026')
  assert.equal(transport.calls[0].method, 'PUT')
})

await checkAsync('一个字段都没有 ⇒ 本地就拒（一次必然 400 的往返）', async () => {
  const { transport, api } = client(() => ({ statusCode: 200, body: {} }))
  await assert.rejects(() => api.updateAccount('tok-1', {}))
  assert.equal(transport.calls.length, 0)
})

await checkAsync('403（当前密码错）**不**意味着要重新登录 —— 别把用户赶回登录页', async () => {
  const { api } = client(() => ({
    statusCode: 403,
    body: { code: 'CURRENT_PASSWORD_INVALID', message: '当前密码不正确，密码没有修改。' }
  }))

  await assert.rejects(
    () => api.updateAccount('tok-1', { password: 'jiazhang2026', currentPassword: 'wrong' }),
    (error) => {
      assert.equal(error.requiresLogin, false)
      assert.equal(error.userMessage, '当前密码不正确，密码没有修改。')
      return true
    }
  )
})

await checkAsync('401（token 失效）⇒ requiresLogin:true（store 据此回登录页）', async () => {
  const { api } = client(() => ({
    statusCode: 401,
    body: { code: 'TOKEN_EXPIRED' }
  }))

  await assert.rejects(
    () => api.fetchAccount('tok-old'),
    (error) => {
      assert.equal(error.requiresLogin, true)
      return true
    }
  )
})

await checkAsync('掩码：手机号留头 3 尾 4、邮箱只留首字符', async () => {
  assert.equal(maskPhone('13800138000'), '138****8000')
  assert.equal(maskEmail('dad@example.com'), 'd***@example.com')
  assert.equal(maskEmail('m@x.com'), 'm***@x.com')
})

await checkAsync('本地预检：手机号接受 +86 / 分隔符写法，拒绝错误长度', async () => {
  assert.equal(checkAccountPhone('+86 138-0013-8000'), null)
  assert.equal(checkAccountPhone('13800138000'), null)
  assert.notEqual(checkAccountPhone('1380013800'), null)
  assert.notEqual(checkAccountPhone('12345'), null)
  assert.notEqual(checkAccountPhone(''), null)
})

await checkAsync('本地预检：邮箱要像邮箱，密码只查长度（其余交给服务端）', async () => {
  assert.equal(checkAccountEmail('dad@example.com'), null)
  assert.notEqual(checkAccountEmail('dad'), null)
  assert.notEqual(checkAccountEmail('dad@'), null)
  assert.match(checkAccountPassword('a1b2c3'), /8/)
  assert.equal(checkAccountPassword('jiazhang2026'), null)
})

await checkAsync('★ 绑了号但没密码 ⇒ 还不能登（只查手机号会骗人）', async () => {
  assert.equal(accountLoginReady({ phone: '13800138000', email: null, hasPassword: false }), false)
  assert.equal(accountLoginReady({ phone: null, email: 'dad@example.com', hasPassword: true }), true)
  assert.equal(
    accountLoginReady({ phone: null, email: null, hasPassword: true }),
    false,
    '只有密码没有标识：App 登录页没有东西可填'
  )
  assert.match(
    accountStatusText({ phone: '13800138000', email: null, hasPassword: false }),
    /还差|还没有设置密码/
  )
})

/**
 * ★ 这两条闸门是为了 2026-10-30 那次「小程序看不到任何接口调用」。
 *
 *   Taro 的 `config/index.ts#env` 靠 webpack `DefinePlugin` 注入，它替换的是
 *   **整段字面量表达式** `process.env.TARO_APP_X`。当时的写法是
 *   `return process.env`（整体），而小程序运行时那只是 webpack 的空 polyfill
 *   （`{}`）⇒ 七个 `defaultEnvironment()` 全返回空对象 ⇒ 所有 API 客户端都是
 *   `null` ⇒ 整端停在预览模式、**一个请求都不发**。
 *
 *   最坑的地方：`tsc`、单测、`build:weapp` **全部通过** —— 只有看产物才能发现。
 *   所以这里直接看产物。
 */
await checkAsync('★ 配置读法：只认 `compiled_env` 的三个键（新增配置必须同步白名单）', async () => {
  const { readCompiledEnvironment } = require('./dist/data/compiled_env.js')
  assert.deepEqual(Object.keys(readCompiledEnvironment()).sort(), [
    'TARO_APP_KP_API_BASE_URL',
    'TARO_APP_KP_CHILD_ID',
    'TARO_APP_KP_DEVICE_ID'
  ])
})

await checkAsync('★ 构建产物：配置必须是编译期字面量（整体的 `process.env` 是空壳）', async () => {
  const distPath = join(__dirname, '..', 'dist', 'common.js')
  if (!existsSync(distPath)) {
    console.log('      (跳过：还没跑 build:weapp)')
    return
  }
  const code = readFileSync(distPath, 'utf8')
  assert.ok(
    !/typeof process&&process\.env\?process\.env/.test(code),
    'dist 里仍有整体的 process.env 读取 ⇒ 小程序运行时会拿到空对象，接口一个都不会发'
  )

  const envLocalPath = join(__dirname, '..', '.env.local')
  const envLocal = existsSync(envLocalPath) ? readFileSync(envLocalPath, 'utf8') : ''
  const matched = /^TARO_APP_KP_API_BASE_URL=(.*)$/m.exec(envLocal)
  const baseUrl = (matched === null ? '' : matched[1]).trim()
  if (baseUrl === '') {
    console.log('      (跳过注入断言：.env.local 没配 baseUrl)')
    return
  }
  assert.ok(
    code.includes(`TARO_APP_KP_API_BASE_URL:"${baseUrl}"`),
    `配置值没被注入：dist 里找不到 TARO_APP_KP_API_BASE_URL:"${baseUrl}"`
  )
})

console.log('')
if (failed > 0) {
  console.log(`FAILED ${failed} 项`)
  process.exit(1)
}
console.log('ALL PASS')

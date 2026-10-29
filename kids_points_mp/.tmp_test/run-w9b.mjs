/**
 * W9-B 小程序端**启动闸门**的异步运行时用例。
 *
 * 结构照抄 `run-w9a.mjs`（顶层 await → 汇总 → 退出码）。这一轮的对象是
 * `AppStore` 的登录状态机 + `RuntimeDeviceContext`，钉住五类"看起来能用、
 * 实际会伤人"的地方：
 *   ① 冷启动：4 个 tab 页各调一次 `ensureAuthRestored()` 也只发一次
 *      `GET /auth/session`（否则每次冷启动 4 个请求，还会互相覆盖状态）；
 *   ② 闸门状态逐一落位：`needs_login` / `needs_bootstrap` / `ready` /
 *      `unreachable` 各自的 `canEnterApp` / `authReason` / `authMessage`；
 *   ③ **网络断了 ≠ 掉登录**：`unreachable` 必须保住 token；只有 401 才清；
 *   ④ 运行期身份：登录成功后 `sharedDeviceContext` 的 deviceId / childId
 *      必须**覆盖**编译期常量，且客户端请求头随之改变（不重建客户端）；
 *   ⑤ 401 分流真的接上了读端点：`TOKEN_EXPIRED` 静默重登**一次**（`wx.login`
 *      只调 1 次，没有循环）⇒ 仍失败就 `login_required(relogin_failed)`；
 *      `TOKEN_INVALID` 直接去登录页，而不是把 401 画成一条"读取失败"。
 *
 * 编译：./node_modules/.bin/tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w9b.mjs
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
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
    default: {},
    request: async () => ({ statusCode: 200, data: null }),
    login: async () => ({ code: 'wx-code-from-stub' }),
    getStorageSync: () => '',
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
    useDidShow: () => undefined,
    useReady: () => undefined,
    redirectTo: async () => undefined,
    getCurrentPages: () => []
  },
  children: [],
  paths: []
}

const { AppStore } = require('./dist/data/store.js')
const { AuthSessionMachine, MemoryAuthTokenStore } = require('./dist/data/auth_session.js')
const { AuthApiException } = require('./dist/data/auth_api_errors.js')
const {
  BootstrapChildResultDto,
  ChildSessionResultDto,
  LoginResultDto,
  SessionDto
} = require('./dist/data/auth_dto.js')
const { AuthTokenHolder } = require('./dist/data/auth_token_holder.js')
const { MemoryKeyValueStorage } = require('./dist/data/client_storage.js')
const { AuthApiConfig } = require('./dist/data/auth_api.js')
const {
  ReadApiClient,
  ReadApiConfig,
  kDeviceIdHeader,
  kChildIdHeader
} = require('./dist/data/read_api.js')
const { sharedDeviceContext } = require('./dist/data/runtime_identity.js')

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

const EXPIRES_AT = '2026-11-05T09:00:00.000Z'
const DEVICE_ID = 'kp-dev-000000000000000000000001'

/** 让 store 里那些 `void xxx()` 的异步链路跑完。 */
async function settle(times = 40) {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

function sessionOf(children) {
  return SessionDto.fromJson({
    user: { id: 'u-1', displayName: '家长' },
    expiresAt: EXPIRES_AT,
    children: children ?? [{ childId: 'c-1', name: '小可爱', role: 'guardian' }]
  })
}

function loginResult(overrides = {}) {
  return LoginResultDto.fromJson({
    token: 'tok-1',
    expiresAt: EXPIRES_AT,
    user: { id: 'u-1', displayName: '家长' },
    membership: { childId: 'c-1', role: 'guardian' },
    ...overrides
  })
}

function childSessionResult(childId, role = 'guardian') {
  return ChildSessionResultDto.fromJson(
    { childId, role, sessionExpiresAt: EXPIRES_AT },
    childId
  )
}

function authError(statusCode, code, message) {
  return new AuthApiException('unauthenticated', message ?? '失败', { statusCode, code })
}

/** 假 `AuthApi`：记录调用顺序，按需覆盖每个方法。 */
function fakeAuthApi(handlers = {}) {
  const calls = []
  return {
    calls,
    async login(input) {
      calls.push({ op: 'login', input })
      return handlers.login ? handlers.login(input) : loginResult()
    },
    async fetchSession(token) {
      calls.push({ op: 'fetchSession', token })
      return handlers.fetchSession ? handlers.fetchSession(token) : sessionOf()
    },
    async logout(token) {
      calls.push({ op: 'logout', token })
      if (handlers.logout) return handlers.logout(token)
      return undefined
    },
    async bootstrapChild(token, input) {
      calls.push({ op: 'bootstrapChild', token, input })
      return handlers.bootstrapChild
        ? handlers.bootstrapChild(token, input)
        : BootstrapChildResultDto.fromJson({
            childId: 'c-1',
            role: 'guardian',
            parentModeUntil: EXPIRES_AT,
            modeSource: 'bootstrap'
          })
    },
    async ensureChildSession(token, input) {
      calls.push({ op: 'ensureChildSession', token, input })
      return handlers.ensureChildSession
        ? handlers.ensureChildSession(token, input)
        : childSessionResult(input.childId)
    },
    close() {}
  }
}

/** 每次 `wx.login()` 的计数（用例断言"没有循环"）。 */
const loginCode = { calls: 0 }

function makeMachine(options = {}) {
  const tokens = options.tokens ?? new MemoryAuthTokenStore(options.seedToken ?? null)
  const holder = options.holder ?? new AuthTokenHolder()
  const storage = options.storage ?? new MemoryKeyValueStorage()
  const loginPort = options.loginPort ?? {
    getCode: async () => {
      loginCode.calls += 1
      return 'wx-code-1'
    }
  }
  const api = options.api === undefined ? fakeAuthApi(options.handlers) : options.api
  const machine = new AuthSessionMachine({
    config: new AuthApiConfig('http://127.0.0.1:3000'),
    api,
    tokens,
    holder,
    storage,
    loginPort,
    env: {},
    generate: () => DEVICE_ID
  })
  return { machine, tokens, holder, storage, loginPort, api }
}

/** 一个不发真实网络、只按脚本回包/抛错的 `ReadTransport`。 */
function fakeReadTransport(responses) {
  const calls = []
  return {
    calls,
    async send(uri, headers, timeoutMs) {
      calls.push({ uri, headers, timeoutMs })
      const index = calls.length - 1
      const next =
        typeof responses === 'function' ? responses(index, calls[index]) : responses[index]
      if (next instanceof Error) throw next
      return next ?? { statusCode: 200, body: {} }
    },
    close() {}
  }
}

/** 编译器身份留空：一切 deviceId / childId 都必须来自运行期上下文。 */
function readClient(transport) {
  return new ReadApiClient({
    config: new ReadApiConfig('http://127.0.0.1:3000', '', ''),
    transport,
    timeoutMs: 1000
  })
}

function newStore(options = {}) {
  sharedDeviceContext.reset()
  return new AppStore(null, null, null, null, options.machine ?? null)
}

// ═════════════════════════════════════════════ A. 冷启动与闸门状态

await checkAsync('闸门：四个页面各调一次 ensureAuthRestored 也只发一次 session', async () => {
  const { machine, api } = makeMachine({ seedToken: 'tok-1' })
  const store = newStore({ machine })

  assert.equal(store.authState, 'idle')
  store.ensureAuthRestored()
  store.ensureAuthRestored()
  store.ensureAuthRestored()
  store.ensureAuthRestored()
  assert.equal(store.authState, 'restoring')
  assert.equal(store.canEnterApp, false)
  await settle()

  assert.equal(store.authState, 'ready')
  assert.equal(store.canEnterApp, true)
  assert.equal(store.isAuthenticated, true)
  assert.equal(store.needsLogin, false)
  assert.equal(api.calls.filter((call) => call.op === 'fetchSession').length, 1)
  assert.equal(api.calls.filter((call) => call.op === 'ensureChildSession').length, 1)
  assert.equal(store.profile.childId, 'c-1')
  assert.equal(store.currentChild.childId, 'c-1')
  assert.equal(store.deviceRole, 'guardian')
  assert.equal(store.accountLabel, '家长')
  assert.equal(store.sessionExpiresAt, Date.parse(EXPIRES_AT))
  // ready 时登录页不该再被用到；候选列表就是会话里的那份孩子（1 个）。
  assert.equal(store.loginCandidates.length, 1)
  assert.equal(store.loginCandidates[0].childId, 'c-1')
  assert.equal(store.isAuthBusy, false)
  assert.deepEqual(sharedDeviceContext.snapshot(), { deviceId: DEVICE_ID, childId: 'c-1' })
})

await checkAsync('闸门：没有 token ⇒ needs_login(no_token)，且 ontoken 不瞎发请求', async () => {
  const { machine, api } = makeMachine()
  const store = newStore({ machine })
  store.ensureAuthRestored()
  await settle()

  assert.equal(store.authState, 'needs_login')
  assert.equal(store.authReason, 'no_token')
  assert.equal(store.canEnterApp, false)
  assert.equal(store.isAuthenticated, false)
  assert.equal(store.needsLogin, true)
  assert.match(store.authMessage, /微信一键登录/)
  assert.deepEqual(api.calls, [])
  assert.equal(sharedDeviceContext.snapshot(), null)
})

await checkAsync('闸门：网络断了 ⇒ unreachable 且**保住** token（不清、不跳登录页）', async () => {
  const { machine, tokens } = makeMachine({
    seedToken: 'tok-1',
    handlers: {
      fetchSession: () => {
        throw authError(null, 'NETWORK_ERROR', '连不上服务器')
      }
    }
  })
  const store = newStore({ machine })
  store.ensureAuthRestored()
  await settle()

  assert.equal(store.authState, 'unreachable')
  // 「确定就绪」才算能进：unreachable 时闸门**不跳登录页**（needsLogin=false），
  // 页面照常显示本地数据 + 读取失败条，用户自己点重试。
  assert.equal(store.canEnterApp, false)
  assert.equal(store.needsLogin, false)
  assert.equal(tokens.read(), 'tok-1')
  assert.match(store.authMessage, /连不上服务器/)

  // 重试仍失败 → 还是 unreachable（而不是 needs_login）；token 依然在。
  store.retryAuth()
  await settle()
  assert.equal(store.authState, 'unreachable')
  assert.equal(tokens.read(), 'tok-1')
})

await checkAsync('闸门：0 个孩子 ⇒ needs_bootstrap；建档案后 ready', async () => {
  // 第 1 次 session 空 → 引导建档案；第 2 次（建完之后）就有孩子了。
  let sessions = 0
  const { machine, api } = makeMachine({
    seedToken: 'tok-1',
    handlers: {
      fetchSession: () => {
        sessions += 1
        return sessionOf(sessions === 1 ? [] : undefined)
      }
    }
  })
  const store = newStore({ machine })
  store.ensureAuthRestored()
  await settle()

  assert.equal(store.authState, 'needs_bootstrap')
  assert.equal(store.canEnterApp, false)
  assert.equal(store.authUser.id, 'u-1')
  assert.equal(store.currentChild, null)
  assert.equal(sharedDeviceContext.childId(), null)
  assert.equal(api.calls.filter((call) => call.op === 'ensureChildSession').length, 0)

  const message = await store.bootstrapChild()
  await settle()

  assert.equal(message, null)
  assert.equal(store.authState, 'ready')
  assert.equal(store.profile.childId, 'c-1')
  assert.equal(sharedDeviceContext.childId(), 'c-1')
  assert.equal(
    api.calls.filter((call) => call.op === 'bootstrapChild').length,
    1
  )
  const bootstrapCall = api.calls.filter((call) => call.op === 'bootstrapChild')[0]
  assert.equal(bootstrapCall.input.deviceId, DEVICE_ID)
  // 编排器只会用 `accepted: true` 发请求（同意先行，界面那层也拦）。
  assert.equal(api.calls.filter((call) => call.op === 'ensureChildSession').length, 1)
})

// ═════════════════════════════════════════════ B. 登录 / 退出

await checkAsync('登录：needs_login → login() → ready（wx.login 只调 1 次）', async () => {
  const { machine, api, tokens } = makeMachine()
  const store = newStore({ machine })
  store.ensureAuthRestored()
  await settle()
  assert.equal(store.authState, 'needs_login')

  loginCode.calls = 0
  const message = await store.login()
  await settle()

  assert.equal(message, null)
  assert.equal(store.authState, 'ready')
  assert.equal(loginCode.calls, 1)
  assert.equal(tokens.read(), 'tok-1')
  assert.deepEqual(
    api.calls.map((call) => call.op),
    ['login', 'fetchSession', 'ensureChildSession']
  )
  // 登录请求本身不带 Authorization（会话固定防护），但 deviceId 必须带。
  assert.equal(api.calls[0].input.deviceId, DEVICE_ID)
})

await checkAsync('登录：微信码失效 ⇒ needs_login(login_failed)，文案用服务端原话', async () => {
  const { machine, tokens } = makeMachine({
    handlers: {
      login: () => {
        throw authError(400, 'WECHAT_CODE_INVALID', '微信登录码已失效')
      }
    }
  })
  const store = newStore({ machine })
  store.ensureAuthRestored()
  await settle()

  const message = await store.login()
  await settle()

  assert.equal(store.authState, 'needs_login')
  assert.equal(store.authReason, 'login_failed')
  assert.equal(message, '微信登录码已失效')
  assert.equal(tokens.read(), null)
  assert.equal(store.isAuthBusy, false)
})

await checkAsync('登录：账号停用 ⇒ needs_login(account_inactive)，token 不落地', async () => {
  const { machine, tokens } = makeMachine({
    handlers: {
      login: () => {
        throw authError(403, 'USER_NOT_ACTIVE', '这个账号已被停用')
      }
    }
  })
  const store = newStore({ machine })
  store.ensureAuthRestored()
  await settle()
  await store.login()
  await settle()

  assert.equal(store.authState, 'needs_login')
  assert.equal(store.authReason, 'account_inactive')
  assert.equal(tokens.read(), null)
  assert.equal(sharedDeviceContext.snapshot(), null)
})

await checkAsync('退出：本地先清 + 服务端没确认时如实说明（revoked=false 才有文案）', async () => {
  const { machine, tokens } = makeMachine({ seedToken: 'tok-1' })
  const store = newStore({ machine })
  store.ensureAuthRestored()
  await settle()
  assert.equal(store.authState, 'ready')

  const message = await store.logout()
  assert.equal(tokens.read(), null)
  assert.equal(store.authState, 'needs_login')
  assert.equal(store.authReason, 'no_token')
  assert.equal(store.canEnterApp, false)
  assert.equal(store.isAuthenticated, false)
  assert.equal(store.currentChild, null)
  assert.equal(sharedDeviceContext.childId(), null)
  // deviceId 是设备标识而不是凭据：退出后**保留**（否则同一台手机会变成新设备）。
  assert.equal(sharedDeviceContext.deviceId(), DEVICE_ID)
  assert.equal(message, null)

  const offline = makeMachine({
    seedToken: 'tok-1',
    handlers: {
      logout: () => {
        throw authError(null, 'NETWORK_ERROR', '连不上服务器')
      }
    }
  })
  const offlineStore = newStore({ machine: offline.machine })
  offlineStore.ensureAuthRestored()
  await settle()
  const offlineMessage = await offlineStore.logout()
  assert.equal(offline.tokens.read(), null)
  assert.equal(offlineStore.authState, 'needs_login')
  assert.match(offlineMessage, /服务端没有确认撤销/)
})

await checkAsync('闸门：没配后端 ⇒ preview，可进主页且不显示登录页依据', async () => {
  const machine = new AuthSessionMachine({
    config: new AuthApiConfig(''),
    api: null,
    tokens: new MemoryAuthTokenStore(null),
    holder: new AuthTokenHolder(),
    storage: new MemoryKeyValueStorage(),
    loginPort: { getCode: async () => 'wx-code-1' },
    env: {},
    generate: () => DEVICE_ID
  })
  const store = newStore({ machine })
  store.ensureAuthRestored()
  await settle()

  assert.equal(store.authState, 'preview')
  assert.equal(store.hasAuthBackend, false)
  assert.equal(store.canEnterApp, true)
  assert.equal(store.needsLogin, false)
  assert.equal(await store.login(), '没有配置登录后端，无法登录。')
})

// ═════════════════════════════════════════════ C. 运行期身份 / 多孩子

await checkAsync('身份：运行期 deviceId/childId 覆盖编译期，并进到请求头', async () => {
  const transport = fakeReadTransport([{ statusCode: 500, body: {} }])
  const client = readClient(transport)
  assert.equal(client.config.effectiveDeviceId, '')
  assert.equal(client.config.effectiveChildId, '')

  sharedDeviceContext.apply({ deviceId: DEVICE_ID, childId: 'c-9' })
  assert.equal(client.config.effectiveDeviceId, DEVICE_ID)
  assert.equal(client.config.effectiveChildId, 'c-9')

  // 500 会抛，但请求已经发出去过 —— 头在传输层留下的就是真相。
  await assert.rejects(() => client.fetchTrash())
  assert.equal(transport.calls.length, 1)
  assert.equal(transport.calls[0].headers[kDeviceIdHeader], DEVICE_ID)
  assert.equal(transport.calls[0].headers[kChildIdHeader], 'c-9')

  // 换孩子（不改 deviceId）⇒ 下一个请求立刻跟着变，不需要重建客户端。
  assert.equal(sharedDeviceContext.applyChild('c-10'), true)
  await assert.rejects(() => client.fetchTrash())
  assert.equal(transport.calls[1].headers[kChildIdHeader], 'c-10')
  assert.equal(transport.calls[1].headers[kDeviceIdHeader], DEVICE_ID)
})

await checkAsync('身份：非法值当场拒（不发出会被后端 trim 的头）', async () => {
  sharedDeviceContext.reset()
  assert.throws(() => sharedDeviceContext.apply({ deviceId: '  ', childId: 'c-1' }), /deviceId/)
  assert.throws(
    () => sharedDeviceContext.apply({ deviceId: DEVICE_ID, childId: '  ' }),
    /childId/
  )
  assert.throws(
    () => sharedDeviceContext.apply({ deviceId: DEVICE_ID, childId: 'c 1' }),
    /空白/
  )
  // 抛了就不该留下半套状态（半个身份比没有身份更危险）。
  assert.equal(sharedDeviceContext.snapshot(), null)
  // 还没有 deviceId 时不能只换孩子 —— 返回 false 而不是造一个半边状态。
  assert.equal(sharedDeviceContext.applyChild('c-1'), false)
  assert.equal(sharedDeviceContext.deviceId(), null)
})

await checkAsync('闸门：多个孩子 ⇒ needs_child_selection，选一个后 ready', async () => {
  const two = [
    { childId: 'c-1', name: '甲', role: 'guardian' },
    { childId: 'c-2', name: '乙', role: 'child' }
  ]
  const { machine, api } = makeMachine({
    seedToken: 'tok-1',
    handlers: {
      fetchSession: () => sessionOf(two),
      // 角色来自**孩子会话**（服务端 DeviceSession.activeRole），不是会话列表里的那一行。
      ensureChildSession: (token, input) =>
        childSessionResult(input.childId, input.childId === 'c-2' ? 'child' : 'guardian')
    }
  })
  const store = newStore({ machine })
  store.ensureAuthRestored()
  await settle()

  assert.equal(store.authState, 'needs_child_selection')
  assert.equal(store.canEnterApp, false)
  assert.equal(store.loginCandidates.length, 2)
  assert.equal(sharedDeviceContext.childId(), null)

  const message = await store.selectChild('c-2')
  await settle()

  assert.equal(message, null)
  assert.equal(store.authState, 'ready')
  assert.equal(store.deviceRole, 'child')
  assert.equal(sharedDeviceContext.childId(), 'c-2')
  assert.equal(
    api.calls.filter((call) => call.op === 'ensureChildSession')[0].input.childId,
    'c-2'
  )
})

// ═════════════════════════════════════════════ D. 401 分流（读端点）

await checkAsync('401：TOKEN_INVALID 的读请求 ⇒ 直接去登录页（不画成读取失败）', async () => {
  const { machine } = makeMachine({ seedToken: 'tok-1' })
  const transport = fakeReadTransport(() => ({
    statusCode: 401,
    body: { code: 'TOKEN_INVALID' }
  }))
  sharedDeviceContext.reset()
  const store = new AppStore(readClient(transport), null, null, null, machine)

  store.ensureAuthRestored()
  await settle(80)

  assert.equal(store.authState, 'needs_login')
  assert.equal(store.authReason, 'token_rejected')
  assert.equal(store.readError, null)
  assert.equal(store.currentChild, null)
  assert.equal(sharedDeviceContext.childId(), null)
})

await checkAsync('401：TOKEN_EXPIRED ⇒ 静默重登**一次**，仍失败则 relogin_failed', async () => {
  const { machine, api } = makeMachine({ seedToken: 'tok-1' })
  const transport = fakeReadTransport(() => ({
    statusCode: 401,
    body: { code: 'TOKEN_EXPIRED' }
  }))
  sharedDeviceContext.reset()
  const store = new AppStore(readClient(transport), null, null, null, machine)

  loginCode.calls = 0
  store.ensureAuthRestored()
  await settle(120)

  assert.equal(loginCode.calls, 1, '静默重登只允许一次（wx.login 一次）')
  assert.equal(api.calls.filter((call) => call.op === 'login').length, 1)
  assert.equal(store.authState, 'needs_login')
  assert.equal(store.authReason, 'relogin_failed')
  // 两次尝试 × 两个端点（首页 + 流水）；再来第三次就是循环了。
  assert.equal(transport.calls.length, 4)
})

console.log('')
if (failed > 0) {
  console.log(`FAILED ${failed} 项`)
  process.exit(1)
}
console.log('ALL PASS')

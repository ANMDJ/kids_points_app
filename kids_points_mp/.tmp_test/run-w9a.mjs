/**
 * W9-A 小程序端登录链路的**异步**运行时用例。
 *
 * 结构照抄 `run-w8c.mjs`：顶层 await → 顶层汇总 → 顶层退出码。
 *
 * 这一轮经过**真** `AuthApiClient` / `AuthSessionMachine`（注入假传输层与
 * 假 `wx.login`）与真 DTO 解析，钉住六类"看起来能做、其实会出错"的地方：
 *   ① 线格式必须严格：`children` 缺失 / `role` 越界 / childId 重复 ⇒ malformed，
 *      不许 `?? []` / `as MemberRole` 猜过去；
 *   ② 请求形状逐字对齐：`login` **不带** Authorization（会话固定防护），
 *      GET 不带 Content-Type，建孩子只发 `consent.accepted:true`；
 *   ③ 401 三分流：`TOKEN_EXPIRED` 静默重登**一次**，`TOKEN_INVALID` 直接去登录页，
 *      网络错误**不清 token**；
 *   ④ 静默重登**没有循环**（重登两次仍 401 ⇒ login_required，`wx.login` 只调 1 次）；
 *   ⑤ deviceId 首次生成并持久化，之后稳定复用（env 只作覆盖，非法即抛）；
 *   ⑥ 预览模式（没配 baseUrl）不发请求、不清 token、不显示登录页依据。
 *
 * 编译：npx tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w9a.mjs
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
    useReady: () => undefined
  },
  children: [],
  paths: []
}

const {
  AuthApiClient,
  AuthApiConfig,
  createAuthApiFromEnvironment
} = require('./dist/data/auth_api.js')
const { AuthApiException, AUTH_FALLBACK_MESSAGES } = require('./dist/data/auth_api_errors.js')
const {
  BootstrapChildResultDto,
  ChildSessionResultDto,
  LoginResultDto,
  SessionDto
} = require('./dist/data/auth_dto.js')
const {
  AuthSessionMachine,
  MemoryAuthTokenStore,
  StorageAuthTokenStore,
  createAuthSessionMachine,
  messageOf,
  kTokenStorageKey
} = require('./dist/data/auth_session.js')
const { AuthTokenHolder } = require('./dist/data/auth_token_holder.js')
const {
  isValidDeviceId,
  generateDeviceId,
  resolveDeviceId,
  peekDeviceId,
  kDeviceIdStorageKey,
  kDeviceIdEnvKey
} = require('./dist/data/device_identity.js')
const { MemoryKeyValueStorage } = require('./dist/data/client_storage.js')
const { ReadApiClient, ReadApiConfig } = require('./dist/data/read_api.js')
const { sharedAuthTokens } = require('./dist/data/auth_token_holder.js')

let failed = 0

async function checkAsync(name, fn) {
  try {
    await fn()
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + error.message)
  }
}

const EXPIRES_AT = '2026-11-05T09:00:00.000Z'
const EXPIRES_MS = Date.parse(EXPIRES_AT)

/** `GET /auth/session` 的线格式（默认：1 个孩子）。 */
function sessionJson(children, overrides = {}) {
  return {
    user: { id: 'u-1', displayName: '家长' },
    expiresAt: EXPIRES_AT,
    children: children ?? [{ childId: 'c-1', name: '小可爱', role: 'guardian' }],
    ...overrides
  }
}

function sessionOf(children, overrides) {
  return SessionDto.fromJson(sessionJson(children, overrides))
}

/** `POST /auth/login` 的线格式。 */
function loginJson(overrides = {}) {
  return {
    token: 'tok-1',
    expiresAt: EXPIRES_AT,
    user: { id: 'u-1', displayName: '家长' },
    membership: { childId: 'c-1', role: 'guardian' },
    ...overrides
  }
}

function loginResult(overrides) {
  return LoginResultDto.fromJson(loginJson(overrides))
}

/** `POST /auth/child-session` 的线格式。 */
function childSessionResult(childId, role = 'guardian') {
  return ChildSessionResultDto.fromJson(
    { childId, role, sessionExpiresAt: EXPIRES_AT },
    childId
  )
}

/**
 * 假的 `WriteTransport`：按调用序号回放响应；`Error` 直接抛（模拟网络异常）。
 * 同时记录每次调用的**完整**请求（头、体、方法），供逐字断言。
 */
function fakeTransport(responses) {
  const calls = []
  return {
    calls,
    async send(uri, headers, body, timeoutMs, method) {
      calls.push({ uri, headers, body, timeoutMs, method })
      const index = calls.length - 1
      const next =
        typeof responses === 'function' ? responses(index, calls[index]) : responses[index]
      if (next instanceof Error) throw next
      return next ?? { statusCode: 200, body: null }
    }
  }
}

function apiError(statusCode, code, message) {
  return new AuthApiException('unauthenticated', message ?? '失败', { statusCode, code })
}


/** `POST /children` 的线格式。 */
function bootstrapJson(overrides = {}) {
  return {
    childId: 'c-new',
    role: 'guardian',
    parentModeUntil: EXPIRES_AT,
    modeSource: 'bootstrap',
    ...overrides
  }
}

/** 假的 `AuthApi`：记录调用顺序，按需覆盖每个方法的返回值（或抛错）。 */
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
        : BootstrapChildResultDto.fromJson(bootstrapJson())
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

/**
 * 装配一台编排器。
 *
 * `env` 默认是 `{}`（**不**读 `process.env`）：这样 deviceId 走"生成 + 持久化"
 * 那条真实路径，且用例之间互不影响。
 */
function makeMachine(options = {}) {
  const tokens = options.tokens ?? new MemoryAuthTokenStore(options.seedToken ?? null)
  const holder = options.holder ?? new AuthTokenHolder()
  const storage = options.storage ?? new MemoryKeyValueStorage()
  const loginPort = options.loginPort ?? { getCode: async () => 'wx-code-1' }
  const api = options.api === undefined ? fakeAuthApi(options.handlers) : options.api
  const machine = new AuthSessionMachine({
    config: options.config ?? new AuthApiConfig('http://127.0.0.1:3000'),
    api,
    tokens,
    holder,
    storage,
    loginPort,
    env: options.env ?? {},
    generate: options.generate ?? (() => 'kp-dev-000000000000000000000001')
  })
  return { machine, tokens, holder, storage, loginPort, api }
}

/** DTO 的 malformed 一律带 `MALFORMED_RESPONSE` + 字段路径（反引号）。 */
function assertMalformed(error, path) {
  assert.ok(error instanceof AuthApiException, `应当是 AuthApiException，实际 ${error}`)
  assert.equal(error.code, 'MALFORMED_RESPONSE')
  if (path !== undefined) {
    assert.ok(
      error.message.includes('`' + path + '`'),
      `message 里应带字段路径 ${path}：${error.message}`
    )
  }
}

// ═══════════════════════════════════════════════ A. 线格式（auth_dto）

await checkAsync('DTO：session 正常解析（1 个孩子 / 绝对到期）', async () => {
  const dto = sessionOf()
  assert.equal(dto.user.id, 'u-1')
  assert.equal(dto.expiresAt, EXPIRES_MS)
  assert.equal(dto.childCount, 1)
  assert.deepEqual(dto.children[0], {
    childId: 'c-1',
    name: '小可爱',
    role: 'guardian'
  })
})

await checkAsync('DTO：children 缺失 ⇒ malformed（不许当成 0 个）', async () => {
  const raw = sessionJson()
  delete raw.children
  assert.throws(() => SessionDto.fromJson(raw), (error) => {
    assertMalformed(error, 'children')
    return true
  })
})

await checkAsync('DTO：role 越界 ⇒ malformed（不许 as MemberRole）', async () => {
  assert.throws(
    () => sessionOf([{ childId: 'c-1', name: 'x', role: 'admin' }]),
    (error) => {
      assertMalformed(error, 'children[0].role')
      return true
    }
  )
})

await checkAsync('DTO：childId 重复 ⇒ malformed（不许静默去重）', async () => {
  assert.throws(
    () =>
      sessionOf([
        { childId: 'c-1', name: 'a', role: 'guardian' },
        { childId: 'c-1', name: 'b', role: 'child' }
      ]),
    (error) => {
      assertMalformed(error, 'children[1].childId')
      return true
    }
  )
})

await checkAsync('DTO：expiresAt 不是 ISO 时间 ⇒ malformed（不许当"永不过期"）', async () => {
  assert.throws(
    () => sessionOf(undefined, { expiresAt: '2026-11-05' }),
    (error) => {
      assertMalformed(error, 'expiresAt')
      return true
    }
  )
  assert.throws(
    () => sessionOf(undefined, { expiresAt: '2026-13-45T00:00:00.000Z' }),
    (error) => {
      assertMalformed(error, 'expiresAt')
      return true
    }
  )
})

await checkAsync('DTO：login 的 token 空串 / 带空白 ⇒ malformed', async () => {
  assert.throws(() => LoginResultDto.fromJson(loginJson({ token: '   ' })), (error) => {
    assertMalformed(error, 'token')
    return true
  })
  assert.throws(() => LoginResultDto.fromJson(loginJson({ token: 'a b' })), (error) => {
    assertMalformed(error, 'token')
    return true
  })
})

await checkAsync('DTO：login 的 membership=null 合法，role 越界 ⇒ malformed', async () => {
  assert.equal(loginResult({ membership: null }).membership, null)
  assert.throws(
    () =>
      LoginResultDto.fromJson(loginJson({ membership: { childId: 'c-1', role: 'root' } })),
    (error) => {
      assertMalformed(error, 'membership.role')
      return true
    }
  )
})

await checkAsync('DTO：login 的安全打印不含 token', async () => {
  const text = loginResult().toDebugString()
  assert.ok(!text.includes('tok-1'), `toDebugString 泄漏了 token：${text}`)
  assert.ok(text.includes('u-1'))
})

await checkAsync('DTO：建孩子只认 role=guardian + modeSource=bootstrap', async () => {
  const dto = BootstrapChildResultDto.fromJson(bootstrapJson())
  assert.equal(dto.childId, 'c-new')
  assert.equal(dto.role, 'guardian')
  assert.equal(dto.modeSource, 'bootstrap')
  assert.equal(dto.parentModeUntil, EXPIRES_MS)
  assert.throws(
    () => BootstrapChildResultDto.fromJson(bootstrapJson({ modeSource: 'pin' })),
    (error) => {
      assertMalformed(error, 'modeSource')
      return true
    }
  )
  assert.throws(
    () => BootstrapChildResultDto.fromJson(bootstrapJson({ role: 'child' })),
    (error) => {
      assertMalformed(error, 'role')
      return true
    }
  )
})

await checkAsync('DTO：child-session 的 childId 回声必须一致', async () => {
  const dto = childSessionResult('c-1', 'child')
  assert.equal(dto.childId, 'c-1')
  assert.equal(dto.role, 'child')
  assert.equal(dto.sessionExpiresAt, EXPIRES_MS)
  assert.throws(
    () =>
      ChildSessionResultDto.fromJson(
        { childId: 'c-OTHER', role: 'guardian', sessionExpiresAt: EXPIRES_AT },
        'c-1'
      ),
    (error) => {
      assertMalformed(error, 'childId')
      return true
    }
  )
})


// ═══════════════════════════════════════════ B. 请求形状（auth_api）

const API_BASE = 'http://127.0.0.1:3000/'

function clientWith(responses) {
  const transport = fakeTransport(responses)
  const client = new AuthApiClient({
    config: new AuthApiConfig(API_BASE),
    transport,
    timeoutMs: 1000
  })
  return { client, transport }
}

await checkAsync('HTTP：login 是 POST /auth/login，体只有 {code}，且**不带** Authorization', async () => {
  sharedAuthTokens.set('tok-old')
  const { client, transport } = clientWith([{ statusCode: 200, body: loginJson() }])
  const dto = await client.login({ code: 'wx-code-9', deviceId: 'dev-1' })
  assert.equal(dto.token, 'tok-1')

  const call = transport.calls[0]
  assert.equal(call.method, 'POST')
  assert.equal(call.uri, 'http://127.0.0.1:3000/auth/login')
  assert.deepEqual(call.body, { code: 'wx-code-9' })
  // ★ 会话固定防护：持有者有旧 token，登录请求也绝不能带上它。
  assert.equal(call.headers.Authorization, undefined)
  assert.equal(call.headers['x-kp-device-id'], 'dev-1')
  assert.ok(call.headers['Content-Type'].includes('application/json'))
  sharedAuthTokens.clear()
})

await checkAsync('HTTP：GET /auth/session 带 Bearer，不带 Content-Type / 设备头', async () => {
  const { client, transport } = clientWith([{ statusCode: 200, body: sessionJson() }])
  await client.fetchSession('tok-1')
  const call = transport.calls[0]
  assert.equal(call.method, 'GET')
  assert.equal(call.uri, 'http://127.0.0.1:3000/auth/session')
  assert.equal(call.headers.Authorization, 'Bearer tok-1')
  assert.equal(call.headers['Content-Type'], undefined)
  assert.equal(call.headers['x-kp-device-id'], undefined)
  assert.equal(call.body, null)
})

await checkAsync('HTTP：POST /children 只发 consent.accepted:true（+可选 relation）', async () => {
  const { client, transport } = clientWith([
    { statusCode: 200, body: bootstrapJson() },
    { statusCode: 200, body: bootstrapJson() }
  ])
  await client.bootstrapChild('tok-1', { deviceId: 'dev-1' })
  await client.bootstrapChild('tok-1', { deviceId: 'dev-1', relation: 'mother' })

  assert.deepEqual(transport.calls[0].body, { consent: { accepted: true } })
  assert.deepEqual(transport.calls[1].body, {
    consent: { accepted: true },
    relation: 'mother'
  })
  assert.equal(transport.calls[0].uri, 'http://127.0.0.1:3000/children')
  assert.equal(transport.calls[0].headers.Authorization, 'Bearer tok-1')
  assert.equal(transport.calls[0].headers['x-kp-device-id'], 'dev-1')
})

await checkAsync('HTTP：POST /auth/child-session 体是 {childId}，且校验回声', async () => {
  const { client, transport } = clientWith([
    {
      statusCode: 200,
      body: { childId: 'c-1', role: 'guardian', sessionExpiresAt: EXPIRES_AT }
    }
  ])
  await client.ensureChildSession('tok-1', { childId: 'c-1', deviceId: 'dev-1' })
  assert.deepEqual(transport.calls[0].body, { childId: 'c-1' })
  assert.equal(transport.calls[0].method, 'POST')
  assert.equal(transport.calls[0].uri, 'http://127.0.0.1:3000/auth/child-session')
})


await checkAsync('HTTP：401 保留业务码，只有 TOKEN_EXPIRED 才 shouldRelogin', async () => {
  const expired = clientWith([
    { statusCode: 401, body: { code: 'TOKEN_EXPIRED', message: '登录已过期' } }
  ])
  await assert.rejects(
    () => expired.client.fetchSession('tok-1'),
    (error) => {
      assert.ok(error instanceof AuthApiException)
      assert.equal(error.statusCode, 401)
      assert.equal(error.code, 'TOKEN_EXPIRED')
      assert.equal(error.shouldRelogin, true)
      assert.equal(error.shouldClearToken, true)
      assert.equal(error.userMessage, '登录已过期')
      return true
    }
  )

  const invalid = clientWith([{ statusCode: 401, body: { code: 'TOKEN_INVALID' } }])
  await assert.rejects(
    () => invalid.client.fetchSession('tok-1'),
    (error) => {
      assert.equal(error.code, 'TOKEN_INVALID')
      assert.equal(error.shouldRelogin, false)
      assert.equal(error.shouldClearToken, true)
      assert.equal(error.userMessage, AUTH_FALLBACK_MESSAGES.TOKEN_INVALID)
      return true
    }
  )
})

await checkAsync('HTTP：429 带上 retryAfterSeconds 与服务端文案', async () => {
  const { client } = clientWith([
    {
      statusCode: 429,
      body: {
        code: 'LOGIN_RATE_LIMITED',
        message: '每 IP 每分钟 20 次',
        retryAfterSeconds: 30
      }
    }
  ])
  await assert.rejects(
    () => client.login({ code: 'c' }),
    (error) => {
      assert.equal(error.statusCode, 429)
      assert.equal(error.retryAfterSeconds, 30)
      assert.equal(error.userMessage, '每 IP 每分钟 20 次')
      return true
    }
  )
})

await checkAsync('HTTP：503 微信未配置 ⇒ unavailable + 可执行文案', async () => {
  const { client } = clientWith([
    { statusCode: 503, body: { code: 'WECHAT_NOT_CONFIGURED' } }
  ])
  await assert.rejects(
    () => client.login({ code: 'c' }),
    (error) => {
      assert.equal(error.kind, 'unavailable')
      assert.equal(error.userMessage, AUTH_FALLBACK_MESSAGES.WECHAT_NOT_CONFIGURED)
      return true
    }
  )
})

await checkAsync('HTTP：logout 204 不抛；401 也不抛（幂等）；500 才抛', async () => {
  const ok = clientWith([{ statusCode: 204, body: null }])
  assert.equal(await ok.client.logout('tok-1'), undefined)
  assert.equal(ok.transport.calls[0].headers.Authorization, 'Bearer tok-1')

  const dead = clientWith([{ statusCode: 401, body: { code: 'TOKEN_INVALID' } }])
  assert.equal(await dead.client.logout('tok-1'), undefined)

  const broken = clientWith([{ statusCode: 500, body: { message: 'boom' } }])
  await assert.rejects(
    () => broken.client.logout('tok-1'),
    (error) => {
      assert.equal(error.statusCode, 500)
      return true
    }
  )
})

await checkAsync('HTTP：传输层异常 ⇒ AuthApiException(network)，不冒充 401', async () => {
  const { client } = clientWith([new Error('网络断了')])
  await assert.rejects(
    () => client.fetchSession('tok-1'),
    (error) => {
      assert.ok(error instanceof AuthApiException)
      assert.equal(error.kind, 'network')
      assert.equal(error.statusCode, null)
      assert.equal(error.shouldClearToken, false)
      return true
    }
  )
})

await checkAsync('HTTP：没配 baseUrl ⇒ CLIENT_NOT_CONFIGURED 且**一次请求都不发**', async () => {
  const transport = fakeTransport([])
  const client = new AuthApiClient({
    config: new AuthApiConfig(''),
    transport,
    timeoutMs: 1000
  })
  await assert.rejects(
    () => client.fetchSession('tok-1'),
    (error) => {
      assert.equal(error.code, 'CLIENT_NOT_CONFIGURED')
      return true
    }
  )
  assert.deepEqual(transport.calls, [])
  assert.equal(createAuthApiFromEnvironment({}), null)
})


await checkAsync('HTTP：既有读客户端共享持有者 ⇒ 业务请求自动带 Bearer', async () => {
  const calls = []
  const readClient = new ReadApiClient({
    config: new ReadApiConfig(API_BASE, 'dev-1', 'c-1'),
    transport: {
      async send(uri, headers) {
        calls.push({ uri, headers })
        return { statusCode: 200, body: {} }
      }
    },
    timeoutMs: 1000
  })

  sharedAuthTokens.clear()
  await assert.rejects(() => readClient.fetchHome())
  assert.equal(calls[0].headers.Authorization, undefined)

  sharedAuthTokens.set('tok-read')
  await assert.rejects(() => readClient.fetchHome())
  assert.equal(calls[1].headers.Authorization, 'Bearer tok-read')
  sharedAuthTokens.clear()
})

// ═══════════════════════════════ C. 设备标识（device_identity）

await checkAsync('设备标识：首次生成 + 持久化，第二次复用（source=storage）', async () => {
  const storage = new MemoryKeyValueStorage()
  const first = resolveDeviceId({
    env: {},
    storage,
    generate: () => 'kp-dev-aaaaaaaaaaaaaaaaaaaaaaaa'
  })
  assert.equal(first.deviceId, 'kp-dev-aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(first.source, 'generated')
  assert.equal(first.persisted, true)
  assert.equal(storage.peek(kDeviceIdStorageKey), first.deviceId)

  const second = resolveDeviceId({ env: {}, storage, generate: () => 'kp-dev-CHANGED' })
  assert.equal(second.deviceId, first.deviceId)
  assert.equal(second.source, 'storage')
})

await checkAsync('设备标识：env 覆盖优先（source=env），非法 env 直接抛', async () => {
  const storage = new MemoryKeyValueStorage({ [kDeviceIdStorageKey]: 'kp-dev-stored' })
  const overridden = resolveDeviceId({
    env: { [kDeviceIdEnvKey]: ' dev-manual ' },
    storage
  })
  assert.equal(overridden.deviceId, 'dev-manual')
  assert.equal(overridden.source, 'env')

  assert.throws(
    () => resolveDeviceId({ env: { [kDeviceIdEnvKey]: 'dev-别人的设备' }, storage }),
    /不是合法的设备标识/
  )
})

await checkAsync('设备标识：storage 里的非法旧值 ⇒ 丢弃并重新生成', async () => {
  const storage = new MemoryKeyValueStorage({ [kDeviceIdStorageKey]: '含 空格 的值' })
  const resolved = resolveDeviceId({
    env: {},
    storage,
    generate: () => 'kp-dev-bbbbbbbbbbbbbbbbbbbbbbbb'
  })
  assert.equal(resolved.deviceId, 'kp-dev-bbbbbbbbbbbbbbbbbbbbbbbb')
  assert.equal(resolved.source, 'generated')
  assert.equal(storage.peek(kDeviceIdStorageKey), resolved.deviceId)
})

await checkAsync('设备标识：写 storage 失败 ⇒ persisted=false（值仍可用，但要如实上报）', async () => {
  const storage = new MemoryKeyValueStorage()
  storage.failWritesFor(kDeviceIdStorageKey)
  const resolved = resolveDeviceId({
    env: {},
    storage,
    generate: () => 'kp-dev-cccccccccccccccccccccccc'
  })
  assert.equal(resolved.persisted, false)
  assert.equal(resolved.deviceId, 'kp-dev-cccccccccccccccccccccccc')
})

await checkAsync('设备标识：生成值形状合法（前缀 + 24 位十六进制）', async () => {
  const value = generateDeviceId(() => 0.123456789)
  assert.equal(isValidDeviceId(value), true)
  assert.match(value, /^kp-dev-[0-9a-f]{24}$/)
  assert.equal(isValidDeviceId(''), false)
  assert.equal(isValidDeviceId('a b'), false)
  assert.equal(isValidDeviceId('x'.repeat(129)), false)
})

await checkAsync('设备标识：peekDeviceId 只读不生成', async () => {
  const storage = new MemoryKeyValueStorage()
  assert.equal(peekDeviceId(storage), null)
  assert.equal(storage.peek(kDeviceIdStorageKey), undefined)
})

// ═════════════════════════════ D. 凭据持有者与持久化

await checkAsync('持有者：空 / 带空白一律拒绝，toString 不泄漏 token', async () => {
  const holder = new AuthTokenHolder()
  assert.equal(holder.authorizationHeader(), null)
  assert.equal(holder.has(), false)
  assert.throws(() => holder.set('   '), /不能为空/)
  assert.throws(() => holder.set('a b'), /空白/)
  holder.set(' tok-1 ')
  assert.equal(holder.authorizationHeader(), 'Bearer tok-1')
  assert.ok(!holder.toString().includes('tok-1'))
  holder.clear()
  assert.equal(holder.has(), false)
})

await checkAsync('token 存储：旧版本写进的坏值 ⇒ 视为没有 token 并清掉', async () => {
  const storage = new MemoryKeyValueStorage({ [kTokenStorageKey]: '  ' })
  const store = new StorageAuthTokenStore(storage)
  assert.equal(store.read(), null)
  assert.equal(storage.peek(kTokenStorageKey), undefined)

  store.write('  tok-2  ')
  assert.equal(storage.peek(kTokenStorageKey), 'tok-2')
  assert.equal(store.read(), 'tok-2')
})


// ═══════════════════════════════ E. 编排（AuthSessionMachine）

await checkAsync('编排：没配 baseUrl ⇒ preview，不发请求、不清 token', async () => {
  const api = fakeAuthApi()
  const { machine, tokens } = makeMachine({
    api,
    config: new AuthApiConfig(''),
    seedToken: 'tok-1'
  })
  assert.equal(machine.isConfigured, false)
  const result = await machine.restore()
  assert.equal(result.kind, 'preview')
  assert.match(result.message, /TARO_APP_KP_API_BASE_URL/)
  assert.deepEqual(api.calls, [])
  assert.equal(tokens.read(), 'tok-1')
})

await checkAsync('编排：工厂按 env 装配 —— 空 env ⇒ preview，有 baseUrl ⇒ 已配置', async () => {
  const preview = createAuthSessionMachine({ env: {} })
  assert.equal(preview.isConfigured, false)
  assert.equal((await preview.restore()).kind, 'preview')

  const configured = createAuthSessionMachine({
    env: { TARO_APP_KP_API_BASE_URL: 'http://127.0.0.1:3000' }
  })
  assert.equal(configured.isConfigured, true)
})

await checkAsync('编排：没有 token ⇒ needs_login(no_token)，且一次请求都不发', async () => {
  const { machine, api, holder } = makeMachine()
  const result = await machine.restore()
  assert.equal(result.kind, 'needs_login')
  assert.equal(result.reason, 'no_token')
  assert.deepEqual(api.calls, [])
  assert.equal(holder.has(), false)
})

await checkAsync('编排：1 个孩子 ⇒ 先 fetchSession 再 child-session，交出 ready', async () => {
  const { machine, api, holder } = makeMachine({ seedToken: 'tok-1' })
  const result = await machine.restore()
  assert.equal(result.kind, 'ready')
  assert.equal(result.token, 'tok-1')
  assert.deepEqual(result.membership, {
    childId: 'c-1',
    name: '小可爱',
    role: 'guardian'
  })
  assert.equal(result.sessionExpiresAt, EXPIRES_MS)
  assert.deepEqual(
    api.calls.map((call) => call.op),
    ['fetchSession', 'ensureChildSession']
  )
  assert.equal(api.calls[0].token, 'tok-1')
  assert.equal(api.calls[1].input.childId, 'c-1')
  // ★ 从 storage 恢复的 token 必须进持有者（否则业务请求不带 Authorization）
  assert.equal(holder.current(), 'tok-1')
})

await checkAsync('编排：0 个孩子 ⇒ needs_bootstrap（不调 child-session）', async () => {
  const { machine, api } = makeMachine({
    seedToken: 'tok-1',
    handlers: { fetchSession: () => sessionOf([]) }
  })
  const result = await machine.restore()
  assert.equal(result.kind, 'needs_bootstrap')
  assert.equal(result.session.childCount, 0)
  assert.deepEqual(api.calls.map((call) => call.op), ['fetchSession'])
})

await checkAsync('编排：2 个孩子 ⇒ needs_child_selection（不猜第一个）', async () => {
  const { machine, api } = makeMachine({
    seedToken: 'tok-1',
    handlers: {
      fetchSession: () =>
        sessionOf([
          { childId: 'c-1', name: '甲', role: 'guardian' },
          { childId: 'c-2', name: '乙', role: 'child' }
        ])
    }
  })
  const result = await machine.restore()
  assert.equal(result.kind, 'needs_child_selection')
  assert.equal(result.children.length, 2)
  assert.deepEqual(api.calls.map((call) => call.op), ['fetchSession'])
})

await checkAsync('编排：401 TOKEN_EXPIRED ⇒ 清 token + needs_login(token_rejected)', async () => {
  const { machine, tokens, holder } = makeMachine({
    seedToken: 'tok-1',
    handlers: {
      fetchSession: () => {
        throw apiError(401, 'TOKEN_EXPIRED', '登录已过期')
      }
    }
  })
  const result = await machine.restore()
  assert.equal(result.kind, 'needs_login')
  assert.equal(result.reason, 'token_rejected')
  assert.equal(result.message, '登录已过期')
  assert.equal(tokens.read(), null)
  assert.equal(holder.has(), false)
})

await checkAsync('编排：网络错误 ⇒ unreachable，**不清** token', async () => {
  const { machine, tokens, holder } = makeMachine({
    seedToken: 'tok-1',
    handlers: {
      fetchSession: () => {
        throw new AuthApiException('network', '连不上服务器', { code: 'NETWORK_ERROR' })
      }
    }
  })
  const result = await machine.restore()
  assert.equal(result.kind, 'unreachable')
  assert.equal(tokens.read(), 'tok-1')
  assert.equal(holder.current(), 'tok-1')
})

await checkAsync('编排：403 USER_NOT_ACTIVE ⇒ account_inactive，token 保留', async () => {
  const { machine, tokens } = makeMachine({
    seedToken: 'tok-1',
    handlers: {
      fetchSession: () => {
        throw apiError(403, 'USER_NOT_ACTIVE', '账号已停用')
      }
    }
  })
  const result = await machine.restore()
  assert.equal(result.kind, 'needs_login')
  assert.equal(result.reason, 'account_inactive')
  assert.equal(tokens.read(), 'tok-1')
})


await checkAsync('编排：login 走 wx.login → /auth/login → 存 token → restore', async () => {
  const { machine, api, tokens, holder, storage } = makeMachine()
  const result = await machine.login()
  assert.equal(result.kind, 'ready')
  assert.deepEqual(
    api.calls.map((call) => call.op),
    ['login', 'fetchSession', 'ensureChildSession']
  )
  assert.equal(api.calls[0].input.code, 'wx-code-1')
  // deviceId 必须是"生成并落盘"的那一个（不是编译期常量，也不是空）
  const deviceId = api.calls[0].input.deviceId
  assert.match(deviceId, /^kp-dev-[0-9a-f]{24}$/)
  assert.equal(storage.peek(kDeviceIdStorageKey), deviceId)
  assert.equal(tokens.writes, 1)
  assert.equal(holder.current(), 'tok-1')
})

await checkAsync('编排：登录被限流 ⇒ needs_login(login_failed)，旧 token **不**清', async () => {
  const { machine, tokens } = makeMachine({
    seedToken: 'tok-old',
    handlers: {
      login: () => {
        throw apiError(429, 'LOGIN_RATE_LIMITED', '登录尝试太频繁')
      }
    }
  })
  const result = await machine.login()
  assert.equal(result.kind, 'needs_login')
  assert.equal(result.reason, 'login_failed')
  assert.equal(result.message, '登录尝试太频繁')
  assert.equal(tokens.read(), 'tok-old')
})

await checkAsync('编排：wx.login 失败 ⇒ login_failed，且**不**发 /auth/login', async () => {
  const { machine, api } = makeMachine({
    loginPort: {
      getCode: async () => {
        throw new Error('wx.login:fail 系统错误')
      }
    }
  })
  const result = await machine.login()
  assert.equal(result.kind, 'needs_login')
  assert.equal(result.reason, 'login_failed')
  assert.match(result.message, /wx\.login:fail/)
  assert.deepEqual(api.calls, [])
})

await checkAsync('编排：没勾选同意 ⇒ 本地抛错且**零请求**（同意先行）', async () => {
  const { machine, api } = makeMachine({ seedToken: 'tok-1' })
  await assert.rejects(
    () => machine.bootstrapChild({ accepted: false }),
    /监护人协议/
  )
  assert.deepEqual(api.calls, [])
})

await checkAsync('编排：勾选同意 ⇒ POST /children 后回到权威的 restore', async () => {
  const { machine, api } = makeMachine({ seedToken: 'tok-1' })
  const result = await machine.bootstrapChild({ accepted: true, relation: 'father' })
  assert.equal(result.kind, 'ready')
  assert.deepEqual(
    api.calls.map((call) => call.op),
    ['bootstrapChild', 'fetchSession', 'ensureChildSession']
  )
  assert.equal(api.calls[0].token, 'tok-1')
  assert.equal(api.calls[0].input.relation, 'father')
  assert.match(api.calls[0].input.deviceId, /^kp-dev-/)
})

await checkAsync('编排：retryOnce —— TOKEN_EXPIRED 只静默重登**一次**并重放', async () => {
  let codeCalls = 0
  const { machine } = makeMachine({
    seedToken: 'tok-1',
    handlers: { login: () => loginResult({ token: 'tok-2' }) },
    loginPort: {
      getCode: async () => {
        codeCalls += 1
        return 'wx-code-retry'
      }
    }
  })
  const seen = []
  const result = await machine.retryOnce(async (token) => {
    seen.push(token)
    if (seen.length === 1) throw apiError(401, 'TOKEN_EXPIRED')
    return 'done'
  })
  assert.equal(result.kind, 'ok')
  assert.equal(result.value, 'done')
  assert.deepEqual(seen, ['tok-1', 'tok-2'])
  assert.equal(codeCalls, 1)
})

await checkAsync('编排：retryOnce —— 重登后仍 401 ⇒ login_required（不是无限循环）', async () => {
  let codeCalls = 0
  const { machine, tokens } = makeMachine({
    seedToken: 'tok-1',
    handlers: { login: () => loginResult({ token: 'tok-2' }) },
    loginPort: {
      getCode: async () => {
        codeCalls += 1
        return 'wx-code-retry'
      }
    }
  })
  const result = await machine.retryOnce(async () => {
    throw apiError(401, 'TOKEN_EXPIRED')
  })
  assert.equal(result.kind, 'login_required')
  assert.equal(result.reason, 'relogin_failed')
  assert.equal(codeCalls, 1)
  assert.equal(tokens.read(), null)
})

await checkAsync('编排：retryOnce —— TOKEN_INVALID / 网络错误都不重登，原样抛出', async () => {
  let codeCalls = 0
  const { machine } = makeMachine({
    seedToken: 'tok-1',
    loginPort: {
      getCode: async () => {
        codeCalls += 1
        return 'wx-code-retry'
      }
    }
  })
  await assert.rejects(
    () =>
      machine.retryOnce(async () => {
        throw apiError(401, 'TOKEN_INVALID')
      }),
    (error) => {
      assert.equal(error.code, 'TOKEN_INVALID')
      return true
    }
  )
  await assert.rejects(
    () =>
      machine.retryOnce(async () => {
        throw new AuthApiException('network', '连不上服务器', { code: 'NETWORK_ERROR' })
      }),
    (error) => {
      assert.equal(error.kind, 'network')
      return true
    }
  )
  assert.equal(codeCalls, 0)
})

await checkAsync('编排：retryOnce —— 没有 token 时直接 login_required(no_token)', async () => {
  const { machine, api } = makeMachine()
  let called = false
  const result = await machine.retryOnce(async () => {
    called = true
    return 'never'
  })
  assert.equal(result.kind, 'login_required')
  assert.equal(result.reason, 'no_token')
  assert.equal(called, false)
  assert.deepEqual(api.calls, [])
})

await checkAsync('编排：logout 先清本地再撤销；网络失败也退出（revoked=false）', async () => {
  const ok = makeMachine({ seedToken: 'tok-1' })
  const okResult = await ok.machine.logout()
  assert.equal(okResult.revoked, true)
  assert.equal(ok.tokens.read(), null)
  assert.equal(ok.holder.has(), false)
  assert.deepEqual(ok.api.calls.map((call) => call.op), ['logout'])

  const offline = makeMachine({
    seedToken: 'tok-1',
    handlers: {
      logout: () => {
        throw new AuthApiException('network', '连不上服务器', { code: 'NETWORK_ERROR' })
      }
    }
  })
  const offlineResult = await offline.machine.logout()
  assert.equal(offlineResult.revoked, false)
  assert.equal(offline.tokens.read(), null)
  assert.equal(offline.holder.has(), false)
})


await checkAsync('编排：selectChild 走 fetchSession → 找到成员位 → child-session', async () => {
  const twoChildren = [
    { childId: 'c-1', name: '甲', role: 'guardian' },
    { childId: 'c-2', name: '乙', role: 'child' }
  ]
  const { machine, api } = makeMachine({
    seedToken: 'tok-1',
    handlers: { fetchSession: () => sessionOf(twoChildren) }
  })
  const result = await machine.selectChild('c-2')
  assert.equal(result.kind, 'ready')
  assert.equal(result.membership.childId, 'c-2')
  assert.equal(result.membership.name, '乙')
  assert.deepEqual(
    api.calls.map((call) => call.op),
    ['fetchSession', 'ensureChildSession']
  )
  assert.equal(api.calls[1].input.childId, 'c-2')
})

await checkAsync('编排：selectChild 选一个不是成员的孩子 ⇒ unreachable + NOT_A_MEMBER（不建会话）', async () => {
  const { machine, api } = makeMachine({
    seedToken: 'tok-1',
    handlers: { fetchSession: () => sessionOf([{ childId: 'c-1', name: '甲', role: 'guardian' }]) }
  })
  const result = await machine.selectChild('c-9')
  assert.equal(result.kind, 'unreachable')
  assert.equal(result.error.code, 'NOT_A_MEMBER')
  assert.deepEqual(api.calls.map((call) => call.op), ['fetchSession'])
})

await checkAsync('编排：deviceId 一次解析后**稳定**（建孩子与选孩子用同一个）', async () => {
  const { machine, api, storage } = makeMachine({ seedToken: 'tok-1' })
  await machine.bootstrapChild({ accepted: true })
  await machine.bootstrapChild({ accepted: true })

  const deviceIds = api.calls
    .filter((call) => call.input && call.input.deviceId)
    .map((call) => call.input.deviceId)
  // 两次 bootstrap + 两次 child-session 都应该用同一个 deviceId（它必须稳定）
  assert.equal(deviceIds.length, 4)
  assert.equal(new Set(deviceIds).size, 1)
  assert.equal(storage.peek(kDeviceIdStorageKey), deviceIds[0])
})

await checkAsync('编排：messageOf 覆盖每一支可用文案', async () => {
  assert.match(messageOf({ kind: 'ready' }), /登录已完成/)
  assert.match(messageOf({ kind: 'needs_bootstrap' }), /建立档案/)
  assert.equal(messageOf({ kind: 'preview', message: 'p' }), 'p')
  assert.equal(messageOf({ kind: 'needs_login', reason: 'no_token', message: 'n' }), 'n')
  assert.equal(
    messageOf({ kind: 'needs_child_selection', token: 't', children: [], message: 's' }),
    's'
  )
})

console.log('')
if (failed > 0) {
  console.log(`FAILED ${failed} 项`)
  process.exit(1)
}
console.log('ALL PASS')

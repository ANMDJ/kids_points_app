/**
 * W8-C 家长模式（小程序端）的**异步**运行时用例。
 *
 * 结构照抄 `run-w8b.mjs`：顶层 await → 顶层汇总 → 顶层退出码。
 *
 * 这一轮经过**真** `ParentModeApiClient`（注入假传输层）与真 `AppStore`：
 *   ① 线格式的四种「自相矛盾」必须 malformed，不许 `?? 0` 猜默认值；
 *   ② 四条路由的方法 / 路径 / 头 / 体逐字对齐（GET 不带 Content-Type，
 *      `DELETE` 不带体，首次设 PIN **不发** `currentPin`）；
 *   ③ `429` 必须变成 `ParentPinLockException` 并带上 `retryAfterSeconds`；
 *   ④ `PARENT_*` 业务码优先用服务端 `message`，缺失才用本地兜底；
 *   ⑤ 倒计时 / 锁定秒数一律从**绝对时刻**现算（本地不存整数）；
 *   ⑥ store：格式错不发请求、403 后重新对齐快照、失败不清空旧快照。
 *
 * 编译：npx tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w8c.mjs
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 纯 Node 无法 require 真实的 `@tarojs/taro`。 */
const taroPath = require.resolve('@tarojs/taro', { paths: [__dirname] })
require.cache[taroPath] = {
  id: taroPath,
  filename: taroPath,
  loaded: true,
  exports: {
    __esModule: true,
    default: {},
    request: async () => ({ statusCode: 200, data: null }),
    useDidShow: () => undefined,
    useReady: () => undefined
  },
  children: [],
  paths: []
}

const { AppStore } = require('./dist/data/store.js')
const { ReadApiConfig } = require('./dist/data/read_api.js')
const { ReadApiException } = require('./dist/data/read_api_errors.js')
const { WriteApiException } = require('./dist/data/write_api_errors.js')
const {
  ParentModeApiClient,
  ParentPinLockException,
  parseParentMode,
  parseParentPinResult,
  parentModeRemainingSeconds,
  isParentPinLockedAt,
  parentPinLockSecondsAt,
  validateParentPin,
  mmss,
  humanizeSeconds,
  PARENT_MODE_MAX_TTL_SECONDS,
  PARENT_PIN_MAX_ATTEMPTS
} = require('./dist/data/parent_mode.js')

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

const NOW = Date.parse('2026-10-27T09:00:00.000Z')

/**
 * `ReadApiException` 没有 `field` 属性 —— 字段路径只在 message / detail 里。
 * 这里统一按「message 里带反引号路径」判定，与其它 DTO 用例同口径。
 */
function assertField(error, path) {
  assert.ok(error instanceof ReadApiException, '应当是 ReadApiException')
  assert.equal(error.kind, 'malformed')
  assert.ok(
    error.message.includes('`' + path + '`'),
    `message 里应带字段路径 ${path}：${error.message}`
  )
}

const config = new ReadApiConfig(
  'http://127.0.0.1:3000/',
  'device-1',
  'child-1'
)

/** `GET/POST/DELETE /auth/parent-mode` + `POST /auth/parent-pin` 的线格式。 */
function modeJson(overrides = {}) {
  return {
    activeRole: 'child',
    parentMode: false,
    // 不在家长模式 ⇒ 来源必须是 null（服务端 `parentModeSourceOf()` 的口径）。
    modeSource: null,
    parentModeExpiresAt: null,
    remainingSeconds: 0,
    pinConfigured: true,
    remainingAttempts: PARENT_PIN_MAX_ATTEMPTS,
    lockedUntil: null,
    ...overrides
  }
}

function parentModeJson(overrides = {}) {
  return modeJson({
    activeRole: 'guardian',
    parentMode: true,
    // 5 分钟以内 ⇒ 来源是 PIN。
    modeSource: 'pin',
    parentModeExpiresAt: '2026-10-27T09:05:00.000Z',
    remainingSeconds: 300,
    ...overrides
  })
}

/** 邀请码加入的家长设备：30 天登录会话自带 guardian（`modeSource: 'session'`）。 */
function sessionModeJson(overrides = {}) {
  return parentModeJson({
    modeSource: 'session',
    parentModeExpiresAt: '2026-11-26T09:00:00.000Z',
    remainingSeconds: 30 * 24 * 60 * 60,
    ...overrides
  })
}

function pinJson(overrides = {}) {
  return {
    pinConfigured: true,
    changed: false,
    pinSetAt: '2026-10-27T08:59:00.000Z',
    remainingAttempts: PARENT_PIN_MAX_ATTEMPTS,
    ...overrides
  }
}

/**
 * 家长模式四端点的假传输层。按 URI 后缀 + 方法分派，用例可以单独替换
 * 「进入失败」与「随后那次对齐 GET」。
 */
function fakeTransport(plan = {}) {
  const state = {
    calls: [],
    bodies: [],
    headers: [],
    enter: { statusCode: 200, body: parentModeJson() },
    exit: { statusCode: 200, body: modeJson() },
    fetch: { statusCode: 200, body: modeJson() },
    pin: { statusCode: 200, body: pinJson() },
    ...plan
  }
  state.transport = {
    async send(uri, headers, body, _timeoutMs, method = 'POST') {
      state.calls.push(`${method} ${uri}`)
      state.bodies.push(body)
      state.headers.push(headers)
      if (uri.endsWith('/auth/parent-pin')) return state.pin
      if (uri.endsWith('/auth/parent-mode')) {
        if (method === 'GET') return state.fetch
        if (method === 'DELETE') return state.exit
        return state.enter
      }
      return { statusCode: 404, body: { code: 'NOT_FOUND' } }
    }
  }
  return state
}

// ------------------------------------------------------------ 解析：自相矛盾

await checkAsync('parse：家长模式回包解析为绝对时刻', async () => {
  const mode = parseParentMode(parentModeJson())
  assert.equal(mode.activeRole, 'guardian')
  assert.equal(mode.parentMode, true)
  assert.equal(mode.modeSource, 'pin')
  assert.equal(mode.expiresAt, NOW + 300_000)
  assert.equal(mode.remainingSeconds, 300)
  assert.equal(mode.lockedUntil, null)
})

await checkAsync('parse：parentMode 与 activeRole 不一致 ⇒ malformed', async () => {
  assert.throws(
    () =>
      parseParentMode(modeJson({ activeRole: 'guardian', parentMode: false })),
    (error) => {
      assert.ok(error instanceof ReadApiException)
      assert.equal(error.kind, 'malformed')
      assertField(error, '$.parentMode')
      return true
    }
  )
})

await checkAsync('parse：在家长模式却没有到期时刻 ⇒ malformed', async () => {
  assert.throws(
    () => parseParentMode(parentModeJson({ parentModeExpiresAt: null })),
    (error) => {
      assertField(error, '$.parentModeExpiresAt')
      return true
    }
  )
})

await checkAsync('parse：不在家长模式却给了到期时刻 ⇒ malformed', async () => {
  assert.throws(
    () =>
      parseParentMode(
        modeJson({ parentModeExpiresAt: '2026-10-27T09:05:00.000Z' })
      ),
    (error) => {
      assertField(error, '$.parentModeExpiresAt')
      return true
    }
  )
})

await checkAsync('parse：pin 来源的 remainingSeconds 越界 ⇒ malformed（1–300）', async () => {
  for (const bad of [0, -1, PARENT_MODE_MAX_TTL_SECONDS + 1]) {
    assert.throws(
      () => parseParentMode(parentModeJson({ remainingSeconds: bad })),
      (error) => {
        assertField(error, '$.remainingSeconds')
        return true
      }
    )
  }
})

await checkAsync('★ parse：session 来源（30 天登录会话）必须合法', async () => {
  // 邀请码加入的家长设备：会话 30 天 ⇒ 2 592 000 秒。
  // 早期版本按「0–300」硬卡，家长本机的第一屏直接变成「数据格式不符合预期」。
  const mode = parseParentMode(sessionModeJson())
  assert.equal(mode.modeSource, 'session')
  assert.equal(mode.parentMode, true)
  assert.equal(mode.remainingSeconds, 2_592_000)
})

await checkAsync('parse：session 的剩余秒数必须在 (300, 一年] 内', async () => {
  // 300 / 120 却自称 session ⇒ 来源标错；40 000 000（毫秒当秒）⇒ 单位错。
  for (const bad of [300, 120, 40_000_000]) {
    assert.throws(
      () =>
        parseParentMode(
          sessionModeJson({ remainingSeconds: bad })
        ),
      (error) => {
        assertField(error, '$.remainingSeconds')
        return true
      }
    )
  }
})

await checkAsync('parse：modeSource 与 parentMode 必须同真同假', async () => {
  // 不在家长模式却给了来源。
  assert.throws(
    () => parseParentMode(modeJson({ modeSource: 'session' })),
    (error) => {
      assertField(error, '$.modeSource')
      return true
    }
  )
  // 在家长模式却缺来源 —— 界面无从选择「倒计时」还是「已登录」。
  const missing = parentModeJson()
  delete missing.modeSource
  assert.throws(
    () => parseParentMode(missing),
    (error) => {
      assertField(error, '$.modeSource')
      return true
    }
  )
  // 未知来源（将来新增第三种）必须显式支持，不能当成 pin。
  assert.throws(
    () => parseParentMode(parentModeJson({ modeSource: 'inherit' })),
    (error) => {
      assertField(error, '$.modeSource')
      return true
    }
  )
})

await checkAsync('parse：锁定态与剩余次数必须互相解释', async () => {
  assert.throws(
    () =>
      parseParentMode(
        modeJson({
          lockedUntil: '2026-10-27T09:15:00.000Z',
          remainingAttempts: 3
        })
      ),
    (error) => {
      assertField(error, '$.remainingAttempts')
      return true
    }
  )
  assert.throws(
    () => parseParentMode(modeJson({ remainingAttempts: 0 })),
    (error) => {
      assertField(error, '$.remainingAttempts')
      return true
    }
  )
  const locked = parseParentMode(
    modeJson({
      lockedUntil: '2026-10-27T09:15:00.000Z',
      remainingAttempts: 0
    })
  )
  assert.equal(locked.lockedUntil, NOW + 900_000)
})

await checkAsync('parse：缺字段 / 类型不对 ⇒ malformed，不猜默认值', async () => {
  assert.throws(() => parseParentMode({}), /activeRole/)
  assert.throws(
    () => parseParentMode(modeJson({ remainingAttempts: '3' })),
    /remainingAttempts/
  )
})

// ---------------------------------------------------------- 解析：设 PIN 回包

await checkAsync('parse：设置 PIN 回包区分「改」与「设」', async () => {
  const first = parseParentPinResult(pinJson({ changed: false }))
  assert.equal(first.changed, false)
  assert.equal(first.pinConfigured, true)
  assert.equal(first.pinSetAt, NOW - 60_000)

  const changed = parseParentPinResult(pinJson({ changed: true }))
  assert.equal(changed.changed, true)
})

await checkAsync('parse：设 PIN 成功后 pinConfigured=false ⇒ malformed', async () => {
  assert.throws(
    () => parseParentPinResult(pinJson({ pinConfigured: false })),
    (error) => {
      assertField(error, '$.pinConfigured')
      return true
    }
  )
})
// -------------------------------------------------------------- 纯函数口径

await checkAsync('倒计时：向上取整，过期即 0', async () => {
  const mode = parseParentMode(parentModeJson())
  assert.equal(parentModeRemainingSeconds(mode, NOW), 300)
  assert.equal(parentModeRemainingSeconds(mode, NOW + 299_500), 1)
  assert.equal(parentModeRemainingSeconds(mode, NOW + 300_000), 0)
  assert.equal(parentModeRemainingSeconds(mode, NOW + 400_000), 0)
  assert.equal(parentModeRemainingSeconds(null, NOW), 0)
})

await checkAsync('锁定：只看绝对时刻，不看本地整数', async () => {
  const locked = parseParentMode(
    modeJson({
      lockedUntil: '2026-10-27T09:15:00.000Z',
      remainingAttempts: 0
    })
  )
  assert.equal(isParentPinLockedAt(locked, NOW), true)
  assert.equal(isParentPinLockedAt(locked, NOW + 900_000), false)
  assert.equal(parentPinLockSecondsAt(locked, NOW), 900)
  assert.equal(parentPinLockSecondsAt(locked, NOW + 899_500), 1)
  assert.equal(parentPinLockSecondsAt(locked, NOW + 900_000), 0)
  assert.equal(isParentPinLockedAt(null, NOW), false)
})

await checkAsync('文案：mmss / humanizeSeconds', async () => {
  assert.equal(mmss(300), '5:00')
  assert.equal(mmss(297), '4:57')
  assert.equal(mmss(59), '0:59')
  assert.equal(mmss(0), '0:00')
  assert.equal(mmss(-5), '0:00')

  assert.equal(humanizeSeconds(900), '15 分钟')
  assert.equal(humanizeSeconds(899), '14 分 59 秒')
  assert.equal(humanizeSeconds(59), '59 秒')
  assert.equal(humanizeSeconds(60), '1 分钟')
})

await checkAsync('预检：4–6 位数字；空串交给调用方', async () => {
  assert.equal(validateParentPin('1234'), null)
  assert.equal(validateParentPin('123456'), null)
  assert.equal(validateParentPin('  1234  '), null)
  assert.equal(validateParentPin(''), null)
  assert.ok(validateParentPin('123'))
  assert.ok(validateParentPin('1234567'))
  assert.ok(validateParentPin('12a4'))
})
// ------------------------------------------------------------ 客户端：路由

await checkAsync('路由：GET 不带 Content-Type / 不带体', async () => {
  const fake = fakeTransport()
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await client.fetch()
  assert.deepEqual(fake.calls, ['GET http://127.0.0.1:3000/auth/parent-mode'])
  assert.equal(fake.bodies[0], null)
  assert.equal(fake.headers[0]['Content-Type'], undefined)
  assert.equal(fake.headers[0]['x-kp-device-id'], 'device-1')
  assert.equal(fake.headers[0]['x-kp-child-id'], 'child-1')
})

await checkAsync('路由：POST 带 {pin}，DELETE 不带体', async () => {
  const fake = fakeTransport()
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await client.enter('  1234 ')
  assert.deepEqual(fake.calls, ['POST http://127.0.0.1:3000/auth/parent-mode'])
  assert.deepEqual(fake.bodies[0], { pin: '1234' })
  assert.equal(fake.headers[0]['Content-Type'], 'application/json; charset=utf-8')

  const second = fakeTransport()
  const secondClient = new ParentModeApiClient({
    config,
    transport: second.transport
  })
  await secondClient.exit()
  assert.deepEqual(second.calls, ['DELETE http://127.0.0.1:3000/auth/parent-mode'])
  assert.equal(second.bodies[0], null)
})

await checkAsync('路由：首次设 PIN 不发 currentPin，改 PIN 才发', async () => {
  const fake = fakeTransport()
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await client.setPin({ pin: '1234' })
  assert.deepEqual(fake.bodies[0], { pin: '1234' })

  await client.setPin({ pin: '5678', currentPin: '1234' })
  assert.deepEqual(fake.bodies[1], { pin: '5678', currentPin: '1234' })
})

await checkAsync('路由：本地格式错 ⇒ 不发请求', async () => {
  const fake = fakeTransport()
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await assert.rejects(() => client.enter('12'), /4–6 位数字/)
  await assert.rejects(
    () => client.setPin({ pin: '1234', currentPin: '   ' }),
    /currentPin/
  )
  assert.deepEqual(fake.calls, [])
})
// ------------------------------------------------------ 客户端：失败语义

await checkAsync('429 ⇒ ParentPinLockException（带剩余秒数）', async () => {
  const fake = fakeTransport({
    enter: {
      statusCode: 429,
      body: { code: 'PARENT_PIN_LOCKED', retryAfterSeconds: 899 }
    }
  })
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await assert.rejects(
    () => client.enter('1234'),
    (error) => {
      assert.ok(error instanceof ParentPinLockException)
      assert.ok(error instanceof WriteApiException)
      assert.equal(error.kind, 'conflict')
      assert.equal(error.statusCode, 429)
      assert.equal(error.retryAfterSeconds, 899)
      assert.match(error.userMessage, /14 分 59 秒/)
      return true
    }
  )
})

await checkAsync('429 无 retryAfterSeconds ⇒ 兜底文案（不冒充网络故障）', async () => {
  const fake = fakeTransport({
    enter: { statusCode: 429, body: { code: 'PARENT_PIN_LOCKED' } }
  })
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await assert.rejects(
    () => client.enter('1234'),
    (error) => {
      assert.equal(error.retryAfterSeconds, 0)
      assert.match(error.userMessage, /不是网络问题/)
      return true
    }
  )
})

await checkAsync('PARENT_* 优先用服务端 message', async () => {
  const fake = fakeTransport({
    enter: {
      statusCode: 403,
      body: {
        code: 'PARENT_PIN_INVALID',
        message: '家长 PIN 不对，还剩 4 次机会。'
      }
    }
  })
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await assert.rejects(
    () => client.enter('1234'),
    (error) => {
      assert.equal(error.kind, 'forbidden')
      assert.equal(error.code, 'PARENT_PIN_INVALID')
      assert.equal(error.userMessage, '家长 PIN 不对，还剩 4 次机会。')
      assert.equal(error.detail, '家长 PIN 不对，还剩 4 次机会。')
      return true
    }
  )
})

await checkAsync('PARENT_* 无 message ⇒ 本地兜底文案', async () => {
  const fake = fakeTransport({
    exit: { statusCode: 409, body: { code: 'PARENT_PIN_NOT_SET' } }
  })
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await assert.rejects(
    () => client.exit(),
    (error) => {
      assert.equal(error.kind, 'conflict')
      assert.match(error.userMessage, /还没有家长 PIN/)
      return true
    }
  )
})

await checkAsync('非 PARENT_* 错误仍走通用分类', async () => {
  const fake = fakeTransport({
    fetch: { statusCode: 500, body: { code: 'INTERNAL_ERROR' } }
  })
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await assert.rejects(
    () => client.fetch(),
    (error) => {
      assert.ok(error instanceof WriteApiException)
      assert.equal(error.kind, 'server')
      return true
    }
  )
})

await checkAsync('2xx 但形状不对 ⇒ malformed', async () => {
  const fake = fakeTransport({
    fetch: { statusCode: 200, body: modeJson({ activeRole: 'guardian' }) }
  })
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await assert.rejects(
    () => client.fetch(),
    (error) => {
      assert.ok(error instanceof ReadApiException)
      assert.equal(error.kind, 'malformed')
      return true
    }
  )
})
// ------------------------------------------------------------------- store

function makeStore(fake) {
  return new AppStore(
    null,
    null,
    null,
    new ParentModeApiClient({ config, transport: fake.transport })
  )
}

await checkAsync('store：初始「还不知道」不等于「不在家长模式」', async () => {
  const store = makeStore(fakeTransport())
  assert.equal(store.hasParentMode, true)
  assert.equal(store.parentMode, null)
  assert.equal(store.isParentMode, false)
  assert.equal(store.isParentPinConfigured, false)
  assert.equal(store.parentModeReadStatus, 'idle')
})

await checkAsync('store：refresh 应用快照，倒计时现算', async () => {
  const fake = fakeTransport({
    fetch: { statusCode: 200, body: parentModeJson({ remainingSeconds: 297 }) }
  })
  const store = makeStore(fake)
  await store.refreshParentMode()
  assert.equal(store.parentModeReadStatus, 'ready')
  assert.equal(store.isParentMode, true)
  assert.equal(store.parentMode.expiresAt, NOW + 300_000)
  assert.equal(store.parentModeRemainingSeconds(NOW), 300)
  assert.equal(store.parentModeRemainingSeconds(NOW + 180_000), 120)
  assert.equal(store.parentModeRemainingSeconds(NOW + 300_000), 0)
})

await checkAsync('★ store：session 来源（邀请码家长设备）不许出倒计时', async () => {
  // 30 天会话 ⇒ 2 592 000 秒。界面靠 `isParentModeSessionBacked` 决定文案，
  // 否则 `mmss(2592000)` 会渲染成 `43200:00`。
  const fake = fakeTransport({
    fetch: { statusCode: 200, body: sessionModeJson({ pinConfigured: false }) }
  })
  const store = makeStore(fake)
  await store.refreshParentMode()
  assert.equal(store.parentModeReadStatus, 'ready')
  assert.equal(store.isParentMode, true)
  assert.equal(store.isParentModeSessionBacked, true)
  assert.equal(store.isParentModePinBacked, false)
  // 「还没设 PIN」与「在家长模式」是两件独立的事，可以同时成立。
  assert.equal(store.isParentPinConfigured, false)
  assert.ok(store.parentModeRemainingSeconds(NOW) > 300)
})

await checkAsync('store：enter 走 POST，成功后更新快照', async () => {
  const fake = fakeTransport()
  const store = makeStore(fake)
  const error = await store.enterParentMode(' 1234 ')
  assert.equal(error, null)
  assert.deepEqual(fake.calls, ['POST http://127.0.0.1:3000/auth/parent-mode'])
  assert.deepEqual(fake.bodies[0], { pin: '1234' })
  assert.equal(store.isParentMode, true)
  assert.equal(store.isParentModeBusy, false)
})

await checkAsync('store：格式错本地就拒（不发请求、不算计次）', async () => {
  const fake = fakeTransport()
  const store = makeStore(fake)
  assert.equal(await store.enterParentMode('  '), '请输入家长 PIN。')
  assert.match(await store.enterParentMode('12'), /4–6 位数字/)
  assert.deepEqual(fake.calls, [])
})

await checkAsync('store：403 后重新对齐快照（次数已递减）', async () => {
  const fake = fakeTransport({
    enter: {
      statusCode: 403,
      body: { code: 'PARENT_PIN_INVALID', message: '还剩 4 次机会。' }
    },
    fetch: { statusCode: 200, body: modeJson({ remainingAttempts: 4 }) }
  })
  const store = makeStore(fake)
  const error = await store.enterParentMode('9999')
  assert.equal(error, '还剩 4 次机会。')
  assert.deepEqual(fake.calls, [
    'POST http://127.0.0.1:3000/auth/parent-mode',
    'GET http://127.0.0.1:3000/auth/parent-mode'
  ])
  assert.equal(store.parentPinRemainingAttempts, 4)
  assert.equal(store.isParentPinBusy, false)
})

await checkAsync('store：429 记录锁定秒数并对齐 lockedUntil', async () => {
  const fake = fakeTransport({
    enter: {
      statusCode: 429,
      body: { code: 'PARENT_PIN_LOCKED', retryAfterSeconds: 900 }
    },
    fetch: {
      statusCode: 200,
      body: modeJson({
        lockedUntil: '2026-10-27T09:15:00.000Z',
        remainingAttempts: 0
      })
    }
  })
  const store = makeStore(fake)
  const error = await store.enterParentMode('1234')
  assert.match(error, /15 分钟/)
  assert.equal(store.parentPinLockSecondsAt(NOW), 900)
  assert.equal(store.isParentPinLockedAt(NOW), true)
  assert.equal(store.isParentPinLockedAt(NOW + 900_000), false)
})

await checkAsync('store：读取失败不清空上一次快照', async () => {
  const fake = fakeTransport({
    fetch: { statusCode: 200, body: parentModeJson() }
  })
  const store = makeStore(fake)
  await store.refreshParentMode()
  assert.equal(store.isParentMode, true)

  fake.fetch = { statusCode: 500, body: { code: 'INTERNAL_ERROR' } }
  await store.refreshParentMode()
  assert.equal(store.parentModeReadStatus, 'error')
  assert.ok(store.parentModeError)
  assert.equal(store.isParentMode, true, '旧快照必须留着')
})
await checkAsync('store：exit 不需要 PIN，失败时保留家长模式', async () => {
  const fake = fakeTransport({
    fetch: { statusCode: 200, body: parentModeJson() },
    exit: { statusCode: 500, body: { code: 'INTERNAL_ERROR' } }
  })
  const store = makeStore(fake)
  await store.refreshParentMode()
  const failedExit = await store.exitParentMode()
  assert.ok(failedExit)
  assert.equal(store.isParentMode, true, '退出没成功就不能说退出了')

  fake.exit = { statusCode: 200, body: modeJson() }
  assert.equal(await store.exitParentMode(), null)
  assert.equal(store.isParentMode, false)
  assert.equal(fake.bodies[1], null)
})

await checkAsync('store：setPin 成功后只改 PIN 相关字段', async () => {
  const fake = fakeTransport({
    fetch: { statusCode: 200, body: parentModeJson() },
    pin: { statusCode: 200, body: pinJson({ changed: true }) }
  })
  const store = makeStore(fake)
  await store.refreshParentMode()
  const before = store.parentMode

  assert.equal(
    await store.setParentPin({ pin: '5678', currentPin: '1234' }),
    null
  )
  assert.deepEqual(fake.bodies[1], { pin: '5678', currentPin: '1234' })
  assert.equal(store.isParentMode, true)
  assert.equal(store.parentMode.expiresAt, before.expiresAt)
  assert.equal(store.parentMode.activeRole, before.activeRole)
  assert.equal(store.lastParentPinResult.changed, true)
  assert.equal(store.isParentPinConfigured, true)
})

await checkAsync('store：setPin 空当前 PIN 本地就拒', async () => {
  const fake = fakeTransport()
  const store = makeStore(fake)
  assert.equal(
    await store.setParentPin({ pin: '5678', currentPin: '   ' }),
    '请输入当前家长 PIN。'
  )
  assert.deepEqual(fake.calls, [])
})

// ---------------------------------------------------------------- 无后端

await checkAsync('无后端：hasParentMode=false，所有动作只回文案', async () => {
  const store = new AppStore(null, null, null, null)
  assert.equal(store.hasParentMode, false)
  assert.equal(store.isParentMode, false)
  assert.match(await store.enterParentMode('1234'), /没有接入后端/)
  assert.match(await store.exitParentMode(), /没有接入后端/)
  assert.match(await store.setParentPin({ pin: '1234' }), /没有接入后端/)
  await store.refreshParentMode()
  assert.equal(store.parentModeReadStatus, 'ready')
})

console.log('')
if (failed > 0) {
  console.log(`FAILED ${failed} 项`)
  process.exit(1)
}
console.log('ALL PASS')

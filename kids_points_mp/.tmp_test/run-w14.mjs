/**
 * W14 孩子模式（小程序端）的**异步**运行时用例（2026-11-03）。
 *
 * 结构照抄 `run-w8c.mjs`（Taro stub → require 编译产物 → 汇总 → 退出码）。
 * 这一轮钉的是 `docs/design/51-kid-mode-window.md` 里的四件事：
 *   ① 线格式三态：进行中 / 已到期（**不**自动回家长模式）/ 没开，矛盾形状一律 malformed；
 *   ② 两条新路由的方法 / 路径 / 体逐字对齐（`POST` 只发 durationMinutes；
 *      `DELETE` 必须带 pin —— 收回是提权方向）；
 *   ③ 30 分钟上限在客户端也挡一次（注定 400 的请求不发）；
 *   ④ store：倒计时从绝对时刻现算、已开着不静默续期、收回后回到家长模式。
 *
 * 编译：./node_modules/.bin/tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w14.mjs
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
const {
  ParentModeApiClient,
  KID_MODE_MIN_MINUTES,
  KID_MODE_MAX_MINUTES,
  KID_MODE_DEFAULT_MINUTES,
  isKidModeActiveAt,
  isKidModeExpiredAt,
  kidModeRemainingSeconds,
  parseParentMode,
  validateKidModeMinutes
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

const config = new ReadApiConfig('http://127.0.0.1:3000/', 'device-1', 'child-1')

function modeJson(overrides = {}) {
  return {
    activeRole: 'child',
    parentMode: false,
    modeSource: null,
    parentModeExpiresAt: null,
    remainingSeconds: 0,
    pinConfigured: true,
    remainingAttempts: 5,
    lockedUntil: null,
    kidMode: false,
    kidModeExpired: false,
    kidModeUntil: null,
    kidModeRemainingSeconds: 0,
    ...overrides
  }
}

function kidModeJson(overrides = {}) {
  return modeJson({
    kidMode: true,
    kidModeUntil: '2026-11-03T10:15:00.000Z',
    kidModeRemainingSeconds: 900,
    ...overrides
  })
}

function expiredKidModeJson(overrides = {}) {
  return modeJson({
    kidModeExpired: true,
    kidModeUntil: '2026-11-03T10:15:00.000Z',
    kidModeRemainingSeconds: 0,
    ...overrides
  })
}

function parentJson(overrides = {}) {
  return modeJson({
    activeRole: 'guardian',
    parentMode: true,
    modeSource: 'session',
    parentModeExpiresAt: '2026-12-03T10:00:00.000Z',
    remainingSeconds: 30 * 24 * 60 * 60,
    ...overrides
  })
}

/** 按路径 + 方法分派；用例可单独替换 `enterKid` / `exitKid` / `fetch`。 */
function fakeTransport(plan = {}) {
  const state = {
    calls: [],
    bodies: [],
    fetch: { statusCode: 200, body: modeJson() },
    enterKid: { statusCode: 200, body: kidModeJson() },
    exitKid: { statusCode: 200, body: parentJson() },
    ...plan
  }
  state.transport = {
    async send(uri, _headers, body, _timeoutMs, method = 'POST') {
      state.calls.push(`${method} ${uri}`)
      state.bodies.push(body)
      if (uri.endsWith('/auth/kid-mode')) {
        if (method === 'DELETE') return state.exitKid
        return state.enterKid
      }
      if (uri.endsWith('/auth/parent-mode') && method === 'GET') return state.fetch
      return { statusCode: 404, body: { code: 'NOT_FOUND' } }
    }
  }
  return state
}

function makeStore(fake) {
  return new AppStore(
    null,
    null,
    null,
    new ParentModeApiClient({ config, transport: fake.transport })
  )
}

const NOW = Date.parse('2026-11-03T10:00:00.000Z')

// ---------------------------------------------------------------- 常量 / 校验

await checkAsync('常量：1–30 分钟，默认 15（不是"默认即上限"）', async () => {
  assert.equal(KID_MODE_MIN_MINUTES, 1)
  assert.equal(KID_MODE_MAX_MINUTES, 30)
  assert.equal(KID_MODE_DEFAULT_MINUTES, 15)
})

await checkAsync('validateKidModeMinutes：45 / 0 / 小数 ⇒ 拒；1..30 整数 ⇒ 过', async () => {
  for (const bad of [45, 0, -1, 1.5, Number.NaN]) {
    assert.ok(validateKidModeMinutes(bad) !== null, `bad=${String(bad)}`)
  }
  for (const good of [1, 15, 30]) {
    assert.equal(validateKidModeMinutes(good), null, `good=${good}`)
  }
})

// ---------------------------------------------------------------- 线格式

await checkAsync('parse：孩子模式进行中 ⇒ 绝对时刻 + 900 秒', async () => {
  const mode = parseParentMode(kidModeJson())
  assert.equal(mode.kidMode, true)
  assert.equal(mode.kidModeExpired, false)
  assert.equal(mode.kidModeUntil, NOW + 900_000)
  assert.equal(mode.kidModeRemainingSeconds, 900)
  assert.equal(mode.parentMode, false)
})

await checkAsync('parse：已到期 ⇒ kidModeExpired（A 方案，不回家长模式）', async () => {
  const mode = parseParentMode(expiredKidModeJson())
  assert.equal(mode.kidMode, false)
  assert.equal(mode.kidModeExpired, true)
  assert.equal(mode.parentMode, false)
})

await checkAsync('parse：同时 true / 与家长模式同真 / 缺时刻 / 秒数越界 ⇒ malformed', async () => {
  const cases = [
    kidModeJson({ kidModeExpired: true }),
    parentJson({ kidMode: true, kidModeUntil: '2026-11-03T10:15:00.000Z' }),
    modeJson({ kidMode: true, kidModeRemainingSeconds: 600 }),
    kidModeJson({ kidModeRemainingSeconds: 0 }),
    kidModeJson({ kidModeRemainingSeconds: 1801 }),
    expiredKidModeJson({ kidModeRemainingSeconds: 5 }),
    modeJson({ kidModeUntil: '2026-11-03T10:15:00.000Z' }),
    modeJson({ kidModeRemainingSeconds: 10 })
  ]
  for (const [index, json] of cases.entries()) {
    assert.throws(
      () => parseParentMode(json),
      (error) => {
        assert.ok(error instanceof ReadApiException, `case ${index} 不是 ReadApiException`)
        assert.equal(error.kind, 'malformed', `case ${index} kind=${error.kind}`)
        return true
      }
    )
  }
})


// ---------------------------------------------------------------- 现算

await checkAsync('剩余秒数：从绝对时刻向上取整；到期 / 未开都是 0', async () => {
  const mode = parseParentMode(kidModeJson())
  assert.equal(kidModeRemainingSeconds(mode, NOW), 900)
  assert.equal(kidModeRemainingSeconds(mode, NOW + 899_500), 1)
  assert.equal(kidModeRemainingSeconds(mode, NOW + 900_000), 0)
  assert.equal(kidModeRemainingSeconds(parseParentMode(modeJson()), NOW), 0)
})

await checkAsync('三态判据：窗口内 active；越过到期时刻立刻算 expired', async () => {
  const mode = parseParentMode(kidModeJson())
  assert.equal(isKidModeActiveAt(mode, NOW), true)
  assert.equal(isKidModeExpiredAt(mode, NOW), false)
  assert.equal(isKidModeActiveAt(mode, NOW + 900_000), false)
  assert.equal(isKidModeExpiredAt(mode, NOW + 900_000), true)

  const expired = parseParentMode(expiredKidModeJson())
  assert.equal(isKidModeActiveAt(expired, NOW), false)
  assert.equal(isKidModeExpiredAt(expired, NOW), true)
  assert.equal(isKidModeExpiredAt(null, NOW), false)
})

// ---------------------------------------------------------------- 客户端

await checkAsync('client：enterKidMode ⇒ POST /auth/kid-mode + {durationMinutes}', async () => {
  const fake = fakeTransport()
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  const mode = await client.enterKidMode(20)
  assert.equal(mode.kidMode, true)
  assert.equal(fake.calls.length, 1)
  assert.match(fake.calls[0], /^POST /)
  assert.ok(fake.calls[0].endsWith('/auth/kid-mode'))
  assert.deepEqual(fake.bodies[0], { durationMinutes: 20 })
})

await checkAsync('client：exitKidMode ⇒ DELETE /auth/kid-mode + {pin}（收回要凭据）', async () => {
  const fake = fakeTransport()
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  const mode = await client.exitKidMode(' 1234 ')
  assert.equal(mode.parentMode, true)
  assert.match(fake.calls[0], /^DELETE /)
  assert.deepEqual(fake.bodies[0], { pin: '1234' })
})

await checkAsync('client：45 分钟本地就拒，一个请求都不发', async () => {
  const fake = fakeTransport()
  const client = new ParentModeApiClient({ config, transport: fake.transport })
  await assert.rejects(() => client.enterKidMode(45), /30/)
  assert.equal(fake.calls.length, 0)
})

// ---------------------------------------------------------------- store

await checkAsync('store：refresh 应用孩子模式快照；倒计时现算', async () => {
  const fake = fakeTransport({ fetch: { statusCode: 200, body: kidModeJson() } })
  const store = makeStore(fake)
  await store.refreshParentMode()
  assert.equal(store.isKidMode, true)
  assert.equal(store.isKidModeExpired, false)
  const until = store.parentMode.kidModeUntil
  assert.equal(store.kidModeRemainingSeconds(until - 30_000), 30)
})

await checkAsync('store：已到期快照 ⇒ isKidModeExpiredAt；家长模式仍为 false', async () => {
  const fake = fakeTransport({ fetch: { statusCode: 200, body: expiredKidModeJson() } })
  const store = makeStore(fake)
  await store.refreshParentMode()
  assert.equal(store.isKidMode, false)
  assert.equal(store.isKidModeExpiredAt(Date.now()), true)
  assert.equal(store.isParentMode, false)
})

await checkAsync('store：enterKidMode 提交分钟数；已开着 ⇒ 本地拒（不静默续期）', async () => {
  const fake = fakeTransport({ fetch: { statusCode: 200, body: parentJson() } })
  const store = makeStore(fake)
  await store.refreshParentMode()
  assert.equal(await store.enterKidMode(20), null)
  assert.equal(store.isKidMode, true)
  assert.equal(fake.calls.filter((call) => call.includes('/auth/kid-mode')).length, 1)

  const blocked = await store.enterKidMode(30)
  assert.ok(blocked !== null && blocked.includes('请先输入家长 PIN'))
  assert.equal(fake.calls.filter((call) => call.includes('/auth/kid-mode')).length, 1)
})

await checkAsync('store：exitKidMode 空 PIN 本地拒；正确 PIN 调 API 并回到家长模式', async () => {
  const fake = fakeTransport({ fetch: { statusCode: 200, body: kidModeJson() } })
  const store = makeStore(fake)
  await store.refreshParentMode()

  assert.equal(await store.exitKidMode('   '), '请输入家长 PIN。')
  assert.equal(fake.calls.filter((call) => call.includes('/auth/kid-mode')).length, 0)

  assert.equal(await store.exitKidMode(' 1234 '), null)
  assert.deepEqual(fake.bodies[fake.bodies.length - 1], { pin: '1234' })
  assert.equal(store.isKidMode, false)
  assert.equal(store.isParentMode, true)
})

console.log('')
if (failed > 0) {
  console.error(`FAIL  孩子模式用例未通过：${failed} 条`)
  process.exit(1)
}
console.log('PASS  孩子模式用例全部通过')


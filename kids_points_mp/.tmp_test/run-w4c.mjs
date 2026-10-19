/**
 * W4-C 只读接入的**异步**运行时用例（`run.js` 的同步部分跑完后由它拉起）。
 *
 * ── 为什么单独一个 `.mjs` ─────────────────────────────────────────────────
 *   这些用例要 `await` store / client 的 Promise；而 `run.js` 是 CommonJS，
 *   没有顶层 `await`。若把汇总/退出码放进 `main()` 里，`honesty-probe` 的 D12
 *   守卫会（正确地）把它当成“汇总被嵌套在回调里”的旧缺陷形态。
 *   拆到 ESM 后：顶层 `await Promise.all(...)` → 顶层汇总 → 顶层退出码，
 *   既真的等完所有用例，也保持 D12 守卫可以静态验证。
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * ⚠️ 纯 Node 无法 require 真实的 `@tarojs/taro`（见 `run.js` 头注释）。
 *    子进程有**自己的** `require.cache`，所以这段壳必须在这里再注入一次；
 *    顺序必须是「先塞缓存，再 require store」。
 */
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
const {
  ReadApiClient,
  ReadApiConfig,
  createReadApiFromEnvironment,
  kDeviceIdHeader,
  kChildIdHeader
} = require('./dist/data/read_api.js')
const { ReadApiException } = require('./dist/data/read_api_errors.js')
const { HomeDto, RecordsPageDto } = require('./dist/data/read_dto.js')
const { mapRecordsPage } = require('./dist/data/read_mapper.js')

let failed = 0
const pendingChecks = []

function report(name, error) {
  if (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + error.message)
  } else {
    console.log('PASS  ' + name)
  }
}

function check(name, fn) {
  let result
  try {
    result = fn()
  } catch (error) {
    report(name, error)
    return
  }
  if (result && typeof result.then === 'function') {
    pendingChecks.push(
      result.then(
        () => report(name),
        (error) => report(name, error)
      )
    )
    return
  }
  report(name)
}

async function checkAsync(name, fn) {
  try {
    await fn()
    console.log('PASS  ' + name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + error.message)
  }
}

// ── 阶段 W4-C：只读端点接入（配置降级 / 游标翻页 / 刷新竞态）──────────────
function w4Home(overrides = {}) {
  return Object.assign(
    {
      child: { id: 'child-1', name: '小明', pointsBalance: 15 },
      goodHabitCount: 2,
      rewardCount: 1,
      habits: [
        {
          id: 'habit-1',
          title: '认真刷牙',
          points: 1,
          icon: 'spray',
          color: '#7fbf55',
          condition: '早晚各一次',
          dailyLimit: 2,
          ruleId: null
        }
      ],
      rules: [
        {
          id: 'rule-1',
          title: '完成作业',
          points: 2,
          direction: 'reward',
          icon: 'book',
          color: '#f6c64a',
          condition: '独立完成',
          dailyLimit: 1,
          currentVersion: 3
        }
      ],
      wishes: [
        {
          id: 'wish-1',
          title: '小饼干',
          cost: 20,
          emoji: '🍪',
          coverStyle: 'A',
          redeemed: false
        }
      ]
    },
    overrides
  )
}

/** 已解析成 UI 前形态的一页流水（createdAt 是 epoch 毫秒）。 */
function w4Page(records, overrides = {}) {
  return Object.assign(
    { records, limit: 50, hasMore: false, nextCursor: null },
    overrides
  )
}

/** 后端线格式（createdAt 是 ISO 字符串）。 */
function w4WireRecord(index, overrides = {}) {
  return Object.assign(
    {
      id: `record-${index}`,
      title: `记录 ${index}`,
      points: 1,
      category: 'praise',
      source: 'guardian',
      operatorRole: 'guardian',
      note: '',
      habitId: 'habit-1',
      ruleId: null,
      ruleVersion: null,
      wishId: null,
      reversesRecordId: null,
      reversedAt: null,
      balanceAfter: 15,
      createdAt: new Date(Date.UTC(2026, 0, 1, 8, 0, index)).toISOString()
    },
    overrides
  )
}

function w4Record(index, overrides = {}) {
  const wire = w4WireRecord(index, overrides)
  return Object.assign(wire, { createdAt: Date.parse(wire.createdAt) })
}

function w4FakeApi(input = {}) {
  const calls = { home: 0, records: [] }
  return {
    calls,
    fetchHome: async () => {
      calls.home += 1
      return HomeDto.fromJson(input.home ? input.home(calls.home) : w4Home())
    },
    fetchRecords: async (query) => {
      calls.records.push(query)
      return input.records
        ? input.records(query, calls.records.length)
        : w4Page([])
    }
  }
}

check('W4 配置缺失：不发请求、退回预览；三项齐全才 live', () => {
  const empty = ReadApiConfig.fromEnvironment({})
  assert.strictEqual(empty.isConfigured, false)
  assert.ok(empty.validationError.includes('TARO_APP_KP_API_BASE_URL'))
  assert.strictEqual(createReadApiFromEnvironment({}), null, '缺配置不得构造客户端')

  const onlyBase = ReadApiConfig.fromEnvironment({
    TARO_APP_KP_API_BASE_URL: 'http://127.0.0.1:3000'
  })
  assert.strictEqual(onlyBase.isConfigured, false)
  assert.ok(onlyBase.validationError.includes('TARO_APP_KP_DEVICE_ID'))

  const badBase = ReadApiConfig.fromEnvironment({
    TARO_APP_KP_API_BASE_URL: '127.0.0.1:3000',
    TARO_APP_KP_DEVICE_ID: 'device',
    TARO_APP_KP_CHILD_ID: 'child'
  })
  assert.strictEqual(badBase.isConfigured, false, '非 http(s) 地址必须被拦下')

  const full = ReadApiConfig.fromEnvironment({
    TARO_APP_KP_API_BASE_URL: 'http://127.0.0.1:3000/',
    TARO_APP_KP_DEVICE_ID: 'device-1',
    TARO_APP_KP_CHILD_ID: 'child-1'
  })
  assert.strictEqual(full.isConfigured, true)
  assert.strictEqual(
    full.uri('/records', { limit: '50', category: 'praise', cursor: 'a/b+c=' }),
    'http://127.0.0.1:3000/records?limit=50&category=praise&cursor=a%2Fb%2Bc%3D'
  )
  assert.strictEqual(
    full.uri('/home'),
    'http://127.0.0.1:3000/home',
    '路径与 baseUrl 之间不得出现双斜杠或丢斜杠'
  )
})

check('W4 错误翻译：501 不伪装成「没有记录」，可重试语义准确', () => {
  const notReady = ReadApiException.fromHttp({
    statusCode: 501,
    body: { code: 'DB_NOT_READY', message: 'database not configured' }
  })
  assert.strictEqual(notReady.kind, 'notImplemented')
  assert.strictEqual(notReady.statusCode, 501)
  assert.strictEqual(notReady.code, 'DB_NOT_READY')
  assert.ok(notReady.userMessage.includes('不是「没有记录」'))
  assert.strictEqual(notReady.isRetryable, true)

  const unauth = ReadApiException.fromHttp({ statusCode: 401, body: null })
  assert.strictEqual(unauth.kind, 'unauthenticated')
  assert.strictEqual(unauth.isRetryable, false, '401 重试没意义，应先重新配对')

  const timeout = ReadApiException.timeout(10000)
  assert.strictEqual(timeout.kind, 'timeout')
  assert.ok(timeout.userMessage.includes('10 秒'))
  assert.strictEqual(timeout.isRetryable, true)

  const malformed = ReadApiException.malformed('records[0].points')
  assert.strictEqual(malformed.kind, 'malformed')
  assert.ok(malformed.userMessage.includes('records[0].points'))
})

check('W4 严格 DTO：hasMore / nextCursor 必须自洽，枚举漂移显式失败', () => {
  assert.throws(
    () =>
      RecordsPageDto.fromJson({
        records: [],
        limit: 50,
        hasMore: true,
        nextCursor: null
      }),
    (error) =>
      error instanceof ReadApiException && error.kind === 'malformed',
    'hasMore=true 却没有游标，会让「加载更多」死循环'
  )
  assert.throws(
    () =>
      RecordsPageDto.fromJson({
        records: [],
        limit: 50,
        hasMore: false,
        nextCursor: 'cursor-1'
      }),
    (error) =>
      error instanceof ReadApiException && error.kind === 'malformed',
    'hasMore=false 却给游标属于契约漂移'
  )
  assert.throws(
    () => mapRecordsPage(w4Page([w4Record(1, { category: 'bonus' })])),
    (error) =>
      error instanceof ReadApiException &&
      error.kind === 'malformed' &&
      error.userMessage.includes('category'),
    '未知 category 不许静默塞进 UI 模型'
  )
  assert.throws(
    () =>
      RecordsPageDto.fromJson({
        records: [],
        limit: 1.5,
        hasMore: false,
        nextCursor: null
      }),
    (error) =>
      error instanceof ReadApiException && error.kind === 'malformed',
    'limit 必须是整数'
  )
})


check('W4 store：首屏快照 + 游标翻页 + 按 id 去重', async () => {
  const api = w4FakeApi({
    records: (_query, call) =>
      call === 1
        ? w4Page([w4Record(1), w4Record(2)], {
            hasMore: true,
            nextCursor: 'cursor-2'
          })
        : w4Page([w4Record(2), w4Record(3)])
  })
  const store = new AppStore(api)

  assert.strictEqual(store.isLiveMode, true)
  assert.strictEqual(store.isReadOnly, true)
  assert.strictEqual(store.usingPreview, true, '首启尚未读取成功 → 预览态')

  await store.refreshFromServer()
  assert.strictEqual(store.usingPreview, false)
  assert.strictEqual(store.readStatus, 'ready')
  assert.strictEqual(store.points, 15)
  assert.strictEqual(store.profile.name, '小明')
  assert.strictEqual(store.habits[0].title, '认真刷牙')
  assert.strictEqual(store.visibleRecords.length, 2)
  assert.strictEqual(store.hasMoreRecords, true)

  await store.loadMoreRecords()
  assert.strictEqual(api.calls.records[1].cursor, 'cursor-2', '游标必须原样回传')
  assert.deepStrictEqual(
    store.visibleRecords.map((record) => record.id),
    ['record-1', 'record-2', 'record-3'],
    '第二页重复的 record-2 只能出现一次'
  )
  assert.strictEqual(store.hasMoreRecords, false)

  await store.loadMoreRecords()
  assert.strictEqual(api.calls.records.length, 2, '没有更多时不得再发请求')
})

check('W4 store：切分类重新请求第一页（不在本地二次过滤）', async () => {
  const api = w4FakeApi({
    records: (query) =>
      query.category === 'praise'
        ? w4Page([w4Record(1)])
        : w4Page([w4Record(1), w4Record(2)])
  })
  const store = new AppStore(api)
  await store.refreshFromServer()
  assert.strictEqual(store.visibleRecords.length, 2)

  await store.setRecordFilter('praise')
  assert.strictEqual(api.calls.records[1].category, 'praise')
  assert.strictEqual(api.calls.records[1].cursor, undefined, '切分类从第一页开始')
  assert.strictEqual(store.visibleRecords.length, 1)
  assert.strictEqual(store.recordFilter, 'praise')
})

check('W4 store：首屏未完成时切分类，旧分类响应作废且使用新分类', async () => {
  let releaseInitialHome
  const initialHome = new Promise((resolve) => {
    releaseInitialHome = resolve
  })
  let homeCalls = 0
  const api = {
    recordsCalls: [],
    fetchHome() {
      homeCalls += 1
      // 第一次故意挂起：模拟首屏 /home 还在路上。
      return homeCalls === 1 ? initialHome : Promise.resolve(HomeDto.fromJson(w4Home()))
    },
    async fetchRecords(query) {
      this.recordsCalls.push(query)
      return query.category === 'praise'
        ? w4Page([w4Record(1)])
        : w4Page([w4Record(1), w4Record(2), w4Record(3)])
    }
  }
  const store = new AppStore(api)

  const initial = store.refreshFromServer()
  await store.setRecordFilter('praise')
  assert.strictEqual(store.recordFilter, 'praise')
  assert.strictEqual(api.recordsCalls[1].category, 'praise')
  assert.deepStrictEqual(
    store.visibleRecords.map((record) => record.id),
    ['record-1'],
    '新分类的第一页应立即可见'
  )

  releaseInitialHome(HomeDto.fromJson(w4Home()))
  await initial
  assert.deepStrictEqual(
    store.visibleRecords.map((record) => record.id),
    ['record-1'],
    '旧分类的响应回来晚了一步，也不许覆盖新分类列表'
  )
  assert.strictEqual(store.readStatus, 'ready')
})


check('W4 store：刷新失败保留旧数据，并给出可重试错误', async () => {
  let failing = false
  const api = w4FakeApi({
    home: () => {
      if (failing) throw ReadApiException.network(new Error('offline'))
      return w4Home()
    },
    records: () => {
      if (failing) throw ReadApiException.network(new Error('offline'))
      return w4Page([w4Record(1)])
    }
  })
  const store = new AppStore(api)
  await store.refreshFromServer()
  const before = store.visibleRecords.map((record) => record.id)

  failing = true
  await store.refreshFromServer()
  assert.strictEqual(store.readStatus, 'error')
  assert.strictEqual(store.readError.kind, 'network')
  assert.strictEqual(store.usingPreview, false, '已经看过服务端数据就不能退回预览')
  assert.strictEqual(store.points, 15, '失败不得清空已有余额')
  assert.deepStrictEqual(
    store.visibleRecords.map((record) => record.id),
    before,
    '失败不得清空已有列表'
  )
})

check('W4 store：并发刷新按 epoch 丢弃过期响应（旧响应不许覆盖新响应）', async () => {
  let releaseFirst
  const firstHome = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const api = {
    calls: 0,
    fetchHome() {
      this.calls += 1
      return this.calls === 1
        ? firstHome
        : Promise.resolve(
            HomeDto.fromJson(
              w4Home({
                child: { id: 'child-1', name: '小明', pointsBalance: 99 }
              })
            )
          )
    },
    async fetchRecords() {
      return w4Page([])
    }
  }
  const store = new AppStore(api)

  const stale = store.refreshFromServer()
  await store.refreshFromServer()
  assert.strictEqual(store.points, 99)

  releaseFirst(HomeDto.fromJson(w4Home()))
  await stale
  assert.strictEqual(store.points, 99, '第一次（更旧）的响应必须被丢弃')
  assert.strictEqual(store.readStatus, 'ready')
})

check('W4 store：ensureInitialRead 只发一次，读过后不自动重试', async () => {
  const api = w4FakeApi()
  const store = new AppStore(api)
  store.ensureInitialRead()
  store.ensureInitialRead()
  assert.strictEqual(api.calls.home, 1, '首帧并发调用也只能发一次')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(store.readStatus, 'ready')

  store.ensureInitialRead()
  assert.strictEqual(api.calls.home, 1, '已读过（含失败）不再自动重试')
})

  await checkAsync(
    'W4 客户端：GET 原样回传游标、带设备身份头、解析文本响应',
    async () => {
      const seen = []
      const transport = {
        async send(uri, headers, timeoutMs) {
          seen.push({ uri, headers, timeoutMs })
          return {
            statusCode: 200,
            body: JSON.stringify(
              w4Page([w4WireRecord(1)], {
                hasMore: true,
                nextCursor: 'cursor-2'
              })
            )
          }
        }
      }
      const client = new ReadApiClient({
        config: new ReadApiConfig(
          'http://127.0.0.1:3000/',
          'device-1',
          'child-1'
        ),
        transport,
        timeoutMs: 1234
      })

      const page = await client.fetchRecords({
        category: 'praise',
        cursor: 'cursor-1',
        limit: 20
      })
      assert.strictEqual(page.records[0].id, 'record-1')
      assert.strictEqual(page.nextCursor, 'cursor-2')
      assert.strictEqual(seen[0].timeoutMs, 1234)
      assert.strictEqual(seen[0].headers[kDeviceIdHeader], 'device-1')
      assert.strictEqual(seen[0].headers[kChildIdHeader], 'child-1')
      assert.ok(seen[0].uri.includes('cursor=cursor-1'))
      assert.ok(seen[0].uri.includes('category=praise'))
      assert.ok(seen[0].uri.includes('limit=20'))
    }
  )

await Promise.all(pendingChecks)
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1

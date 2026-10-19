/**
 * W4-E 写入口的**异步**运行时用例（`run.js` 的同步部分跑完后由它拉起）。
 *
 * 与 `run-w4c.mjs` 同样的理由：CommonJS 没有顶层 `await`，而 D12 守卫不允许
 * 把汇总 / 退出码塞进回调。这里顶层 `await` → 顶层汇总 → 顶层退出码。
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 纯 Node 无法 require 真实的 `@tarojs/taro`，与 run.js / run-w4c.mjs 同款壳。 */
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
const { HomeDto, RecordsPageDto } = require('./dist/data/read_dto.js')
const {
  WriteApiClient,
  createWriteApiFromEnvironment
} = require('./dist/data/write_api.js')
const { WriteApiException } = require('./dist/data/write_api_errors.js')
const { WrittenRecordDto } = require('./dist/data/write_dto.js')

let failed = 0
const pending = []

function report(name, error) {
  if (error) {
    failed += 1
    console.log('FAIL  ' + name + ' -> ' + error.message)
  } else {
    console.log('PASS  ' + name)
  }
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

const config = new ReadApiConfig(
  'http://127.0.0.1:3000/',
  'device-1',
  'child-1'
)

function recordJson(overrides = {}) {
  return Object.assign(
    {
      id: 'record-1',
      title: '认真刷牙',
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
      balanceAfter: 11,
      createdAt: new Date().toISOString()
    },
    overrides
  )
}

function writtenJson(overrides = {}, executedRecordId) {
  const record = recordJson(overrides)
  return {
    record,
    executedRecordId: executedRecordId ?? record.id
  }
}

function homeDto(pointsBalance = 11) {
  return HomeDto.fromJson({
    child: { id: 'child-1', name: '小明', pointsBalance },
    goodHabitCount: 1,
    rewardCount: 0,
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
    rules: [],
    wishes: []
  })
}

function pageDto(records = []) {
  return RecordsPageDto.fromJson({
    records,
    limit: 50,
    hasMore: false,
    nextCursor: null
  })
}

function fakeReadApi(input = {}) {
  const calls = { home: 0, records: [] }
  return {
    calls,
    async fetchHome() {
      calls.home += 1
      return input.home ? input.home(calls.home) : homeDto()
    },
    async fetchRecords(query) {
      calls.records.push(query)
      return input.records ? input.records(query) : pageDto()
    }
  }
}

function fakeWriteApi(input = {}) {
  const calls = { checkIn: [], reverse: [] }
  return {
    calls,
    async checkIn(habitId, idempotencyKey) {
      calls.checkIn.push({ habitId, idempotencyKey })
      if (input.checkIn) return input.checkIn(habitId, idempotencyKey)
      return WrittenRecordDto.fromJson(writtenJson())
    },
    async reverse(recordId, args) {
      calls.reverse.push({ recordId, ...args })
      if (input.reverse) return input.reverse(recordId, args)
      return WrittenRecordDto.fromJson(
        writtenJson(
          {
            id: 'correction-1',
            category: 'adjust',
            source: 'correction',
            points: -1,
            reversesRecordId: recordId,
            balanceAfter: 10
          },
          'correction-1'
        )
      )
    }
  }
}

await checkAsync('W4-E 配置缺失时不构造写客户端', async () => {
  assert.strictEqual(createWriteApiFromEnvironment({}), null)
  assert.ok(config.isConfigured)
})

await checkAsync('W4-E 客户端：POST 路径 / body / 身份头 / 幂等头', async () => {
  const seen = []
  const transport = {
    async send(uri, headers, body, timeoutMs) {
      seen.push({ uri, headers, body, timeoutMs })
      return { statusCode: 201, body: writtenJson() }
    }
  }
  const client = new WriteApiClient({ config, transport, timeoutMs: 1234 })
  const result = await client.checkIn('habit-1', 'key-1')

  assert.strictEqual(result.record.id, 'record-1')
  assert.strictEqual(result.executedRecordId, 'record-1')
  assert.ok(seen[0].uri.endsWith('/records/check-in'))
  assert.deepStrictEqual(seen[0].body, { habitId: 'habit-1' })
  assert.strictEqual(seen[0].headers['x-kp-device-id'], 'device-1')
  assert.strictEqual(seen[0].headers['x-kp-child-id'], 'child-1')
  assert.strictEqual(seen[0].headers['idempotency-key'], 'key-1')
  assert.strictEqual(seen[0].timeoutMs, 1234)
})

await checkAsync('W4-E 客户端：撤销备注去空白，空备注不落空串', async () => {
  const seen = []
  const transport = {
    async send(uri, headers, body) {
      seen.push({ uri, body })
      return {
        statusCode: 201,
        body: writtenJson(
          {
            id: 'correction-1',
            category: 'adjust',
            source: 'correction',
            points: -1,
            reversesRecordId: 'record-1',
            balanceAfter: 10
          },
          'correction-1'
        )
      }
    }
  }
  const client = new WriteApiClient({ config, transport })
  await client.reverse('record-1', { note: '  认真刷牙  ' })
  await client.reverse('record-1', { note: '   ' })

  assert.ok(seen[0].uri.endsWith('/records/record-1/reverse'))
  assert.deepStrictEqual(seen[0].body, { note: '认真刷牙' })
  assert.deepStrictEqual(seen[1].body, {})
})

await checkAsync('W4-E 错误：409 业务码优先于状态码', async () => {
  const limit = WriteApiException.fromHttp({
    statusCode: 409,
    body: { code: 'HABIT_DAILY_LIMIT_REACHED', message: 'reached' }
  })
  assert.strictEqual(limit.kind, 'conflict')
  assert.ok(limit.userMessage.includes('次数已经用完'))
  assert.strictEqual(limit.isRetryable, false)

  const habit = WriteApiException.fromHttp({
    statusCode: 404,
    body: { code: 'HABIT_NOT_FOUND' }
  })
  const record = WriteApiException.fromHttp({
    statusCode: 404,
    body: { code: 'RECORD_NOT_FOUND' }
  })
  assert.ok(habit.userMessage.includes('习惯'))
  assert.ok(record.userMessage.includes('打卡记录'))
})

await checkAsync('W4-E DTO：executedRecordId 与 record.id 不一致必须显式失败', async () => {
  assert.throws(
    () => WrittenRecordDto.fromJson(writtenJson({}, 'other')),
    (error) =>
      error instanceof WriteApiException && error.kind === 'malformed',
    '不一致的 executedRecordId 不能被当成成功'
  )

  const missing = writtenJson()
  delete missing.executedRecordId
  assert.throws(
    () => WrittenRecordDto.fromJson(missing),
    (error) =>
      error instanceof WriteApiException && error.kind === 'malformed',
    '缺 executedRecordId 必须归一成写异常（而不是只读异常）'
  )
})

await checkAsync('W4-E store：打卡真的 POST + 幂等键，并刷新服务端快照', async () => {
  const readApi = fakeReadApi({ records: () => pageDto([recordJson()]) })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()

  assert.strictEqual(store.isLiveMode, true)
  assert.strictEqual(store.usesServerWrites, true)
  assert.strictEqual(store.isReadOnly, true, '其它写入口仍只读')
  assert.strictEqual(store.canWriteCheckIns, true)

  const message = await store.submitCheckIn(store.habits[0])
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.checkIn.length, 1)
  assert.strictEqual(writeApi.calls.checkIn[0].habitId, 'habit-1')
  assert.ok(writeApi.calls.checkIn[0].idempotencyKey)
  assert.strictEqual(store.points, 11)
  assert.strictEqual(store.visibleRecords[0].id, 'record-1')
})

await checkAsync('W4-E store：服务端拒绝时内存余额与流水不变', async () => {
  const readApi = fakeReadApi()
  const writeApi = fakeWriteApi({
    checkIn: () => {
      throw new WriteApiException('conflict', '这个习惯今天的次数已经用完啦')
    }
  })
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()
  const points = store.points
  const records = store.visibleRecords.length

  const message = await store.submitCheckIn(store.habits[0])
  assert.strictEqual(message, '这个习惯今天的次数已经用完啦')
  assert.strictEqual(store.points, points)
  assert.strictEqual(store.visibleRecords.length, records)
})

await checkAsync('W4-E store：双击串行，只发一次写请求', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const writeApi = fakeWriteApi({ checkIn: () => gate })
  const store = new AppStore(fakeReadApi(), writeApi)
  await store.refreshFromServer()

  const first = store.submitCheckIn(store.habits[0])
  const second = await store.submitCheckIn(store.habits[0])
  assert.ok(second.includes('保存中'))
  assert.strictEqual(writeApi.calls.checkIn.length, 1)

  release(WrittenRecordDto.fromJson(writtenJson()))
  assert.strictEqual(await first, null)
})

await checkAsync('W4-E store：撤销用今天未冲正的记录 id', async () => {
  const readApi = fakeReadApi({ records: () => pageDto([recordJson()]) })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()

  const message = await store.submitUndoCheckIn(store.habits[0])
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.reverse.length, 1)
  assert.strictEqual(writeApi.calls.reverse[0].recordId, 'record-1')
  assert.strictEqual(writeApi.calls.reverse[0].note, '认真刷牙')
})

await checkAsync('W4-E store：当前页无目标时取不分类流水定位', async () => {
  let reads = 0
  const readApi = fakeReadApi({
    records: () => {
      reads += 1
      return reads === 1 ? pageDto([]) : pageDto([recordJson()])
    }
  })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()

  const message = await store.submitUndoCheckIn(store.habits[0])
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.reverse[0].recordId, 'record-1')
  assert.ok(
    readApi.calls.records.some(
      (query) => query.limit === 200 && query.category === undefined
    ),
    '必须取不分类流水，才能同时看到 praise 与 adjust（冲正）'
  )
})

await checkAsync('W4-E store：live 但没写客户端时拒绝写，不偷偷改内存', async () => {
  const store = new AppStore(fakeReadApi(), null)
  await store.refreshFromServer()
  const points = store.points

  const message = await store.submitCheckIn(store.habits[0])
  assert.strictEqual(store.isCheckInReadOnly, true)
  assert.ok(message.includes('没有接上后端'))
  assert.strictEqual(store.points, points)
})

await Promise.all(pending)
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1

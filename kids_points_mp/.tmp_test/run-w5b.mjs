/**
 * W5-B「记一笔」（`POST /records/adjust`）的**异步**运行时用例。
 *
 * 与 `run-w4e.mjs` / `run-w5a.mjs` 同样的理由：CommonJS 没有顶层 `await`，
 * 而 D12 守卫不允许把汇总 / 退出码塞进回调。
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 纯 Node 无法 require 真实的 `@tarojs/taro`，与 run.js / run-w5a.mjs 同款壳。 */
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
const { WriteApiClient } = require('./dist/data/write_api.js')
const { WriteApiException } = require('./dist/data/write_api_errors.js')

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

const config = new ReadApiConfig(
  'http://127.0.0.1:3000/',
  'device-1',
  'child-1'
)

function recordJson(overrides = {}) {
  return Object.assign(
    {
      id: 'record-1',
      title: '额外奖励',
      points: 5,
      category: 'adjust',
      source: 'guardian',
      operatorRole: 'guardian',
      note: '',
      habitId: null,
      ruleId: null,
      ruleVersion: null,
      wishId: null,
      reversesRecordId: null,
      reversedAt: null,
      balanceAfter: 16,
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

function homeDto(input = {}) {
  return HomeDto.fromJson(
    Object.assign(
      {
        child: { id: 'child-1', name: '小明', pointsBalance: 11 },
        goodHabitCount: 1,
        rewardCount: 0,
        habits: [],
        rules: [],
        wishes: []
      },
      input
    )
  )
}

function pageDto(records = []) {
  return RecordsPageDto.fromJson({
    records,
    limit: 50,
    hasMore: false,
    nextCursor: null
  })
}

/** 可变的「服务端快照」：写完刷新时必须看到新状态，否则断言只是在考本地缓存。 */
function fakeReadApi(getHome = () => homeDto(), getRecords = () => pageDto()) {
  const calls = { home: 0, records: [] }
  return {
    calls,
    async fetchHome() {
      calls.home += 1
      return getHome()
    },
    async fetchRecords(query) {
      calls.records.push(query)
      return getRecords()
    }
  }
}

function fakeWriteApi(input = {}) {
  const calls = { adjust: [] }
  return {
    calls,
    async adjust(args) {
      calls.adjust.push(args)
      if (input.adjust) return input.adjust(args)
      return writtenJson()
    }
  }
}

await checkAsync(
  'W5-B 客户端：POST /records/adjust，标题去空白 / 带符号分值原样发出',
  async () => {
    const seen = []
    const transport = {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, headers, body, timeoutMs, method })
        return {
          statusCode: 201,
          body: writtenJson({ points: -3, balanceAfter: 8 })
        }
      }
    }
    const client = new WriteApiClient({ config, transport, timeoutMs: 1234 })
    const written = await client.adjust({
      title: '  扣除积分  ',
      points: -3,
      note: '  说话不礼貌  ',
      idempotencyKey: 'key-adjust-1'
    })

    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].method, 'POST')
    assert.ok(seen[0].uri.endsWith('/records/adjust'), seen[0].uri)
    assert.strictEqual(seen[0].body.title, '扣除积分')
    assert.strictEqual(seen[0].body.note, '说话不礼貌')
    assert.strictEqual(seen[0].body.points, -3, '扣分必须原样发出（再取反就变加分）')
    assert.strictEqual(seen[0].headers['idempotency-key'], 'key-adjust-1')
    assert.strictEqual(seen[0].headers['x-kp-device-id'], 'device-1')
    assert.strictEqual(seen[0].headers['x-kp-child-id'], 'child-1')
    assert.strictEqual(seen[0].timeoutMs, 1234)
    assert.strictEqual(written.record.points, -3)
    assert.strictEqual(written.record.balanceAfter, 8)
    assert.strictEqual(written.executedRecordId, written.record.id)
  }
)

await checkAsync('W5-B 客户端：空备注不发 note 字段（空串不许进 body）', async () => {
  const seen = []
  const transport = {
    async send(uri, headers, body) {
      seen.push({ uri, body })
      return { statusCode: 201, body: writtenJson() }
    }
  }
  const client = new WriteApiClient({ config, transport })
  await client.adjust({ title: '额外奖励', points: 5, note: '   ' })

  assert.strictEqual(seen.length, 1)
  assert.strictEqual('note' in seen[0].body, false, '空白备注不该出现在 body 里')
  assert.strictEqual(seen[0].body.points, 5)
})

await checkAsync('W5-B 客户端：空标题 / 0 分在本地就拒，一次请求都不发', async () => {
  const seen = []
  const transport = {
    async send(uri, headers, body) {
      seen.push({ uri, body })
      return { statusCode: 201, body: writtenJson() }
    }
  }
  const client = new WriteApiClient({ config, transport })

  await assert.rejects(() => client.adjust({ title: '   ', points: 5 }), /title/)
  await assert.rejects(
    () => client.adjust({ title: '额外奖励', points: 0 }),
    /points/
  )
  assert.strictEqual(seen.length, 0, '本地拒掉的操作不允许产生请求')
})

await checkAsync('W5-B 客户端：回包缺 balanceAfter ⇒ malformed，不把坏数据塞进 UI', async () => {
  const transport = {
    async send() {
      const body = writtenJson()
      delete body.record.balanceAfter
      return { statusCode: 201, body }
    }
  }
  const client = new WriteApiClient({ config, transport })

  await assert.rejects(
    () => client.adjust({ title: '额外奖励', points: 5 }),
    (error) => {
      assert.ok(error instanceof WriteApiException)
      assert.strictEqual(error.kind, 'malformed')
      return true
    }
  )
})
await checkAsync('W5-B 客户端：409 INSUFFICIENT_POINTS 给出可读文案（不冒充其他 409）', async () => {
  const transport = {
    async send() {
      return { statusCode: 409, body: { code: 'INSUFFICIENT_POINTS' } }
    }
  }
  const client = new WriteApiClient({ config, transport })

  await assert.rejects(
    () => client.adjust({ title: '扣除积分', points: -99 }),
    (error) => {
      assert.ok(error instanceof WriteApiException)
      assert.strictEqual(error.kind, 'conflict')
      assert.strictEqual(error.code, 'INSUFFICIENT_POINTS')
      assert.ok(error.userMessage.includes('积分不足'), error.userMessage)
      return true
    }
  )
})



await checkAsync('W5-B store：live 下走 POST /records/adjust，余额以服务端为准', async () => {
  // 服务端快照是**可变**的：只有真的把回包落进 UI 才算接通，否则只考了本地缓存。
  let serverPoints = 11
  const serverRecord = recordJson({ id: 'adjust-1', balanceAfter: 16 })
  const readApi = fakeReadApi(
    () =>
      homeDto({ child: { id: 'child-1', name: '小明', pointsBalance: serverPoints } }),
    () => pageDto(serverPoints === 16 ? [serverRecord] : [])
  )
  const writeApi = fakeWriteApi({
    adjust: async () => {
      serverPoints = 16
      return writtenJson({ id: 'adjust-1', points: 5, balanceAfter: 16 })
    }
  })
  const store = new AppStore(readApi, writeApi)

  await store.refreshFromServer()
  const before = store.points
  assert.strictEqual(before, 11)

  const message = await store.submitQuickNote(5, '额外奖励')
  assert.strictEqual(message, null, String(message))

  assert.strictEqual(writeApi.calls.adjust.length, 1, '只发一次请求')
  const args = writeApi.calls.adjust[0]
  assert.strictEqual(args.title, '额外奖励')
  assert.strictEqual(args.points, 5)
  assert.strictEqual(typeof args.idempotencyKey, 'string')
  assert.ok(args.idempotencyKey.startsWith('adjust-'), args.idempotencyKey)

  assert.strictEqual(store.points, 16, '余额必须取服务端快照')
  assert.strictEqual(store.records[0].id, 'adjust-1')
  assert.strictEqual(readApi.calls.home, 2, '写成功后必须刷新校正')
})

await checkAsync('W5-B store：空事由用默认文案，扣分带负号发出（客户端不取反）', async () => {
  const writeApi = fakeWriteApi({
    adjust: async () =>
      writtenJson({ title: '扣除积分', points: -3, balanceAfter: 8 })
  })
  const store = new AppStore(fakeReadApi(), writeApi)
  await store.refreshFromServer()

  const message = await store.submitQuickNote(-3, '   ')
  assert.strictEqual(message, null, String(message))
  assert.strictEqual(writeApi.calls.adjust[0].title, '扣除积分')
  assert.strictEqual(writeApi.calls.adjust[0].points, -3)
})

await checkAsync('W5-B store：409 积分不足 ⇒ 返回可读原因，本地余额与流水不变', async () => {
  const readApi = fakeReadApi()
  const writeApi = fakeWriteApi({
    adjust: async () => {
      throw WriteApiException.fromHttp({
        statusCode: 409,
        body: { code: 'INSUFFICIENT_POINTS' }
      })
    }
  })
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()
  const beforePoints = store.points
  const beforeRecords = store.records.length

  const message = await store.submitQuickNote(-99, '随便扣')
  assert.ok(message.includes('积分不足'), String(message))
  assert.strictEqual(store.points, beforePoints, '被拒的写入不许动余额')
  assert.strictEqual(store.records.length, beforeRecords, '被拒的写入不许留流水')
  assert.strictEqual(writeApi.calls.adjust.length, 1)
})

await checkAsync('W5-B store：保存中再点一次 ⇒ 只回提示，不发第二个请求', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const writeApi = fakeWriteApi({
    adjust: async () => {
      await gate
      return writtenJson()
    }
  })
  const store = new AppStore(fakeReadApi(), writeApi)
  await store.refreshFromServer()

  const first = store.submitQuickNote(5, '额外奖励')
  const second = await store.submitQuickNote(5, '额外奖励')
  assert.ok(second.includes('正在保存'), String(second))
  assert.strictEqual(writeApi.calls.adjust.length, 1, '第二次不许发请求')

  release()
  assert.strictEqual(await first, null)
  assert.strictEqual(writeApi.calls.adjust.length, 1)
})

await checkAsync('W5-B store：live 但没注入写客户端 ⇒ 拒绝写，不偷偷改内存', async () => {
  const store = new AppStore(fakeReadApi(), null)
  await store.refreshFromServer()
  const beforePoints = store.points
  const beforeRecords = store.records.length

  const message = await store.submitQuickNote(2, '额外奖励')
  assert.ok(message.includes('只读模式'), String(message))
  assert.strictEqual(store.points, beforePoints)
  assert.strictEqual(store.records.length, beforeRecords)
})

await checkAsync('W5-B store：0 分在本地就拒，一次请求都不发', async () => {
  const writeApi = fakeWriteApi()
  const store = new AppStore(fakeReadApi(), writeApi)
  await store.refreshFromServer()

  const message = await store.submitQuickNote(0, '零分')
  assert.strictEqual(message, '调整金额不能为 0')
  assert.strictEqual(writeApi.calls.adjust.length, 0)
})

await checkAsync('W5-B store：预览模式仍走本地 addQuickNote，返回值语义不变', async () => {
  const store = new AppStore(null, null)
  const before = store.points

  const message = await store.submitQuickNote(4, '预览奖励')
  assert.strictEqual(message, null, String(message))
  assert.strictEqual(store.points, before + 4)
  assert.strictEqual(store.records[0].points, 4)
  assert.strictEqual(store.records[0].title, '预览奖励')
})

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1

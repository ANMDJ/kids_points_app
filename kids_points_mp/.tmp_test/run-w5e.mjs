/**
 * W5-E 档案写端点（`PATCH /child` 改昵称）的**异步**运行时用例。
 *
 * 与 `run-w4e.mjs` / `run-w5a.mjs` 同样的理由：CommonJS 没有顶层 `await`，
 * 而 D12 守卫不允许把汇总 / 退出码塞进回调。这里顶层 `await` → 顶层汇总 →
 * 顶层退出码。
 *
 * 编译（项目约定，与 `21-w5d-handoff.md` §6 一致）：
 *   npx tsc -p .tmp_test/tsconfig.test.json   # rootDir ../src → 产物落在 .tmp_test/dist
 *   node .tmp_test/run-w5e.mjs
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

function homeDto(name = '小明') {
  return HomeDto.fromJson({
    child: { id: 'child-1', name, pointsBalance: 100 },
    goodHabitCount: 0,
    rewardCount: 0,
    habits: [],
    rules: [],
    wishes: []
  })
}

function pageDto() {
  return RecordsPageDto.fromJson({
    records: [],
    limit: 50,
    hasMore: false,
    nextCursor: null
  })
}

/** 可变的「服务端快照」：count 用来证明改名**没有**多跑一次 /home。 */
function fakeReadApi(getHome = () => homeDto()) {
  const calls = { home: 0, records: 0 }
  return {
    calls,
    async fetchHome() {
      calls.home += 1
      return getHome()
    },
    async fetchRecords() {
      calls.records += 1
      return pageDto()
    }
  }
}

function fakeWriteApi(input = {}) {
  const calls = { renameChild: [] }
  return {
    calls,
    async renameChild(name) {
      calls.renameChild.push(name)
      if (input.renameChild) return input.renameChild(name)
      return { childId: 'child-1', name }
    }
  }
}

await checkAsync(
  'W5-E 客户端：PATCH /child，body 只有 name，且不带幂等键',
  async () => {
    const seen = []
    const transport = {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, headers, body, timeoutMs, method })
        return {
          statusCode: 200,
          body: { childId: 'child-1', name: '小明明' }
        }
      }
    }
    const client = new WriteApiClient({ config, transport, timeoutMs: 1234 })
    const dto = await client.renameChild('  小明明  ')

    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].method, 'PATCH')
    assert.ok(seen[0].uri.endsWith('/child'), seen[0].uri)
    assert.deepStrictEqual(seen[0].body, { name: '小明明' }, '只发 name，childId 只从身份头来')
    assert.strictEqual(seen[0].headers['x-kp-device-id'], 'device-1')
    assert.strictEqual(seen[0].headers['x-kp-child-id'], 'child-1')
    assert.strictEqual(
      seen[0].headers['idempotency-key'],
      undefined,
      'PATCH 本就幂等（同名不改库），不需要幂等键'
    )
    assert.strictEqual(seen[0].timeoutMs, 1234)
    assert.strictEqual(dto.childId, 'child-1')
    assert.strictEqual(dto.name, '小明明')
  }
)

await checkAsync('W5-E 客户端：空昵称在本地就拒，一个请求都不发', async () => {
  const seen = []
  const client = new WriteApiClient({
    config,
    transport: {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, body, method })
        return { statusCode: 200, body: { childId: 'child-1', name: 'x' } }
      }
    }
  })
  await assert.rejects(() => client.renameChild('   '), /name 不能为空/)
  assert.strictEqual(seen.length, 0)
})

await checkAsync(
  'W5-E 客户端：回包 childId 与当前会话不一致 ⇒ malformed，名字不落地',
  async () => {
    const client = new WriteApiClient({
      config,
      transport: {
        async send() {
          return {
            statusCode: 200,
            body: { childId: 'child-2', name: '别人家的孩子' }
          }
        }
      }
    })
    await assert.rejects(
      () => client.renameChild('小明明'),
      (error) =>
        error instanceof WriteApiException &&
        error.kind === 'malformed' &&
        error.detail.includes('child-2'),
      '回包写的是另一个孩子，绝不能更新本地档案'
    )
  }
)

await checkAsync('W5-E 客户端：400 的两个业务码翻成可展示中文', async () => {
  async function fail400(code) {
    const client = new WriteApiClient({
      config,
      transport: {
        async send() {
          return {
            statusCode: 400,
            body: { statusCode: 400, code, message: 'backend english message' }
          }
        }
      }
    })
    try {
      await client.renameChild('随便一个名字')
      throw new Error('必须抛出 WriteApiException')
    } catch (error) {
      if (!(error instanceof WriteApiException)) throw error
      return error
    }
  }

  const tooLong = await fail400('CHILD_NAME_TOO_LONG')
  assert.ok(tooLong.userMessage.includes('16 个字符'), tooLong.userMessage)
  assert.ok(!tooLong.userMessage.includes('400'), tooLong.userMessage)

  const empty = await fail400('CHILD_NAME_EMPTY')
  assert.ok(empty.userMessage.includes('不能为空'), empty.userMessage)
  assert.ok(!empty.userMessage.includes('400'), empty.userMessage)
})

await checkAsync(
  'W5-E store：live 用服务端返回的名字覆盖档案，且不额外重拉 /home',
  async () => {
    const readApi = fakeReadApi()
    const writeApi = fakeWriteApi({
      // 服务端 trim / 规范化后的值才是库里真实的名字。
      renameChild: () => ({ childId: 'child-1', name: '小明明' })
    })
    const store = new AppStore(readApi, writeApi)
    await store.refreshFromServer()
    assert.strictEqual(store.profile.name, '小明')

    const homeCallsBefore = readApi.calls.home
    const message = await store.submitRenameChild('  小明明 ')

    assert.strictEqual(message, null)
    assert.deepStrictEqual(writeApi.calls.renameChild, ['小明明'], '本地先 trim 再发')
    assert.strictEqual(store.profile.name, '小明明')
    assert.strictEqual(
      readApi.calls.home,
      homeCallsBefore,
      'PATCH 回包已是权威值，不该再多跑一次 /home 让滞后快照盖回去'
    )
  }
)

await checkAsync('W5-E store：名字没变就不发请求', async () => {
  const writeApi = fakeWriteApi()
  const store = new AppStore(fakeReadApi(), writeApi)
  await store.refreshFromServer()

  const message = await store.submitRenameChild(' 小明 ')

  assert.ok(message.includes('没有变化'), message)
  assert.strictEqual(writeApi.calls.renameChild.length, 0)
})

await checkAsync('W5-E store：live 但没写客户端 ⇒ 只读文案，档案不动', async () => {
  const store = new AppStore(fakeReadApi(), null)
  await store.refreshFromServer()
  assert.strictEqual(store.isProfileWriteReadOnly, true)

  const message = await store.submitRenameChild('小明明')

  assert.strictEqual(message, store.profileReadOnlyWriteMessage)
  assert.strictEqual(store.profile.name, '小明', '没保存就不能先改，否则刷新就打回原形')
})

await checkAsync('W5-E store：预览模式照旧本地生效（演示数据本来就该改）', async () => {
  const store = new AppStore(null, null)
  store.profile.name = '小明'
  assert.strictEqual(store.isProfileWriteReadOnly, false, '预览模式不是「只读」')

  const message = await store.submitRenameChild(' 小明明 ')

  assert.strictEqual(message, null)
  assert.strictEqual(store.profile.name, '小明明')
})

await checkAsync('W5-E store：空昵称不发请求，返回可读原因', async () => {
  const writeApi = fakeWriteApi()
  const store = new AppStore(fakeReadApi(), writeApi)
  await store.refreshFromServer()

  const message = await store.submitRenameChild('   ')

  assert.ok(message.includes('不能为空'), message)
  assert.strictEqual(writeApi.calls.renameChild.length, 0)
})

await checkAsync('W5-E store：写请求失败时不改内存，返回服务端文案', async () => {
  const writeApi = fakeWriteApi({
    renameChild: () => {
      throw new WriteApiException(
        'badRequest',
        '昵称最多 16 个字符（表情按 1 个算），这次没有保存。',
        { statusCode: 400, code: 'CHILD_NAME_TOO_LONG' }
      )
    }
  })
  const store = new AppStore(fakeReadApi(), writeApi)
  await store.refreshFromServer()

  const message = await store.submitRenameChild('这个名字确实有点太长了')

  assert.ok(message.includes('16 个字符'), message)
  assert.strictEqual(store.profile.name, '小明', '失败不许偷偷改内存')
})

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1

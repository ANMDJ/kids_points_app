/**
 * W5-A 规则写端点（新建 / 编辑 / 软删 / 加入习惯）的**异步**运行时用例。
 *
 * 与 `run-w4e.mjs` 同样的理由：CommonJS 没有顶层 `await`，而 D12 守卫不允许
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

function ruleJson(overrides = {}) {
  return Object.assign(
    {
      id: 'rule-1',
      title: '每天练琴 30 分钟',
      points: 2,
      direction: 'reward',
      icon: 'music',
      color: '#9b8be8',
      condition: '认真练习不断开',
      dailyLimit: 1,
      currentVersion: 1
    },
    overrides
  )
}

function habitJson(overrides = {}) {
  return Object.assign(
    {
      id: 'habit-1',
      title: '每天练琴 30 分钟',
      points: 2,
      icon: 'music',
      color: '#9b8be8',
      condition: '认真练习不断开',
      dailyLimit: 1,
      ruleId: 'rule-1'
    },
    overrides
  )
}

function homeDto(input = {}) {
  return HomeDto.fromJson({
    child: { id: 'child-1', name: '小明', pointsBalance: 11 },
    goodHabitCount: 1,
    rewardCount: 0,
    habits: input.habits ?? [],
    rules: input.rules ?? [],
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

/** 可变的「服务端快照」：写完刷新时必须看到新状态，否则断言只是在考本地缓存。 */
function fakeReadApi(getHome = () => homeDto()) {
  const calls = { home: 0, records: [] }
  return {
    calls,
    async fetchHome() {
      calls.home += 1
      return getHome()
    },
    async fetchRecords(query) {
      calls.records.push(query)
      return pageDto()
    }
  }
}

function fakeWriteApi(input = {}) {
  const calls = { createRule: [], updateRule: [], deleteRule: [], addHabit: [] }
  return {
    calls,
    async createRule(args) {
      calls.createRule.push(args)
      if (input.createRule) return input.createRule(args)
      return ruleJson()
    },
    async updateRule(ruleId, args) {
      calls.updateRule.push({ ruleId, ...args })
      if (input.updateRule) return input.updateRule(ruleId, args)
      return ruleJson({ currentVersion: args.expectedVersion + 1 })
    },
    async deleteRule(ruleId, idempotencyKey) {
      calls.deleteRule.push({ ruleId, idempotencyKey })
      if (input.deleteRule) return input.deleteRule(ruleId, idempotencyKey)
      return ruleId
    },
    async addHabitFromRule(ruleId, idempotencyKey) {
      calls.addHabit.push({ ruleId, idempotencyKey })
      if (input.addHabit) return input.addHabit(ruleId, idempotencyKey)
      return habitJson()
    }
  }
}

await checkAsync('W5-A 客户端：新建 POST /point-rules，带符号分值原样发出', async () => {
  const seen = []
  const transport = {
    async send(uri, headers, body, timeoutMs, method) {
      seen.push({ uri, headers, body, timeoutMs, method })
      return { statusCode: 201, body: ruleJson({ points: -3, direction: 'penalty' }) }
    }
  }
  const client = new WriteApiClient({ config, transport, timeoutMs: 1234 })
  const rule = await client.createRule({
    title: '  每天练琴  ',
    condition: '  认真练习  ',
    dailyLimit: 2,
    points: -3,
    icon: 'music',
    color: '#9b8be8',
    idempotencyKey: 'key-1'
  })

  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].method, 'POST')
  assert.ok(seen[0].uri.endsWith('/point-rules'))
  assert.strictEqual(seen[0].body.title, '每天练琴')
  assert.strictEqual(seen[0].body.condition, '认真练习')
  assert.strictEqual(seen[0].body.points, -3, '扣分必须原样发出（再取反就变加分）')
  assert.strictEqual(seen[0].body.dailyLimit, 2)
  assert.strictEqual(seen[0].headers['idempotency-key'], 'key-1')
  assert.strictEqual(seen[0].headers['x-kp-device-id'], 'device-1')
  assert.strictEqual(seen[0].headers['x-kp-child-id'], 'child-1')
  assert.strictEqual(seen[0].timeoutMs, 1234)
  assert.strictEqual(rule.points, -3)
  assert.strictEqual(rule.direction, 'penalty')
})

await checkAsync('W5-A 客户端：编辑 PATCH + expectedVersion（乐观锁）', async () => {
  const seen = []
  const transport = {
    async send(uri, headers, body, timeoutMs, method) {
      seen.push({ uri, body, method })
      return { statusCode: 200, body: ruleJson({ currentVersion: 5, points: -2 }) }
    }
  }
  const client = new WriteApiClient({ config, transport })
  const rule = await client.updateRule('rule-1', {
    title: '每天练琴',
    condition: '认真练习',
    dailyLimit: 1,
    points: -2,
    expectedVersion: 4
  })

  assert.strictEqual(seen[0].method, 'PATCH')
  assert.ok(seen[0].uri.endsWith('/point-rules/rule-1'))
  assert.strictEqual(seen[0].body.expectedVersion, 4)
  assert.strictEqual(seen[0].body.points, -2)
  assert.strictEqual(rule.currentVersion, 5)
})

await checkAsync('W5-A 客户端：删除 DELETE 无请求体，回包 ruleId 必须对得上', async () => {
  const seen = []
  const transport = {
    async send(uri, headers, body, timeoutMs, method) {
      seen.push({ uri, headers, body, method })
      return { statusCode: 200, body: { ruleId: 'rule-1' } }
    }
  }
  const client = new WriteApiClient({ config, transport })
  const ruleId = await client.deleteRule('rule-1', 'key-del')

  assert.strictEqual(ruleId, 'rule-1')
  assert.strictEqual(seen[0].method, 'DELETE')
  assert.ok(seen[0].uri.endsWith('/point-rules/rule-1'))
  assert.strictEqual(seen[0].body, null, 'DELETE 不带请求体')
  assert.strictEqual(
    seen[0].headers['Content-Type'],
    undefined,
    '没有 body 就不该声明 Content-Type'
  )
  assert.strictEqual(seen[0].headers['idempotency-key'], 'key-del')

  const wrong = new WriteApiClient({
    config,
    transport: {
      async send() {
        return { statusCode: 200, body: { ruleId: 'rule-other' } }
      }
    }
  })
  await assert.rejects(
    () => wrong.deleteRule('rule-1'),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'malformed' &&
      error.detail.includes('ruleId'),
    '回包确认的不是「我删的那条」必须显式失败'
  )
})

await checkAsync('W5-A 客户端：按规则生成习惯 POST .../habits，无请求体', async () => {
  const seen = []
  const transport = {
    async send(uri, headers, body, timeoutMs, method) {
      seen.push({ uri, body, method })
      return { statusCode: 201, body: habitJson() }
    }
  }
  const client = new WriteApiClient({ config, transport })
  const habit = await client.addHabitFromRule('rule-1')

  assert.strictEqual(seen[0].method, 'POST')
  assert.ok(seen[0].uri.endsWith('/point-rules/rule-1/habits'))
  assert.strictEqual(seen[0].body, null)
  assert.strictEqual(habit.id, 'habit-1')
  assert.strictEqual(habit.ruleId, 'rule-1')
})

await checkAsync('W5-A 客户端：缺字段的写回包归一成 malformed', async () => {
  const client = new WriteApiClient({
    config,
    transport: {
      async send() {
        const broken = ruleJson()
        delete broken.currentVersion
        return { statusCode: 201, body: broken }
      }
    }
  })
  await assert.rejects(
    () =>
      client.createRule({
        title: 'x',
        condition: '',
        dailyLimit: 1,
        points: 1,
        icon: 'book',
        color: '#f6c64a'
      }),
    (error) => error instanceof WriteApiException && error.kind === 'malformed',
    '缺 currentVersion 必须显式失败，不能把 undefined 塞进 UI 模型'
  )
})

await checkAsync('W5-A 错误：规则写端点的业务码 → 可读中文', async () => {
  const conflict = WriteApiException.fromHttp({
    statusCode: 409,
    body: { code: 'RULE_VERSION_CONFLICT' }
  })
  assert.strictEqual(conflict.kind, 'conflict')
  assert.ok(conflict.userMessage.includes('刷新'), conflict.userMessage)
  assert.strictEqual(conflict.isRetryable, false)

  const penalty = WriteApiException.fromHttp({
    statusCode: 409,
    body: { code: 'RULE_IS_PENALTY' }
  })
  assert.ok(penalty.userMessage.includes('扣分规则'), penalty.userMessage)

  const duplicate = WriteApiException.fromHttp({
    statusCode: 409,
    body: { code: 'HABIT_ALREADY_EXISTS' }
  })
  assert.ok(duplicate.userMessage.includes('已经'), duplicate.userMessage)

  const missing = WriteApiException.fromHttp({
    statusCode: 404,
    body: { code: 'RULE_NOT_FOUND' }
  })
  assert.strictEqual(missing.kind, 'notFound')
  assert.ok(missing.userMessage.includes('规则'), missing.userMessage)
})

await checkAsync('W5-A store：新建真的 POST，回包与刷新后的服务端快照都进列表', async () => {
  let home = homeDto()
  const readApi = fakeReadApi(() => home)
  const writeApi = fakeWriteApi({
    createRule: () => {
      home = homeDto({ rules: [ruleJson()] })
      return ruleJson()
    }
  })
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()
  assert.strictEqual(store.isRuleWriteReadOnly, false)

  const message = await store.submitAddRule(
    '每天练琴 30 分钟',
    '认真练习不断开',
    1,
    2,
    'music',
    '#9b8be8'
  )
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.createRule.length, 1)
  assert.strictEqual(writeApi.calls.createRule[0].points, 2)
  assert.ok(writeApi.calls.createRule[0].idempotencyKey)
  assert.strictEqual(store.rules.length, 1)
  assert.strictEqual(store.rules[0].id, 'rule-1')
  assert.strictEqual(store.rules[0].currentVersion, 1)
})

await checkAsync('W5-A store：编辑用界面上的版本号，版本以服务端回包为准', async () => {
  let home = homeDto({ rules: [ruleJson()] })
  const readApi = fakeReadApi(() => home)
  const writeApi = fakeWriteApi({
    updateRule: (ruleId, args) => {
      home = homeDto({
        rules: [ruleJson({ currentVersion: args.expectedVersion + 1 })]
      })
      return ruleJson({ currentVersion: args.expectedVersion + 1 })
    }
  })
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()
  const rule = store.rules[0]

  const message = await store.submitUpdateRule(rule, {
    title: '每天练琴 20 分钟',
    condition: '认真练习不断开',
    dailyLimit: 1,
    points: 3
  })
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.updateRule[0].ruleId, 'rule-1')
  assert.strictEqual(
    writeApi.calls.updateRule[0].expectedVersion,
    1,
    'expectedVersion 必须是客户端看到的版本'
  )
  assert.strictEqual(store.rules[0].currentVersion, 2)
})

await checkAsync('W5-A store：409 版本冲突时保留原版本、不假装改成功', async () => {
  const readApi = fakeReadApi(() => homeDto({ rules: [ruleJson()] }))
  const writeApi = fakeWriteApi({
    updateRule: () => {
      throw new WriteApiException(
        'conflict',
        '这条规则刚被其他人改动过，请刷新后再改（不会覆盖别人的修改）。'
      )
    }
  })
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()
  const rule = store.rules[0]

  const message = await store.submitUpdateRule(rule, {
    title: '每天练琴 20 分钟',
    condition: '认真练习不断开',
    dailyLimit: 1,
    points: 3
  })
  assert.ok(message.includes('其他人改动过'), message)
  assert.strictEqual(store.rules[0].currentVersion, 1)
  assert.strictEqual(store.rules[0].title, '每天练琴 30 分钟')
})

await checkAsync('W5-A store：删除走 DELETE，刷新失败也先本地软删', async () => {
  let first = true
  const readApi = fakeReadApi(() => {
    if (first) {
      first = false
      return homeDto({ rules: [ruleJson()] })
    }
    // 删除后的刷新故意失败：本地镜像必须已经跟上（软删），
    // 否则规则会「删过却还在列表里」，用户只能再点一次。
    throw new Error('刷新失败')
  })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()
  const rule = store.rules[0]

  const message = await store.submitRemoveRule(rule)
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.deleteRule[0].ruleId, 'rule-1')
  assert.ok(writeApi.calls.deleteRule[0].idempotencyKey)
  assert.strictEqual(store.rules.length, 0, '回收站条目不该出现在规则列表里')
  // W5-F 起 live 模式的回收站**以 `GET /trash` 为准**（本地列表只是首页镜像，
  // 拿它当回收站会把服务端已恢复的条目又列出来）—— 刷新失败时本地确实软删了
  // （上面 0 条已证明），但「回收站里能看到它」要等下一次成功拉取，
  // 那条路径由 `run-w5f.mjs` 覆盖。
  assert.strictEqual(
    store.trashItems().length,
    0,
    'live 模式不许用本地镜像冒充回收站'
  )
})

await checkAsync('W5-A store：加入习惯带上 ruleId，扣分规则本地先拒绝', async () => {
  let home = homeDto({ rules: [ruleJson()] })
  const readApi = fakeReadApi(() => home)
  const writeApi = fakeWriteApi({
    addHabit: () => {
      home = homeDto({ rules: [ruleJson()], habits: [habitJson()] })
      return habitJson()
    }
  })
  const store = new AppStore(readApi, writeApi)
  await store.refreshFromServer()

  const message = await store.submitAddHabitFromRule(store.rules[0])
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.addHabit[0].ruleId, 'rule-1')
  assert.ok(writeApi.calls.addHabit[0].idempotencyKey)
  assert.strictEqual(store.habits.length, 1)
  assert.strictEqual(store.habits[0].ruleId, 'rule-1')

  const penaltyWrite = fakeWriteApi()
  const penaltyStore = new AppStore(
    fakeReadApi(() =>
      homeDto({ rules: [ruleJson({ points: -3, direction: 'penalty' })] })
    ),
    penaltyWrite
  )
  await penaltyStore.refreshFromServer()
  const rejected = await penaltyStore.submitAddHabitFromRule(
    penaltyStore.rules[0]
  )
  assert.ok(rejected.includes('扣分规则'), rejected)
  assert.strictEqual(penaltyWrite.calls.addHabit.length, 0)
})

await checkAsync('W5-A store：live 但没写客户端时四条规则写入口都只读', async () => {
  const store = new AppStore(
    fakeReadApi(() => homeDto({ rules: [ruleJson()] })),
    null
  )
  await store.refreshFromServer()
  assert.strictEqual(store.isRuleWriteReadOnly, true)

  const add = await store.submitAddRule('新规则', '', 1, 1, 'book', '#f6c64a')
  assert.strictEqual(add, store.ruleReadOnlyWriteMessage)
  const update = await store.submitUpdateRule(store.rules[0], {
    title: '改个名',
    condition: '',
    dailyLimit: 1,
    points: 1
  })
  assert.strictEqual(update, store.ruleReadOnlyWriteMessage)
  const remove = await store.submitRemoveRule(store.rules[0])
  assert.strictEqual(remove, store.ruleReadOnlyWriteMessage)
  const habit = await store.submitAddHabitFromRule(store.rules[0])
  assert.strictEqual(habit, store.ruleReadOnlyWriteMessage)

  assert.strictEqual(store.rules.length, 1, '被拦下的写操作不许偷偷改内存')
  assert.strictEqual(store.habits.length, 0)
})

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1

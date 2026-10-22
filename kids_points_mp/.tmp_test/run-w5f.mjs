/**
 * W5-F 回收站（`GET /trash` ＋ 恢复 / 彻底删除）与 C9 习惯软删的**异步**运行时用例。
 *
 * 与 `run-w5e.mjs` 同样的理由（CommonJS 没有顶层 `await`，D12 守卫不允许把
 * 汇总 / 退出码塞进回调）：顶层 `await` → 顶层汇总 → 顶层退出码。
 *
 * 编译（项目约定，与 `21-w5d-handoff.md` §6 一致）：
 *   npx tsc -p .tmp_test/tsconfig.test.json   # rootDir ../src → 产物落在 .tmp_test/dist
 *   node .tmp_test/run-w5f.mjs
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 纯 Node 无法 require 真实的 `@tarojs/taro`，与 run.js / run-w5e.mjs 同款壳。 */
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
const { HomeDto, RecordsPageDto, TrashListDto } = require('./dist/data/read_dto.js')
const { mapTrash } = require('./dist/data/read_mapper.js')
const { TrashTargetDto } = require('./dist/data/write_dto.js')
const { WriteApiClient } = require('./dist/data/write_api.js')
const { WriteApiException } = require('./dist/data/write_api_errors.js')
const {
  isTrashExpired,
  trashKindFromWire,
  trashPurgeOutcomeText
} = require('./dist/data/types.js')

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

const DAY = 86400000
const habitJson = {
  id: 'habit-1',
  title: '早睡',
  points: 2,
  icon: 'moon',
  color: '#7fbf55',
  condition: '每天 21:00 前上床',
  dailyLimit: 1,
  ruleId: 'rule-1'
}

function homeDto(habits = []) {
  return HomeDto.fromJson({
    child: { id: 'child-1', name: '小明', pointsBalance: 100 },
    goodHabitCount: 0,
    rewardCount: 0,
    habits,
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

/**
 * 可变的「服务端回收站」：`trashSource()` 返回 `{ items }` 或抛错，
 * 每个用例自己决定下一次 `GET /trash` 该看到什么。
 */
function fakeReadApi(options = {}) {
  const calls = { home: 0, records: 0, trash: 0 }
  let trashSource = options.trash ?? (() => ({ items: [] }))
  let homeSource = options.home ?? (() => homeDto())
  return {
    calls,
    setTrash(next) {
      trashSource = next
    },
    setHome(next) {
      homeSource = next
    },
    async fetchHome() {
      calls.home += 1
      return homeSource()
    },
    async fetchRecords() {
      calls.records += 1
      return pageDto()
    },
    async fetchTrash() {
      calls.trash += 1
      return TrashListDto.fromJson(trashSource())
    }
  }
}

function fakeWriteApi(options = {}) {
  const calls = { deleteHabit: [], restoreTrashItem: [], purgeTrashItem: [] }
  return {
    calls,
    async deleteHabit(id, idempotencyKey) {
      calls.deleteHabit.push({ id, idempotencyKey })
      if (options.deleteHabit) return options.deleteHabit(id, idempotencyKey)
      return id
    },
    async restoreTrashItem(kind, id) {
      calls.restoreTrashItem.push({ kind, id })
      if (options.restoreTrashItem) return options.restoreTrashItem(kind, id)
      return new TrashTargetDto(kind, id)
    },
    async purgeTrashItem(kind, id) {
      calls.purgeTrashItem.push({ kind, id })
      if (options.purgeTrashItem) return options.purgeTrashItem(kind, id)
      return new TrashTargetDto(kind, id)
    }
  }
}

const now = Date.now()
const daysAgo = (days) => new Date(now - days * DAY).toISOString()


// ───────────────────────────── 线值白名单（types.ts）─────────────────────────────

await checkAsync('W5-F types：回收站类型只认三个线值，别的必须被挡下', () => {
  assert.strictEqual(trashKindFromWire('point_rule'), 'point_rule')
  assert.strictEqual(trashKindFromWire('wish'), 'wish')
  assert.strictEqual(trashKindFromWire('habit'), 'habit')
  // 后端将来新增类型时，客户端必须显式跟上，而不是把它当 habit 塞进界面。
  assert.strictEqual(trashKindFromWire('habit_v2'), null)
  assert.strictEqual(trashKindFromWire(''), null)
  assert.strictEqual(trashKindFromWire('Habit'), null, '大小写不做宽容')
})

await checkAsync('W5-F types：过期判定用同一份 90 天常量，边界是“满 90 天”', () => {
  assert.strictEqual(isTrashExpired(null, now), false)
  assert.strictEqual(isTrashExpired(now - 89 * DAY, now), false)
  assert.strictEqual(isTrashExpired(now - 90 * DAY, now), true)
  assert.strictEqual(isTrashExpired(now - 91 * DAY, now), true)
})

await checkAsync('W5-F types：批量清理文案必须区分“清掉几条 / 没清掉几条”', () => {
  assert.strictEqual(
    trashPurgeOutcomeText({ purged: 2, failed: 0, error: null }),
    '已清理 2 条'
  )
  assert.strictEqual(
    trashPurgeOutcomeText({ purged: 0, failed: 0, error: null }),
    '没有可清理的内容'
  )
  const partial = trashPurgeOutcomeText({
    purged: 1,
    failed: 2,
    error: '这条还有流水引用'
  })
  assert.ok(partial.includes('已清理 1 条'), partial)
  assert.ok(partial.includes('2 条没清掉'), partial)
  assert.ok(partial.includes('这条还有流水引用'), partial)
  assert.strictEqual(
    trashPurgeOutcomeText({ purged: 0, failed: 1, error: '没权限' }),
    '没能清理：没权限'
  )
})

// ───────────────────────────── 映射（read_mapper.ts）─────────────────────────────

await checkAsync('W5-F mapper：未知 kind 抛 malformed，绝不静默跳过一行', () => {
  const dto = TrashListDto.fromJson({
    items: [
      { kind: 'point_rule', id: 'rule-1', title: '完成作业', deletedAt: daysAgo(1) },
      { kind: 'nope', id: 'x', title: '坏行', deletedAt: daysAgo(1) }
    ]
  })
  assert.throws(
    () => mapTrash(dto, now),
    (error) =>
      error instanceof ReadApiException &&
      error.kind === 'malformed' &&
      // 路径在 userMessage 里（`malformed(path, detail)` 的约定）。
      error.userMessage.includes('items[1].kind') &&
      error.detail.includes('nope')
  )
})

await checkAsync('W5-F mapper：expired 由 deletedAt 现算，不信任服务端字段', () => {
  const dto = TrashListDto.fromJson({
    items: [
      { kind: 'habit', id: 'habit-1', title: '早睡', deletedAt: daysAgo(2) },
      // 即使服务端多塞一个 expired:false，也只认 deletedAt。
      { kind: 'wish', id: 'wish-1', title: '滑板', deletedAt: daysAgo(120), expired: false }
    ]
  })
  const rows = mapTrash(dto, now)
  assert.deepStrictEqual(
    rows.map((row) => [row.kind, row.id, row.expired]),
    [
      ['habit', 'habit-1', false],
      ['wish', 'wish-1', true]
    ]
  )
})

// ─────────────────────── 写回包一致性（write_dto.ts / write_api.ts）───────────────────────

await checkAsync('W5-F write_dto：回包 kind / id 与请求不一致 ⇒ malformed', () => {
  assert.throws(
    () => TrashTargetDto.fromJson({ kind: 'wish', id: 'habit-1' }, '$', 'habit', 'habit-1'),
    (error) => error instanceof WriteApiException && error.kind === 'malformed'
  )
  assert.throws(
    () => TrashTargetDto.fromJson({ kind: 'habit', id: 'habit-2' }, '$', 'habit', 'habit-1'),
    (error) => error instanceof WriteApiException && error.kind === 'malformed'
  )
  const ok = TrashTargetDto.fromJson(
    { kind: 'habit', id: 'habit-1' },
    '$',
    'habit',
    'habit-1'
  )
  assert.strictEqual(ok.id, 'habit-1')
})

await checkAsync(
  'W5-F 客户端：DELETE /habits/:id 带幂等键，回包 habitId 不符 ⇒ malformed',
  async () => {
    const seen = []
    const client = new WriteApiClient({
      config,
      transport: {
        async send(uri, headers, body, timeoutMs, method) {
          seen.push({ uri, headers, body, method })
          return { statusCode: 200, body: { habitId: 'habit-1' } }
        }
      }
    })
    const id = await client.deleteHabit('habit-1', 'key-1')
    assert.strictEqual(id, 'habit-1')
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].method, 'DELETE')
    assert.ok(seen[0].uri.endsWith('/habits/habit-1'), seen[0].uri)
    assert.strictEqual(seen[0].body, null, 'DELETE 不带 body')
    assert.strictEqual(seen[0].headers['idempotency-key'], 'key-1')

    const wrong = new WriteApiClient({
      config,
      transport: {
        async send() {
          return { statusCode: 200, body: { habitId: 'habit-2' } }
        }
      }
    })
    await assert.rejects(
      () => wrong.deleteHabit('habit-1'),
      (error) =>
        error instanceof WriteApiException &&
        error.kind === 'malformed' &&
        error.detail.includes('habit-2')
    )
  }
)

await checkAsync(
  'W5-F 客户端：恢复 / 彻底删除的路径正确，未知 kind 在本地就拒（一个请求都不发）',
  async () => {
    const seen = []
    const client = new WriteApiClient({
      config,
      transport: {
        async send(uri, headers, body, timeoutMs, method) {
          seen.push({ uri, method })
          return { statusCode: 200, body: { kind: 'habit', id: 'habit-1' } }
        }
      }
    })

    await client.restoreTrashItem('habit', 'habit-1')
    await client.purgeTrashItem('habit', 'habit-1')
    assert.strictEqual(seen.length, 2)
    assert.strictEqual(seen[0].method, 'POST')
    assert.ok(seen[0].uri.endsWith('/trash/habit/habit-1/restore'), seen[0].uri)
    assert.strictEqual(seen[1].method, 'DELETE')
    assert.ok(seen[1].uri.endsWith('/trash/habit/habit-1'), seen[1].uri)

    const countBefore = seen.length
    await assert.rejects(
      () => client.purgeTrashItem('habit_v2', 'habit-1'),
      /未知回收站类型/
    )
    assert.strictEqual(seen.length, countBefore, '拼错的类型不该发请求')
  }
)

// ───────────────────────────── store：拉取（refreshTrash）─────────────────────────────

await checkAsync('W5-F store：refreshTrash 拉服务端条目，状态 ready', async () => {
  const readApi = fakeReadApi({
    trash: () => ({
      items: [
        { kind: 'point_rule', id: 'rule-1', title: '完成作业', deletedAt: daysAgo(3) },
        { kind: 'habit', id: 'habit-1', title: '早睡', deletedAt: daysAgo(120) }
      ]
    })
  })
  const store = new AppStore(readApi, fakeWriteApi())
  assert.strictEqual(store.trashItems().length, 0, '打开之前是 0，不猜数字')

  await store.refreshTrash()

  assert.strictEqual(store.trashStatus, 'ready')
  assert.strictEqual(store.trashError, null)
  assert.deepStrictEqual(
    store.trashItems().map((item) => [item.kind, item.id, item.expired]),
    [
      ['point_rule', 'rule-1', false],
      ['habit', 'habit-1', true]
    ]
  )
  assert.strictEqual(readApi.calls.trash, 1)
  assert.strictEqual(readApi.calls.home, 0, '回收站不该顺带重拉首页')
})

await checkAsync(
  'W5-F store：首页读失败（usingPreview=true）不影响回收站 —— 分支只看 readApi，不看 usingPreview',
  async () => {
    const readApi = fakeReadApi({
      home: () => {
        throw new ReadApiException('network', '连不上服务器。')
      },
      trash: () => ({
        items: [{ kind: 'habit', id: 'habit-9', title: '收拾玩具', deletedAt: daysAgo(2) }]
      })
    })
    const store = new AppStore(readApi, fakeWriteApi())

    await store.refreshFromServer()
    assert.strictEqual(store.usingPreview, true, '首页没拉成功 ⇒ usingPreview 还是 true')

    await store.refreshTrash()
    assert.deepStrictEqual(
      store.trashItems().map((item) => item.id),
      ['habit-9'],
      '回收站必须用服务端结果，不能退化成首页的本地镜像'
    )
  }
)

await checkAsync(
  'W5-F store：回收站读取失败**保留**上一次列表，只报错（清空 = 假装已彻底删掉）',
  async () => {
    const failedSource = () => {
      throw new ReadApiException('forbidden', '你没有查看回收站的权限。', {
        statusCode: 403,
        code: 'NOT_GUARDIAN'
      })
    }
    let source = () => ({
      items: [{ kind: 'wish', id: 'wish-1', title: '滑板', deletedAt: daysAgo(1) }]
    })
    const readApi = fakeReadApi({ trash: () => source() })
    const store = new AppStore(readApi, fakeWriteApi())
    await store.refreshTrash()
    assert.strictEqual(store.trashItems().length, 1)

    source = failedSource
    await store.refreshTrash()

    assert.strictEqual(store.trashStatus, 'error')
    assert.ok(
      store.trashError.userMessage.includes('没有查看回收站'),
      store.trashError.userMessage
    )
    assert.strictEqual(store.trashItems().length, 1, '失败不许清空列表')
  }
)

// ───────────────────────────── store：删除习惯（C9）─────────────────────────────

await checkAsync(
  'W5-F store：删除习惯走 DELETE /habits/:id，软删后首页不再列出（刷新失败也如此）',
  async () => {
    const readApi = fakeReadApi({ home: () => homeDto([habitJson]) })
    const writeApi = fakeWriteApi()
    const store = new AppStore(readApi, writeApi)
    await store.refreshFromServer()
    assert.strictEqual(store.habits.length, 1)

    // 让随后的刷新失败：证明本地镜像自己就把这条标成了 deleted。
    readApi.setHome(() => {
      throw new ReadApiException('network', '连不上服务器。')
    })
    const message = await store.submitRemoveHabit(store.habits[0])

    assert.strictEqual(message, null)
    assert.strictEqual(writeApi.calls.deleteHabit.length, 1)
    assert.strictEqual(writeApi.calls.deleteHabit[0].id, 'habit-1')
    assert.ok(
      writeApi.calls.deleteHabit[0].idempotencyKey.startsWith('habit-delete'),
      writeApi.calls.deleteHabit[0].idempotencyKey
    )
    assert.strictEqual(store.habits.length, 0, '软删后首页不该还列出这条')
  }
)

await checkAsync('W5-F store：live 但没写客户端 ⇒ 只读文案，习惯不动', async () => {
  const readApi = fakeReadApi({ home: () => homeDto([habitJson]) })
  const store = new AppStore(readApi, null)
  await store.refreshFromServer()
  assert.strictEqual(store.isHabitWriteReadOnly, true)
  assert.strictEqual(store.isTrashWriteReadOnly, true)

  const message = await store.submitRemoveHabit(store.habits[0])
  assert.strictEqual(message, store.habitReadOnlyWriteMessage)
  assert.strictEqual(store.habits.length, 1)

  const restore = await store.submitRestoreTrash({
    kind: 'habit',
    id: 'habit-1',
    title: '早睡',
    deletedAt: now,
    expired: false
  })
  assert.strictEqual(restore, store.trashReadOnlyWriteMessage)
})
// ───────────────────────────── store：恢复 / 彻底删除 ─────────────────────────────

await checkAsync(
  'W5-F store：恢复成功后首页与回收站都刷新（列表里不再有它）',
  async () => {
    let source = () => ({
      items: [{ kind: 'habit', id: 'habit-1', title: '早睡', deletedAt: daysAgo(1) }]
    })
    const readApi = fakeReadApi({ trash: () => source(), home: () => homeDto([]) })
    const writeApi = fakeWriteApi()
    const store = new AppStore(readApi, writeApi)
    await store.refreshTrash()
    assert.strictEqual(store.trashItems().length, 1)

    source = () => ({ items: [] })
    const message = await store.submitRestoreTrash(store.trashItems()[0])

    assert.strictEqual(message, null)
    assert.deepStrictEqual(writeApi.calls.restoreTrashItem, [
      { kind: 'habit', id: 'habit-1' }
    ])
    assert.ok(readApi.calls.home >= 1, '恢复要重拉首页（可见集合变了）')
    assert.strictEqual(store.trashItems().length, 0)
  }
)

await checkAsync(
  'W5-F store：恢复被服务端拒绝时原样返回原因，列表不动',
  async () => {
    const readApi = fakeReadApi({
      trash: () => ({
        items: [{ kind: 'wish', id: 'wish-1', title: '滑板', deletedAt: daysAgo(1) }]
      })
    })
    const writeApi = fakeWriteApi({
      restoreTrashItem: () => {
        throw new WriteApiException(
          'conflict',
          '它所属的规则还在回收站里，请先恢复规则。',
          { statusCode: 409, code: 'TRASH_PARENT_RULE_DELETED' }
        )
      }
    })
    const store = new AppStore(readApi, writeApi)
    await store.refreshTrash()

    const message = await store.submitRestoreTrash(store.trashItems()[0])

    assert.ok(message.includes('先恢复规则'), message)
    assert.strictEqual(store.trashItems().length, 1, '失败不能把条目从列表抹掉')
  }
)

await checkAsync('W5-F store：彻底删除成功后本地立刻少一条', async () => {
  let source = () => ({
    items: [
      { kind: 'point_rule', id: 'rule-1', title: '完成作业', deletedAt: daysAgo(1) },
      { kind: 'habit', id: 'habit-1', title: '早睡', deletedAt: daysAgo(2) }
    ]
  })
  const readApi = fakeReadApi({ trash: () => source() })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshTrash()

  source = () => ({
    items: [{ kind: 'habit', id: 'habit-1', title: '早睡', deletedAt: daysAgo(2) }]
  })
  const target = store.trashItems().find((item) => item.kind === 'point_rule')
  const message = await store.submitPurgeTrash(target)

  assert.strictEqual(message, null)
  assert.deepStrictEqual(writeApi.calls.purgeTrashItem, [
    { kind: 'point_rule', id: 'rule-1' }
  ])
  assert.deepStrictEqual(
    store.trashItems().map((item) => item.id),
    ['habit-1']
  )
})

// ───────────────────────────── store：批量清理已过期 ─────────────────────────────

await checkAsync(
  'W5-F store：清理已过期是逐条调的，部分失败要如实报 purged / failed',
  async () => {
    let source = () => ({
      items: [
        { kind: 'point_rule', id: 'rule-1', title: '完成作业', deletedAt: daysAgo(120) },
        { kind: 'wish', id: 'wish-1', title: '滑板', deletedAt: daysAgo(100) },
        // 未过期：不该被这次批量碰到。
        { kind: 'habit', id: 'habit-1', title: '早睡', deletedAt: daysAgo(3) }
      ]
    })
    const readApi = fakeReadApi({ trash: () => source() })
    const writeApi = fakeWriteApi({
      purgeTrashItem: (kind, id) => {
        if (id === 'wish-1') {
          throw new WriteApiException(
            'conflict',
            '这条心愿还有流水引用，不能彻底删除。',
            { statusCode: 409, code: 'TRASH_IN_USE' }
          )
        }
        return new TrashTargetDto(kind, id)
      }
    })
    const store = new AppStore(readApi, writeApi)
    await store.refreshTrash()

    source = () => ({
      items: [
        { kind: 'wish', id: 'wish-1', title: '滑板', deletedAt: daysAgo(100) },
        { kind: 'habit', id: 'habit-1', title: '早睡', deletedAt: daysAgo(3) }
      ]
    })
    const outcome = await store.submitPurgeExpiredTrash()

    assert.strictEqual(outcome.purged, 1)
    assert.strictEqual(outcome.failed, 1)
    assert.ok(outcome.error.includes('流水引用'), outcome.error)
    assert.deepStrictEqual(
      writeApi.calls.purgeTrashItem.map((call) => call.id).sort(),
      ['rule-1', 'wish-1'],
      '只碰已过期的两条'
    )
    const text = trashPurgeOutcomeText(outcome)
    assert.ok(text.includes('已清理 1 条') && text.includes('1 条没清掉'), text)
  }
)

await checkAsync('W5-F store：没有过期条目时不发任何请求', async () => {
  const readApi = fakeReadApi({
    trash: () => ({
      items: [{ kind: 'wish', id: 'wish-1', title: '滑板', deletedAt: daysAgo(3) }]
    })
  })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshTrash()

  const outcome = await store.submitPurgeExpiredTrash()

  assert.deepStrictEqual(outcome, { purged: 0, failed: 0, error: null })
  assert.strictEqual(writeApi.calls.purgeTrashItem.length, 0)
})

// ───────────────────────────── 预览模式（本地列表）─────────────────────────────

await checkAsync(
  'W5-F store：预览模式回收站仍来自本地列表，恢复 / 彻底删除照旧可用',
  async () => {
    const store = new AppStore(null, null)
    store.profile.name = '小明'
    const habit = {
      id: 'habit-local',
      title: '收拾玩具',
      points: 2,
      condition: '每天一次',
      dailyLimit: 1,
      icon: 'star',
      color: '#7fbf55',
      ruleId: null,
      status: 'active',
      deletedAt: null
    }
    store.habitList.push(habit)
    store.removeHabit(habit)
    assert.strictEqual(store.trashItems().length, 1)

    await store.refreshTrash()
    assert.strictEqual(store.trashStatus, 'idle', '预览模式没有可拉的东西，状态不动')

    assert.strictEqual(await store.submitRestoreTrash(store.trashItems()[0]), null)
    assert.strictEqual(store.trashItems().length, 0)
    assert.strictEqual(store.habits.length, 1)

    store.removeHabit(store.habits[0])
    assert.strictEqual(await store.submitPurgeTrash(store.trashItems()[0]), null)
    assert.strictEqual(store.trashItems().length, 0)
  }
)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1



/**
 * W7-C 家庭数据导出（`GET /export`）的**异步**运行时用例。
 *
 * 结构照抄 `run-w7b.mjs`（CommonJS 没有顶层 await，D12 守卫不允许把汇总
 * 塞进回调）：顶层 await → 顶层汇总 → 顶层退出码。
 *
 * 与 W7-B 的一处不同：这一轮**真的**构造 `ReadApiClient` 并注入假的传输层，
 * 而不是塞一个 duck-typed 假客户端 —— `fetchExport` 的唯一特别之处就是
 * 「同时保留响应原文」，不经过真解析器就测不到 `rawJson` 逐字这件事。
 *
 * 编译（项目约定）：
 *   npx tsc -p .tmp_test/tsconfig.test.json   # rootDir ../src → 产物落在 .tmp_test/dist
 *   node .tmp_test/run-w7c.mjs
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 纯 Node 无法 require 真实的 `@tarojs/taro`，与其它脚本同款壳。 */
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

const { AppStore, demoResetAllowed } = require('./dist/data/store.js')
const { ReadApiClient, ReadApiConfig } = require('./dist/data/read_api.js')
const { FamilyExportDto } = require('./dist/data/read_dto.js')
const { mapFamilyExport } = require('./dist/data/read_mapper.js')
const { ReadApiException } = require('./dist/data/read_api_errors.js')

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

const EXPORT_GENERATED_AT = '2026-10-27T09:00:00.000Z'

// ────────────────────────────────────── 夹具 ──────────────────────────────────────

/**
 * 一份导出文件的线值（九段齐全）。正文段刻意只留最小元素 ——
 * 客户端**不该**解析它们，所以我们也不需要造得像真数据。
 */
function exportJson(overrides = {}) {
  const base = {
    schemaVersion: 1,
    generator: 'kids-points-api',
    generatedAt: EXPORT_GENERATED_AT,
    child: { id: 'child-1', name: '小明', pointsBalance: 42 },
    summary: {
      counts: {
        members: 2,
        rules: 1,
        ruleVersions: 1,
        habits: 1,
        wishes: 0,
        records: 3,
        approvals: 0,
        consents: 1,
        auditLogs: 2
      },
      totals: { records: 3, approvals: 0, auditLogs: 2 },
      truncated: false,
      truncatedSections: []
    },
    members: [{ memberId: 'm1' }],
    rules: [{ id: 'rule-1' }],
    ruleVersions: [{ id: 'rv-1' }],
    habits: [{ id: 'h-1' }],
    wishes: [],
    records: [{ id: 'r-1' }, { id: 'r-2' }, { id: 'r-3' }],
    approvals: [],
    consents: [{ id: 'c-1' }],
    auditLogs: [{ id: 'a-1' }, { id: 'a-2' }]
  }
  return { ...base, ...overrides }
}

/**
 * 假传输层：`next` 可随时替换，`calls` 记下每次请求（断言请求次数 / 头 / URI）。
 * 传 `Error` 实例表示「连不上」，用来验网络错误的归一。
 */
function transportWith(next) {
  const calls = []
  let current = next
  return {
    calls,
    set(nextValue) {
      current = nextValue
    },
    async send(uri, headers, timeoutMs) {
      calls.push({ uri, headers, timeoutMs })
      if (current instanceof Error) throw current
      return current
    }
  }
}

function clientWith(transport) {
  return new ReadApiClient({ config, transport })
}

/** 读客户端：只实现导出（store 的 `loadExport` 只调这一个方法）。 */
function fakeReadApi(initial) {
  const calls = { export: 0 }
  let source = initial
  return {
    calls,
    setSource(next) {
      source = next
    },
    async fetchExport() {
      calls.export += 1
      // 返回值可以是 DTO，也可以是 Promise（用于验证单飞时的在途窗口）。
      return typeof source === 'function' ? source() : source
    }
  }
}

function dtoFrom(json = exportJson()) {
  return FamilyExportDto.fromJson(json, JSON.stringify(json))
}

function expectReadMalformed(fn, fragment) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof ReadApiException, '应抛 ReadApiException，实际：' + error)
    assert.strictEqual(error.kind, 'malformed', 'kind 必须是 malformed')
    assert.ok(
      (error.detail ?? '').includes(fragment),
      `detail 应含「${fragment}」，实际：${error.detail}`
    )
    return error
  }

  throw new Error('必须抛 malformed，实际没有抛')
}

// ────────────────────────────────── ① DTO：形状与自洽 ──────────────────────────────────

await checkAsync('W7-C DTO：九段摘要逐字段落地，正文段不进模型', () => {
  const json = exportJson()
  const text = JSON.stringify(json)
  const dto = FamilyExportDto.fromJson(json, text)

  assert.strictEqual(dto.rawJson, text, 'rawJson 必须是服务端原文')
  assert.strictEqual(dto.schemaVersion, 1)
  assert.strictEqual(dto.generator, 'kids-points-api')
  assert.strictEqual(dto.generatedAt, Date.parse(EXPORT_GENERATED_AT), 'ISO 时间要换成毫秒')
  assert.strictEqual(dto.childId, 'child-1')
  assert.strictEqual(dto.childName, '小明')
  assert.strictEqual(dto.pointsBalance, 42)
  assert.deepStrictEqual(Object.keys(dto.counts).sort(), [
    'approvals',
    'auditLogs',
    'consents',
    'habits',
    'members',
    'records',
    'ruleVersions',
    'rules',
    'wishes'
  ])
  assert.strictEqual(dto.counts.records, 3)
  assert.strictEqual(dto.totals.records, 3)
  assert.strictEqual(dto.truncated, false)
  assert.deepStrictEqual(dto.truncatedSections, [])
})

await checkAsync('W7-C DTO：截断标记与截断段必须自洽（两个方向都要拦）', () => {
  const inconsistent = (truncated, sections) =>
    exportJson({
      summary: { ...exportJson().summary, truncated, truncatedSections: sections }
    })

  expectReadMalformed(
    () => FamilyExportDto.fromJson(inconsistent(false, ['records']), '{}'),
    'truncatedSections'
  )
  expectReadMalformed(
    () => FamilyExportDto.fromJson(inconsistent(true, []), '{}'),
    'truncated'
  )
})

await checkAsync('W7-C 映射：不重算 counts（服务端说 99 就是 99，客户端不拿正文数一遍）', () => {
  const json = exportJson({
    summary: {
      ...exportJson().summary,
      counts: { ...exportJson().summary.counts, records: 99 }
    }
  })
  const model = mapFamilyExport(FamilyExportDto.fromJson(json, JSON.stringify(json)))

  assert.strictEqual(model.counts.records, 99, '重算等于用客户端猜测覆盖服务端事实')
  assert.strictEqual(model.rawJson, JSON.stringify(json))
  assert.deepStrictEqual(Object.keys(model).sort(), [
    'childId',
    'childName',
    'counts',
    'generatedAt',
    'generator',
    'pointsBalance',
    'rawJson',
    'schemaVersion',
    'totals',
    'truncated',
    'truncatedSections'
  ])
})

// ────────────────────────────────── ② 真 ReadApiClient ──────────────────────────────────

await checkAsync('W7-C 客户端：GET /export，带设备与孩子头，rawJson 逐字等于响应原文', async () => {
  const text = JSON.stringify(exportJson())
  const transport = transportWith({ statusCode: 200, body: text })
  const dto = await clientWith(transport).fetchExport()

  assert.strictEqual(transport.calls.length, 1)
  assert.strictEqual(transport.calls[0].uri, 'http://127.0.0.1:3000/export')
  assert.strictEqual(transport.calls[0].headers['x-kp-device-id'], 'device-1')
  assert.strictEqual(transport.calls[0].headers['x-kp-child-id'], 'child-1')
  assert.strictEqual(dto.rawJson, text, '复制出去必须是这份原文，不是重新序列化的近似物')
})

await checkAsync('W7-C 客户端：传输层已把 body 解析成对象时，rawJson 诚实退化为 stringify', async () => {
  const json = exportJson()
  const dto = await clientWith(transportWith({ statusCode: 200, body: json })).fetchExport()

  assert.strictEqual(dto.rawJson, JSON.stringify(json), '对象分支只能退化，不能假装逐字相同')
  assert.strictEqual(dto.childName, '小明')
})

await checkAsync('W7-C 客户端：403 / 501 / 网络错误各自归一（不画成「没有数据」）', async () => {
  const forbidden = clientWith(
    transportWith({ statusCode: 403, body: { code: 'FORBIDDEN', message: 'denied' } })
  )
  let caught = null
  try {
    await forbidden.fetchExport()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ReadApiException, '应抛 ReadApiException')
  assert.strictEqual(caught.kind, 'forbidden')
  assert.strictEqual(caught.code, 'FORBIDDEN')

  caught = null
  try {
    await clientWith(transportWith({ statusCode: 501, body: {} })).fetchExport()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ReadApiException)
  assert.strictEqual(caught.kind, 'notImplemented', '501 是「服务端没库」，不是「没有记录」')

  caught = null
  try {
    await clientWith(transportWith(new Error('ECONNREFUSED'))).fetchExport()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof ReadApiException)
  assert.strictEqual(caught.kind, 'network')
})


// ────────────────────────────────── ③ store.loadExport ──────────────────────────────────

await checkAsync('W7-C store：成功后 status=ready，文件来自服务端（不是本地预览）', async () => {
  const readApi = fakeReadApi(() => dtoFrom())
  const store = new AppStore(readApi, null)
  await store.loadExport()

  assert.strictEqual(store.exportReadStatus, 'ready')
  assert.strictEqual(store.exportError, null)
  assert.strictEqual(store.isExportBusy, false)
  assert.ok(store.familyExport !== null)
  assert.strictEqual(store.familyExport.childName, '小明')
  assert.strictEqual(store.familyExport.counts.records, 3)
  assert.strictEqual(readApi.calls.export, 1)
})

await checkAsync('W7-C store：单飞 —— 在途期间连点只发一次请求', async () => {
  let release = null
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const readApi = fakeReadApi(async () => {
    await gate
    return dtoFrom()
  })
  const store = new AppStore(readApi, null)

  const first = store.loadExport()
  const second = store.loadExport() // 在途时再点：必须直接返回
  assert.strictEqual(store.isExportBusy, true, '在途期间要显示忙碌，别让用户以为没反应')
  release()
  await Promise.all([first, second])

  assert.strictEqual(readApi.calls.export, 1, '在途期间的第二次点击不该产生请求')
  assert.strictEqual(store.exportReadStatus, 'ready')
  assert.strictEqual(store.isExportBusy, false)
})

await checkAsync('W7-C store：刷新失败 ⇒ 报错但**保留**上一次的文件', async () => {
  const readApi = fakeReadApi(() => dtoFrom())
  const store = new AppStore(readApi, null)
  await store.loadExport()
  const firstFile = store.familyExport.rawJson

  readApi.setSource(() => {
    throw ReadApiException.fromHttp({ statusCode: 500, body: { code: 'BOOM' } })
  })
  await store.loadExport()

  assert.strictEqual(store.exportReadStatus, 'error')
  assert.ok(store.exportError !== null)
  assert.strictEqual(store.exportError.kind, 'server')
  assert.strictEqual(store.isExportBusy, false)
  assert.ok(store.familyExport !== null, '刚导出过的文件不该突然消失')
  assert.strictEqual(store.familyExport.rawJson, firstFile, '保留的必须是那份原文')
})

await checkAsync('W7-C store：坏文件（截断字段自洽失败）也算失败，且不覆盖旧文件', async () => {
  const readApi = fakeReadApi(() => dtoFrom())
  const store = new AppStore(readApi, null)
  await store.loadExport()
  const firstFile = store.familyExport.rawJson

  readApi.setSource(() =>
    dtoFrom({
      ...exportJson(),
      summary: { ...exportJson().summary, truncatedSections: ['records'] }
    })
  )
  await store.loadExport()

  assert.strictEqual(store.exportReadStatus, 'error')
  assert.strictEqual(store.exportError.kind, 'malformed')
  assert.strictEqual(store.familyExport.rawJson, firstFile)
})

await checkAsync('W7-C store：预览模式不发请求，直接 ready 空态（不编假文件）', async () => {
  const store = new AppStore(null, null)
  await store.loadExport()

  assert.strictEqual(store.exportReadStatus, 'ready')
  assert.strictEqual(store.familyExport, null, '预览模式没有服务端文件')
  assert.strictEqual(store.exportError, null)
  assert.strictEqual(store.isExportBusy, false)
})

await checkAsync('W7-C store：演示重置会清空导出缓存（否则新账号能看到上一个家庭）', async () => {
  assert.strictEqual(demoResetAllowed(''), true, '本脚本跑在非生产环境')

  const readApi = fakeReadApi(() => dtoFrom())
  const store = new AppStore(readApi, null)
  await store.loadExport()
  assert.ok(store.familyExport !== null)

  assert.strictEqual(store.resetToSeed(), true)
  assert.strictEqual(store.familyExport, null, '切账号 / 重置后不许留着上一个家庭的文件')
  assert.strictEqual(store.exportReadStatus, 'idle')
  assert.strictEqual(store.exportError, null)
})

// ────────────────────────────────────── 汇总 ──────────────────────────────────────

console.log('')
if (failed === 0) {
  console.log('W7-C 全部用例通过')
  process.exitCode = 0
} else {
  console.log(`W7-C 有 ${failed} 条用例失败`)
  process.exitCode = 1
}


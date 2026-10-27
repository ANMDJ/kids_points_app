/**
 * W7-D 家庭数据删除的**异步**运行时用例（小程序端）。
 *
 * 结构照抄 `run-w7c.mjs`：顶层 await → 顶层汇总 → 顶层退出码（D12 守卫）。
 *
 * 这一轮同时经过**真** `ReadApiClient` / `WriteApiClient`（注入假传输层）：
 * 删除的两个关键契约（GET 的严格形状、POST 的 `{confirmed:true}`）都不在
 * DTO 里，而在「客户端到底发了什么」这一层 —— 用 duck-typed 假客户端测不到。
 *
 * 编译：npx tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w7d.mjs
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

const { AppStore } = require('./dist/data/store.js')
const { ReadApiClient, ReadApiConfig } = require('./dist/data/read_api.js')
const { WriteApiClient } = require('./dist/data/write_api.js')
const { FamilyDeletionStateDto } = require('./dist/data/read_dto.js')
const { mapFamilyDeletion } = require('./dist/data/read_mapper.js')
const {
  deletionDeadlineText,
  deletionKeptText,
  deletionRemainingText,
  deletionStatusLabel,
  deletionSummaryRows
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

const config = new ReadApiConfig('http://127.0.0.1:3000/', 'device-1', 'child-1')

/** 执行摘要线值（十类行数齐全）。 */
function summaryJson(overrides = {}) {
  return {
    coolingDays: 7,
    redacted: {
      child: 1,
      members: 2,
      rules: 1,
      ruleVersions: 1,
      habits: 1,
      wishes: 1,
      records: 4,
      approvals: 1,
      consents: 1,
      notifications: 2,
      ...overrides
    },
    kept: { records: 4, pointsBalance: 7 },
    note: '账本流水与余额按 02 §5.7 I5 保留；描述性文本与身份痕迹已匿名化。'
  }
}

function deletionJson({
  status = 'none',
  canCancel = false,
  daysRemaining = null,
  withSummary = false,
  withRequest = false
} = {}) {
  const hasRequest = withRequest || status !== 'none'
  return {
    childId: 'child-1',
    status,
    requestedAt: hasRequest ? '2026-10-27T01:00:00.000Z' : null,
    scheduledFor: hasRequest ? '2026-11-03T01:00:00.000Z' : null,
    cancelledAt: status === 'cancelled' ? '2026-10-28T01:00:00.000Z' : null,
    executedAt: status === 'executed' ? '2026-11-03T01:00:00.000Z' : null,
    daysRemaining,
    canCancel,
    summary: withSummary ? summaryJson() : null
  }
}

// ────────────────────────────────────── DTO ──────────────────────────────────────

await checkAsync('DTO pending：带剩余天数 / 可撤销，解析成同形对象', () => {
  const dto = FamilyDeletionStateDto.fromJson(
    deletionJson({ status: 'pending', canCancel: true, daysRemaining: 7 })
  )
  assert.strictEqual(dto.status, 'pending')
  assert.strictEqual(dto.daysRemaining, 7)
  assert.strictEqual(dto.canCancel, true)
  assert.strictEqual(dto.summary, null)
})

await checkAsync('DTO pending 缺 daysRemaining ⇒ malformed（客户端不按本地时钟猜）', () => {
  assert.throws(
    () =>
      FamilyDeletionStateDto.fromJson(
        deletionJson({ status: 'pending', canCancel: true })
      ),
    /daysRemaining/
  )
})

await checkAsync('DTO pending 但 canCancel=false ⇒ malformed', () => {
  assert.throws(
    () =>
      FamilyDeletionStateDto.fromJson(
        deletionJson({ status: 'pending', daysRemaining: 7 })
      ),
    /canCancel/
  )
})

await checkAsync('DTO executed 缺 summary ⇒ malformed（删了什么无从回答）', () => {
  assert.throws(
    () => FamilyDeletionStateDto.fromJson(deletionJson({ status: 'executed' })),
    /executedAt|摘要/
  )
})

await checkAsync('DTO unknown status ⇒ malformed（绝不默认成 none）', () => {
  assert.throws(
    () => FamilyDeletionStateDto.fromJson(deletionJson({ status: 'deleting' })),
    /未知删除状态/
  )
})

await checkAsync('DTO 摘要缺一类行数 ⇒ malformed', () => {
  const json = deletionJson({ status: 'executed', withSummary: true })
  delete json.summary.redacted.records
  assert.throws(() => FamilyDeletionStateDto.fromJson(json), /records|摘要/)
})

// ────────────────────────────────────── 映射 / 文案 ──────────────────────────────────────

await checkAsync('map：pending 的截止日与剩余天数来自服务端', () => {
  const deletion = mapFamilyDeletion(
    FamilyDeletionStateDto.fromJson(
      deletionJson({ status: 'pending', canCancel: true, daysRemaining: 6 })
    )
  )
  assert.strictEqual(deletion.status, 'pending')
  assert.match(deletionDeadlineText(deletion), /^将于 \d{4}-\d{2}-\d{2} 删除$/)
  assert.strictEqual(deletionRemainingText(deletion), '还有 6 天可以撤销')
  assert.strictEqual(deletionStatusLabel(deletion), '已申请删除')
})

await checkAsync('map：剩余 0 天说「即将执行」，不是「已删除」', () => {
  const deletion = mapFamilyDeletion(
    FamilyDeletionStateDto.fromJson(
      deletionJson({ status: 'pending', canCancel: true, daysRemaining: 0 })
    )
  )
  assert.strictEqual(deletionRemainingText(deletion), '即将执行（等待后台任务）')
})

await checkAsync('map：executed 摘要只列出真的动过的行；账本条数原样', () => {
  const deletion = mapFamilyDeletion(
    FamilyDeletionStateDto.fromJson(
      deletionJson({ status: 'executed', withSummary: true })
    )
  )
  assert.strictEqual(deletionStatusLabel(deletion), '已删除')
  assert.match(deletionDeadlineText(deletion), /^已于 /)
  const rows = deletionSummaryRows(deletion.summary)
  assert.strictEqual(rows.length, 10)
  assert.strictEqual(rows[0].key, 'child')
  assert.strictEqual(rows[0].label, '孩子档案')
  assert.strictEqual(deletionKeptText(deletion.summary), '保留 4 条流水与余额 7 分')
})

await checkAsync('map：全 0 的摘要不画一排 0', () => {
  const json = deletionJson({ status: 'executed', withSummary: true })
  json.summary.redacted = {
    child: 0,
    members: 0,
    rules: 0,
    ruleVersions: 0,
    habits: 0,
    wishes: 0,
    records: 0,
    approvals: 0,
    consents: 0,
    notifications: 0
  }
  const deletion = mapFamilyDeletion(FamilyDeletionStateDto.fromJson(json))
  assert.strictEqual(deletionSummaryRows(deletion.summary).length, 0)
})


// ────────────────────────────────────── 真客户端 + 假传输 ──────────────────────────────────────

class FakeReadTransport {
  constructor() {
    this.calls = []
    this.status = 200
    this.result = deletionJson({
      status: 'pending',
      canCancel: true,
      daysRemaining: 7
    })
  }

  async send(uri, headers, timeoutMs) {
    this.calls.push({ uri, headers, timeoutMs })
    return { statusCode: this.status, body: this.result }
  }
}

class FakeWriteTransport {
  constructor(result) {
    this.calls = []
    this.status = 200
    this.result = result
  }

  async send(uri, headers, body, timeoutMs, method) {
    this.calls.push({ uri, body, method, headers, timeoutMs })
    return { statusCode: this.status, body: this.result }
  }
}

function liveStore(readTransport, writeTransport) {
  const readApi = new ReadApiClient({
    config,
    transport: readTransport ?? new FakeReadTransport()
  })
  const writeApi = writeTransport
    ? new WriteApiClient({ config, transport: writeTransport })
    : null
  return new AppStore(readApi, writeApi)
}

await checkAsync('读：GET /family-deletion（无 query，身份只在头里）', async () => {
  const transport = new FakeReadTransport()
  const store = liveStore(transport)
  await store.loadFamilyDeletion()

  assert.strictEqual(transport.calls.length, 1)
  assert.ok(transport.calls[0].uri.endsWith('/family-deletion'))
  assert.strictEqual(transport.calls[0].headers['x-kp-device-id'], 'device-1')
  assert.strictEqual(transport.calls[0].headers['x-kp-child-id'], 'child-1')
  assert.strictEqual(store.deletionStatus, 'ready')
  assert.strictEqual(store.familyDeletion.status, 'pending')
  assert.strictEqual(store.familyDeletion.daysRemaining, 7)
})

await checkAsync('读：403 照实报错，且**不清空**上一次的状态', async () => {
  const transport = new FakeReadTransport()
  const store = liveStore(transport)
  await store.loadFamilyDeletion()
  const before = store.familyDeletion.scheduledFor

  transport.status = 403
  transport.result = { code: 'FORBIDDEN', message: '缺少 view_family_deletion' }
  await store.loadFamilyDeletion()

  assert.strictEqual(store.deletionStatus, 'error')
  assert.strictEqual(store.deletionError.statusCode, 403)
  assert.strictEqual(
    store.familyDeletion.scheduledFor,
    before,
    '失败不能把「将于 X 日删除」说成「从未申请」'
  )
})

await checkAsync('写：申请只发 {"confirmed":true}，成功后状态变 pending', async () => {
  const write = new FakeWriteTransport(
    deletionJson({ status: 'pending', canCancel: true, daysRemaining: 7 })
  )
  const store = liveStore(null, write)
  const error = await store.submitRequestFamilyDeletion()

  assert.strictEqual(error, null)
  assert.strictEqual(write.calls.length, 1)
  assert.strictEqual(write.calls[0].method, 'POST')
  assert.ok(write.calls[0].uri.endsWith('/family-deletion'))
  assert.deepStrictEqual(write.calls[0].body, { confirmed: true })
  assert.strictEqual(store.familyDeletion.status, 'pending')
  assert.strictEqual(store.deletionBusy, false)
})

await checkAsync('写：申请回包不是 pending ⇒ 报「不符合约定」，不显示成已申请', async () => {
  const write = new FakeWriteTransport(deletionJson({ status: 'none' }))
  const store = liveStore(null, write)
  const error = await store.submitRequestFamilyDeletion()

  assert.ok(error !== null)
  assert.match(error, /不符合约定/)
  assert.strictEqual(store.familyDeletion, null)
})

await checkAsync('写：撤销不带 body，成功后状态变 cancelled', async () => {
  const write = new FakeWriteTransport(deletionJson({ status: 'cancelled' }))
  const store = liveStore(null, write)
  const error = await store.submitCancelFamilyDeletion()

  assert.strictEqual(error, null)
  assert.ok(write.calls[0].uri.endsWith('/family-deletion/cancel'))
  assert.strictEqual(write.calls[0].body, null)
  assert.strictEqual(store.familyDeletion.status, 'cancelled')
})

await checkAsync('预览模式不发请求（也就不会假装删了）', async () => {
  const store = new AppStore(null, null)
  const error = await store.submitRequestFamilyDeletion()
  assert.match(error, /预览模式/)
})

await checkAsync('演示重置会清空删除状态（否则新账号会看到上一个家庭的删除计划）', async () => {
  const transport = new FakeReadTransport()
  const store = liveStore(transport)
  await store.loadFamilyDeletion()
  assert.ok(store.familyDeletion !== null)

  assert.strictEqual(store.resetToSeed(), true)
  assert.strictEqual(store.familyDeletion, null)
  assert.strictEqual(store.deletionStatus, 'idle')
  assert.strictEqual(store.deletionError, null)
})

// ────────────────────────────────────── 汇总 ──────────────────────────────────────

console.log('')
if (failed === 0) {
  console.log('W7-D 全部用例通过')
  process.exitCode = 0
} else {
  console.log(`W7-D 有 ${failed} 条用例失败`)
  process.exitCode = 1
}


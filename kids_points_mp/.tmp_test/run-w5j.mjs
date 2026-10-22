/**
 * W5-J「我的申请 + 撤回」的运行时用例（小程序侧）。
 *
 * 结构照抄 `run-w5i.mjs`（ESM + 顶层 await + 顶层汇总）：
 *   npx tsc -p .tmp_test/tsconfig.test.json
 *   node .tmp_test/run-w5j.mjs
 *
 * 覆盖三层：
 *   ① 模型：`canWithdrawApproval` 不看 payload，过期 / 已终态不能再撤回；
 *   ② 读：`/approvals/mine` 与收件箱各自分页，绝不写全局收件箱状态；
 *   ③ 写：撤回没有请求体、被 403 `NOT_REQUESTER` / 409 拒绝时如实展示。
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
const { ApprovalsPageDto } = require('./dist/data/read_dto.js')
const { mapApprovalsPage } = require('./dist/data/read_mapper.js')
const {
  approvalWithdrawConfirmText,
  canWithdrawApproval,
  isApprovalPending
} = require('./dist/data/approval.js')
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

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

function approvalJson(overrides = {}) {
  const now = Date.now()
  return Object.assign(
    {
      id: 'approval-1',
      action: 'redeem',
      status: 'pending',
      requesterUserId: 'member-1',
      decidedByUserId: null,
      executedRecordId: null,
      autoReason: null,
      createdAt: new Date(now - 2 * MINUTE).toISOString(),
      decidedAt: null,
      expiresAt: new Date(now + 12 * HOUR).toISOString(),
      summary: { kind: 'redeem', wishId: 'wish-1', title: '乐高', cost: 100 }
    },
    overrides
  )
}

function pageDto(items = [approvalJson()], overrides = {}) {
  return ApprovalsPageDto.fromJson({
    items,
    hasMore: false,
    nextCursor: null,
    ...overrides
  })
}

function emptyPage() {
  return { items: [], hasMore: false, nextCursor: null }
}

const config = new ReadApiConfig(
  'http://127.0.0.1:3000/',
  'device-1',
  'child-1'
)

function fakeReadApi(input = {}) {
  const calls = { approvals: [], mine: [] }
  return {
    calls,
    async fetchApprovals(query) {
      calls.approvals.push(query)
      return pageDto()
    },
    async fetchMyApprovals(query) {
      calls.mine.push(query)
      if (input.mine) return input.mine(query)
      return pageDto([approvalJson({ id: 'mine-1' })])
    }
  }
}

function fakeWriteApi(input = {}) {
  const calls = { withdrawApproval: [] }
  return {
    calls,
    async withdrawApproval(id, key) {
      calls.withdrawApproval.push({ id, key })
      if (input.withdrawApproval) return input.withdrawApproval(id, key)
      return approvalJson({ id, status: 'withdrawn', decidedAt: new Date().toISOString() })
    }
  }
}

function liveStore(input = {}) {
  const readApi = fakeReadApi(input)
  const writeApi = fakeWriteApi(input)
  return { store: new AppStore(readApi, writeApi), readApi, writeApi }
}


// ───────────────────────────── ① 模型：谁能撤回、撤回说什么 ─────────────────────────────

await checkAsync('W5-J 模型：坏 payload 的待处理申请仍然可以撤回（否则永久卡住）', async () => {
  const item = mapApprovalsPage(
    pageDto([approvalJson({ summary: { kind: 'future_thing' } })])
  ).items[0]
  assert.strictEqual(item.summary, null)
  assert.strictEqual(isApprovalPending(item), true)
  assert.strictEqual(
    canWithdrawApproval(item, Date.now()),
    true,
    '撤回不读 payload：申请人有权收回自己提交的东西'
  )
  assert.ok(approvalWithdrawConfirmText(item).includes('不会再被批准'))
})

await checkAsync('W5-J 模型：已终态 / 已过期都不能撤回', async () => {
  const now = Date.now()
  const approved = mapApprovalsPage(
    pageDto([approvalJson({ status: 'approved' })])
  ).items[0]
  assert.strictEqual(canWithdrawApproval(approved, now), false)

  const expired = mapApprovalsPage(
    pageDto([
      approvalJson({ expiresAt: new Date(now - MINUTE).toISOString() })
    ])
  ).items[0]
  assert.strictEqual(canWithdrawApproval(expired, now), false)
  assert.strictEqual(
    canWithdrawApproval(expired, now - 2 * HOUR),
    true,
    '同一行在过期前是能撤回的 —— 判断按传入时刻算，不缓存布尔值'
  )
})

await checkAsync('W5-J 模型：撤回确认文案说清代价（不会扣分 / 不会加心愿）', () => {
  const redeem = mapApprovalsPage(pageDto()).items[0]
  const text = approvalWithdrawConfirmText(redeem)
  assert.ok(text.includes('兑换「乐高」的申请'), text)
  assert.ok(text.includes('积分与心愿都不会变化'), text)
})

// ───────────────────────────── ② 读：mine 与收件箱互相独立 ─────────────────────────────

await checkAsync('W5-J 读：GET /approvals/mine 带上 limit / cursor，且不写收件箱状态', async () => {
  const { store, readApi } = liveStore()
  const before = store.approvals.length
  const page = await store.fetchMyApprovals({ cursor: 'cursor-2', limit: 5 })

  assert.deepStrictEqual(readApi.calls.mine, [
    { status: null, limit: 5, cursor: 'cursor-2' }
  ])
  assert.strictEqual(page.items[0].id, 'mine-1')
  assert.strictEqual(store.approvals.length, before)
  assert.strictEqual(
    store.approvalStatus,
    'idle',
    '我的申请读完不该把家长收件箱从 idle 推到 ready'
  )
  assert.deepStrictEqual(readApi.calls.approvals, [], '更不能顺手拉收件箱')
})

await checkAsync('W5-J 读：预览模式返回空页（不编假申请，也不报错）', async () => {
  const store = new AppStore(null, null)
  assert.strictEqual(store.isLiveMode, false)
  const page = await store.fetchMyApprovals()
  assert.deepStrictEqual(page, emptyPage())
})

await checkAsync('W5-J 读：ReadApiClient 走 /approvals/mine（不是收件箱）且拒绝越界 limit', async () => {
  const seen = []
  const client = new ReadApiClient({
    config,
    transport: {
      async send(uri) {
        seen.push(uri)
        return {
          statusCode: 200,
          body: { items: [], hasMore: false, nextCursor: null }
        }
      }
    }
  })

  await client.fetchMyApprovals({ limit: 5, cursor: 'abc' })
  assert.ok(seen[0].includes('/approvals/mine?'), seen[0])
  assert.ok(seen[0].includes('limit=5'), seen[0])
  assert.ok(seen[0].includes('cursor=abc'), seen[0])

  await assert.rejects(
    () => client.fetchMyApprovals({ limit: 101 }),
    (error) =>
      error.kind === 'malformed' && String(error.detail).includes('1–100')
  )
  assert.strictEqual(seen.length, 1, '越界 limit 不该发出去')
})

// ───────────────────────────── ③ 写：撤回的契约与失败语义 ─────────────────────────────

await checkAsync('W5-J 写：撤回是 POST /approvals/:id/withdraw，无请求体，带幂等键', async () => {
  const seen = []
  const client = new WriteApiClient({
    config,
    transport: {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, headers, body, timeoutMs, method })
        return { statusCode: 200, body: approvalJson({ status: 'withdrawn' }) }
      }
    }
  })

  const dto = await client.withdrawApproval('approval-1', 'idem-withdraw')
  assert.strictEqual(dto.status, 'withdrawn')
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].method, 'POST')
  assert.ok(seen[0].uri.endsWith('/approvals/approval-1/withdraw'), seen[0].uri)
  assert.strictEqual(seen[0].body, null, '撤回没有业务参数')
  assert.strictEqual(seen[0].headers['idempotency-key'], 'idem-withdraw')
  assert.strictEqual(seen[0].headers['Content-Type'], undefined)
})

await checkAsync('W5-J 写：store 撤回成功；收件箱没加载过就不去请求 /approvals', async () => {
  const { store, readApi, writeApi } = liveStore()
  const item = mapApprovalsPage(pageDto()).items[0]

  const message = await store.withdrawApproval(item)
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.withdrawApproval.length, 1)
  assert.strictEqual(writeApi.calls.withdrawApproval[0].id, 'approval-1')
  assert.strictEqual(
    readApi.calls.approvals.length,
    0,
    '孩子的设备请求收件箱会 403：不能因为撤回而凭空失败一次'
  )
})

await checkAsync('W5-J 写：收件箱已加载时撤回成功后同步刷新一次', async () => {
  const { store, readApi } = liveStore()
  await store.refreshApprovals()
  assert.strictEqual(readApi.calls.approvals.length, 1)

  const item = mapApprovalsPage(pageDto()).items[0]
  const message = await store.withdrawApproval(item)
  assert.strictEqual(message, null)
  assert.strictEqual(readApi.calls.approvals.length, 2)
})

await checkAsync('W5-J 写：回包不是 withdrawn ⇒ 契约漂移，不能当成功', async () => {
  const { store } = liveStore({
    withdrawApproval: (id) => approvalJson({ id, status: 'approved' })
  })
  const item = mapApprovalsPage(pageDto()).items[0]
  const message = await store.withdrawApproval(item)
  assert.ok(message !== null && message.includes('与这次撤回不一致'), message)
})

await checkAsync('W5-J 写：409 ⇒ 原样展示 + 刷新已加载的收件箱，不碰首页余额', async () => {
  const conflict = new WriteApiException('conflict', '这条申请已经被处理过了。')
  const { store, readApi } = liveStore({
    withdrawApproval: () => {
      throw conflict
    }
  })
  await store.refreshApprovals()
  const beforePoints = store.points

  const item = mapApprovalsPage(pageDto()).items[0]
  const message = await store.withdrawApproval(item)
  assert.strictEqual(message, conflict.userMessage)
  assert.strictEqual(store.points, beforePoints)
  assert.strictEqual(
    readApi.calls.approvals.length,
    2,
    '收件箱刷新一次（首次加载 + 409 同步）'
  )
})


await checkAsync('W5-J 写：403 NOT_REQUESTER ⇒ 说清「只有申请人能撤回」，且不重试', () => {
  const error = WriteApiException.fromHttp({
    statusCode: 403,
    body: { code: 'NOT_REQUESTER', message: 'not requester' }
  })
  assert.strictEqual(error.kind, 'forbidden')
  assert.ok(error.userMessage.includes('只有提交这条申请的人才能撤回'), error.userMessage)
  assert.ok(error.userMessage.includes('拒绝'), '家长该看到的下一步')
})

await checkAsync('W5-J 写：本地能判死的先拒（已终态 / 已过期），一次请求都不发', async () => {
  const { store, writeApi } = liveStore()
  const approved = mapApprovalsPage(
    pageDto([approvalJson({ status: 'approved' })])
  ).items[0]
  assert.strictEqual(
    await store.withdrawApproval(approved),
    '这条申请已经处理过了，请刷新列表。'
  )

  const expired = mapApprovalsPage(
    pageDto([approvalJson({ expiresAt: new Date(Date.now() - MINUTE).toISOString() })])
  ).items[0]
  assert.strictEqual(
    await store.withdrawApproval(expired),
    '这条申请已超过 72 小时有效期，不能再撤回。'
  )
  assert.strictEqual(writeApi.calls.withdrawApproval.length, 0)
})

await checkAsync('W5-J 写：预览模式不假装撤回成功', async () => {
  const store = new AppStore(null, null)
  const item = mapApprovalsPage(pageDto()).items[0]
  const message = await store.withdrawApproval(item)
  assert.strictEqual(message, '预览模式没有可撤回的申请。')
})

// ────────────────────────────────────── 汇总 ──────────────────────────────────────

if (failed > 0) {
  console.log(`\n${failed} 条用例失败`)
  process.exit(1)
}
console.log('\nW5-J ALL PASS')

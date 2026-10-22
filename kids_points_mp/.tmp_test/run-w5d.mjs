/**
 * W5-D「家长审批收件箱」的运行时用例（小程序侧）。
 *
 * 与 run-w5c.mjs 同样的理由用 ESM：CommonJS 没有顶层 `await`。
 * 覆盖三层：DTO / 映射的松紧边界 → 模型纯函数文案 → store 的读取与判定。
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 纯 Node 无法 require 真实的 `@tarojs/taro`，与 run.js 同款壳。 */
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
const { ApprovalsPageDto, HomeDto, RecordsPageDto } = require('./dist/data/read_dto.js')
const { mapApprovalInboxItem, mapApprovalsPage } =
  require('./dist/data/read_mapper.js')
const {
  approvalAutoReasonLabel,
  approvalBlockedReason,
  approvalConfirmText,
  approvalFilterLabel,
  approvalFilterQuery,
  approvalHeadline,
  approvalDetail,
  approvalRemainingText,
  approvalStatusLabel,
  canApproveApproval,
  canRejectApproval,
  formatApprovalTime,
  isApprovalExpired
} = require('./dist/data/approval.js')
const { WriteApiException } = require('./dist/data/write_api_errors.js')
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

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

function redeemSummary(overrides = {}) {
  return Object.assign(
    { kind: 'redeem', wishId: 'wish-1', title: '乐高', cost: 100 },
    overrides
  )
}

function bonusSummary(overrides = {}) {
  return Object.assign(
    {
      kind: 'bonus',
      amount: 10,
      reason: '主动收拾房间',
      ruleId: null,
      habitId: null,
      basisTitle: null
    },
    overrides
  )
}

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
      // 服务端时间一律 ISO-8601 字符串（readDate 不接受毫秒数）。
      createdAt: new Date(now - 2 * MINUTE).toISOString(),
      decidedAt: null,
      expiresAt: new Date(now + 12 * HOUR).toISOString(),
      summary: redeemSummary()
    },
    overrides
  )
}

function pageJson(items, overrides = {}) {
  return Object.assign({ items, hasMore: false, nextCursor: null }, overrides)
}

function pageDto(items = [approvalJson()], overrides = {}) {
  return ApprovalsPageDto.fromJson(pageJson(items, overrides))
}

function homeDto(points = 100) {
  return HomeDto.fromJson({
    child: { id: 'child-1', name: '小明', pointsBalance: points },
    goodHabitCount: 0,
    rewardCount: 0,
    habits: [],
    rules: [],
    wishes: []
  })
}

/** 只实现 store 用得到的读端点（批准判定成功后会重拉首页 + 流水）。 */
function fakeReadApi(input = {}) {
  const calls = { home: 0, records: 0, approvals: [] }
  return {
    calls,
    async fetchHome() {
      calls.home += 1
      if (input.home) return input.home()
      return homeDto()
    },
    async fetchRecords() {
      calls.records += 1
      if (input.records) return input.records()
      return RecordsPageDto.fromJson({ items: [], hasMore: false, nextCursor: null })
    },
    async fetchApprovals(query) {
      calls.approvals.push(query)
      if (input.approvals) return input.approvals(query)
      return pageDto()
    }
  }
}

function fakeWriteApi(input = {}) {
  const calls = { decideApproval: [] }
  return {
    calls,
    async decideApproval(id, args) {
      calls.decideApproval.push({ id, ...args })
      if (input.decideApproval) return input.decideApproval(id, args)
      return approvalJson({ status: args.approve ? 'approved' : 'rejected' })
    }
  }
}

function liveStore(input = {}) {
  const readApi = fakeReadApi(input)
  const writeApi = fakeWriteApi(input)
  return { store: new AppStore(readApi, writeApi), readApi, writeApi }
}

const configOk = new ReadApiConfig('http://127.0.0.1:3000/', 'device-1', 'child-1')
assert.strictEqual(configOk.deviceId, 'device-1')

// ───────────────────────────── ① DTO / 映射的松紧边界 ─────────────────────────

await checkAsync('W5-D DTO：未知 summary.kind ⇒ null（服务端比客户端新），整页不崩', async () => {
  const dto = pageDto([approvalJson({ summary: { kind: 'future_thing', x: 1 } })])
  const page = mapApprovalsPage(dto)
  assert.strictEqual(page.items.length, 1)
  assert.strictEqual(page.items[0].summary, null)
  // 读不懂 payload **不等于** 这行可以消失；也仍然可以拒绝。
  const item = page.items[0]
  assert.strictEqual(canApproveApproval(item, Date.now()), false)
  assert.strictEqual(canRejectApproval(item, Date.now()), true)
})

await checkAsync('W5-D DTO：hasMore / nextCursor 必须自洽（两种坏形状都报 malformed）', async () => {
  assert.throws(
    () => ApprovalsPageDto.fromJson(pageJson([], { hasMore: true, nextCursor: null })),
    (error) => error.kind === 'malformed' && String(error.detail).includes('游标')
  )
  assert.throws(
    () => ApprovalsPageDto.fromJson(pageJson([], { hasMore: false, nextCursor: 'x' })),
    (error) => error.kind === 'malformed'
  )
})

await checkAsync('W5-D 映射：redeem 的空 wishId ⇒ malformed（批准它等于兑一个不存在的心愿）', async () => {
  const dto = pageDto([approvalJson({ summary: redeemSummary({ wishId: '  ' }) })])
  assert.throws(
    () => mapApprovalInboxItem(dto.items[0], 'items[0]'),
    (error) =>
      error.kind === 'malformed' && String(error.detail) === '不能为空'
  )
})

await checkAsync('W5-D 模型：summary=null 时标题说「内容无法识别」，不猜内容', async () => {
  const dto = pageDto([approvalJson({ summary: null })])
  const item = mapApprovalInboxItem(dto.items[0], 'items[0]')
  assert.strictEqual(item.summary, null)
  const reason = approvalBlockedReason(item, Date.now())
  assert.ok(reason.includes('内容无法识别'), reason)
  assert.ok(reason.includes('拒绝'), reason)
  assert.strictEqual(approvalConfirmText(true, item).includes('不能批准'), true)
})

await checkAsync('W5-D 模型：三种摘要的标题 / 内容 / 确认文案都对得上「要扣多少分」', async () => {
  const now = Date.now()
  const redeem = mapApprovalInboxItem(pageDto([approvalJson()]).items[0])
  assert.strictEqual(approvalHeadline(redeem.summary), '兑换心愿')
  assert.ok(approvalDetail(redeem.summary).includes('「乐高」 · 100 分'))
  assert.ok(approvalConfirmText(true, redeem).includes('扣 100 分'))
  assert.ok(approvalConfirmText(false, redeem).includes('不会生效'))

  const bonus = mapApprovalInboxItem(
    pageDto([approvalJson({ summary: bonusSummary({ basisTitle: '整理房间' }) })]).items[0]
  )
  assert.strictEqual(approvalHeadline(bonus.summary), '加分申请')
  assert.ok(approvalDetail(bonus.summary).includes('+10 分'))
  assert.ok(approvalDetail(bonus.summary).includes('依据「整理房间」'))
  assert.ok(approvalConfirmText(true, bonus).includes('加 10 分'))

  const addWish = mapApprovalInboxItem(
    pageDto([
      approvalJson({
        summary: { kind: 'add_wish', title: '滑板', cost: 60, emoji: '🛹' }
      })
    ]).items[0]
  )
  assert.strictEqual(approvalHeadline(addWish.summary), '新增心愿')
  assert.ok(approvalDetail(addWish.summary).includes('🛹「滑板」 · 60 分'))
  assert.ok(approvalConfirmText(true, addWish).includes('加入心愿单'))

  // 三者的剩余有效期都还在（12 小时 TTL）
  assert.strictEqual(isApprovalExpired(redeem, now), false)
  assert.strictEqual(canApproveApproval(redeem, now), true)
})

await checkAsync('W5-D 模型：剩余有效期 / 过期 / 未知状态都如实说，不四舍五入成「快过期」', async () => {
  const now = Date.now()
  const base = mapApprovalInboxItem(pageDto([approvalJson()]).items[0])

  const day = { ...base, expiresAt: now + 3 * HOUR }
  assert.strictEqual(approvalRemainingText(day, now), '还剩 3 小时')

  const half = { ...base, expiresAt: now + 90 * MINUTE }
  assert.strictEqual(approvalRemainingText(half, now), '还剩 1 小时')

  const almost = { ...base, expiresAt: now + 30 * 1000 }
  assert.strictEqual(approvalRemainingText(almost, now), '不到 1 分钟')

  const expired = { ...base, expiresAt: now - 1 }
  assert.strictEqual(approvalRemainingText(expired, now), null)
  assert.strictEqual(canApproveApproval(expired, now), false)
  assert.strictEqual(canRejectApproval(expired, now), false)
  assert.ok(approvalBlockedReason(expired, now).includes('72 小时'))

  // 未知状态：不猜成「待处理」，也不崩。
  const unknown = { ...base, status: 'teleported' }
  assert.strictEqual(approvalStatusLabel(unknown), '状态未知（teleported）')
  assert.strictEqual(canApproveApproval(unknown, now), false)

  const invalidated = { ...base, status: 'invalidated', autoReason: 'INSUFFICIENT_POINTS' }
  assert.strictEqual(approvalStatusLabel(invalidated), '已失效')
  assert.strictEqual(approvalAutoReasonLabel(invalidated), '积分不够了')
  assert.strictEqual(approvalAutoReasonLabel(base), '')
})

await checkAsync('W5-D 模型：筛选词表 / 请求参数 / 时间格式', async () => {
  assert.strictEqual(approvalFilterLabel('pending'), '待处理')
  assert.strictEqual(approvalFilterLabel('rejected'), '已拒绝')
  assert.strictEqual(approvalFilterQuery('pending'), 'pending')
  // 「全部」不能发 status=all（后端只认四个具体值）
  assert.strictEqual(approvalFilterQuery('all'), undefined)

  const text = formatApprovalTime(new Date(2026, 9, 21, 14, 5).getTime())
  assert.strictEqual(text, '10 月 21 日 14:05')
})

await checkAsync('W5-D store：预览模式不装数据也不转圈（status=ready，零请求）', async () => {
  const store = new AppStore(null, null)
  await store.refreshApprovals()
  assert.strictEqual(store.approvals.length, 0)
  assert.strictEqual(store.approvalStatus, 'ready')
  assert.strictEqual(store.approvalError, null)
  // 预览模式没有写端点 ⇒ 批准按钮必须是禁用的（页面直接读这个）
  assert.strictEqual(store.canDecideApprovals, false)
})

await checkAsync('W5-D store：ensureApprovalsLoaded 只读一次；默认筛选是「待处理」', async () => {
  const { store, readApi } = liveStore()
  store.ensureApprovalsLoaded()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(readApi.calls.approvals.length, 1)
  assert.deepStrictEqual(readApi.calls.approvals[0], {
    status: 'pending',
    limit: 20,
    cursor: null
  })
  assert.strictEqual(store.approvals.length, 1)
  assert.strictEqual(store.pendingApprovalCount, 1)

  // 已成功后不再自动重读 —— 否则每次进页都会打一次服务端
  store.ensureApprovalsLoaded()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.strictEqual(readApi.calls.approvals.length, 1)
})

await checkAsync('W5-D store：403 如实落到 approvalError（不污染首页读状态）', async () => {
  const { store } = liveStore({
    approvals: async () => {
      throw new ReadApiException('forbidden', '没有批准申请的权限', {
        statusCode: 403
      })
    }
  })
  await store.refreshApprovals()
  assert.strictEqual(store.approvalStatus, 'error')
  assert.strictEqual(store.approvalError.kind, 'forbidden')
  assert.strictEqual(store.approvals.length, 0)
  // 独立切片：首页/流水的读状态跟审批无关
  assert.strictEqual(store.readStatus, 'idle')
})

await checkAsync('W5-D store：切换筛选 = 重新向服务端要第一页（不是本地过滤 20 条）', async () => {
  const { store, readApi } = liveStore({
    approvals: async (query) =>
      pageDto(
        query.status === 'approved'
          ? [approvalJson({ id: 'approval-9', status: 'approved' })]
          : [approvalJson()]
      )
  })
  await store.refreshApprovals()
  assert.strictEqual(store.approvals[0].id, 'approval-1')

  await store.setApprovalFilter('approved')
  assert.strictEqual(readApi.calls.approvals.length, 2)
  assert.strictEqual(readApi.calls.approvals[1].status, 'approved')
  assert.strictEqual(store.approvals.length, 1)
  assert.strictEqual(store.approvals[0].id, 'approval-9')

  // 「全部」不带 status（服务端默认就是全部）
  await store.setApprovalFilter('all')
  assert.strictEqual(readApi.calls.approvals[2].status, undefined)
})

await checkAsync('W5-D store：批准成功 ⇒ 幂等键 + 重拉审批与首页（余额由服务端说了算）', async () => {
  const { store, readApi, writeApi } = liveStore()
  await store.refreshApprovals()
  const item = store.approvals[0]
  const homeBefore = readApi.calls.home

  const message = await store.decideApproval(item, { approve: true })
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.decideApproval.length, 1)
  assert.strictEqual(writeApi.calls.decideApproval[0].id, 'approval-1')
  assert.strictEqual(writeApi.calls.decideApproval[0].approve, true)
  assert.ok(
    String(writeApi.calls.decideApproval[0].idempotencyKey).startsWith(
      'approval-decide-'
    ),
    String(writeApi.calls.decideApproval[0].idempotencyKey)
  )
  assert.strictEqual(readApi.calls.home, homeBefore + 1, '批准后必须刷新首页')
  assert.strictEqual(readApi.calls.approvals.length, 2, '审批列表也要重拉')
  assert.strictEqual(store.decidingApprovalId, null)
})

await checkAsync('W5-D store：拒绝不动首页（没有扣分），但同样重拉列表', async () => {
  const { store, readApi, writeApi } = liveStore()
  await store.refreshApprovals()
  const homeBefore = readApi.calls.home

  const message = await store.decideApproval(store.approvals[0], {
    approve: false
  })
  assert.strictEqual(message, null)
  assert.strictEqual(writeApi.calls.decideApproval[0].approve, false)
  assert.strictEqual(readApi.calls.home, homeBefore)
  assert.strictEqual(readApi.calls.approvals.length, 2)
})

await checkAsync('W5-D store：读不懂 / 已过期在本地就拒 —— 一次请求都不发', async () => {
  const { store, writeApi } = liveStore()
  await store.refreshApprovals()

  const broken = { ...store.approvals[0], summary: null }
  const brokenMessage = await store.decideApproval(broken, { approve: true })
  assert.ok(brokenMessage.includes('内容无法识别'), brokenMessage)

  const expired = { ...store.approvals[0], expiresAt: Date.now() - 1 }
  const expiredMessage = await store.decideApproval(expired, { approve: true })
  assert.ok(expiredMessage.includes('72 小时'), expiredMessage)

  // 已终态的行同样不发请求
  const decided = { ...store.approvals[0], status: 'approved' }
  const decidedMessage = await store.decideApproval(decided, { approve: true })
  assert.ok(decidedMessage.includes('已经处理过'), decidedMessage)

  assert.strictEqual(writeApi.calls.decideApproval.length, 0)
})

await checkAsync('W5-D store：409 冲突 ⇒ 回服务端文案并重拉列表（本地那行已经过时）', async () => {
  const { store, readApi } = liveStore({
    decideApproval: async () => {
      throw new WriteApiException('conflict', '这条申请已经处理过了，请刷新。', {
        statusCode: 409,
        code: 'ALREADY_DECIDED'
      })
    }
  })
  await store.refreshApprovals()
  const message = await store.decideApproval(store.approvals[0], { approve: true })
  assert.strictEqual(message, '这条申请已经处理过了，请刷新。')
  assert.strictEqual(readApi.calls.approvals.length, 2)
  assert.strictEqual(store.decidingApprovalId, null, '失败也要放开按钮')
})

await checkAsync('W5-D store：在途时再点是「忙」而不是第二次判定（幂等键只是第二道）', async () => {
  let release = null
  const { store, writeApi } = liveStore({
    decideApproval: async () =>
      new Promise((resolve) => {
        release = () => resolve(approvalJson({ status: 'approved' }))
      })
  })
  await store.refreshApprovals()
  const item = store.approvals[0]

  const first = store.decideApproval(item, { approve: true })
  assert.strictEqual(store.decidingApprovalId, 'approval-1')
  const second = await store.decideApproval(item, { approve: true })
  assert.ok(second.includes('正在处理中'), second)
  assert.strictEqual(writeApi.calls.decideApproval.length, 1)

  release()
  assert.strictEqual(await first, null)
  assert.strictEqual(store.decidingApprovalId, null)
})

console.log(failed === 0 ? '\nW5-D ALL PASS' : `\nW5-D ${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1

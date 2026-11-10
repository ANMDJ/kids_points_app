/**
 * P1-3「审批详情 ＋ 通知深链」的小程序侧运行时用例（2026-11-10）。
 *
 * 覆盖四层：
 *   ① DTO / 映射：`requesterRole` 只有详情接口带，缺省不猜；
 *   ② 模型纯函数：谁提的 / 自批（判据与服务端一致）；
 *   ③ 读客户端：`GET /approvals/:id` 的 URL 形状（id 要 encode）；
 *   ④ store：live 模式返回映射后的行；预览模式给可展示的原因，绝不编详情。
 *
 * 与 run-w5d.mjs 同样用 ESM（CommonJS 没有顶层 await），并同样给
 * `@tarojs/taro` 打一个纯 Node 可用的壳。
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

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
const { ApprovalInboxItemDto } = require('./dist/data/read_dto.js')
const { mapApprovalInboxItem } = require('./dist/data/read_mapper.js')
const {
  approvalRequesterLabel,
  isApprovalSelfApproved
} = require('./dist/data/approval.js')
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

function approvalJson(overrides = {}) {
  return Object.assign(
    {
      id: 'ap-1',
      action: 'redeem',
      status: 'pending',
      requesterUserId: 'user-kid',
      requesterRole: 'child',
      decidedByUserId: null,
      executedRecordId: null,
      autoReason: null,
      createdAt: '2026-10-20T08:00:00.000Z',
      decidedAt: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
      summary: { kind: 'redeem', wishId: 'wish-1', title: '乐高', cost: 100 }
    },
    overrides
  )
}

function itemOf(json) {
  return mapApprovalInboxItem(ApprovalInboxItemDto.fromJson(json, '$'))
}

const config = new ReadApiConfig('http://127.0.0.1:3000/', 'device-1', 'child-1')

// ───────────────────────── ① DTO / 映射 ─────────────────────────

await checkAsync('P1-3 DTO：详情带 requesterRole ⇒ 映射后原样保留', async () => {
  const item = itemOf(approvalJson())
  assert.strictEqual(item.requesterRole, 'child')
  assert.strictEqual(approvalRequesterLabel(item), '孩子提交')
})

await checkAsync('P1-3 DTO：列表 / 老服务端没有 requesterRole ⇒ null，文案兜底「家庭成员」', async () => {
  const json = approvalJson()
  delete json.requesterRole
  const item = itemOf(json)
  assert.strictEqual(item.requesterRole, null)
  assert.strictEqual(approvalRequesterLabel(item), '家庭成员提交')
})

await checkAsync('P1-3 模型：不认识的旧角色也不猜成「孩子」', async () => {
  assert.strictEqual(
    approvalRequesterLabel(itemOf(approvalJson({ requesterRole: 'viewer' }))),
    '家庭成员提交'
  )
})

await checkAsync('P1-3 模型：isApprovalSelfApproved 与服务端同一判据', async () => {
  assert.strictEqual(isApprovalSelfApproved(itemOf(approvalJson())), false)
  assert.strictEqual(
    isApprovalSelfApproved(
      itemOf(approvalJson({ status: 'approved', decidedByUserId: 'user-kid' }))
    ),
    true
  )
  assert.strictEqual(
    isApprovalSelfApproved(
      itemOf(approvalJson({ status: 'approved', decidedByUserId: 'user-dad' }))
    ),
    false
  )
})

// ───────────────────────── ② 读客户端：URL 形状 ─────────────────────────

await checkAsync('P1-3 ReadApiClient：GET /approvals/:id（id 必须 encode）', async () => {
  const uris = []
  const client = new ReadApiClient({
    config,
    transport: {
      async send(uri) {
        uris.push(uri)
        return { statusCode: 200, body: approvalJson() }
      }
    }
  })
  const dto = await client.fetchApproval('ap 1/2')
  assert.strictEqual(uris.length, 1)
  assert.ok(uris[0].endsWith('/approvals/ap%201%2F2'), '实际请求：' + uris[0])
  assert.ok(dto instanceof ApprovalInboxItemDto)
  assert.strictEqual(dto.requesterRole, 'child')
})

await checkAsync('P1-3 ReadApiClient：404 ⇒ ReadApiException(APPROVAL_NOT_FOUND)', async () => {
  const client = new ReadApiClient({
    config,
    transport: {
      async send() {
        return { statusCode: 404, body: { code: 'APPROVAL_NOT_FOUND' } }
      }
    }
  })
  await assert.rejects(
    () => client.fetchApproval('ap-404'),
    (error) =>
      error instanceof ReadApiException &&
      error.statusCode === 404 &&
      error.code === 'APPROVAL_NOT_FOUND'
  )
})

// ───────────────────────── ③ store ─────────────────────────

function liveStore(input = {}) {
  const calls = []
  const readApi = {
    async fetchApproval(id) {
      calls.push(id)
      if (input.fail) throw input.fail
      return ApprovalInboxItemDto.fromJson(approvalJson(input.json), 'approval')
    }
  }
  return { store: new AppStore(readApi, null), calls }
}

await checkAsync('P1-3 store：按 id 取一条并映射（不写全局收件箱）', async () => {
  const { store, calls } = liveStore()
  const item = await store.fetchApproval('ap-9')
  assert.deepStrictEqual(calls, ['ap-9'])
  assert.strictEqual(item.id, 'ap-1')
  assert.strictEqual(approvalRequesterLabel(item), '孩子提交')
})

await checkAsync('P1-3 store：读失败原样抛（页面照实说明，不吞成空详情）', async () => {
  const failure = new ReadApiException('childNotFound', '没有这条申请（404）。', {
    statusCode: 404,
    code: 'APPROVAL_NOT_FOUND'
  })
  const { store } = liveStore({ fail: failure })
  await assert.rejects(
    () => store.fetchApproval('ap-404'),
    (error) => error === failure
  )
})

await checkAsync('P1-3 store：预览模式不编造详情', async () => {
  const store = new AppStore(null, null)
  await assert.rejects(
    () => store.fetchApproval('ap-1'),
    (error) =>
      error instanceof ReadApiException &&
      error.code === 'APPROVAL_DETAIL_UNAVAILABLE' &&
      error.userMessage.includes('没有连接服务器')
  )
})

console.log('')
if (failed > 0) {
  console.error('FAIL  ' + failed + ' 条 P1-3 用例未通过')
  process.exit(1)
}
console.log('PASS  P1-3 审批详情 / 深链用例全部通过')


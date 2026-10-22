/**
 * W5-C「心愿」写端点（`POST /wishes` / `DELETE /wishes/:id`）的**异步**运行时用例。
 *
 * 与 `run-w4e.mjs` / `run-w5a.mjs` / `run-w5b.mjs` 同样的理由：CommonJS 没有顶层
 * `await`，而 D12 守卫不允许把汇总 / 退出码塞进回调。
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

function wishJson(overrides = {}) {
  return Object.assign(
    {
      id: 'wish-1',
      title: '去游乐园',
      cost: 40,
      emoji: '🎡',
      coverStyle: 'A',
      redeemed: false
    },
    overrides
  )
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
  const calls = { createWish: [], deleteWish: [], requestRedeem: [] }
  return {
    calls,
    async createWish(args) {
      calls.createWish.push(args)
      if (input.createWish) return input.createWish(args)
      return wishJson({ title: args.title, cost: args.cost, emoji: args.emoji })
    },
    async deleteWish(id, key) {
      calls.deleteWish.push({ id, key })
      if (input.deleteWish) return input.deleteWish(id, key)
      return id
    },
    async requestRedeem(id, key) {
      calls.requestRedeem.push({ id, key })
      if (input.requestRedeem) return input.requestRedeem(id, key)
      return approvalJson()
    }
  }
}

/** `POST /approvals` 的线格式（与后端 `toBody` 同构）。 */
function approvalJson(overrides = {}) {
  return Object.assign(
    {
      id: 'approval-1',
      action: 'redeem',
      status: 'pending',
      requesterUserId: 'member-1',
      decidedByUserId: null,
      executedRecordId: null,
      autoReason: null
    },
    overrides
  )
}

await checkAsync(
  'W5-C 客户端：POST /wishes，标题去空白、**不传 coverStyle**（配色由服务端定）',
  async () => {
    const seen = []
    const transport = {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, headers, body, timeoutMs, method })
        return {
          statusCode: 201,
          body: wishJson({ title: '去游乐园', cost: 40, coverStyle: 'B' })
        }
      }
    }
    const client = new WriteApiClient({ config, transport, timeoutMs: 1234 })
    const dto = await client.createWish({
      title: '  去游乐园  ',
      cost: 40,
      emoji: '🎡',
      idempotencyKey: 'key-wish-1'
    })

    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].method, 'POST')
    assert.ok(seen[0].uri.endsWith('/wishes'), seen[0].uri)
    assert.strictEqual(seen[0].body.title, '去游乐园')
    assert.strictEqual(seen[0].body.cost, 40)
    assert.strictEqual(seen[0].body.emoji, '🎡')
    // 关键：客户端**不许**替服务端决定配色 —— 两套算法必然会在某天给出不同答案
    assert.strictEqual(
      'coverStyle' in seen[0].body,
      false,
      'coverStyle 不该出现在请求体里'
    )
    assert.strictEqual(seen[0].headers['idempotency-key'], 'key-wish-1')
    assert.strictEqual(seen[0].headers['x-kp-device-id'], 'device-1')
    assert.strictEqual(seen[0].headers['x-kp-child-id'], 'child-1')
    assert.strictEqual(seen[0].timeoutMs, 1234)
    assert.strictEqual(dto.coverStyle, 'B', '配色以服务端回包为准')
    assert.strictEqual(dto.cost, 40)
  }
)

await checkAsync(
  'W5-C 客户端：空标题 / 0 分 / 空图标在本地就拒，一次请求都不发',
  async () => {
    const seen = []
    const transport = {
      async send(uri, headers, body) {
        seen.push({ uri, body })
        return { statusCode: 201, body: wishJson() }
      }
    }
    const client = new WriteApiClient({ config, transport })

    await assert.rejects(
      () => client.createWish({ title: '   ', cost: 40, emoji: '🎁' }),
      /title/
    )
    await assert.rejects(
      () => client.createWish({ title: '去游乐园', cost: 0, emoji: '🎁' }),
      /cost/
    )
    await assert.rejects(
      () => client.createWish({ title: '去游乐园', cost: 1.5, emoji: '🎁' }),
      /cost/
    )
    await assert.rejects(
      () => client.createWish({ title: '去游乐园', cost: 40, emoji: '  ' }),
      /emoji/
    )
    assert.strictEqual(seen.length, 0, '本地拒掉的操作不允许产生请求')
  }
)

await checkAsync(
  'W5-C 客户端：DELETE /wishes/:id 无请求体，幂等键照样随头发出',
  async () => {
    const seen = []
    const transport = {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, headers, body, method })
        return { statusCode: 200, body: { wishId: 'wish-1' } }
      }
    }
    const client = new WriteApiClient({ config, transport })
    const deleted = await client.deleteWish('wish-1', 'key-wish-del')

    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].method, 'DELETE')
    assert.ok(seen[0].uri.endsWith('/wishes/wish-1'), seen[0].uri)
    assert.strictEqual(seen[0].body, null, 'DELETE 不该带请求体')
    assert.strictEqual(seen[0].headers['idempotency-key'], 'key-wish-del')
    assert.strictEqual(deleted, 'wish-1')
  }
)

await checkAsync(
  'W5-C 客户端：回包确认的不是我删的那条 ⇒ malformed，不假装删对了',
  async () => {
    const transport = {
      async send() {
        return { statusCode: 200, body: { wishId: 'wish-other' } }
      }
    }
    const client = new WriteApiClient({ config, transport })

    await assert.rejects(
      () => client.deleteWish('wish-1'),
      (error) => {
        assert.ok(error instanceof WriteApiException)
        assert.strictEqual(error.kind, 'malformed')
        return true
      }
    )
  }
)

await checkAsync('W5-C 客户端：404 WISH_NOT_FOUND 给出心愿文案', async () => {
  const transport = {
    async send() {
      return { statusCode: 404, body: { code: 'WISH_NOT_FOUND' } }
    }
  }
  const client = new WriteApiClient({ config, transport })

  await assert.rejects(
    () => client.deleteWish('wish-1'),
    (error) => {
      assert.ok(error instanceof WriteApiException)
      assert.strictEqual(error.kind, 'notFound')
      assert.strictEqual(error.code, 'WISH_NOT_FOUND')
      assert.ok(error.userMessage.includes('心愿'), error.userMessage)
      return true
    }
  )
})

await checkAsync(
  'W5-C 客户端：403 APPROVAL_REQUIRED 说明「没保存」，但**不**说「已提交」',
  async () => {
    const transport = {
      async send() {
        return { statusCode: 403, body: { code: 'APPROVAL_REQUIRED' } }
      }
    }
    const client = new WriteApiClient({ config, transport })

    await assert.rejects(
      () => client.createWish({ title: '去游乐园', cost: 40, emoji: '🎡' }),
      (error) => {
        assert.ok(error instanceof WriteApiException)
        assert.strictEqual(error.kind, 'forbidden')
        assert.strictEqual(error.code, 'APPROVAL_REQUIRED')
        assert.ok(error.userMessage.includes('家长'), error.userMessage)
        assert.ok(error.userMessage.includes('没有保存'), error.userMessage)
        // 403 时服务端**没有**创建审批单：说“已提交”会让家长去审批页白翻一遍
        assert.strictEqual(
          error.userMessage.includes('已提交'),
          false,
          error.userMessage
        )
        return true
      }
    )
  }
)

await checkAsync(
  'W5-C 兑换客户端：POST /approvals 只发 action + targetId（不带 costSnapshot / autoApprove）',
  async () => {
    const seen = []
    const transport = {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, headers, body, timeoutMs, method })
        return { statusCode: 202, body: approvalJson() }
      }
    }
    const client = new WriteApiClient({ config, transport })
    const approval = await client.requestRedeem('wish-1', 'key-redeem-1')

    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].method, 'POST')
    assert.ok(seen[0].uri.endsWith('/approvals'), seen[0].uri)
    assert.deepStrictEqual(seen[0].body, {
      action: 'redeem',
      targetId: 'wish-1'
    })
    assert.strictEqual(seen[0].headers['idempotency-key'], 'key-redeem-1')
    assert.strictEqual(seen[0].headers['x-kp-child-id'], 'child-1')
    assert.strictEqual(approval.status, 'pending')
    assert.strictEqual(approval.executedRecordId, null)
  }
)

await checkAsync(
  'W5-C 兑换客户端：回包缺 status ⇒ malformed（不猜审批结果）',
  async () => {
    const transport = {
      async send() {
        return {
          statusCode: 202,
          body: { id: 'approval-1', action: 'redeem' }
        }
      }
    }
    const client = new WriteApiClient({ config, transport })

    await assert.rejects(
      () => client.requestRedeem('wish-1'),
      (error) => {
        assert.ok(error instanceof WriteApiException)
        assert.strictEqual(error.kind, 'malformed')
        return true
      }
    )
  }
)

await checkAsync('W5-C 兑换客户端：409 WISH_ALREADY_REDEEMED 说「没提交」', async () => {
  const transport = {
    async send() {
      return { statusCode: 409, body: { code: 'WISH_ALREADY_REDEEMED' } }
    }
  }
  const client = new WriteApiClient({ config, transport })

  await assert.rejects(
    () => client.requestRedeem('wish-1'),
    (error) => {
      assert.ok(error instanceof WriteApiException)
      assert.strictEqual(error.kind, 'conflict')
      assert.strictEqual(error.code, 'WISH_ALREADY_REDEEMED')
      assert.ok(error.userMessage.includes('已经兑换过'), error.userMessage)
      assert.ok(error.userMessage.includes('没有提交'), error.userMessage)
      return true
    }
  )
})

await checkAsync(
  'W5-C 兑换 store：pending ⇒ 只说「已提交，等家长确认」，不扣分不写流水',
  async () => {
    const readApi = fakeReadApi(() => homeDto({ wishes: [wishJson()] }))
    const writeApi = fakeWriteApi()
    const store = new AppStore(readApi, writeApi)
    await store.refreshFromServer()
    const beforePoints = store.points
    const beforeRecords = store.records.length

    const message = await store.submitRedeemWish('wish-1')

    assert.strictEqual(writeApi.calls.requestRedeem.length, 1)
    assert.strictEqual(writeApi.calls.requestRedeem[0].id, 'wish-1')
    assert.ok(
      String(writeApi.calls.requestRedeem[0].key).startsWith('wish-redeem-'),
      String(writeApi.calls.requestRedeem[0].key)
    )
    assert.strictEqual(typeof message, 'string', 'pending 必须给用户一句提示')
    assert.ok(message.includes('已提交给家长确认'), message)
    assert.ok(message.includes('批准后才会扣 40 分'), message)
    // pending 时**还没有**扣分：这里说“兑换成功”就是骗人
    assert.strictEqual(message.includes('兑换成功'), false, message)
    assert.strictEqual(store.points, beforePoints, '没批之前余额不能动')
    assert.strictEqual(store.records.length, beforeRecords, 'pending 不许写流水')
    assert.strictEqual(store.wishes[0].redeemed, false)
  }
)

await checkAsync(
  'W5-C 兑换 store：approved ⇒ 以服务端快照为准（客户端不手写扣分）',
  async () => {
    let serverHome = homeDto({ wishes: [wishJson()] })
    const readApi = fakeReadApi(() => serverHome)
    const writeApi = fakeWriteApi({
      requestRedeem: async () => approvalJson({ status: 'approved', executedRecordId: 'rec-9' })
    })
    const store = new AppStore(readApi, writeApi)
    await store.refreshFromServer()
    // 服务端批准后：余额 11 → 1，心愿已兑换
    serverHome = homeDto({
      child: { id: 'child-1', name: '小明', pointsBalance: 1 },
      wishes: [wishJson({ redeemed: true })]
    })

    const message = await store.submitRedeemWish('wish-1')

    assert.strictEqual(message, null, String(message))
    assert.strictEqual(store.points, 1, '必须用服务端快照，不是本地减 40')
    assert.strictEqual(store.wishes[0].redeemed, true)
  }
)

await checkAsync(
  'W5-C 兑换 store：invalidated ⇒ 说清哪条前提消失，余额不变',
  async () => {
    const readApi = fakeReadApi(() => homeDto({ wishes: [wishJson()] }))
    const writeApi = fakeWriteApi({
      requestRedeem: async () =>
        approvalJson({ status: 'invalidated', autoReason: 'WISH_DELETED' })
    })
    const store = new AppStore(readApi, writeApi)
    await store.refreshFromServer()
    const beforePoints = store.points

    const message = await store.submitRedeemWish('wish-1')

    assert.strictEqual(typeof message, 'string')
    assert.ok(message.includes('心愿已经被删除了'), message)
    assert.ok(message.includes('积分没有变动'), message)
    assert.strictEqual(store.points, beforePoints)
  }
)

await checkAsync(
  'W5-C store：live 下走 POST /wishes，配色以服务端快照为准',
  async () => {
    let serverWishes = []
    const readApi = fakeReadApi(() => homeDto({ wishes: serverWishes }))
    const writeApi = fakeWriteApi({
      createWish: async (args) => {
        const created = wishJson({
          id: 'wish-9',
          title: args.title,
          cost: args.cost,
          emoji: args.emoji,
          coverStyle: 'C'
        })
        serverWishes = [created]
        return created
      }
    })
    const store = new AppStore(readApi, writeApi)

    await store.refreshFromServer()
    assert.strictEqual(store.wishes.length, 0)

    const message = await store.submitAddWish('  去游乐园  ', 40, '🎡')
    assert.strictEqual(message, null, String(message))

    assert.strictEqual(writeApi.calls.createWish.length, 1, '只发一次请求')
    const args = writeApi.calls.createWish[0]
    assert.strictEqual(args.title, '去游乐园')
    assert.strictEqual(args.cost, 40)
    assert.strictEqual(args.emoji, '🎡')
    assert.strictEqual('coverStyle' in args, false, 'store 也不该替服务端选配色')
    assert.strictEqual(typeof args.idempotencyKey, 'string')
    assert.ok(args.idempotencyKey.startsWith('wish-create-'), args.idempotencyKey)

    assert.strictEqual(store.wishes.length, 1)
    assert.strictEqual(store.wishes[0].id, 'wish-9')
    assert.strictEqual(store.wishes[0].coverStyle, 'C')
    assert.strictEqual(readApi.calls.home, 2, '写成功后必须刷新校正')
  }
)

await checkAsync(
  'W5-C store：孩子需审批（403 APPROVAL_REQUIRED）⇒ 返回可读原因，列表不变',
  async () => {
    const readApi = fakeReadApi()
    const writeApi = fakeWriteApi({
      createWish: async () => {
        throw WriteApiException.fromHttp({
          statusCode: 403,
          body: { code: 'APPROVAL_REQUIRED' }
        })
      }
    })
    const store = new AppStore(readApi, writeApi)
    await store.refreshFromServer()

    const message = await store.submitAddWish('去游乐园', 40, '🎡')
    assert.strictEqual(typeof message, 'string')
    assert.ok(message.includes('家长'), String(message))
    assert.strictEqual(store.wishes.length, 0, '被拒的写入不许本地先插一条')
    assert.strictEqual(writeApi.calls.createWish.length, 1)
  }
)

await checkAsync(
  'W5-C store：空标题 / 0 分在本地就拒（一次请求都不发）',
  async () => {
    const writeApi = fakeWriteApi()
    const store = new AppStore(fakeReadApi(), writeApi)
    await store.refreshFromServer()

    assert.strictEqual(
      typeof (await store.submitAddWish('   ', 40, '🎡')),
      'string'
    )
    assert.strictEqual(
      typeof (await store.submitAddWish('去游乐园', 0, '🎡')),
      'string'
    )
    assert.strictEqual(writeApi.calls.createWish.length, 0)
    assert.strictEqual(store.wishes.length, 0)
  }
)

await checkAsync(
  'W5-C store：删除心愿 ⇒ DELETE /wishes/:id，列表里消失且不产生任何流水',
  async () => {
    let serverWishes = [wishJson({ id: 'wish-1' })]
    const readApi = fakeReadApi(() => homeDto({ wishes: serverWishes }))
    const writeApi = fakeWriteApi({
      deleteWish: async (id) => {
        serverWishes = []
        return id
      }
    })
    const store = new AppStore(readApi, writeApi)
    await store.refreshFromServer()
    assert.strictEqual(store.wishes.length, 1)

    const message = await store.submitRemoveWish('wish-1')
    assert.strictEqual(message, null, String(message))

    assert.strictEqual(writeApi.calls.deleteWish.length, 1)
    assert.strictEqual(writeApi.calls.deleteWish[0].id, 'wish-1')
    assert.ok(
      String(writeApi.calls.deleteWish[0].key).startsWith('wish-delete-'),
      String(writeApi.calls.deleteWish[0].key)
    )
    assert.strictEqual(store.wishes.length, 0)
    // 删心愿**不碰流水**：扣分只发生在真正兑换时，这里一条负分记录都不该冒出来
    assert.strictEqual(
      store.records.filter((record) => record.points < 0).length,
      0
    )
    assert.strictEqual(readApi.calls.home, 2, '删成功后必须刷新校正')
  }
)

await checkAsync(
  'W5-C store：心愿 live 但没注入写客户端 ⇒ 拒绝写，不偷偷改内存',
  async () => {
    const store = new AppStore(fakeReadApi(), null)
    await store.refreshFromServer()

    assert.strictEqual(store.isWishWriteReadOnly, true)
    assert.strictEqual(
      await store.submitAddWish('去游乐园', 40, '🎡'),
      store.wishReadOnlyWriteMessage
    )
    assert.strictEqual(
      await store.submitRemoveWish('wish-1'),
      store.wishReadOnlyWriteMessage
    )
    // 兑换也是写：没有写客户端就必须拦下，而不是本地扣一次分
    assert.strictEqual(
      await store.submitRedeemWish('wish-1'),
      store.readOnlyWriteMessage
    )
    assert.strictEqual(store.wishes.length, 0)
  }
)

await checkAsync(
  'W5-C store：空心愿 id 在本地就拒 ⇒ 一次请求都不发、也不本地扣分',
  async () => {
    const writeApi = fakeWriteApi()
    const store = new AppStore(fakeReadApi(() => homeDto({ wishes: [wishJson()] })), writeApi)
    await store.refreshFromServer()
    const beforePoints = store.points

    assert.strictEqual(await store.submitRedeemWish('   '), '心愿 id 不能为空')
    assert.strictEqual(writeApi.calls.requestRedeem.length, 0)
    assert.strictEqual(store.points, beforePoints)
  }
)

await checkAsync(
  'W5-C 兑换确认文案：live 说「提交申请、批准后才扣」，预览说「立即扣除」',
  async () => {
    const live = new AppStore(
      fakeReadApi(() => homeDto({ wishes: [wishJson()] })),
      fakeWriteApi()
    )
    await live.refreshFromServer()

    const liveText = live.redeemConfirmText(live.wishes[0])
    assert.ok(liveText.includes('提交给家长确认'), liveText)
    assert.ok(liveText.includes('批准后才会扣 40 分'), liveText)
    assert.ok(liveText.includes('现在还没有扣'), liveText)
    // 「立即扣除」只属于预览模式；live 说这句就是在骗人
    assert.strictEqual(liveText.includes('立即扣除'), false, liveText)

    const preview = new AppStore(null, null)
    assert.strictEqual(preview.resetToSeed(), true)
    const previewWish = preview.wishes[0]
    const previewText = preview.redeemConfirmText(previewWish)
    assert.ok(previewText.includes('立即扣除'), previewText)
    assert.ok(previewText.includes(`${previewWish.cost} 分`), previewText)
    // 预览模式没有服务端可申请，写「等家长确认」等于演戏
    assert.strictEqual(previewText.includes('提交给家长确认'), false, previewText)
  }
)

console.log(failed === 0 ? '\nW5-C ALL PASS' : `\nW5-C ${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1


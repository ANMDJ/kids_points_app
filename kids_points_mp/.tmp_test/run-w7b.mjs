/**
 * W7-B 监护人同意（`GET /consent` ＋ 同意 / 撤回）的**异步**运行时用例。
 *
 * 结构照抄 `run-w5i.mjs`（CommonJS 没有顶层 await，D12 守卫不允许把汇总
 * 塞进回调）：顶层 await → 顶层汇总 → 顶层退出码。
 *
 * 编译（项目约定）：
 *   npx tsc -p .tmp_test/tsconfig.test.json   # rootDir ../src → 产物落在 .tmp_test/dist
 *   node .tmp_test/run-w7b.mjs
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
const { ReadApiConfig } = require('./dist/data/read_api.js')
const { ConsentStateDto, MemberListDto } = require('./dist/data/read_dto.js')
const { mapConsent } = require('./dist/data/read_mapper.js')
const { ReadApiException } = require('./dist/data/read_api_errors.js')
const { WriteApiClient } = require('./dist/data/write_api.js')
const { WriteApiException } = require('./dist/data/write_api_errors.js')
const {
  consentGrantedText,
  consentVersionLabel,
  consentWithdrawnText,
  guardianConsentStatusLabelOf,
  isDraftConsentVersion
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

const GRANTED_AT = Date.parse('2026-10-27T01:30:00.000Z')
const WITHDRAWN_AT = Date.parse('2026-10-27T03:05:00.000Z')
const VERSION = '2026-10-27-draft'

// ────────────────────────────────────── 夹具 ──────────────────────────────────────

/** 一个同意状态的线值；默认「已同意（草案版协议）」。 */
function consentJson(overrides = {}) {
  return {
    childId: 'child-1',
    status: 'granted',
    consentVersion: VERSION,
    grantedAt: new Date(GRANTED_AT).toISOString(),
    withdrawnAt: null,
    ...overrides
  }
}

function dtoOf(overrides = {}) {
  return new ConsentStateDto(
    overrides.childId ?? 'child-1',
    overrides.status ?? 'granted',
    overrides.consentVersion === undefined ? VERSION : overrides.consentVersion,
    overrides.grantedAt === undefined ? GRANTED_AT : overrides.grantedAt,
    overrides.withdrawnAt === undefined ? null : overrides.withdrawnAt
  )
}

function memberJson(overrides = {}) {
  return {
    memberId: 'm1',
    userId: 'u1',
    displayName: '妈妈',
    role: 'guardian',
    status: 'active',
    joinedAt: new Date('2026-10-01T10:00:00.000Z').toISOString(),
    removedAt: null,
    isSelf: true,
    ...overrides
  }
}

/** 读客户端：只实现同意相关的方法（Node 里不做静态检查，够用即可）。 */
function fakeReadApi(options = {}) {
  const calls = { members: 0, consent: 0 }
  let consentSource = options.consent ?? (() => dtoOf())
  return {
    calls,
    setConsent(next) {
      consentSource = next
    },
    async fetchMembers() {
      calls.members += 1
      return MemberListDto.fromJson({ items: options.members ?? [memberJson()] })
    },
    async fetchConsent() {
      calls.consent += 1
      return consentSource()
    }
  }
}

/** 写客户端：同意 / 撤回各自可替换，便于逐条构造 403 / 409 / 畸形回包。 */
function fakeWriteApi(options = {}) {
  const calls = { grant: 0, withdraw: 0 }
  let grantSource = options.grant ?? (() => dtoOf())
  let withdrawSource =
    options.withdraw ??
    (() => dtoOf({ status: 'withdrawn', withdrawnAt: WITHDRAWN_AT }))
  return {
    calls,
    setGrant(next) {
      grantSource = next
    },
    setWithdraw(next) {
      withdrawSource = next
    },
    async grantConsent() {
      calls.grant += 1
      return grantSource()
    },
    async withdrawConsent() {
      calls.withdraw += 1
      return withdrawSource()
    }
  }
}

function liveStore(options = {}) {
  const readApi = fakeReadApi(options)
  const writeApi = fakeWriteApi(options)
  return { store: new AppStore(readApi, writeApi), readApi, writeApi }
}

/** DTO / 映射层的畸形回包：必须是 `malformed`，且 detail 指出字段。 */
function expectReadMalformed(fn, fragment = '') {
  try {
    fn()
  } catch (error) {
    assert.ok(
      error instanceof ReadApiException,
      '应抛 ReadApiException，实际：' + error
    )
    assert.strictEqual(error.kind, 'malformed', 'kind 必须是 malformed')
    if (fragment !== '') {
      assert.ok(
        (error.detail ?? '').includes(fragment),
        `detail 应含「${fragment}」，实际：${error.detail}`
      )
    }
    return error
  }
  throw new Error('必须抛 malformed，实际没有抛')
}

/** 写客户端：回包不符合约定时同样必须是 `malformed`（不是通用失败）。 */
function expectWriteMalformed(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(
      error instanceof WriteApiException,
      '应抛 WriteApiException，实际：' + error
    )
    assert.strictEqual(error.kind, 'malformed', 'kind 必须是 malformed')
    assert.strictEqual(error.code, 'MALFORMED_RESPONSE')
    return error
  }
  throw new Error('必须抛 malformed，实际没有抛')
}

// ────────────────────────────────────── ① DTO 形状 ──────────────────────────────────────

await checkAsync('W7-B DTO：granted 合法行逐字段落地', () => {
  const dto = ConsentStateDto.fromJson(consentJson())
  assert.strictEqual(dto.childId, 'child-1')
  assert.strictEqual(dto.status, 'granted')
  assert.strictEqual(dto.consentVersion, VERSION)
  assert.strictEqual(dto.grantedAt, GRANTED_AT, 'ISO 字符串要换成毫秒')
  assert.strictEqual(dto.withdrawnAt, null)
})

await checkAsync('W7-B DTO：granted 缺协议版本 / 缺同意时间 ⇒ malformed', () => {
  expectReadMalformed(
    () => ConsentStateDto.fromJson(consentJson({ consentVersion: null })),
    '协议版本'
  )
  expectReadMalformed(
    () => ConsentStateDto.fromJson(consentJson({ consentVersion: '   ' })),
    '协议版本'
  )
  expectReadMalformed(
    () => ConsentStateDto.fromJson(consentJson({ grantedAt: null })),
    '同意时间'
  )
})

await checkAsync('W7-B DTO：withdrawn 必带撤回时间，none 必须全空', () => {
  expectReadMalformed(
    () => ConsentStateDto.fromJson(consentJson({ status: 'withdrawn' })),
    '撤回时间'
  )
  expectReadMalformed(
    () =>
      ConsentStateDto.fromJson(
        consentJson({ status: 'none', consentVersion: VERSION, grantedAt: null })
      ),
    'none'
  )
  const none = ConsentStateDto.fromJson(
    consentJson({ status: 'none', consentVersion: null, grantedAt: null })
  )
  assert.strictEqual(none.status, 'none')
  assert.strictEqual(none.consentVersion, null)
})

await checkAsync('W7-B DTO：未知 status 不在这里判（交给 mapper）', () => {
  const dto = ConsentStateDto.fromJson(
    consentJson({ status: 'expired', consentVersion: null, grantedAt: null })
  )
  assert.strictEqual(dto.status, 'expired', 'DTO 只保证形状，不认识就别编')
})

// ────────────────────────────────────── ② 映射 / 文案 ──────────────────────────────────────

await checkAsync('W7-B mapper：三个已知状态逐个映射，未知状态显式失败', () => {
  const granted = mapConsent(dtoOf())
  assert.strictEqual(granted.childId, 'child-1')
  assert.strictEqual(granted.status, 'granted')
  assert.strictEqual(granted.consentVersion, VERSION)
  assert.strictEqual(granted.grantedAt, GRANTED_AT)
  assert.strictEqual(granted.withdrawnAt, null)

  const withdrawn = mapConsent(
    dtoOf({ status: 'withdrawn', withdrawnAt: WITHDRAWN_AT })
  )
  assert.strictEqual(withdrawn.status, 'withdrawn')
  assert.strictEqual(withdrawn.withdrawnAt, WITHDRAWN_AT, '撤回时间要留着给界面显示')

  const none = mapConsent(
    dtoOf({ status: 'none', consentVersion: null, grantedAt: null })
  )
  assert.strictEqual(none.status, 'none')
  assert.strictEqual(none.grantedAt, null)

  expectReadMalformed(() =>
    mapConsent(dtoOf({ status: 'expired', consentVersion: null, grantedAt: null }))
  )
})

await checkAsync('W7-B types：状态徽标 / 版本展示 / 草案判定', () => {
  assert.strictEqual(guardianConsentStatusLabelOf('granted'), '已同意')
  assert.strictEqual(guardianConsentStatusLabelOf('withdrawn'), '已撤回')
  assert.strictEqual(guardianConsentStatusLabelOf('none'), '未同意')

  assert.strictEqual(consentVersionLabel(mapConsent(dtoOf())), VERSION)
  assert.strictEqual(
    consentVersionLabel(mapConsent(dtoOf({ status: 'none', consentVersion: null, grantedAt: null }))),
    '—',
    '没有版本号时要有占位符，不能留空（看起来像加载失败）'
  )

  assert.strictEqual(isDraftConsentVersion(mapConsent(dtoOf())), true)
  assert.strictEqual(
    isDraftConsentVersion(mapConsent(dtoOf({ consentVersion: '2026-10-27' }))),
    false,
    '去掉 -draft 就是正式版'
  )
  assert.strictEqual(
    isDraftConsentVersion(mapConsent(dtoOf({ status: 'none', consentVersion: null, grantedAt: null }))),
    true,
    '没有版本号说明还没同意过，提示「法务文本待替换」不算说谎'
  )
})

await checkAsync('W7-B types：同意 / 撤回文案带服务端时间，缺时间不编', () => {
  const granted = mapConsent(dtoOf())
  assert.ok(consentGrantedText(granted).endsWith(' 同意'))
  assert.ok(consentGrantedText(granted).includes('2026-10-27'))
  assert.strictEqual(consentWithdrawnText(granted), null)

  const withdrawn = mapConsent(
    dtoOf({ status: 'withdrawn', withdrawnAt: WITHDRAWN_AT })
  )
  assert.ok(consentWithdrawnText(withdrawn).endsWith(' 撤回'))
  assert.strictEqual(
    consentGrantedText(
      mapConsent(dtoOf({ status: 'none', consentVersion: null, grantedAt: null }))
    ),
    null,
    '没有同意时间就返回 null，让界面写「时间未知」'
  )
})

function clientWith(handler) {
  const seen = []
  const client = new WriteApiClient({
    config,
    transport: {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, headers, body, method })
        return handler({ uri, headers, body, method })
      }
    }
  })
  return { client, seen }
}

// ────────────────────────────────────── ③ store ──────────────────────────────────────

await checkAsync('W7-B store：打开面板才拉，刷新成员不带这次请求', async () => {
  const { store, readApi } = liveStore()

  assert.strictEqual(store.consentReadStatus, 'idle')
  assert.strictEqual(
    store.consent.status,
    'none',
    '未拉到时是「陌生」快照，不是服务端事实'
  )

  await store.refreshMembers()
  assert.strictEqual(
    readApi.calls.consent,
    0,
    'GET /consent 是 guardian 专属，不能塞进全局刷新（孩子每次都会吃 403）'
  )

  await store.refreshConsent()
  assert.strictEqual(readApi.calls.consent, 1)
  assert.strictEqual(store.consentReadStatus, 'ready')
  assert.strictEqual(store.consentError, null)
})

await checkAsync('W7-B store：孩子视角 canManageConsent 为 false，家长为 true', async () => {
  const child = liveStore({ members: [memberJson({ role: 'child' })] })
  await child.store.refreshMembers()
  assert.strictEqual(child.store.canManageConsent, false)

  const guardian = liveStore()
  await guardian.store.refreshMembers()
  assert.strictEqual(guardian.store.canManageConsent, true)
})

await checkAsync('W7-B store：拉取失败保留旧快照，403 照实上报', async () => {
  const { store, readApi } = liveStore()
  await store.refreshConsent()
  assert.strictEqual(store.consent.status, 'granted')

  readApi.setConsent(() => {
    throw new ReadApiException('forbidden', '你没有查看同意状态的权限。', {
      statusCode: 403,
      code: 'FORBIDDEN'
    })
  })
  await store.refreshConsent()

  assert.strictEqual(store.consentReadStatus, 'error')
  assert.strictEqual(store.consentError.code, 'FORBIDDEN')
  assert.strictEqual(
    store.consent.status,
    'granted',
    '失败不能把「已同意」改写成「未同意」—— 那是最坏的一种谎'
  )
  assert.ok(!store.consentError.userMessage.includes('403'))
})

await checkAsync('W7-B store：同意成功用回包替换快照，不重拉整份状态', async () => {
  const { store, readApi, writeApi } = liveStore()
  await store.refreshConsent()
  const before = readApi.calls.consent

  let notified = 0
  const unsubscribe = store.subscribe(() => {
    notified += 1
  })
  const error = await store.submitGrantConsent()
  unsubscribe()

  assert.strictEqual(error, null, '成功必须是 null（字符串都是要展示的失败原因）')
  assert.strictEqual(writeApi.calls.grant, 1)
  assert.strictEqual(store.consent.status, 'granted')
  assert.strictEqual(store.consent.grantedAt, GRANTED_AT)
  assert.strictEqual(store.consentReadStatus, 'ready')
  assert.strictEqual(store.consentError, null)
  assert.strictEqual(store.isConsentWriteBusy, false, '结束后必须解除忙碌')
  assert.strictEqual(
    readApi.calls.consent,
    before,
    '构造幂等的回包已经是最新事实，不用再 GET 一次'
  )
  assert.ok(notified > 0, '成功要通知界面重绘')
})

await checkAsync('W7-B store：同意在途再点 ⇒ 本地拦下，只有一次请求', async () => {
  const { store, writeApi } = liveStore()
  await store.refreshConsent()

  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  writeApi.setGrant(() => gate)

  const pending = store.submitGrantConsent()
  assert.strictEqual(store.isConsentWriteBusy, true)
  const blocked = await store.submitGrantConsent()
  assert.strictEqual(blocked, '上一次同意操作正在保存中，请稍候…')
  assert.strictEqual(writeApi.calls.grant, 1, '双击不能发两次请求')

  release(dtoOf())
  assert.strictEqual(await pending, null)
  assert.strictEqual(store.isConsentWriteBusy, false)
})

await checkAsync('W7-B store：同意 403 ⇒ 原样回报并重拉真状态', async () => {
  const { store, readApi, writeApi } = liveStore()
  await store.refreshConsent()
  const before = readApi.calls.consent

  readApi.setConsent(() =>
    dtoOf({ status: 'withdrawn', withdrawnAt: WITHDRAWN_AT })
  )
  writeApi.setGrant(() => {
    throw new WriteApiException('forbidden', '当前身份不能作出同意。', {
      statusCode: 403,
      code: 'FORBIDDEN'
    })
  })

  const error = await store.submitGrantConsent()

  assert.strictEqual(error, '当前身份不能作出同意。')
  assert.strictEqual(writeApi.calls.grant, 1)
  assert.strictEqual(
    readApi.calls.consent,
    before + 1,
    '403 说明本地快照可能过时（角色被降级），要拉一次真状态'
  )
  assert.strictEqual(store.consent.status, 'withdrawn', '界面要看到服务端事实')
  assert.strictEqual(store.isConsentWriteBusy, false)
})
await checkAsync('W7-B store：撤回成功落成 withdrawn，重复撤回本地拦下', async () => {
  const { store, writeApi } = liveStore()
  await store.refreshConsent()

  assert.strictEqual(await store.submitWithdrawConsent(), null)
  assert.strictEqual(writeApi.calls.withdraw, 1)
  assert.strictEqual(store.consent.status, 'withdrawn')
  assert.strictEqual(store.consent.withdrawnAt, WITHDRAWN_AT)

  const again = await store.submitWithdrawConsent()
  assert.strictEqual(again, '同意已经撤回过了，不需要重复撤回。')
  assert.strictEqual(writeApi.calls.withdraw, 1, '重复撤回不该打服务端')
})

await checkAsync('W7-B store：撤回 409 ⇒ 回报并重拉，快照跟服务端对齐', async () => {
  const { store, readApi, writeApi } = liveStore()
  await store.refreshConsent()
  const before = readApi.calls.consent

  readApi.setConsent(() => dtoOf())
  writeApi.setWithdraw(() => {
    throw new WriteApiException('conflict', '另一台设备刚刚改过同意状态。', {
      statusCode: 409,
      code: 'CONSENT_STATE_CHANGED'
    })
  })

  const error = await store.submitWithdrawConsent()

  assert.strictEqual(error, '另一台设备刚刚改过同意状态。')
  assert.strictEqual(readApi.calls.consent, before + 1)
  assert.strictEqual(store.consent.status, 'granted', '409 之后按服务端回包纠正')
  assert.strictEqual(store.isConsentWriteBusy, false)
})

await checkAsync('W7-B store：live 但没注入写客户端 ⇒ 拒绝写，不改内存', async () => {
  const readApi = fakeReadApi()
  const store = new AppStore(readApi, null)
  await store.refreshConsent()

  assert.strictEqual(store.isConsentWriteReadOnly, true)
  assert.strictEqual(
    await store.submitGrantConsent(),
    store.consentReadOnlyWriteMessage
  )
  assert.strictEqual(
    await store.submitWithdrawConsent(),
    store.consentReadOnlyWriteMessage
  )
  assert.strictEqual(store.consent.status, 'granted', '不能偷偷改内存')
})

await checkAsync('W7-B store：预览模式（无读客户端）⇒ 也拒绝写，且带上原因', async () => {
  const store = new AppStore(null, null)
  assert.strictEqual(store.isLiveMode, false)

  const granted = await store.submitGrantConsent()
  const withdrawn = await store.submitWithdrawConsent()

  assert.ok(granted.includes('预览模式'))
  assert.ok(withdrawn.includes('预览模式'))
  assert.strictEqual(store.consent.status, 'none')
})

await checkAsync('W7-B store：恢复演示数据会清掉同意快照', async () => {
  const { store } = liveStore()
  await store.refreshConsent()
  assert.strictEqual(store.consent.status, 'granted')

  const reset = store.resetToSeed()

  assert.strictEqual(reset, true, '开发构建下允许恢复演示数据')
  assert.strictEqual(
    store.consent.status,
    'none',
    '上一个孩子的「已同意」绝不能留给下一个孩子'
  )
  assert.strictEqual(store.consentReadStatus, 'idle')
  assert.strictEqual(store.consentError, null)
})


// ────────────────────────────────────── ④ 写客户端 ──────────────────────────────────────

await checkAsync('W7-B 客户端：POST /consent 只发 {accepted:true}，不带幂等键', async () => {
  const { client, seen } = clientWith(() => ({
    statusCode: 200,
    body: consentJson()
  }))

  const dto = await client.grantConsent()

  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].method, 'POST')
  assert.strictEqual(seen[0].uri, 'http://127.0.0.1:3000/consent')
  assert.deepStrictEqual(seen[0].body, { accepted: true })
  assert.strictEqual(seen[0].headers['x-kp-device-id'], 'device-1')
  assert.strictEqual(seen[0].headers['x-kp-child-id'], 'child-1')
  assert.strictEqual(
    seen[0].headers['Content-Type'],
    'application/json; charset=utf-8'
  )
  assert.strictEqual(
    seen[0].headers['idempotency-key'],
    undefined,
    '协议版本由服务端决定，重复调用天然幂等，不需要幂等键'
  )
  assert.strictEqual(dto.status, 'granted')
  assert.strictEqual(dto.grantedAt, GRANTED_AT)
})

await checkAsync('W7-B 客户端：同意回包不是 granted ⇒ malformed（不能画成已同意）', async () => {
  const { client } = clientWith(() => ({
    statusCode: 200,
    body: consentJson({
      status: 'withdrawn',
      withdrawnAt: new Date(WITHDRAWN_AT).toISOString()
    })
  }))

  let caught = null
  try {
    await client.grantConsent()
  } catch (error) {
    caught = error
  }
  expectWriteMalformed(() => {
    if (caught === null) throw new Error('没有抛错')
    throw caught
  })
})

await checkAsync('W7-B 客户端：撤回没有请求体，也不声明 Content-Type', async () => {
  const { client, seen } = clientWith(() => ({
    statusCode: 200,
    body: consentJson({
      status: 'withdrawn',
      withdrawnAt: new Date(WITHDRAWN_AT).toISOString()
    })
  }))

  const dto = await client.withdrawConsent()

  assert.strictEqual(seen[0].method, 'POST')
  assert.strictEqual(seen[0].uri, 'http://127.0.0.1:3000/consent/withdraw')
  assert.strictEqual(seen[0].body, null, '目标孩子由会话决定，没有请求体')
  assert.strictEqual(
    seen[0].headers['Content-Type'],
    undefined,
    '没有请求体就不要声明 Content-Type'
  )
  assert.strictEqual(seen[0].headers['idempotency-key'], undefined)
  assert.strictEqual(dto.status, 'withdrawn')
})

await checkAsync('W7-B 客户端：撤回回包 granted ⇒ malformed（撤回没有生效）', async () => {
  const { client } = clientWith(() => ({
    statusCode: 200,
    body: consentJson()
  }))

  let caught = null
  try {
    await client.withdrawConsent()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof WriteApiException, '应抛 WriteApiException')
  assert.strictEqual(caught.kind, 'malformed')
  assert.ok(
    (caught.detail ?? '').includes('granted'),
    'detail 要说清是「回包还是 granted」，方便定位'
  )
})

await checkAsync('W7-B 客户端：403 / 500 各自归一，用户文案不暴露内部细节', async () => {
  const forbidden = clientWith(() => ({
    statusCode: 403,
    body: { code: 'FORBIDDEN', message: 'forbidden' }
  }))
  let caught = null
  try {
    await forbidden.client.grantConsent()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof WriteApiException)
  assert.strictEqual(caught.kind, 'forbidden')
  assert.strictEqual(caught.code, 'FORBIDDEN')
  assert.ok(caught.userMessage.includes('权限'), '403 的文案要说清是权限问题')
  assert.ok(
    !caught.userMessage.includes('FORBIDDEN'),
    '用户文案不该出现服务端错误码'
  )

  const missing = clientWith(() => ({
    statusCode: 500,
    body: {
      code: 'CONSENT_VERSION_MISSING',
      message: 'consent version missing'
    }
  }))
  caught = null
  try {
    await missing.client.grantConsent()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof WriteApiException)
  assert.strictEqual(caught.code, 'CONSENT_VERSION_MISSING')
  assert.ok(
    !caught.userMessage.includes('CONSENT_VERSION_MISSING'),
    '用户文案不该出现服务端错误码'
  )
})

// ────────────────────────────────────── 汇总 ──────────────────────────────────────

console.log('')
if (failed === 0) {
  console.log('W7-B 全部用例通过')
  process.exitCode = 0
} else {
  console.log(`W7-B 有 ${failed} 条用例失败`)
  process.exitCode = 1
}


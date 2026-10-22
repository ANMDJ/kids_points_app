/**
 * W5-I 邀请码（`GET /invites` ＋ 生成 / 吊销）的**异步**运行时用例。
 *
 * 结构照抄 `run-w5h.mjs`（CommonJS 没有顶层 await，D12 守卫不允许把汇总
 * 塞进回调）：顶层 await → 顶层汇总 → 顶层退出码。
 *
 * 编译（项目约定）：
 *   npx tsc -p .tmp_test/tsconfig.test.json   # rootDir ../src → 产物落在 .tmp_test/dist
 *   node .tmp_test/run-w5i.mjs
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
const { InviteDto, InviteListDto } = require('./dist/data/read_dto.js')
const { mapInvite, mapInvites } = require('./dist/data/read_mapper.js')
const { ReadApiException } = require('./dist/data/read_api_errors.js')
const { WriteApiClient } = require('./dist/data/write_api.js')
const { WriteApiException } = require('./dist/data/write_api_errors.js')
const {
  inviteDisplayCode,
  inviteExpiresText,
  inviteRemainingUses,
  inviteRoleLabelOf,
  inviteStatusLabelOf,
  inviteStatusOf,
  inviteUsageText
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

const NOW = Date.parse('2026-10-10T10:00:00.000Z')
const CREATED = new Date('2026-10-01T10:00:00.000Z').toISOString()

/** 一个码的线值；`expiresAt` 默认在 `NOW` 之后（可用）。 */
function inviteJson(overrides = {}) {
  return {
    id: 'inv-1',
    code: 'ABCD2345',
    role: 'child',
    maxUses: 3,
    usedCount: 0,
    expiresAt: new Date(NOW + 7 * 24 * 3600 * 1000).toISOString(),
    revoked: false,
    createdAt: CREATED,
    ...overrides
  }
}

function inviteListJson(items = [inviteJson()]) {
  return InviteListDto.fromJson({ items })
}

function dtoOf(overrides = {}) {
  return new InviteDto(
    overrides.id ?? 'inv-1',
    overrides.code ?? 'ABCD2345',
    overrides.role ?? 'child',
    overrides.maxUses ?? 3,
    overrides.usedCount ?? 0,
    overrides.expiresAt ?? NOW + 7 * 24 * 3600 * 1000,
    overrides.revoked ?? false,
    overrides.createdAt ?? Date.parse(CREATED)
  )
}

function fakeReadApi(options = {}) {
  const calls = { invites: 0 }
  let invitesSource = options.invites ?? (() => inviteListJson())
  return {
    calls,
    setInvites(next) {
      invitesSource = next
    },
    async fetchInvites() {
      calls.invites += 1
      return invitesSource()
    }
  }
}

function fakeWriteApi(options = {}) {
  const calls = { create: [], revoke: [] }
  return {
    calls,
    async createInvite(input) {
      calls.create.push({ ...input })
      if (options.create) return options.create(input)
      return dtoOf({
        id: 'inv-new',
        code: 'NEWW8888',
        role: input.role,
        maxUses: input.maxUses
      })
    },
    async revokeInvite(inviteId) {
      calls.revoke.push(inviteId)
      if (options.revoke) return options.revoke(inviteId)
      return { id: inviteId, revoked: true }
    }
  }
}

// ────────────────────────────── 派生结论：状态 / 文案（客户端现算） ──────────────────────────────

await checkAsync('W5-I types：状态优先级 已吊销 > 已用完 > 已过期 > 可用', () => {
  assert.strictEqual(inviteStatusOf(dtoOf(), NOW), 'usable')
  assert.strictEqual(
    inviteStatusOf(dtoOf({ expiresAt: NOW - 1 }), NOW),
    'expired'
  )
  assert.strictEqual(
    inviteStatusOf(dtoOf({ expiresAt: NOW }), NOW),
    'expired',
    '到期时刻本身就算过期（与 inviteIsExpiredAt 同口径）'
  )
  assert.strictEqual(
    inviteStatusOf(dtoOf({ usedCount: 3, expiresAt: NOW - 1 }), NOW),
    'exhausted',
    '已经用完的码没必要说「过期」'
  )
  assert.strictEqual(
    inviteStatusOf(
      dtoOf({ revoked: true, usedCount: 3, expiresAt: NOW - 1 }),
      NOW
    ),
    'revoked',
    '吊销是家长主动做的事，永远第一条'
  )
})

await checkAsync('W5-I types：剩余名额夹到 0，徽标 / 角色 / 用量文案', () => {
  assert.strictEqual(inviteRemainingUses(dtoOf({ maxUses: 3, usedCount: 1 })), 2)
  assert.strictEqual(
    inviteRemainingUses(dtoOf({ maxUses: 1, usedCount: 1 })),
    0,
    '用完就是 0，不能是负数'
  )
  assert.strictEqual(inviteStatusLabelOf('usable'), '可用')
  assert.strictEqual(inviteStatusLabelOf('exhausted'), '已用完')
  assert.strictEqual(inviteStatusLabelOf('expired'), '已过期')
  assert.strictEqual(inviteStatusLabelOf('revoked'), '已吊销')
  assert.strictEqual(inviteRoleLabelOf('guardian'), '家长')
  assert.strictEqual(inviteRoleLabelOf('child'), '孩子')
  assert.strictEqual(inviteUsageText(dtoOf({ maxUses: 3, usedCount: 1 })), '已用 1/3')
})

await checkAsync('W5-I types：展示码 8 位才分组，其它长度原样', () => {
  assert.strictEqual(inviteDisplayCode('ABCD2345'), 'ABCD-2345')
  assert.strictEqual(inviteDisplayCode('ABCD-2345'), 'ABCD-2345')
  assert.strictEqual(inviteDisplayCode('SHORT'), 'SHORT')
  assert.strictEqual(
    /^有效至 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(
      inviteExpiresText(Date.parse('2026-10-18T10:30:00.000Z'))
    ),
    true,
    '按本地时区展示绝对时间，不显示相对天数'
  )
  assert.strictEqual(inviteExpiresText(Number.NaN), '有效期未知')
})

// ───────────────────────────── 映射：不认识的事实必须显式失败 ─────────────────────────────

await checkAsync('W5-I mapper：viewer / 空码 / 越界用量 ⇒ malformed', () => {
  assert.throws(
    () => mapInvites(inviteListJson([inviteJson({ role: 'viewer' })])),
    (error) =>
      error instanceof ReadApiException &&
      error.kind === 'malformed' &&
      error.userMessage.includes('role'),
    '`viewer` 不是可邀请角色，猜成孩子就是一次权限漂移'
  )
  assert.throws(
    () => mapInvites(inviteListJson([inviteJson({ code: '  ' })])),
    (error) => error instanceof ReadApiException && error.kind === 'malformed',
    '空码复制出去什么都做不了'
  )
  assert.throws(
    () => mapInvites(inviteListJson([inviteJson({ maxUses: 0 })])),
    (error) => error instanceof ReadApiException && error.kind === 'malformed'
  )
  assert.throws(
    () =>
      mapInvites(inviteListJson([inviteJson({ maxUses: 1, usedCount: 2 })])),
    (error) =>
      error instanceof ReadApiException &&
      error.kind === 'malformed' &&
      error.userMessage.includes('usedCount')
  )
})

await checkAsync('W5-I mapper：合法行逐个字段落到 InviteCode', () => {
  const rows = mapInvites(
    inviteListJson([
      inviteJson(),
      inviteJson({ id: 'inv-2', code: 'ZZZZ9999', role: 'guardian', maxUses: 1 })
    ])
  )
  assert.strictEqual(rows.length, 2)
  assert.deepStrictEqual(
    { ...rows[0] },
    {
      id: 'inv-1',
      code: 'ABCD2345',
      role: 'child',
      maxUses: 3,
      usedCount: 0,
      expiresAt: NOW + 7 * 24 * 3600 * 1000,
      revoked: false,
      createdAt: Date.parse(CREATED)
    }
  )
  assert.strictEqual(rows[1].role, 'guardian')
  assert.strictEqual(mapInvite(dtoOf()).id, 'inv-1')
})

// ───────────────────────────── store：拉取 / 角色判定 ─────────────────────────────

const { MemberListDto } = require('./dist/data/read_dto.js')

function memberJson(overrides = {}) {
  return {
    memberId: 'm1',
    userId: 'u1',
    displayName: '妈妈',
    role: 'guardian',
    status: 'active',
    joinedAt: CREATED,
    removedAt: null,
    isSelf: true,
    ...overrides
  }
}

/** 给读客户端补上 `fetchMembers`：角色判定要先有「自己那一行」。 */
function withMembers(readApi, items = [memberJson()]) {
  readApi.calls.members = 0
  readApi.fetchMembers = async () => {
    readApi.calls.members += 1
    return MemberListDto.fromJson({ items })
  }
  return readApi
}

await checkAsync('W5-I store：refreshInvites 拉服务端列表并映射', async () => {
  const readApi = fakeReadApi()
  const store = new AppStore(readApi, fakeWriteApi())
  assert.strictEqual(store.invitesReadStatus, 'idle')
  assert.strictEqual(store.invites.length, 0, '打开面板前不该有邀请码')

  await store.refreshInvites()
  assert.strictEqual(readApi.calls.invites, 1)
  assert.strictEqual(store.invitesReadStatus, 'ready')
  assert.strictEqual(store.invitesError, null)
  assert.strictEqual(store.invites.length, 1)
  assert.strictEqual(store.invites[0].code, 'ABCD2345')
})

await checkAsync('W5-I store：拉取失败保留旧列表，403 照实上报', async () => {
  const readApi = fakeReadApi()
  const store = new AppStore(readApi, fakeWriteApi())
  await store.refreshInvites()

  readApi.setInvites(() => {
    throw new ReadApiException('forbidden', '你没有查看邀请码的权限。', {
      statusCode: 403,
      code: 'FORBIDDEN'
    })
  })
  await store.refreshInvites()
  assert.strictEqual(store.invitesReadStatus, 'error')
  assert.strictEqual(store.invitesError.code, 'FORBIDDEN')
  assert.strictEqual(store.invites.length, 1, '失败不能画成「还没有邀请码」')
})

await checkAsync('W5-I store：canManageInvites 只看自己那一行的角色', async () => {
  const guardianStore = new AppStore(
    withMembers(fakeReadApi()),
    fakeWriteApi()
  )
  await guardianStore.refreshMembers()
  assert.strictEqual(guardianStore.canManageInvites, true)

  const childStore = new AppStore(
    withMembers(fakeReadApi(), [memberJson({ role: 'child' })]),
    fakeWriteApi()
  )
  await childStore.refreshMembers()
  assert.strictEqual(
    childStore.canManageInvites,
    false,
    '孩子不能生成邀请码 —— 界面据此连请求都不发'
  )
})

// ───────────────────────────── store：生成 / 吊销 ─────────────────────────────

await checkAsync('W5-I store：生成成功 ⇒ 新码插到列表头，参数原样发出', async () => {
  const readApi = fakeReadApi({
    invites: () =>
      inviteListJson([inviteJson(), inviteJson({ id: 'inv-2', code: 'ZZZZ9999' })])
  })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshInvites()
  const before = readApi.calls.invites

  const message = await store.submitCreateInvite({
    role: 'child',
    maxUses: 5,
    expiresInDays: 7
  })
  assert.strictEqual(message, null)
  assert.deepStrictEqual(writeApi.calls.create, [
    { role: 'child', maxUses: 5, expiresInDays: 7 }
  ])
  assert.strictEqual(readApi.calls.invites, before, '成功后不重拉整页')
  assert.deepStrictEqual(
    store.invites.map((row) => row.id),
    ['inv-new', 'inv-1', 'inv-2'],
    '刚生成的码必须排第一 —— 家长马上要复制它'
  )
  assert.strictEqual(store.isInviteWriteBusy, false, '忙碌标记要复位')
})

await checkAsync('W5-I store：生成 409 ⇒ 返回原因并重拉（撞码 / 角色变了）', async () => {
  const readApi = fakeReadApi()
  const writeApi = fakeWriteApi({
    create: () => {
      throw new WriteApiException(
        'conflict',
        '服务端连续生成的邀请码都撞上了已有码，这次没有生成。请再试一次。',
        { statusCode: 409, code: 'INVITE_CODE_GENERATION_FAILED' }
      )
    }
  })
  const store = new AppStore(readApi, writeApi)
  await store.refreshInvites()
  const before = readApi.calls.invites

  const message = await store.submitCreateInvite({
    role: 'guardian',
    maxUses: 1,
    expiresInDays: 1
  })
  assert.ok(message.includes('撞上了已有码'), message)
  assert.strictEqual(readApi.calls.invites, before + 1, '409 后必须重拉')
  assert.strictEqual(store.isInviteWriteBusy, false)
})

await checkAsync('W5-I store：非法角色在本地就拒，一次请求都不发', async () => {
  const writeApi = fakeWriteApi()
  const store = new AppStore(fakeReadApi(), writeApi)
  const message = await store.submitCreateInvite({
    role: 'viewer',
    maxUses: 1,
    expiresInDays: 7
  })
  assert.ok(message.includes('孩子'), message)
  assert.strictEqual(writeApi.calls.create.length, 0)
})

await checkAsync('W5-I store：吊销只把那一行标成已吊销，其余字段不动', async () => {
  const readApi = fakeReadApi({
    invites: () =>
      inviteListJson([
        inviteJson({ maxUses: 3, usedCount: 1 }),
        inviteJson({ id: 'inv-2', code: 'ZZZZ9999', role: 'guardian' })
      ])
  })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshInvites()

  const message = await store.submitRevokeInvite(store.invites[0])
  assert.strictEqual(message, null)
  assert.deepStrictEqual(writeApi.calls.revoke, ['inv-1'])
  assert.strictEqual(store.invites[0].revoked, true)
  assert.strictEqual(store.invites[0].usedCount, 1, '吊销不改用量事实')
  assert.strictEqual(store.invites[0].code, 'ABCD2345')
  assert.strictEqual(store.invites[1].revoked, false, '别的行不该被波及')
  assert.strictEqual(store.busyInviteId, null)
})

await checkAsync('W5-I store：已吊销的码再吊销 ⇒ 本地拒绝，不发请求', async () => {
  const readApi = fakeReadApi({
    invites: () => inviteListJson([inviteJson({ revoked: true })])
  })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshInvites()

  const message = await store.submitRevokeInvite(store.invites[0])
  assert.ok(message.includes('已经吊销过'), message)
  assert.strictEqual(writeApi.calls.revoke.length, 0)
})

await checkAsync('W5-I store：live 但没注入写客户端 ⇒ 拒绝写，不改内存', async () => {
  const store = new AppStore(fakeReadApi(), null)
  await store.refreshInvites()
  assert.strictEqual(store.isInviteWriteReadOnly, true)

  const created = await store.submitCreateInvite({
    role: 'child',
    maxUses: 1,
    expiresInDays: 7
  })
  assert.strictEqual(created, store.inviteReadOnlyWriteMessage)
  const revoked = await store.submitRevokeInvite(store.invites[0])
  assert.strictEqual(revoked, store.inviteReadOnlyWriteMessage)
  assert.strictEqual(store.invites[0].revoked, false, '不能偷偷改内存')
})

// ───────────────────────────── 客户端：路径 / 请求体 / 回包校验 ─────────────────────────────

await checkAsync('W5-I 客户端：POST /invites 只发三个字段，且不带幂等键', async () => {
  const seen = []
  const client = new WriteApiClient({
    config,
    transport: {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, headers, body, method })
        return {
          statusCode: 201,
          body: inviteJson({ id: 'inv-new', code: 'NEWW8888', maxUses: 2 })
        }
      }
    }
  })
  const written = await client.createInvite({
    role: 'child',
    maxUses: 2,
    expiresInDays: 7
  })
  assert.strictEqual(written.id, 'inv-new')
  assert.strictEqual(written.code, 'NEWW8888')
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].method, 'POST')
  assert.ok(seen[0].uri.endsWith('/invites'), seen[0].uri)
  assert.deepStrictEqual(seen[0].body, {
    role: 'child',
    maxUses: 2,
    expiresInDays: 7
  })
  assert.strictEqual(
    seen[0].headers['idempotency-key'],
    undefined,
    '每次生成都该是新码：带幂等键会让重放拿回同一张票'
  )
})

await checkAsync('W5-I 客户端：回包 role / maxUses 与请求不一致 ⇒ malformed', async () => {
  const wrongRole = new WriteApiClient({
    config,
    transport: {
      async send() {
        return {
          statusCode: 201,
          body: inviteJson({ role: 'guardian', maxUses: 2 })
        }
      }
    }
  })
  await assert.rejects(
    () => wrongRole.createInvite({ role: 'child', maxUses: 2, expiresInDays: 7 }),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'malformed' &&
      error.detail.includes('role'),
    '要的是孩子码、回包却是家长码 ⇒ 发出去就是权限事故'
  )

  const wrongUses = new WriteApiClient({
    config,
    transport: {
      async send() {
        return { statusCode: 201, body: inviteJson({ maxUses: 3 }) }
      }
    }
  })
  await assert.rejects(
    () => wrongUses.createInvite({ role: 'child', maxUses: 2, expiresInDays: 7 }),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'malformed' &&
      error.detail.includes('maxUses'),
    '名额被悄悄改写会让「发给 2 个人」变成「发给 3 个人」'
  )
})

await checkAsync('W5-I 客户端：参数越界在本地就拒，一次请求都不发', async () => {
  let calls = 0
  const client = new WriteApiClient({
    config,
    transport: {
      async send() {
        calls += 1
        return { statusCode: 201, body: inviteJson() }
      }
    }
  })
  await assert.rejects(
    () => client.createInvite({ role: 'child', maxUses: 0, expiresInDays: 7 }),
    (error) => error.message.includes('1–10')
  )
  await assert.rejects(
    () => client.createInvite({ role: 'child', maxUses: 1, expiresInDays: 31 }),
    (error) => error.message.includes('1–30')
  )
  await assert.rejects(
    () => client.createInvite({ role: 'viewer', maxUses: 1, expiresInDays: 7 }),
    (error) => error.message.includes('guardian')
  )
  assert.strictEqual(calls, 0)
})

await checkAsync('W5-I 客户端：POST /invites/:id/revoke 无请求体，回包 id 不符 ⇒ malformed', async () => {
  const seen = []
  const client = new WriteApiClient({
    config,
    transport: {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, headers, body, method })
        return { statusCode: 200, body: { id: 'inv-1', revoked: true } }
      }
    }
  })
  const written = await client.revokeInvite('inv-1')
  assert.strictEqual(written.id, 'inv-1')
  assert.strictEqual(written.revoked, true)
  assert.strictEqual(seen[0].method, 'POST')
  assert.strictEqual(seen[0].body, null, '吊销不带 body')
  assert.ok(seen[0].uri.endsWith('/invites/inv-1/revoke'), seen[0].uri)
  assert.strictEqual(seen[0].headers['Content-Type'], undefined)

  const wrongId = new WriteApiClient({
    config,
    transport: {
      async send() {
        return { statusCode: 200, body: { id: 'inv-9', revoked: true } }
      }
    }
  })
  await assert.rejects(
    () => wrongId.revokeInvite('inv-1'),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'malformed' &&
      error.detail.includes('inv-9')
  )

  const notRevoked = new WriteApiClient({
    config,
    transport: {
      async send() {
        return { statusCode: 200, body: { id: 'inv-1', revoked: false } }
      }
    }
  })
  await assert.rejects(
    () => notRevoked.revokeInvite('inv-1'),
    (error) =>
      error instanceof WriteApiException && error.kind === 'malformed',
    '200 但 revoked=false 是自相矛盾的回包'
  )
})

await checkAsync('W5-I 客户端：404 INVITE_NOT_FOUND / 409 撞码 各自归一', async () => {
  const notFound = new WriteApiClient({
    config,
    transport: {
      async send() {
        return {
          statusCode: 404,
          body: { code: 'INVITE_NOT_FOUND', message: 'invite not found' }
        }
      }
    }
  })
  await assert.rejects(
    () => notFound.revokeInvite('inv-1'),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'notFound' &&
      error.userMessage.includes('不存在')
  )

  const generationFailed = new WriteApiClient({
    config,
    transport: {
      async send() {
        return {
          statusCode: 409,
          body: { code: 'INVITE_CODE_GENERATION_FAILED', message: 'collision' }
        }
      }
    }
  })
  await assert.rejects(
    () =>
      generationFailed.createInvite({
        role: 'child',
        maxUses: 1,
        expiresInDays: 7
      }),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'conflict' &&
      error.userMessage.includes('再试一次'),
    '撞码不是用户的错，也不该说成网络问题'
  )
})

// ────────────────────────────────────── 汇总 ──────────────────────────────────────

if (failed > 0) {
  console.log(`\n${failed} 条用例失败`)
  process.exit(1)
}
console.log('\nW5-I ALL PASS')





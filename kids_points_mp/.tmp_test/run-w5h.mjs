/**
 * W5-H 家庭成员（`GET /members` ＋ 改角色 / 移出）的**异步**运行时用例。
 *
 * 与 `run-w5f.mjs` 同样的结构（CommonJS 没有顶层 await，D12 守卫不允许把
 * 汇总塞进回调）：顶层 await → 顶层汇总 → 顶层退出码。
 *
 * 编译（项目约定）：
 *   npx tsc -p .tmp_test/tsconfig.test.json   # rootDir ../src → 产物落在 .tmp_test/dist
 *   node .tmp_test/run-w5h.mjs
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
const { MemberListDto, MemberDto } = require('./dist/data/read_dto.js')
const { mapMembers } = require('./dist/data/read_mapper.js')
const { WriteApiClient } = require('./dist/data/write_api.js')
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

const config = new ReadApiConfig(
  'http://127.0.0.1:3000/',
  'device-1',
  'child-1'
)

const JOINED = new Date('2026-10-01T10:00:00.000Z').toISOString()

function memberJson(overrides = {}) {
  return {
    memberId: 'm1',
    userId: 'u1',
    displayName: '妈妈',
    role: 'guardian',
    status: 'active',
    joinedAt: JOINED,
    removedAt: null,
    isSelf: true,
    ...overrides
  }
}

function memberListJson(items = [memberJson()]) {
  return MemberListDto.fromJson({ items })
}

function dtoOf(overrides = {}) {
  return new MemberDto(
    overrides.memberId ?? 'm1',
    overrides.userId ?? 'u1',
    overrides.displayName === undefined ? '妈妈' : overrides.displayName,
    overrides.role ?? 'guardian',
    overrides.status ?? 'active',
    Date.parse(JOINED),
    overrides.removedAt ?? null,
    overrides.isSelf ?? true
  )
}

function fakeReadApi(options = {}) {
  const calls = { members: 0 }
  let membersSource = options.members ?? (() => memberListJson())
  return {
    calls,
    setMembers(next) {
      membersSource = next
    },
    async fetchMembers() {
      calls.members += 1
      return membersSource()
    }
  }
}

function fakeWriteApi(options = {}) {
  const calls = { changeRole: [], remove: [] }
  return {
    calls,
    async changeMemberRole(memberId, role) {
      calls.changeRole.push({ memberId, role })
      if (options.changeRole) return options.changeRole(memberId, role)
      return dtoOf({ memberId, role })
    },
    async removeMember(memberId) {
      calls.remove.push(memberId)
      if (options.remove) return options.remove(memberId)
      return { memberId, status: 'removed', removedAt: Date.now() }
    }
  }
}


// ───────────────────────────── 映射：不认识的角色必须显式失败 ─────────────────────────────

await checkAsync('W5-H mapper：未知 role / status 抛 malformed，不猜成孩子', () => {
  assert.throws(
    () => mapMembers(memberListJson([memberJson({ role: 'owner' })])),
    (error) =>
      error instanceof ReadApiException &&
      error.kind === 'malformed' &&
      error.userMessage.includes('role'),
    '未知 role 不能被当成合法成员'
  )
  assert.throws(
    () => mapMembers(memberListJson([memberJson({ status: 'deleted' })])),
    (error) => error instanceof ReadApiException && error.kind === 'malformed'
  )
})

await checkAsync('W5-H mapper：displayName=null 保留为 null（界面用「未命名成员」占位）', () => {
  const rows = mapMembers(memberListJson([memberJson({ displayName: null })]))
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].displayName, null)
  assert.strictEqual(rows[0].isSelf, true)
})

// ───────────────────────────── store：拉取 / 能力派生 ─────────────────────────────

await checkAsync('W5-H store：refreshMembers 拉服务端列表，家长身份 ⇒ 可管理', async () => {
  const readApi = fakeReadApi({
    members: () =>
      memberListJson([
        memberJson(),
        memberJson({
          memberId: 'm2',
          userId: 'u2',
          displayName: '小明',
          role: 'child',
          isSelf: false
        })
      ])
  })
  const store = new AppStore(readApi, fakeWriteApi())
  assert.strictEqual(store.memberStatus, 'idle')
  assert.strictEqual(store.members.length, 0, '打开弹窗前不该有成员数据')

  await store.refreshMembers()
  assert.strictEqual(readApi.calls.members, 1)
  assert.strictEqual(store.memberStatus, 'ready')
  assert.strictEqual(store.members.length, 2)
  assert.strictEqual(store.selfMember.memberId, 'm1')
  assert.strictEqual(store.canManageMembers, true)
})

await checkAsync('W5-H store：自己是孩子 ⇒ canManageMembers=false（不靠猜）', async () => {
  const readApi = fakeReadApi({
    members: () =>
      memberListJson([
        memberJson({ role: 'child' }),
        memberJson({
          memberId: 'm2',
          userId: 'u2',
          displayName: '爸爸',
          role: 'guardian',
          isSelf: false
        })
      ])
  })
  const store = new AppStore(readApi, fakeWriteApi())
  await store.refreshMembers()
  assert.strictEqual(store.canManageMembers, false)
})

await checkAsync('W5-H store：拉取失败保留已有列表，错误照实上报', async () => {
  const readApi = fakeReadApi()
  const store = new AppStore(readApi, fakeWriteApi())
  await store.refreshMembers()
  assert.strictEqual(store.members.length, 1)

  readApi.setMembers(() => {
    throw new ReadApiException('forbidden', '你没有查看成员的权限。', {
      statusCode: 403,
      code: 'FORBIDDEN'
    })
  })
  await store.refreshMembers()
  assert.strictEqual(store.memberStatus, 'error')
  assert.strictEqual(store.memberError.code, 'FORBIDDEN')
  assert.strictEqual(store.members.length, 1, '失败不能把列表画成「家庭空了」')
})

// ───────────────────────────── store：改角色 / 移出 ─────────────────────────────

await checkAsync('W5-H store：改角色以回包为准，只替换那一行', async () => {
  const readApi = fakeReadApi({
    members: () =>
      memberListJson([
        memberJson(),
        memberJson({
          memberId: 'm2',
          userId: 'u2',
          displayName: '小明',
          role: 'child',
          isSelf: false
        })
      ])
  })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshMembers()

  const child = store.members[1]
  const message = await store.submitChangeMemberRole(child)
  assert.strictEqual(message, null)
  assert.deepStrictEqual(writeApi.calls.changeRole, [
    { memberId: 'm2', role: 'guardian' }
  ])
  assert.strictEqual(store.members[1].role, 'guardian')
  assert.strictEqual(store.members[0].role, 'guardian', '自己那一行不该被波及')
  assert.strictEqual(store.busyMemberId, null)
})

await checkAsync('W5-H store：改自己 / 移出自己在本地就拒，一次请求都不发', async () => {
  const readApi = fakeReadApi()
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshMembers()
  const self = store.selfMember

  assert.ok((await store.submitChangeMemberRole(self)).includes('不能修改自己'))
  assert.ok((await store.submitRemoveMember(self)).includes('不能移出自己'))
  assert.strictEqual(writeApi.calls.changeRole.length, 0)
  assert.strictEqual(writeApi.calls.remove.length, 0)
})

await checkAsync('W5-H store：移出成功 ⇒ 该行从列表消失，其余保留', async () => {
  const readApi = fakeReadApi({
    members: () =>
      memberListJson([
        memberJson(),
        memberJson({
          memberId: 'm2',
          userId: 'u2',
          displayName: '小明',
          role: 'child',
          isSelf: false
        })
      ])
  })
  const writeApi = fakeWriteApi()
  const store = new AppStore(readApi, writeApi)
  await store.refreshMembers()

  const message = await store.submitRemoveMember(store.members[1])
  assert.strictEqual(message, null)
  assert.deepStrictEqual(writeApi.calls.remove, ['m2'])
  assert.deepStrictEqual(
    store.members.map((row) => row.memberId),
    ['m1']
  )
  assert.strictEqual(store.busyMemberId, null)
})

await checkAsync('W5-H store：409 ⇒ 返回原因并重拉（本地行已过时）', async () => {
  const readApi = fakeReadApi({
    members: () =>
      memberListJson([
        memberJson(),
        memberJson({
          memberId: 'm2',
          userId: 'u2',
          displayName: '小明',
          role: 'child',
          isSelf: false
        })
      ])
  })
  const writeApi = fakeWriteApi({
    changeRole: () => {
      throw new WriteApiException('conflict', '这个成员已经变了，请刷新后再试。', {
        statusCode: 409,
        code: 'MEMBER_NOT_ACTIVE'
      })
    }
  })
  const store = new AppStore(readApi, writeApi)
  await store.refreshMembers()
  const before = readApi.calls.members

  readApi.setMembers(() => memberListJson([memberJson()]))
  const message = await store.submitChangeMemberRole(store.members[1])
  assert.strictEqual(message, '这个成员已经变了，请刷新后再试。')
  assert.strictEqual(readApi.calls.members, before + 1, '409 后必须重拉')
  assert.strictEqual(store.members.length, 1)
})

await checkAsync('W5-H store：live 但没注入写客户端 ⇒ 拒绝写，不改内存', async () => {
  const readApi = fakeReadApi({
    members: () =>
      memberListJson([
        memberJson(),
        memberJson({
          memberId: 'm2',
          userId: 'u2',
          displayName: '小明',
          role: 'child',
          isSelf: false
        })
      ])
  })
  const store = new AppStore(readApi, null)
  await store.refreshMembers()
  const message = await store.submitRemoveMember(store.members[1])
  assert.strictEqual(message, store.memberReadOnlyWriteMessage)
  assert.strictEqual(store.members.length, 2, '不能偷偷改内存')
})


// ───────────────────────────── 客户端：路径 / 回包身份校验 ─────────────────────────────

await checkAsync('W5-H 客户端：PATCH /members/:id 只发 role，回包 role / id 不符 ⇒ malformed', async () => {
  const seen = []
  const client = new WriteApiClient({
    config,
    transport: {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, body, method })
        return { statusCode: 200, body: memberJson({ role: 'child', isSelf: false }) }
      }
    }
  })
  const written = await client.changeMemberRole('m1', 'child')
  assert.strictEqual(written.memberId, 'm1')
  assert.strictEqual(seen.length, 1)
  assert.strictEqual(seen[0].method, 'PATCH')
  assert.ok(seen[0].uri.endsWith('/members/m1'), seen[0].uri)
  assert.deepStrictEqual(seen[0].body, { role: 'child' })

  const wrongRole = new WriteApiClient({
    config,
    transport: {
      async send() {
        return { statusCode: 200, body: memberJson({ role: 'guardian' }) }
      }
    }
  })
  await assert.rejects(
    () => wrongRole.changeMemberRole('m1', 'child'),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'malformed' &&
      error.detail.includes('role')
  )

  const wrongId = new WriteApiClient({
    config,
    transport: {
      async send() {
        return { statusCode: 200, body: memberJson({ memberId: 'm9', role: 'child' }) }
      }
    }
  })
  await assert.rejects(
    () => wrongId.changeMemberRole('m1', 'child'),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'malformed' &&
      error.detail.includes('m9')
  )
})

await checkAsync('W5-H 客户端：DELETE /members/:id 无请求体，回包 id 不符 ⇒ malformed', async () => {
  const seen = []
  const client = new WriteApiClient({
    config,
    transport: {
      async send(uri, headers, body, timeoutMs, method) {
        seen.push({ uri, body, method })
        return {
          statusCode: 200,
          body: {
            memberId: 'm2',
            status: 'removed',
            removedAt: new Date().toISOString()
          }
        }
      }
    }
  })
  const written = await client.removeMember('m2')
  assert.strictEqual(written.memberId, 'm2')
  assert.strictEqual(written.status, 'removed')
  assert.strictEqual(seen[0].method, 'DELETE')
  assert.strictEqual(seen[0].body, null, 'DELETE 不带 body')
  assert.ok(seen[0].uri.endsWith('/members/m2'), seen[0].uri)

  const wrong = new WriteApiClient({
    config,
    transport: {
      async send() {
        return {
          statusCode: 200,
          body: {
            memberId: 'm3',
            status: 'removed',
            removedAt: new Date().toISOString()
          }
        }
      }
    }
  })
  await assert.rejects(
    () => wrong.removeMember('m2'),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'malformed' &&
      error.detail.includes('m3')
  )
})

// ────────────────────────────────────── 汇总 ──────────────────────────────────────

if (failed > 0) {
  console.log(`\n${failed} 条用例失败`)
  process.exit(1)
}
console.log('\nW5-H ALL PASS')


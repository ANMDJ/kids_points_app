/**
 * W8-B 首启引导的**异步**运行时用例（小程序端）。
 *
 * 结构照抄 `run-w7d.mjs`：顶层 await → 顶层汇总 → 顶层退出码（D12 守卫）。
 *
 * 这一轮经过**真** `OnboardingApiClient`（注入假传输层）与真 `AppStore`：
 *   ① 第③④步的三种意图（未传 / `null` / `[]`）在请求体里必须真的不同；
 *   ② 第⑤步的 slug 去重与 PIN 省略（**不发** `parentPin`）；
 *   ③ 引导回包形状自相矛盾时一律 malformed（不画成「已完成」）；
 *   ④ `onboarded: false` 才要求引导；403 / 500 放行（不能把应用锁死）；
 *   ⑤ 完成引导后：奖励约定加习惯、扣分约定不加，且不掩盖单条失败。
 *
 * 编译：npx tsc -p .tmp_test/tsconfig.test.json && node .tmp_test/run-w8b.mjs
 */
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

/** 纯 Node 无法 require 真实的 `@tarojs/taro`。 */
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
const { WriteApiClient } = require('./dist/data/write_api.js')
const {
  OnboardingApiClient,
  parseOnboardingView,
  parseOnboardingResult,
  normalizeFocusAreas,
  normalizeTemplateSlugs,
  AGE_BAND_OPTIONS,
  FOCUS_AREA_OPTIONS
} = require('./dist/data/onboarding.js')
const { ReadApiException } = require('./dist/data/read_api_errors.js')
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

function templateJson(overrides = {}) {
  return {
    slug: 'tidy-desk',
    title: '自己收书包',
    condition: '睡前自己收好书包',
    dailyLimit: 1,
    points: 2,
    direction: 'reward',
    icon: 'backpack',
    color: '#e9834b',
    ageBand: 'primary_low',
    focusAreas: ['生活习惯'],
    sortWeight: 10,
    ...overrides
  }
}

function viewJson(overrides = {}) {
  return {
    childId: 'child-1',
    onboarded: false,
    onboardedAt: null,
    ageBand: null,
    focusAreas: [],
    templates: [templateJson()],
    ...overrides
  }
}

function resultJson(rules) {
  return {
    childId: 'child-1',
    onboardedAt: '2026-10-27T09:00:00.000Z',
    rules:
      rules ??
      [
        {
          ruleId: 'rule-1',
          title: '自己收书包',
          condition: '睡前自己收好书包',
          dailyLimit: 1,
          points: 2,
          direction: 'reward',
          icon: 'backpack',
          color: '#e9834b',
          currentVersion: 1
        }
      ]
  }
}

/** 引导三端点的假传输层。 */
function fakeOnboardingTransport(options = {}) {
  const state = {
    viewStatus: options.viewStatus ?? 200,
    viewBody: options.viewBody ?? viewJson(),
    stateBody: options.stateBody ?? {
      childId: 'child-1',
      onboarded: false,
      onboardedAt: null,
      ageBand: null,
      focusAreas: []
    },
    completeStatus: options.completeStatus ?? 200,
    completeBody: options.completeBody ?? resultJson(),
    calls: [],
    lastBody: null,
    lastHeaders: null
  }
  state.transport = {
    async send(uri, headers, body, _timeoutMs, method = 'POST') {
      state.calls.push(`${method} ${uri}`)
      state.lastBody = body
      state.lastHeaders = headers
      if (uri.endsWith('/onboarding/complete')) {
        return {
          statusCode: state.completeStatus,
          body: state.completeBody
        }
      }
      if (uri.endsWith('/onboarding/profile')) {
        return { statusCode: 200, body: state.stateBody }
      }
      if (uri.endsWith('/onboarding')) {
        return { statusCode: state.viewStatus, body: state.viewBody }
      }
      return { statusCode: 404, body: { code: 'NOT_FOUND' } }
    }
  }
  return state
}

/** 写端点（加习惯）的假传输层。 */
function fakeWriteTransport(calls = []) {
  return {
    async send(uri, _headers, _body, _timeoutMs, method = 'POST') {
      calls.push(`${method} ${uri}`)
      if (uri.endsWith('/habits')) {
        const segments = uri.split('/')
        const ruleId = segments[segments.length - 2]
        return {
          statusCode: 200,
          body: {
            id: `habit-${ruleId}`,
            title: '自己收书包',
            points: 2,
            icon: 'backpack',
            color: '#e9834b',
            condition: '睡前自己收好书包',
            dailyLimit: 1,
            ruleId
          }
        }
      }
      return { statusCode: 404, body: { code: 'NOT_FOUND' } }
    }
  }
}


// ---------------------------------------------------------------- 契约常量

await checkAsync('跨端常量：4 个学段 / 6 个关注点', async () => {
  assert.deepEqual(
    AGE_BAND_OPTIONS.map((option) => option.value),
    ['preschool', 'primary_low', 'primary_high', 'junior_high']
  )
  assert.deepEqual([...FOCUS_AREA_OPTIONS], [
    '作业专注',
    '生活习惯',
    '阅读',
    '运动',
    '情绪管理',
    '家务'
  ])
})

// ------------------------------------------------------------------- DTO

await checkAsync('view：合法回包逐个解析模板', async () => {
  const view = parseOnboardingView(viewJson())
  assert.equal(view.onboarded, false)
  assert.equal(view.templates.length, 1)
  assert.equal(view.templates[0].slug, 'tidy-desk')
  assert.equal(view.templates[0].isPenalty, false)
})

await checkAsync('view：onboarded / onboardedAt 不一致 ⇒ malformed', async () => {
  assert.throws(
    () => parseOnboardingView(viewJson({ onboarded: true, onboardedAt: null })),
    ReadApiException
  )
})

await checkAsync('view：未知学段 / 未知关注点 ⇒ malformed', async () => {
  assert.throws(
    () => parseOnboardingView(viewJson({ ageBand: 'college' })),
    ReadApiException
  )
  assert.throws(
    () => parseOnboardingView(viewJson({ focusAreas: ['打游戏'] })),
    ReadApiException
  )
  assert.throws(
    () =>
      parseOnboardingView(
        viewJson({ templates: [templateJson({ ageBand: 'x' })] })
      ),
    ReadApiException
  )
})

await checkAsync('view：重复 slug / 空模板库 / 坏分值 ⇒ malformed', async () => {
  assert.throws(
    () =>
      parseOnboardingView(
        viewJson({ templates: [templateJson(), templateJson()] })
      ),
    ReadApiException
  )
  assert.throws(
    () => parseOnboardingView(viewJson({ templates: [] })),
    ReadApiException
  )
  for (const bad of [{ points: 0 }, { points: -2 }, { direction: 'bonus' }]) {
    assert.throws(
      () => parseOnboardingView(viewJson({ templates: [templateJson(bad)] })),
      ReadApiException
    )
  }
})

await checkAsync('result：空 rules ⇒ malformed（不能显示已完成）', async () => {
  assert.throws(() => parseOnboardingResult(resultJson([])), ReadApiException)
  const ok = parseOnboardingResult(resultJson())
  assert.equal(ok.rules[0].ruleId, 'rule-1')
  assert.equal(ok.rules[0].isPenalty, false)
})


// ---------------------------------------------------------------- 客户端

await checkAsync('客户端：GET 不带 Content-Type；PATCH 传 ageBand:null', async () => {
  const fake = fakeOnboardingTransport()
  const api = new OnboardingApiClient({ config, transport: fake.transport })

  await api.fetch()
  assert.deepEqual(fake.calls, ['GET http://127.0.0.1:3000/onboarding'])
  assert.equal(
    Object.keys(fake.lastHeaders).some(
      (key) => key.toLowerCase() === 'content-type'
    ),
    false
  )

  await api.saveProfile({ ageBand: null })
  assert.ok(fake.calls[1].startsWith('PATCH '))
  assert.ok('ageBand' in fake.lastBody)
  assert.equal(fake.lastBody.ageBand, null)
  assert.equal('focusAreas' in fake.lastBody, false)
})

await checkAsync('客户端：关注点保序去重；未知值本地拒绝', async () => {
  const fake = fakeOnboardingTransport()
  const api = new OnboardingApiClient({ config, transport: fake.transport })

  await api.saveProfile({ focusAreas: ['阅读', '家务', '阅读'] })
  assert.deepEqual(fake.lastBody.focusAreas, ['阅读', '家务'])
  assert.deepEqual(normalizeFocusAreas(['阅读', '阅读']), ['阅读'])

  await assert.rejects(() => api.saveProfile({ focusAreas: ['打游戏'] }))
  assert.equal(fake.calls.length, 1, '本地拒绝时不该发请求')
})

await checkAsync('客户端：complete 去重 slug、跳过 PIN 无 parentPin', async () => {
  const fake = fakeOnboardingTransport()
  const api = new OnboardingApiClient({ config, transport: fake.transport })

  await api.complete({ templateSlugs: ['tidy-desk', 'tidy-desk'] })
  assert.deepEqual(fake.lastBody.templateSlugs, ['tidy-desk'])
  assert.equal('parentPin' in fake.lastBody, false)
  assert.deepEqual(normalizeTemplateSlugs(['a', 'a', ' ']), ['a'])

  await assert.rejects(() => api.complete({ templateSlugs: [] }))
  await assert.rejects(() =>
    api.complete({ templateSlugs: ['a'], parentPin: '' })
  )
  await assert.rejects(() =>
    api.complete({ templateSlugs: ['a'], parentPin: '12' })
  )
})

await checkAsync('客户端：409 / 501 保留业务码', async () => {
  const fake = fakeOnboardingTransport({
    completeStatus: 409,
    completeBody: {
      code: 'ONBOARDING_ALREADY_COMPLETED',
      message: '这个孩子的引导已经完成过了。'
    }
  })
  const api = new OnboardingApiClient({ config, transport: fake.transport })

  await assert.rejects(
    () => api.complete({ templateSlugs: ['tidy-desk'] }),
    (error) =>
      error instanceof WriteApiException &&
      error.kind === 'conflict' &&
      error.code === 'ONBOARDING_ALREADY_COMPLETED'
  )

  fake.completeStatus = 501
  fake.completeBody = {
    code: 'ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED',
    message: '当前装配没有数据库连接。'
  }
  await assert.rejects(
    () => api.complete({ templateSlugs: ['tidy-desk'] }),
    (error) =>
      error instanceof WriteApiException &&
      error.code === 'ONBOARDING_PERSISTENCE_NOT_IMPLEMENTED'
  )
})


// ------------------------------------------------------------------- store

await checkAsync('store：只有 onboarded:false 才要求引导；失败保留旧快照', async () => {
  const fake = fakeOnboardingTransport()
  const store = new AppStore(
    null,
    null,
    new OnboardingApiClient({ config, transport: fake.transport })
  )

  assert.equal(store.needsOnboarding, false, '还不知道 ≠ 未引导')
  await store.refreshOnboarding()
  assert.equal(store.needsOnboarding, true)

  fake.viewStatus = 403
  fake.viewBody = { code: 'FORBIDDEN', message: '没有权限' }
  await store.refreshOnboarding()
  assert.equal(store.needsOnboarding, true, '失败不能把已引导说成未引导')
  assert.ok(store.onboardingError !== null)
})

await checkAsync('store：保存草稿只改学段，关注点与模板不丢', async () => {
  const fake = fakeOnboardingTransport({
    viewBody: viewJson({ focusAreas: ['阅读'] }),
    stateBody: {
      childId: 'child-1',
      onboarded: false,
      onboardedAt: null,
      ageBand: 'primary_high',
      focusAreas: ['阅读']
    }
  })
  const store = new AppStore(
    null,
    null,
    new OnboardingApiClient({ config, transport: fake.transport })
  )

  await store.refreshOnboarding()
  const error = await store.saveOnboardingDraft({ ageBand: 'primary_high' })
  assert.equal(error, null)
  assert.equal(store.onboarding.ageBand, 'primary_high')
  assert.deepEqual(store.onboarding.focusAreas, ['阅读'])
  assert.equal(store.onboarding.templates.length, 1)
})

await checkAsync('store：完成引导 —— 奖励加习惯、扣分不加、PIN 逐字发出', async () => {
  const writeCalls = []
  const fake = fakeOnboardingTransport({
    completeBody: resultJson([
      {
        ruleId: 'rule-1',
        title: '自己收书包',
        condition: '睡前自己收好书包',
        dailyLimit: 1,
        points: 2,
        direction: 'reward',
        icon: 'backpack',
        color: '#e9834b',
        currentVersion: 1
      },
      {
        ruleId: 'rule-2',
        title: '顶嘴',
        condition: '对家人大喊大叫',
        dailyLimit: 1,
        points: 1,
        direction: 'penalty',
        icon: 'spray',
        color: '#e9834b',
        currentVersion: 1
      }
    ])
  })
  const store = new AppStore(
    null,
    new WriteApiClient({ config, transport: fakeWriteTransport(writeCalls) }),
    new OnboardingApiClient({ config, transport: fake.transport })
  )

  await store.refreshOnboarding()
  const error = await store.completeOnboarding({
    templateSlugs: ['tidy-desk', 'talk-back'],
    ageBand: 'primary_low',
    focusAreas: ['生活习惯'],
    parentPin: '2468'
  })

  assert.equal(error, null)
  assert.equal(store.needsOnboarding, false)
  assert.equal(store.lastOnboardingResult.rules.length, 2)
  assert.equal(store.lastOnboardingHabitCount, 1)
  assert.deepEqual(store.lastOnboardingManualTitles, ['顶嘴'])
  assert.equal(store.habits.length, 1)
  assert.equal(writeCalls.length, 1, '扣分规则不能变成孩子打卡的习惯（A1）')
  assert.ok(writeCalls[0].endsWith('/point-rules/rule-1/habits'))
  assert.equal(fake.lastBody.parentPin, '2468')
  assert.deepEqual(fake.lastBody.templateSlugs, ['tidy-desk', 'talk-back'])
})

await checkAsync('store：完成引导 409 ⇒ 重拉状态并放行', async () => {
  const fake = fakeOnboardingTransport({
    completeStatus: 409,
    completeBody: {
      code: 'ONBOARDING_ALREADY_COMPLETED',
      message: '这个孩子的引导已经完成过了。'
    }
  })
  const store = new AppStore(
    null,
    null,
    new OnboardingApiClient({ config, transport: fake.transport })
  )

  await store.refreshOnboarding()
  fake.viewBody = viewJson({
    onboarded: true,
    onboardedAt: '2026-10-27T09:00:00.000Z'
  })
  const error = await store.completeOnboarding({ templateSlugs: ['tidy-desk'] })

  assert.ok(error !== null)
  assert.equal(store.needsOnboarding, false)
  assert.equal(
    fake.calls.filter(
      (call) => call.endsWith('/onboarding') && call.startsWith('GET')
    ).length,
    2
  )
})

console.log(failed === 0 ? '\nW8-B ALL PASS' : `\nW8-B ${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1


/**
 * registration-invite-http.test.ts —— 网站「邀请码获取」的集成测试
 *                                  （W12，2026-11-02；真起 Nest ＋ 真发 HTTP）
 *
 * ── 本文件钉住什么 ────────────────────────────────────────────────────────
 *   ① 两个字段都必填、都按**同一份** `account-identifier.ts` 规范化；
 *   ② 每日额度是**配置**（默认 50；改成 7 立即生效；非法值回退 50）；
 *   ③ 额度用完 ⇒ 429（不是 500、也不是 201 + 空码）；
 *   ④ 多余字段 ⇒ 400（`whitelist + forbidNonWhitelisted`）；
 *   ⑤ `GET /invite` 页面真的能被拉到，且**小程序 / App 两段文案都在**；
 *   ⑥ `GET .../quota` 只读、不改额度。
 *
 * ── ⚠️ 诚实标注 ────────────────────────────────────────────────────────────
 *   仓储是**内存替身**：本文件证明的是接线、状态码、文案与配置读取。
 *   「额度自增与落码在同一事务」「并发下恰好 50 张」需要活库，**由
 *   `test-db/registration-invites-db.dbtest.ts` 负责**（2026-11-04 补齐并实跑：
 *   `npm run test:db` → 真库 379 条通过，含该文件 6 条）。
 *   在补上它之前，这里写的是一句**悬空承诺** —— 指向一个不存在的文件。
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { applyGlobalPipes } from '../src/app.setup'
import {
  REGISTRATION_INVITE_REPOSITORY,
  type RegistrationInvitePort
} from '../src/registration-invites/registration-invite.repository'
import { RegistrationInvitesHttpModule } from '../src/registration-invites/registration-invites-http.module'
import type {
  CreateRegistrationInviteInput,
  CreateRegistrationInviteResult,
  RegistrationInviteLookup,
  RegistrationInviteQuotaSnapshot
} from '../src/registration-invites/registration-invite.types'

interface HttpResult {
  status: number
  body: Record<string, unknown>
  text: string
  contentType: string | null
}

async function send(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  let payload: string | undefined
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(init.body)
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(payload === undefined ? {} : { body: payload })
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  if (text !== '') {
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      body = { _raw: text }
    }
  }
  return {
    status: res.status,
    body,
    text,
    contentType: res.headers.get('content-type')
  }
}

// ── 内存替身：额度 + 落码 ────────────────────────────────────────────────────
interface RepoFake extends RegistrationInvitePort {
  calls: CreateRegistrationInviteInput[]
  quota: RegistrationInviteQuotaSnapshot
  /** 下一次 `createInvite` 是否直接回「额度用完」。 */
  exhaust: boolean
}

function makeRepoFake(): RepoFake {
  const fake: RepoFake = {
    calls: [],
    quota: { dailyLimit: 50, issued: 0, remainingToday: 50 },
    exhaust: false,

    async createInvite(input): Promise<CreateRegistrationInviteResult> {
      fake.calls.push(input)
      if (fake.exhaust || fake.quota.remainingToday <= 0) {
        return { kind: 'quota_exhausted', issued: fake.quota.issued }
      }
      fake.quota.issued += 1
      fake.quota.remainingToday -= 1
      return {
        kind: 'created',
        row: {
          code: 'KIDSA234',
          expiresAt: input.expiresAt,
          remainingToday: fake.quota.remainingToday
        }
      }
    },

    async findByCode(_code: string): Promise<RegistrationInviteLookup | null> {
      return null
    },

    async readQuota(input): Promise<RegistrationInviteQuotaSnapshot> {
      return {
        dailyLimit: input.dailyLimit,
        issued: fake.quota.issued,
        remainingToday: Math.max(0, input.dailyLimit - fake.quota.issued)
      }
    }
  }
  return fake
}

interface Harness {
  app: INestApplication
  url: string
  repo: RepoFake
}

async function startApp(): Promise<Harness> {
  const repo = makeRepoFake()
  const moduleRef = await Test.createTestingModule({
    imports: [RegistrationInvitesHttpModule.register({ hasDatabase: false })]
  })
    .overrideProvider(REGISTRATION_INVITE_REPOSITORY)
    .useValue(repo)
    .compile()

  const app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  const url = await app.getUrl()
  return { app, url: url.replace('[::1]', '127.0.0.1'), repo }
}

const ENV_LIMIT = 'REGISTRATION_INVITE_DAILY_LIMIT'
const ENV_TTL = 'REGISTRATION_INVITE_TTL_DAYS'

describe('网站邀请码（GET /invite ＋ POST /public/registration-invites）', () => {
  let harness!: Harness
  const saved: Record<string, string | undefined> = {}

  before(async () => {
    saved[ENV_LIMIT] = process.env[ENV_LIMIT]
    saved[ENV_TTL] = process.env[ENV_TTL]
    harness = await startApp()
  })

  after(async () => {
    await harness.app.close()
    for (const key of [ENV_LIMIT, ENV_TTL]) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  beforeEach(() => {
    harness.repo.calls.length = 0
    harness.repo.quota = { dailyLimit: 50, issued: 0, remainingToday: 50 }
    harness.repo.exhaust = false
    delete process.env[ENV_LIMIT]
    delete process.env[ENV_TTL]
  })

  it('★ 发放成功：201 + 展示形码 + 脱敏标识 + 当日剩余', async () => {
    const res = await send(harness.url, '/public/registration-invites', {
      body: { phone: ' +86 138-0013-8000 ', email: 'Dad@Example.COM' }
    })

    assert.equal(res.status, 201, res.text)
    assert.equal(res.body.code, 'KIDS-A234')
    assert.equal(res.body.phoneMasked, '138****8000')
    assert.equal(res.body.emailMasked, 'd***@example.com')
    assert.equal(res.body.dailyLimit, 50)
    assert.equal(res.body.remainingToday, 49)
    assert.equal(typeof res.body.expiresAt, 'string')

    // 端口拿到的是**规范化后**的值（网站层不再保留原始写法）
    const call = harness.repo.calls[0]
    assert.equal(call?.phone, '13800138000')
    assert.equal(call?.email, 'dad@example.com')
    assert.equal(call?.dailyLimit, 50)
    assert.match(call?.day ?? '', /^\d{4}-\d{2}-\d{2}$/)
    // 有效期默认 7 天（允许 ±1 分钟的执行耗时）
    const days = ((call?.expiresAt.getTime() ?? 0) - Date.now()) / 86400000
    assert.ok(days > 6.99 && days < 7.01, `expiresAt 应约为 7 天后，实际 ${days}`)
  })

  it('手机号 / 邮箱形状错 ⇒ 400，且**一次发码都没发生**', async () => {
    const badPhone = await send(harness.url, '/public/registration-invites', {
      body: { phone: '12345', email: 'dad@example.com' }
    })
    assert.equal(badPhone.status, 400, badPhone.text)
    assert.equal(badPhone.body.code, 'INVALID_PHONE')

    const badEmail = await send(harness.url, '/public/registration-invites', {
      body: { phone: '13800138000', email: 'not-an-email' }
    })
    assert.equal(badEmail.status, 400, badEmail.text)
    assert.equal(badEmail.body.code, 'INVALID_EMAIL')

    assert.equal(harness.repo.calls.length, 0)
  })

  it('少一个字段 / 多一个字段都 ⇒ 400（集合封闭）', async () => {
    const missing = await send(harness.url, '/public/registration-invites', {
      body: { phone: '13800138000' }
    })
    assert.equal(missing.status, 400, missing.text)

    const extra = await send(harness.url, '/public/registration-invites', {
      body: { phone: '13800138000', email: 'dad@example.com', role: 'guardian' }
    })
    assert.equal(extra.status, 400, extra.text)
    assert.equal(harness.repo.calls.length, 0)
  })

  it('★ 每日上限来自配置：改成 7 ⇒ 回包与端口都是 7；有效期也可配', async () => {
    process.env[ENV_LIMIT] = '7'
    process.env[ENV_TTL] = '1'
    const res = await send(harness.url, '/public/registration-invites', {
      body: { phone: '13800138000', email: 'dad@example.com' }
    })
    assert.equal(res.status, 201, res.text)
    assert.equal(res.body.dailyLimit, 7)
    assert.equal(harness.repo.calls[0]?.dailyLimit, 7)
    const days = ((harness.repo.calls[0]?.expiresAt.getTime() ?? 0) - Date.now()) / 86400000
    assert.ok(days > 0.99 && days < 1.01, `expiresAt 应约为 1 天后，实际 ${days}`)
  })

  it('非法配置（0）⇒ 回退默认 50（不是 500、也不是 0）', async () => {
    process.env[ENV_LIMIT] = '0'
    const res = await send(harness.url, '/public/registration-invites', {
      body: { phone: '13800138000', email: 'dad@example.com' }
    })
    assert.equal(res.status, 201, res.text)
    assert.equal(res.body.dailyLimit, 50)
  })

  it('★ 额度用完 ⇒ 429 + retryAfterSeconds（不是 500 / 不是空码）', async () => {
    harness.repo.exhaust = true
    const res = await send(harness.url, '/public/registration-invites', {
      body: { phone: '13800138000', email: 'dad@example.com' }
    })

    assert.equal(res.status, 429, res.text)
    assert.equal(res.body.code, 'REGISTRATION_INVITE_DAILY_LIMIT')
    assert.equal(res.body.dailyLimit, 50)
    assert.ok((res.body.retryAfterSeconds as number) > 0)
    assert.match(res.text, /今天.*发完/)
  })

  it('GET /public/registration-invites/quota 只读且如实回额度', async () => {
    harness.repo.quota = { dailyLimit: 50, issued: 49, remainingToday: 1 }
    const res = await send(harness.url, '/public/registration-invites/quota')
    assert.equal(res.status, 200, res.text)
    assert.equal(res.body.dailyLimit, 50)
    assert.equal(res.body.remainingToday, 1)
    assert.equal(typeof res.body.resetsAt, 'string')
    assert.equal(res.body.timeZone, 'Asia/Shanghai')
    // 只读：没有触发发码
    assert.equal(harness.repo.calls.length, 0)
  })

  it('★ GET /invite 能打开，且小程序 / App 两段文案都在（同账号、互不依赖）', async () => {
    const res = await send(harness.url, '/invite')
    assert.equal(res.status, 200, res.text)
    assert.match(res.contentType ?? '', /text\/html/)
    assert.match(res.text, /邀请码获取/)
    assert.match(res.text, /在微信小程序里注册/)
    assert.match(res.text, /在 App 里注册/)
    assert.match(res.text, /同一套账号，互不依赖/)
    assert.match(res.text, /不需要「先在小程序登录过」/)
    // 页面必须用**相对**路径请求接口，否则 /k 入口会绕过前缀
    assert.match(res.text, /api\('public\/registration-invites'/)
    assert.ok(!res.text.includes("api('/public/registration-invites'"))
  })
})


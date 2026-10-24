/**
 * device-tokens.test.ts —— 设备推送 token 的**离线**用例（W6-A，2026-10-24）
 *
 * 覆盖四层，每层都只回答自己那一个问题：
 *   A. **静态对账**：`manage_device_tokens` 在矩阵里（guardian/child 都 ALLOW、viewer
 *      fail-closed），`DEVICE_PLATFORMS` 与 `schema.prisma` 的 `enum DevicePlatform`
 *      逐字相等 —— 平台名写错时没有任何编译器会说话，只能这样钉住。
 *   B. **无库装配**：四个端口方法**全部** 501（不返回空列表冒充「这个人没有设备」）。
 *   C. **service 的翻译**：`owned_by_other` → 409、`not_found` → 404、行 → 线格式
 *      （时间 ISO、**绝不含 `token`**）。
 *   D. **推送适配器**：配置解析的四种结论，以及 `WebhookPushAdapter` 对
 *      2xx / 410 / 5xx / 超时的处理（410 才动 token 状态）。
 *
 * ★ 这里**不**证明唯一约束、LRU 淘汰、并发注销幂等 —— 那需要真 Postgres：
 *   `test-db/device-tokens-db.dbtest.ts`。
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'

import { HttpException, HttpStatus } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { ALL_ACTIONS, resolveVerdict } from '../src/contracts/permission-matrix'
import {
  NotImplementedDeviceTokensRepository,
  type DeviceTokensPort
} from '../src/device-tokens/device-tokens.repository'
import { DeviceTokensService } from '../src/device-tokens/device-tokens.service'
import {
  MAX_ACTIVE_TOKENS_PER_USER,
  DEVICE_PLATFORMS,
  type ActivePushToken,
  type RegisterDeviceTokenInput,
  type RegisterDeviceTokenResult,
  type RevokeDeviceTokenResult
} from '../src/device-tokens/device-tokens.types'
import { NoopPushAdapter } from '../src/notifications/noop-push.adapter'
import { NotificationsModule } from '../src/notifications/notifications.module'
import { PUSH_PORT, type PushMessage } from '../src/notifications/push.port'
import {
  DEFAULT_PUSH_WEBHOOK_TIMEOUT_MS,
  MAX_PUSH_WEBHOOK_TIMEOUT_MS,
  MIN_PUSH_WEBHOOK_TIMEOUT_MS,
  readWebhookPushConfig
} from '../src/notifications/push-webhook.config'
import {
  WebhookPushAdapter,
  createPushAdapter,
  type WebhookPushPayload
} from '../src/notifications/webhook-push.adapter'

/** 取 HttpException 的状态码 + 机器码（与 notifications.test.ts 同一手法）。 */
function describeHttpError(error: unknown): { status: number; code: string; message: string } {
  if (!(error instanceof HttpException)) throw error
  const response = error.getResponse()
  const record = typeof response === 'object' && response !== null ? response : {}
  const code = 'code' in record ? String((record as { code: unknown }).code) : ''
  const message = 'message' in record ? String((record as { message: unknown }).message) : ''
  return { status: error.getStatus(), code, message }
}

/** 端口替身：只回答 service 问的问题，并记下**每次调用的入参**。 */
class PortFake implements DeviceTokensPort {
  readonly registers: RegisterDeviceTokenInput[] = []
  readonly revokes: { userId: string; token: string }[] = []
  readonly listings: string[] = []
  readonly deactivations: string[][] = []

  registerResult: RegisterDeviceTokenResult | null = null
  revokeResult: RevokeDeviceTokenResult | null = null
  active: ActivePushToken[] = []
  listError: Error | null = null
  deactivateCount = 0

  async register(input: RegisterDeviceTokenInput): Promise<RegisterDeviceTokenResult> {
    this.registers.push(input)
    if (this.registerResult === null) throw new Error('测试没设置 registerResult')
    return this.registerResult
  }

  async revoke(input: { userId: string; token: string }): Promise<RevokeDeviceTokenResult> {
    this.revokes.push(input)
    if (this.revokeResult === null) throw new Error('测试没设置 revokeResult')
    return this.revokeResult
  }

  async listActiveForUser(userId: string): Promise<ActivePushToken[]> {
    this.listings.push(userId)
    if (this.listError !== null) throw this.listError
    return this.active
  }

  async deactivateTokens(tokens: string[]): Promise<number> {
    this.deactivations.push([...tokens])
    return this.deactivateCount
  }
}

const CREATED_AT = new Date('2026-10-20T01:00:00.000Z')
const LAST_SEEN_AT = new Date('2026-10-24T02:00:00.000Z')
const REVOKED_AT = new Date('2026-10-24T03:00:00.000Z')

const ACTIVE_ROW = {
  id: 'tok-1',
  platform: 'ios' as const,
  active: true,
  lastSeenAt: LAST_SEEN_AT,
  createdAt: CREATED_AT,
  revokedAt: null
}

const REVOKED_ROW = { ...ACTIVE_ROW, active: false, revokedAt: REVOKED_AT }

const MOM = { userId: 'u-mom', role: 'guardian' as const }
const KID = { userId: 'u-kid', role: 'child' as const }
const TOKEN = 'ios-token-abcdef'

function makeMessage(recipientUserId = 'u-kid'): PushMessage {
  return {
    type: 'approval.status_changed',
    approvalId: 'ap-1',
    childId: 'child-1',
    recipientUserId,
    action: 'view_child_points',
    status: 'approved',
    decidedByUserId: 'u-mom',
    occurredAt: '2026-10-24T02:00:00.000Z'
  }
}

// ══ 组 A：静态对账 ════════════════════════════════════════════════════════════
describe('组 A：矩阵 / Prisma 枚举 / 平台常量', () => {
  it('manage_device_tokens 在矩阵里：guardian / child 都 ALLOW，viewer fail-closed', () => {
    // 孩子的设备也要能收到推送 ⇒ 不能只给家长。这与 `view_notifications` 同一判断。
    assert.ok(
      (ALL_ACTIONS as readonly string[]).includes('manage_device_tokens'),
      '矩阵里没有 manage_device_tokens —— 路由上的 @RequireAction 会让所有人都 403'
    )
    assert.equal(resolveVerdict('manage_device_tokens', 'guardian'), 'ALLOW')
    assert.equal(resolveVerdict('manage_device_tokens', 'child'), 'ALLOW')
    // viewer 没有列 ⇒ 一律 DENY（不因为「只是登记设备」开口子）。
    assert.equal(resolveVerdict('manage_device_tokens', 'viewer'), 'DENY')
  })

  it('DEVICE_PLATFORMS 与 schema.prisma 的 enum DevicePlatform 逐字相等', () => {
    // 平台名写错（`ios` → `apns`）不会有任何编译器报错：DTO 照样接受，
    // 库里的枚举却收不下 ⇒ 注册 500。这条用例是唯一会说话的地方。
    const schemaPath = resolve(process.cwd(), 'prisma', 'schema.prisma')
    const schema = readFileSync(schemaPath, 'utf8')
    const block = /enum DevicePlatform \{([\s\S]*?)\}/.exec(schema)
    assert.ok(block !== null, `schema.prisma 里找不到 enum DevicePlatform（读的是 ${schemaPath}）`)
    const values = block[1]
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line !== '')
    assert.deepEqual(values, [...DEVICE_PLATFORMS], 'TS 常量与 Prisma 枚举不一致')
  })

  it('上限是 10（网关每次要收全部 token，不设上限就是放大器入口）', () => {
    assert.equal(MAX_ACTIVE_TOKENS_PER_USER, 10)
  })
})

// ══ 组 B：无库装配 —— 四个方法全 501 ═════════════════════════════════════════
describe('组 B：NotImplementedDeviceTokensRepository 拒绝假装成功', () => {
  const repository = new NotImplementedDeviceTokensRepository()

  it('register ⇒ 501（不假装登记成功：客户端会以为能收到推送）', async () => {
    await assert.rejects(
      () => repository.register({ userId: 'u-1', childId: null, platform: 'ios', token: TOKEN }),
      (error: unknown) => {
        const { status, code } = describeHttpError(error)
        assert.equal(status, HttpStatus.NOT_IMPLEMENTED)
        assert.equal(code, 'DEVICE_TOKENS_PERSISTENCE_NOT_IMPLEMENTED')
        return true
      }
    )
  })

  it('revoke ⇒ 501（不假装注销成功）', async () => {
    await assert.rejects(
      () => repository.revoke({ userId: 'u-1', token: TOKEN }),
      (error: unknown) => {
        const { status, code } = describeHttpError(error)
        assert.equal(status, HttpStatus.NOT_IMPLEMENTED)
        assert.equal(code, 'DEVICE_TOKENS_PERSISTENCE_NOT_IMPLEMENTED')
        return true
      }
    )
  })

  it('listActiveForUser ⇒ 501（回 [] 会被读成「这个人没有设备」）', async () => {
    // ★ 这一条最关键：`[]` 会让适配器回答 `no_device_token`，
    //   那是「没上报过设备」的结论，与「根本没接库」是两件事。
    await assert.rejects(() => repository.listActiveForUser('u-1'), (error: unknown) => {
      assert.equal(describeHttpError(error).status, HttpStatus.NOT_IMPLEMENTED)
      return true
    })
  })

  it('deactivateTokens ⇒ 501（不返回 0 冒充「已经全部置为失效」）', async () => {
    await assert.rejects(() => repository.deactivateTokens([TOKEN]), (error: unknown) => {
      assert.equal(describeHttpError(error).status, HttpStatus.NOT_IMPLEMENTED)
      return true
    })
  })
})

// ══ 组 C：service 的翻译（端口结果 → HTTP 语义 / 线格式）═════════════════════
describe('组 C：DeviceTokensService', () => {
  it('register 把会话 actor 写进端口入参（userId 绝不来自请求体），并 trim token', async () => {
    const port = new PortFake()
    port.registerResult = { kind: 'ok', row: ACTIVE_ROW, created: true }
    const service = new DeviceTokensService(port)

    await service.register({ platform: 'ios', token: '  ios-token-abcdef  ' }, MOM, 'child-1')

    assert.deepEqual(port.registers[0], {
      userId: 'u-mom',
      childId: 'child-1',
      platform: 'ios',
      token: TOKEN
    })
  })

  it('register 的响应是线格式：时间是 ISO 串，且**不含 token**', async () => {
    const port = new PortFake()
    port.registerResult = { kind: 'ok', row: ACTIVE_ROW, created: true }
    const service = new DeviceTokensService(port)

    const dto = await service.register({ platform: 'ios', token: TOKEN }, MOM, 'child-1')

    assert.deepEqual(dto, {
      id: 'tok-1',
      platform: 'ios',
      active: true,
      lastSeenAt: '2026-10-24T02:00:00.000Z',
      createdAt: '2026-10-20T01:00:00.000Z',
      revokedAt: null
    })
    // ★ 显式断言「没有 token 这个键」：`deepEqual` 已经覆盖，但这条失败信息更直白。
    assert.equal('token' in dto, false, '响应里回显了 token —— 推送凭据会进日志 / 截图')
  })

  it('owned_by_other ⇒ 409 + DEVICE_TOKEN_OWNED_BY_OTHER（不是 400：请求形状是对的）', async () => {
    const port = new PortFake()
    port.registerResult = { kind: 'owned_by_other' }
    const service = new DeviceTokensService(port)

    await assert.rejects(
      () => service.register({ platform: 'ios', token: TOKEN }, KID, 'child-1'),
      (error: unknown) => {
        const { status, code } = describeHttpError(error)
        assert.equal(status, HttpStatus.CONFLICT)
        assert.equal(code, 'DEVICE_TOKEN_OWNED_BY_OTHER')
        return true
      }
    )
  })

  it('revoke 只把会话 userId 与 token 交给端口（没有 childId —— 注销不依赖当前档案）', async () => {
    const port = new PortFake()
    port.revokeResult = { kind: 'ok', row: REVOKED_ROW }
    const service = new DeviceTokensService(port)

    const dto = await service.revoke({ token: TOKEN }, KID)

    assert.deepEqual(port.revokes, [{ userId: 'u-kid', token: TOKEN }])
    assert.equal(dto.active, false)
    assert.equal(dto.revokedAt, '2026-10-24T03:00:00.000Z')
    assert.equal('token' in dto, false)
  })

  it('not_found ⇒ 404 + DEVICE_TOKEN_NOT_FOUND（不是我的 = 不存在，不给探测口）', async () => {
    const port = new PortFake()
    port.revokeResult = { kind: 'not_found' }
    const service = new DeviceTokensService(port)

    await assert.rejects(
      () => service.revoke({ token: TOKEN }, KID),
      (error: unknown) => {
        const { status, code } = describeHttpError(error)
        assert.equal(status, HttpStatus.NOT_FOUND)
        assert.equal(code, 'DEVICE_TOKEN_NOT_FOUND')
        return true
      }
    )
  })
})

// ══ 组 D：配置解析（纯函数，不起服务）════════════════════════════════════════
describe('组 D：readWebhookPushConfig', () => {
  it('没配 / 只有空白 ⇒ disabled（常态，不是故障）', () => {
    assert.deepEqual(readWebhookPushConfig({}), { kind: 'disabled', reason: 'not_configured' })
    assert.equal(readWebhookPushConfig({ PUSH_WEBHOOK_URL: '   ' }).kind, 'disabled')
  })

  it('不是合法 URL ⇒ invalid（配错不许静默落回 no-op）', () => {
    const result = readWebhookPushConfig({ PUSH_WEBHOOK_URL: 'not-a-url' })
    assert.equal(result.kind, 'invalid')
    assert.match(result.kind === 'invalid' ? result.reason : '', /不是合法 URL/)
  })

  it('非 http(s) 协议 ⇒ invalid（`ftp:` / `file:` 会让 fetch 抛错，不该等到运行时）', () => {
    for (const url of ['ftp://push.example.com/x', 'file:///etc/passwd']) {
      const result = readWebhookPushConfig({ PUSH_WEBHOOK_URL: url })
      assert.equal(result.kind, 'invalid', `${url} 被接受了`)
      assert.match(result.kind === 'invalid' ? result.reason : '', /只支持 http\(s\)/)
    }
  })

  it('生产环境用 http ⇒ invalid（请求体含可直接推送的设备 token）', () => {
    const result = readWebhookPushConfig({
      NODE_ENV: 'production',
      PUSH_WEBHOOK_URL: 'http://push.example.com/hook'
    })
    assert.equal(result.kind, 'invalid')
    assert.match(result.kind === 'invalid' ? result.reason : '', /必须是 https/)
  })

  it('开发环境允许 http（否则本地联调只能自签证书，而那条路只会让人关校验）', () => {
    const result = readWebhookPushConfig({
      NODE_ENV: 'development',
      PUSH_WEBHOOK_URL: 'http://127.0.0.1:9099/hook'
    })
    assert.equal(result.kind, 'ok')
    assert.deepEqual(result.kind === 'ok' ? result.config : null, {
      url: 'http://127.0.0.1:9099/hook',
      token: null,
      timeoutMs: DEFAULT_PUSH_WEBHOOK_TIMEOUT_MS
    })
  })

  it('token 去空白后使用；只有空白 ⇒ null（不带 authorization 头）', () => {
    const withToken = readWebhookPushConfig({
      PUSH_WEBHOOK_URL: 'https://push.example.com/hook',
      PUSH_WEBHOOK_TOKEN: '  s3cret  '
    })
    assert.equal(withToken.kind === 'ok' ? withToken.config.token : 'x', 's3cret')

    const blank = readWebhookPushConfig({
      PUSH_WEBHOOK_URL: 'https://push.example.com/hook',
      PUSH_WEBHOOK_TOKEN: '  '
    })
    assert.equal(blank.kind === 'ok' ? blank.config.token : 'x', null)
  })

  it('超时：非法 ⇒ 默认；越界 ⇒ 夹在 [100, 5000]', () => {
    const base = { PUSH_WEBHOOK_URL: 'https://push.example.com/hook' }
    const read = (raw: string): number => {
      const result = readWebhookPushConfig({ ...base, PUSH_WEBHOOK_TIMEOUT_MS: raw })
      return result.kind === 'ok' ? result.config.timeoutMs : -1
    }
    assert.equal(read('abc'), DEFAULT_PUSH_WEBHOOK_TIMEOUT_MS)
    assert.equal(read('0'), MIN_PUSH_WEBHOOK_TIMEOUT_MS)
    assert.equal(read('99999'), MAX_PUSH_WEBHOOK_TIMEOUT_MS)
    assert.equal(read('1234'), 1234)
    // 默认值必须**小于** service 的 1s 兜底（见配置文件的注释）。
    assert.ok(DEFAULT_PUSH_WEBHOOK_TIMEOUT_MS < 1000)
  })
})

// ══ 组 E：装配选择（三种结论 → 两种实现）════════════════════════════════════
describe('组 E：createPushAdapter / NotificationsModule 的绑定', () => {
  const okConfig = { url: 'http://127.0.0.1:9/hook', token: null, timeoutMs: 800 }

  it('ok ⇒ WebhookPushAdapter；disabled / invalid ⇒ NoopPushAdapter', () => {
    const port = new PortFake()
    assert.ok(createPushAdapter({ kind: 'ok', config: okConfig }, port) instanceof WebhookPushAdapter)
    assert.ok(
      createPushAdapter({ kind: 'disabled', reason: 'not_configured' }, port) instanceof NoopPushAdapter
    )
    assert.ok(
      createPushAdapter({ kind: 'invalid', reason: '坏了' }, port) instanceof NoopPushAdapter
    )
  })

  it('NotificationsModule 在 ok 配置下把 PUSH_PORT 绑到 WebhookPushAdapter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        NotificationsModule.register({
          hasDatabase: false,
          pushWebhook: { kind: 'ok', config: okConfig }
        })
      ]
    }).compile()
    try {
      assert.ok(moduleRef.get(PUSH_PORT) instanceof WebhookPushAdapter)
    } finally {
      await moduleRef.close()
    }
  })

  it('NotificationsModule 在 disabled 配置下仍是 no-op（默认世界不变）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        NotificationsModule.register({
          hasDatabase: false,
          pushWebhook: { kind: 'disabled', reason: 'not_configured' }
        })
      ]
    }).compile()
    try {
      const port = moduleRef.get(PUSH_PORT)
      assert.ok(port instanceof NoopPushAdapter)
      const result = await port.send(makeMessage())
      assert.deepEqual(result, { delivered: false, reason: 'provider_not_configured' })
    } finally {
      await moduleRef.close()
    }
  })
})
// ══ 组 F：WebhookPushAdapter 对网关的四种回答 ═════════════════════════════════
interface GatewayRequest {
  path: string
  headers: IncomingMessage['headers']
  body: WebhookPushPayload
}

/** 假网关：真起一个本地 HTTP 服务（不打桩 `fetch` —— 那会连超时/中止一起测掉）。 */
class StubGateway {
  readonly received: GatewayRequest[] = []
  status = 200
  /** `undefined` ⇒ 回空 body（用来测「410 但没说哪些失效」）。 */
  responseBody: unknown = { messageId: 'pm-1' }
  delayMs = 0
  url = ''
  private server: Server | null = null

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('没拿到监听端口')
    this.url = `http://127.0.0.1:${address.port}/push`
  }

  async stop(): Promise<void> {
    await new Promise<void>((done) => {
      if (this.server === null) return done()
      this.server.close(() => done())
    })
    this.server = null
  }

  reset(): void {
    this.received.length = 0
    this.status = 200
    this.responseBody = { messageId: 'pm-1' }
    this.delayMs = 0
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    this.received.push({
      path: req.url ?? '',
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as WebhookPushPayload
    })
    if (this.delayMs > 0) await new Promise((done) => setTimeout(done, this.delayMs))
    // 客户端已超时断开（超时用例）：不能再写 head，否则只留下 ECONNRESET 噪音。
    if (res.destroyed || res.writableEnded) return
    try {
      res.writeHead(this.status, { 'content-type': 'application/json' })
      res.end(this.responseBody === undefined ? '' : JSON.stringify(this.responseBody))
    } catch {
      // 对端走了：这条连接上的写入失败与「适配器的结论」无关。
    }
  }
}
describe('组 F：WebhookPushAdapter（真 HTTP 往返）', () => {
  const gateway = new StubGateway()
  const twoTokens: ActivePushToken[] = [
    { token: 'tok-a', platform: 'ios' },
    { token: 'tok-b', platform: 'android' }
  ]
  let port: PortFake

  before(async () => {
    await gateway.start()
  })
  after(async () => {
    await gateway.stop()
  })
  beforeEach(() => {
    gateway.reset()
    port = new PortFake()
    port.active = [...twoTokens]
  })

  const adapter = (overrides: { token?: string | null; timeoutMs?: number } = {}) =>
    new WebhookPushAdapter(
      { url: gateway.url, token: overrides.token ?? null, timeoutMs: overrides.timeoutMs ?? 800 },
      port
    )

  it('2xx ⇒ delivered:true + 网关给的 messageId；请求体与头部都是约定形状', async () => {
    const result = await adapter().send(makeMessage('u-kid'))

    assert.deepEqual(result, { delivered: true, providerMessageId: 'pm-1' })
    assert.equal(port.listings[0], 'u-kid', '读 token 用的不是收件人 userId')

    const request = gateway.received[0]
    assert.equal(request.path, '/push')
    assert.equal(request.headers['x-kp-event'], 'approval.status_changed')
    assert.equal(request.headers.authorization, undefined, '没配 token 却发了 authorization')
    assert.equal(request.body.version, 1)
    assert.equal(request.body.event, 'approval.status_changed')
    assert.deepEqual(request.body.tokens, twoTokens)
    // ★ message **原样转发**：适配器不加工内容（换渠道时语义只有一处定义）。
    assert.deepEqual(request.body.message, makeMessage('u-kid'))
  })

  it('配了 token ⇒ authorization: Bearer', async () => {
    await adapter({ token: 's3cret' }).send(makeMessage())
    assert.equal(gateway.received[0].headers.authorization, 'Bearer s3cret')
  })

  it('2xx 但 body 里没有 messageId ⇒ providerMessageId 为 null（不编造 id）', async () => {
    gateway.responseBody = {}
    const result = await adapter().send(makeMessage())
    assert.deepEqual(result, { delivered: true, providerMessageId: null })
  })

  it('★ 410 且列出 invalidTokens ⇒ 只把**那几条**置为失效（坏网关不能下线任意 token）', async () => {
    port.deactivateCount = 1
    gateway.status = 410
    gateway.responseBody = { invalidTokens: ['tok-b', 'not-ours'] }

    const result = await adapter().send(makeMessage())

    assert.equal(result.delivered, false)
    assert.equal(result.delivered === false ? result.reason : '', 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /410/)
    assert.deepEqual(port.deactivations, [['tok-b']], '把没发出去的 token 也动了')
  })

  it('410 但没说哪些失效 ⇒ 本次发送的全部置为失效', async () => {
    port.deactivateCount = 2
    gateway.status = 410
    gateway.responseBody = undefined

    await adapter().send(makeMessage())

    assert.deepEqual(port.deactivations, [['tok-a', 'tok-b']])
  })

  it('★ 5xx ⇒ provider_error 且**不动** token（401 可能只是我们配错凭据）', async () => {
    gateway.status = 503
    gateway.responseBody = { error: 'down' }

    const result = await adapter().send(makeMessage())

    assert.equal(result.delivered === false ? result.reason : '', 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /HTTP 503/)
    assert.equal(port.deactivations.length, 0, '非 410 也改了 token 状态 —— 一次配错会清空用户设备')
  })

  it('没有 token ⇒ no_device_token，且**不**发网络请求', async () => {
    port.active = []
    const result = await adapter().send(makeMessage())
    assert.deepEqual(result, { delivered: false, reason: 'no_device_token' })
    assert.equal(gateway.received.length, 0)
  })

  it('读 token 抛错（无库 501）⇒ provider_error，绝不冒充「这个人没有设备」', async () => {
    port.listError = new Error('DEVICE_TOKENS_PERSISTENCE_NOT_IMPLEMENTED')
    const result = await adapter().send(makeMessage())
    assert.equal(result.delivered === false ? result.reason : '', 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /读取设备 token 失败/)
  })

  it('超时（网关比 timeoutMs 慢）⇒ provider_error，不外抛', async () => {
    gateway.delayMs = 300
    const result = await adapter({ timeoutMs: 100 }).send(makeMessage())
    assert.equal(result.delivered === false ? result.reason : '', 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /不可达/)
  })

  it('410 后 deactivateTokens 抛错 ⇒ 仍是 provider_error（状态写不进去不该变成异常）', async () => {
    gateway.status = 410
    gateway.responseBody = { invalidTokens: ['tok-a'] }
    port.deactivateTokens = async (): Promise<number> => {
      throw new Error('连接池耗尽')
    }
    const result = await adapter().send(makeMessage())
    assert.equal(result.delivered === false ? result.reason : '', 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /已置 0 条/)
  })
})






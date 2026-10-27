/**
 * push-delivery-e2e-db.dbtest.ts —— 推送链路**端到端**的真库证据（W6-G，2026-10-25）
 *
 * ── 这份用例补的是哪一段 ────────────────────────────────────────────────────
 *   W6-A ~ W6-F 已经分别证明了「token 能登记」「任务能入队」「worker 会结算」
 *   「队列能对账」「Flutter 会上报 / 注销」。但那条链**从来没有一次真正接通**：
 *   审批 HTTP → 同一事务写 Notification + PushRetryJob → worker 领件 →
 *   `WebhookPushAdapter` 读真 `DeviceToken` → POST 到**真 HTTP 网关** → 回写任务状态。
 *   本文件把这段接起来，且除网关外**没有任何替身**：
 *
 *     · 真 Nest（`AppModule`，真实路由 / 三道屏障 / Prisma 端口）；
 *     · 真 Postgres（审批、通知、任务、token 全部读库）；
 *     · 真 `PushRetryWorker.tick()`（不是直接调 adapter 绕过结算）；
 *     · 真 `WebhookPushAdapter`（不是手写 fetch）；
 *     · 真 `node:http` 网关（本进程内监听 127.0.0.1 的随机端口）。
 *
 * ── 为什么这里可以不用 L2 / L3 的推送凭据 ───────────────────────────────────
 *   本仓库接的是**一条 HTTP 契约**，不是 APNs / FCM SDK（见
 *   `webhook-push.adapter.ts` 文件头）。契约的另一端由本文件的本地网关扮演，
 *   所以「网关说什么」可以逐字控制：200 / 500 / 410 / 没有 token。
 *   真正缺的仍然是「网关再往后交给谁」—— 那需要外部凭据，不在本套件的射程内。
 *
 * ── 五个组，各自证明一件离线用例证明不了的事 ────────────────────────────────
 *   A. `POST /device-tokens` 走真路由 + 真库：响应不回显 token，库里有 active 行；
 *   B. 批准 ⇒ worker 真把 `approval.status_changed` 发到网关，任务转 `sent`，
 *      网关收到的 token / 授权头 / 消息体都与库里一致；
 *   C. 网关 500 ⇒ 任务按**渠道故障**重试（`attempts + 1`），而审批**仍然成立**、
 *      心愿**仍然落地** —— 推送失败绝不回滚业务；
 *   D. 网关 410 ⇒ 该 token 在库里被置为 inactive，任务同样按渠道故障重试；
 *   E. 收件人没有 token ⇒ 适配器**根本不会发 HTTP**，任务按**结构性失败**重试
 *      （`attempts` 不变、5 分钟后再来），不是「当成渠道坏了」把次数烧光。
 *
 * ── 怎么让「我们这一条」一定被 worker 领到 ──────────────────────────────────
 *   共享实验库里可能躺着历史任务（本仓库不做 DELETE 清理）。因此本套件：
 *     ① 把 `PUSH_RETRY_CONFIG.batchSize` 覆盖成 **1**（只领一条）；
 *     ② 被测任务的 `nextAttemptAt` 临时改成 `2000-01-01`（比任何历史行都早）。
 *   这样 `claimDue` 的 `ORDER BY nextAttemptAt ASC` 第一条必然是本用例创建的那条，
 *   既不需要清库，也不会顺手把别人的任务发出去。
 *
 * ── ★ 与其它真库套件同一条纪律：不做 DELETE 清理 ────────────────────────────
 *   每轮用新前缀（`dbtest-<run>-e2e-…`），跑完那些行还在，本身就是证据。
 *   入口：`npm run test:db`（缺 `DATABASE_URL` 直接红，`NODE_ENV=production` 硬拒绝）。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AppModule } from '../src/app.module'
import { applyGlobalPipes } from '../src/app.setup'
import { PrismaDeviceTokensRepository } from '../src/device-tokens/device-tokens.prisma.repository'
import { PUSH_DELIVERY_PORT } from '../src/notifications/push.port'
import { PUSH_RETRY_CONFIG, type PushRetryConfig } from '../src/notifications/push-retry.config'
import type { PushRetryTickResult } from '../src/notifications/push-retry.types'
import { PushRetryWorker } from '../src/notifications/push-retry.worker'
import type { WebhookPushConfig } from '../src/notifications/push-webhook.config'
import {
  WebhookPushAdapter,
  type WebhookPushPayload
} from '../src/notifications/webhook-push.adapter'
import { PrismaService } from '../src/prisma/prisma.service'
import { grantConsentFor } from './support/consent-fixture'

const RUN = randomUUID().replace(/-/g, '').slice(0, 10)

const ID = {
  // 家庭 A：两位家长 + 一个孩子 —— 批准链（组 B / C）
  dad: `dbtest-${RUN}-e2e-dad`,
  mom: `dbtest-${RUN}-e2e-mom`,
  kid: `dbtest-${RUN}-e2e-kid`,
  child: `dbtest-${RUN}-e2e-child`,
  devDad: `dbtest-${RUN}-e2e-dev-dad`,
  devMom: `dbtest-${RUN}-e2e-dev-mom`,
  devKid: `dbtest-${RUN}-e2e-dev-kid`,
  // 家庭 B：一位家长 + 一个孩子，家长**没有** token —— 结构性失败（组 E）
  dadB: `dbtest-${RUN}-e2e-dad-b`,
  kidB: `dbtest-${RUN}-e2e-kid-b`,
  childB: `dbtest-${RUN}-e2e-child-b`,
  devDadB: `dbtest-${RUN}-e2e-dev-dad-b`,
  devKidB: `dbtest-${RUN}-e2e-dev-kid-b`,
  // 家庭 C：一位家长 + 一个孩子，家长有 token —— 410 失效（组 D）
  momC: `dbtest-${RUN}-e2e-mom-c`,
  kidC: `dbtest-${RUN}-e2e-kid-c`,
  childC: `dbtest-${RUN}-e2e-child-c`,
  devMomC: `dbtest-${RUN}-e2e-dev-mom-c`,
  devKidC: `dbtest-${RUN}-e2e-dev-kid-c`
} as const

const H = {
  dad: { 'x-kp-device-id': ID.devDad, 'x-kp-child-id': ID.child },
  mom: { 'x-kp-device-id': ID.devMom, 'x-kp-child-id': ID.child },
  kid: { 'x-kp-device-id': ID.devKid, 'x-kp-child-id': ID.child },
  dadB: { 'x-kp-device-id': ID.devDadB, 'x-kp-child-id': ID.childB },
  kidB: { 'x-kp-device-id': ID.devKidB, 'x-kp-child-id': ID.childB },
  momC: { 'x-kp-device-id': ID.devMomC, 'x-kp-child-id': ID.childC },
  kidC: { 'x-kp-device-id': ID.devKidC, 'x-kp-child-id': ID.childC }
} as const

const TOKEN = {
  kid: `tok-${RUN}-e2e-kid`,
  dadRevoked: `tok-${RUN}-e2e-dad-revoked`,
  momC: `tok-${RUN}-e2e-mom-c`
} as const

/** 本地网关的凭据：适配器只在配置了 token 时才带 `authorization`，这里顺便验它。 */
const GATEWAY_TOKEN = `gw-token-${RUN}`

let prisma: PrismaService
let app: INestApplication
let worker: PushRetryWorker
let url = ''

// ══ 本地推送网关（契约另一端）═════════════════════════════════════════════════

type GatewayMode = 'ok' | 'fail500' | 'gone410'

interface GatewayCall {
  event: string | undefined
  authorization: string | undefined
  body: WebhookPushPayload
}

const gateway = {
  mode: 'ok' as GatewayMode,
  calls: [] as GatewayCall[],
  seq: 0
}

let gatewayServer: Server

function startGateway(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: WebhookPushPayload
    try {
      body = JSON.parse(raw) as WebhookPushPayload
    } catch {
      // 网关看不懂的请求体不该被算成一次「成功投递」—— 直接 400，让 worker 走失败结算。
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('invalid json')
      return
    }

    gateway.calls.push({
      event: typeof req.headers['x-kp-event'] === 'string' ? req.headers['x-kp-event'] : undefined,
      authorization: req.headers.authorization,
      body
    })

    if (gateway.mode === 'gone410') {
      // 只把本次发出去的 token 列回来（适配器会再与 sent 集合求交）。
      res.writeHead(410, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ invalidTokens: body.tokens.map((row) => row.token) }))
      return
    }
    if (gateway.mode === 'fail500') {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('gateway down')
      return
    }

    gateway.seq += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ messageId: `gw-${RUN}-${gateway.seq}` }))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${address.port}/push` })
    })
  })
}

function resetGateway(mode: GatewayMode): void {
  gateway.mode = mode
  gateway.calls.length = 0
}

// ══ 真库 / 真 HTTP 的小工具 ═══════════════════════════════════════════════════

interface HttpResult {
  status: number
  body: Record<string, unknown>
}

async function send(
  path: string,
  init: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<HttpResult> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(init.body ?? {})
  })
  const text = await res.text()
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: res.status, body }
}

async function seed(): Promise<void> {
  const future = new Date(Date.now() + 60 * 60_000)
  await prisma.child.createMany({
    data: [
      { id: ID.child, name: `推送 e2e 套件 A ${RUN}` },
      { id: ID.childB, name: `推送 e2e 套件 B ${RUN}` },
      { id: ID.childC, name: `推送 e2e 套件 C ${RUN}` }
    ]
  })
  await prisma.user.createMany({
    data: [
      { id: ID.dad, displayName: 'e2e 家长 A' },
      { id: ID.mom, displayName: 'e2e 家长 B' },
      { id: ID.kid, displayName: 'e2e 孩子 A' },
      { id: ID.dadB, displayName: 'e2e 家长 B 家' },
      { id: ID.kidB, displayName: 'e2e 孩子 B 家' },
      { id: ID.momC, displayName: 'e2e 家长 C 家' },
      { id: ID.kidC, displayName: 'e2e 孩子 C 家' }
    ]
  })
  await prisma.childMember.createMany({
    data: [
      { childId: ID.child, userId: ID.dad, role: 'guardian' },
      { childId: ID.child, userId: ID.mom, role: 'guardian' },
      { childId: ID.child, userId: ID.kid, role: 'child' },
      { childId: ID.childB, userId: ID.dadB, role: 'guardian' },
      { childId: ID.childB, userId: ID.kidB, role: 'child' },
      { childId: ID.childC, userId: ID.momC, role: 'guardian' },
      { childId: ID.childC, userId: ID.kidC, role: 'child' }
    ]
  })
  // ★ W7-A 起写端点都过 ConsentGuard：三家各自授权（提交 → 审批都要过闸门）。
  await grantConsentFor(prisma, [
    [ID.child, ID.dad],
    [ID.childB, ID.dadB],
    [ID.childC, ID.momC]
  ])
  await prisma.deviceSession.createMany({
    data: [
      { deviceId: ID.devDad, childId: ID.child, userId: ID.dad, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devMom, childId: ID.child, userId: ID.mom, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKid, childId: ID.child, userId: ID.kid, activeRole: 'child', expiresAt: future },
      { deviceId: ID.devDadB, childId: ID.childB, userId: ID.dadB, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKidB, childId: ID.childB, userId: ID.kidB, activeRole: 'child', expiresAt: future },
      { deviceId: ID.devMomC, childId: ID.childC, userId: ID.momC, activeRole: 'guardian', expiresAt: future },
      { deviceId: ID.devKidC, childId: ID.childC, userId: ID.kidC, activeRole: 'child', expiresAt: future }
    ]
  })
}

/** 提交一条 `add_wish` 审批；返回 approvalId（断言 202 已在里面）。 */
async function submitWish(
  headers: Record<string, string>,
  title: string,
  cost = 15
): Promise<string> {
  const res = await send('/approvals', {
    headers,
    body: { action: 'add_wish', title, cost, emoji: '🎈' }
  })
  assert.equal(res.status, 202, `提交审批失败：${JSON.stringify(res.body)}`)
  const id = res.body.id
  assert.equal(typeof id, 'string', '202 响应里没有 approvalId')
  return id as string
}

async function approveWish(headers: Record<string, string>, approvalId: string): Promise<void> {
  const res = await send(`/approvals/${approvalId}/decide`, {
    headers,
    body: { decision: 'approved' }
  })
  assert.equal(res.status, 200, `批准失败：${JSON.stringify(res.body)}`)
}

function keyOfStatusChanged(approvalId: string, recipientUserId: string): string {
  return `approval.status_changed:${approvalId}:${recipientUserId}:approved`
}

function keyOfSubmitted(approvalId: string, recipientUserId: string): string {
  return `approval.submitted:${approvalId}:${recipientUserId}`
}

/**
 * 把一条任务的 `nextAttemptAt` 拨到 2000 年。
 *
 * ★ 只改时间，不改 status / attempts / payload —— 仍是「一条到期的 pending 任务」，
 *   只是保证它在共享库里排第一（理由见文件头）。
 */
async function makeDue(dedupeKey: string): Promise<void> {
  const result = await prisma.pushRetryJob.updateMany({
    where: { dedupeKey, status: 'pending' },
    data: { nextAttemptAt: new Date('2000-01-01T00:00:00.000Z') }
  })
  assert.equal(result.count, 1, `没有找到待发任务 ${dedupeKey}`)
}

async function jobOf(dedupeKey: string) {
  const row = await prisma.pushRetryJob.findUnique({ where: { dedupeKey } })
  assert.ok(row !== null, `库里没有任务 ${dedupeKey}`)
  return row
}

function assertTickSettled(
  result: PushRetryTickResult,
  expected: Partial<Pick<PushRetryTickResult, 'sent' | 'retried' | 'dead' | 'expired'>>
): void {
  assert.equal(result.claimed, 1, `本轮应只领 1 条，实际 claimed=${result.claimed}`)
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(
      result[field as keyof PushRetryTickResult],
      value,
      `本轮结算结果不符：${JSON.stringify(result)}`
    )
  }
}

// ══ 装配 ═════════════════════════════════════════════════════════════════════

before(async () => {
  prisma = new PrismaService()
  await prisma.$connect()
  await seed()

  const started = await startGateway()
  gatewayServer = started.server

  const pushConfig: WebhookPushConfig = {
    url: started.url,
    token: GATEWAY_TOKEN,
    // 与默认值一致：必须小于 worker 的 1000ms 兜底，否则「适配器还没超时就被判死」。
    timeoutMs: 800
  }
  const realAdapter = new WebhookPushAdapter(
    pushConfig,
    new PrismaDeviceTokensRepository(prisma)
  )

  const retryConfig: PushRetryConfig = {
    enabled: true,
    intervalMs: 15_000,
    // ★ 只领一条：共享库里的历史任务不会被这一轮顺手发出去（文件头「怎么让…」）。
    batchSize: 1,
    ttlMs: 24 * 60 * 60_000,
    claimTimeoutMs: 60_000,
    maxAttempts: 6
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // 真 Nest + 真路由；只把**网关地址**与「每轮领几条」换成本套件的值。
    // 适配器本身仍是生产实现（`WebhookPushAdapter`），不是替身。
    .overrideProvider(PUSH_DELIVERY_PORT)
    .useValue(realAdapter)
    .overrideProvider(PUSH_RETRY_CONFIG)
    .useValue(retryConfig)
    .compile()

  app = moduleRef.createNestApplication()
  applyGlobalPipes(app)
  await app.listen(0, '127.0.0.1')
  url = await app.getUrl()
  worker = app.get(PushRetryWorker)
})

after(async () => {
  await app.close()
  await new Promise<void>((resolve, reject) => {
    gatewayServer.close((error) => (error === undefined ? resolve() : reject(error)))
  })
  await prisma.$disconnect()
})

// ══ 组 A：token 登记走真路由 + 真库 ═════════════════════════════════════════

describe('组 A：POST /device-tokens ⇒ 真库行，响应不回显 token', () => {
  it('孩子登记 token ⇒ 200、active=true、库里有行；响应体没有 token 字段', async () => {
    const res = await send('/device-tokens', {
      headers: H.kid,
      body: { platform: 'ios', token: TOKEN.kid }
    })
    assert.equal(res.status, 200, `登记 token 失败：${JSON.stringify(res.body)}`)
    assert.equal(res.body.active, true)
    assert.equal(res.body.platform, 'ios')
    assert.equal('token' in res.body, false, '响应回显了设备 token —— 它会进日志 / 截图')

    const row = await prisma.deviceToken.findUnique({ where: { token: TOKEN.kid } })
    assert.ok(row !== null)
    assert.equal(row.userId, ID.kid, 'token 的归属不是会话 actor')
    assert.equal(row.childId, ID.child)
    assert.equal(row.active, true)
  })

  it('注销后再注销仍 200（结构性幂等），库里 active=false 且 revokedAt 不变', async () => {
    const registered = await send('/device-tokens', {
      headers: H.dad,
      body: { platform: 'android', token: TOKEN.dadRevoked }
    })
    assert.equal(registered.status, 200, `登记 token 失败：${JSON.stringify(registered.body)}`)

    const first = await send('/device-tokens/revoke', {
      headers: H.dad,
      body: { token: TOKEN.dadRevoked }
    })
    assert.equal(first.status, 200, `注销失败：${JSON.stringify(first.body)}`)
    assert.equal(first.body.active, false)

    const second = await send('/device-tokens/revoke', {
      headers: H.dad,
      body: { token: TOKEN.dadRevoked }
    })
    assert.equal(second.status, 200, '重复注销不是幂等 200')
    assert.equal(second.body.revokedAt, first.body.revokedAt, '第二次注销改写了 revokedAt')

    const row = await prisma.deviceToken.findUnique({ where: { token: TOKEN.dadRevoked } })
    assert.ok(row !== null)
    assert.equal(row.active, false)
    assert.ok(row.revokedAt !== null)
  })
})

// ══ 组 B：批准 ⇒ worker ⇒ 真网关（成功链）════════════════════════════════════

describe('组 B：批准 ⇒ worker 真发到网关 ⇒ 任务 sent（成功链）', () => {
  it('网关收到 approval.status_changed + 孩子的 token + Bearer 凭据；任务写 providerMessageId', async () => {
    resetGateway('ok')
    const approvalId = await submitWish(H.kid, `e2e 成功链 ${RUN}`, 15)
    await approveWish(H.dad, approvalId)

    const dedupeKey = keyOfStatusChanged(approvalId, ID.kid)
    await makeDue(dedupeKey)

    const result = await worker.tick(new Date())
    assertTickSettled(result, { sent: 1, retried: 0, dead: 0 })

    // ── 网关侧：收到的是**库里的那条消息**，不是测试另拼的一份 ────────────────
    assert.equal(gateway.calls.length, 1, 'worker 没有恰好调用一次网关')
    const call = gateway.calls[0]
    assert.equal(call.event, 'approval.status_changed')
    assert.equal(call.authorization, `Bearer ${GATEWAY_TOKEN}`)
    assert.equal(call.body.version, 1)
    assert.equal(call.body.event, 'approval.status_changed')
    assert.equal(call.body.message.type, 'approval.status_changed')
    assert.equal(call.body.message.approvalId, approvalId)
    assert.equal(call.body.message.recipientUserId, ID.kid)
    assert.equal(call.body.message.status, 'approved')
    assert.deepEqual(call.body.tokens, [{ token: TOKEN.kid, platform: 'ios' }])

    // ── 队列侧：sent + providerMessageId（不是编出来的 null）────────────────
    const job = await jobOf(dedupeKey)
    assert.equal(job.status, 'sent')
    assert.equal(job.attempts, 0)
    assert.equal(job.claimedAt, null, '终态还留着 claimedAt —— 排查时会误判为「正在发送」')
    assert.equal(job.sentAt !== null, true)
    assert.equal(job.providerMessageId, `gw-${RUN}-1`)

    // ── 业务侧：审批仍是 approved，心愿真的落库 ────────────────────────────
    const approval = await prisma.approvalRequest.findUnique({ where: { id: approvalId } })
    assert.equal(approval?.status, 'approved')
    const wish = await prisma.wish.findFirst({
      where: { childId: ID.child, title: `e2e 成功链 ${RUN}` }
    })
    assert.ok(wish !== null, '批准后没有创建心愿')
  })
})

// ══ 组 C：网关 500 ⇒ 重试，但业务不回滚 ═════════════════════════════════════

describe('组 C：网关 500 ⇒ 任务按渠道故障重试，审批与心愿不受影响', () => {
  it('attempts=1、nextAttemptAt 前移；ApprovalRequest 仍 approved，Wish 仍创建', async () => {
    resetGateway('fail500')
    const approvalId = await submitWish(H.kid, `e2e 失败不回滚 ${RUN}`, 9)
    await approveWish(H.dad, approvalId)

    const dedupeKey = keyOfStatusChanged(approvalId, ID.kid)
    await makeDue(dedupeKey)

    const before = new Date()
    const result = await worker.tick(before)
    assertTickSettled(result, { sent: 0, retried: 1, dead: 0 })
    assert.equal(gateway.calls.length, 1)

    const job = await jobOf(dedupeKey)
    assert.equal(job.status, 'pending', '渠道故障没有回到 pending')
    assert.equal(job.attempts, 1, '渠道故障没有消耗一次尝试')
    assert.equal(job.claimedAt, null)
    assert.match(job.lastError ?? '', /HTTP 500/)
    assert.ok(
      job.nextAttemptAt.getTime() >= before.getTime() + 30_000,
      '没有按 30s 退避排下一次'
    )

    // ★ 这条是本文件最要紧的断言：推送失败**没有**回滚已经成立的业务。
    const approval = await prisma.approvalRequest.findUnique({ where: { id: approvalId } })
    assert.equal(approval?.status, 'approved', '推送失败把审批回滚了')
    const wish = await prisma.wish.findFirst({
      where: { childId: ID.child, title: `e2e 失败不回滚 ${RUN}` }
    })
    assert.ok(wish !== null, '推送失败把心愿回滚了')
  })
})

// ══ 组 D：网关 410 ⇒ token 下线 + 任务重试 ═══════════════════════════════════

describe('组 D：网关 410 ⇒ 该 token 置为 inactive，任务按渠道故障重试', () => {
  it('C 家家长登记 token 后收到待确认推送；网关回 410 ⇒ 库里 active=false、attempts=1', async () => {
    const registered = await send('/device-tokens', {
      headers: H.momC,
      body: { platform: 'weapp', token: TOKEN.momC }
    })
    assert.equal(registered.status, 200, `登记 token 失败：${JSON.stringify(registered.body)}`)

    resetGateway('gone410')
    const approvalId = await submitWish(H.kidC, `e2e 410 ${RUN}`, 8)
    const dedupeKey = keyOfSubmitted(approvalId, ID.momC)
    await makeDue(dedupeKey)

    const result = await worker.tick(new Date())
    assertTickSettled(result, { sent: 0, retried: 1, dead: 0 })

    assert.equal(gateway.calls.length, 1)
    assert.equal(gateway.calls[0].event, 'approval.submitted')
    assert.deepEqual(gateway.calls[0].body.tokens, [{ token: TOKEN.momC, platform: 'weapp' }])

    const tokenRow = await prisma.deviceToken.findUnique({ where: { token: TOKEN.momC } })
    assert.ok(tokenRow !== null)
    assert.equal(tokenRow.active, false, '网关说 token 失效，库里仍是 active')
    assert.ok(tokenRow.revokedAt !== null, '下线 token 时没有写 revokedAt')

    const job = await jobOf(dedupeKey)
    assert.equal(job.status, 'pending')
    assert.equal(job.attempts, 1)
    assert.match(job.lastError ?? '', /410/)

    const approval = await prisma.approvalRequest.findUnique({ where: { id: approvalId } })
    assert.equal(approval?.status, 'pending', '推送失败影响了审批状态')
  })
})

// ══ 组 E：没有 token ⇒ 结构性失败，不发 HTTP、不消耗次数 ═══════════════════

describe('组 E：收件人没有 token ⇒ 不发 HTTP，按结构性失败重试（不消耗 attempts）', () => {
  it('B 家家长没有 token ⇒ 网关 0 次调用；任务 attempts 仍 0，5 分钟后再试', async () => {
    resetGateway('ok')
    const approvalId = await submitWish(H.kidB, `e2e 没有设备 ${RUN}`, 7)
    const dedupeKey = keyOfSubmitted(approvalId, ID.dadB)
    await makeDue(dedupeKey)

    const before = new Date()
    const result = await worker.tick(before)
    assertTickSettled(result, { sent: 0, retried: 1, dead: 0 })

    assert.equal(gateway.calls.length, 0, '没有 token 却仍然调用了网关')

    const job = await jobOf(dedupeKey)
    assert.equal(job.status, 'pending')
    assert.equal(job.attempts, 0, '结构性失败消耗了 attempts —— 24h 内会被无意义地判死')
    assert.equal(job.lastError, 'no_device_token')
    assert.equal(job.claimedAt, null)
    const delay = job.nextAttemptAt.getTime() - before.getTime()
    assert.ok(delay >= 4 * 60_000, `结构性退避不是 5 分钟：${delay}ms`)

    const approval = await prisma.approvalRequest.findUnique({ where: { id: approvalId } })
    assert.equal(approval?.status, 'pending')
  })
})

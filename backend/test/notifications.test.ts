/**
 * notifications.test.ts —— 推送预留接口（W5-K，2026-10-23）
 *
 * ── 这个文件在守什么 ──────────────────────────────────────────────────────
 *   ① 默认适配器**不许假装送达**：`provider_not_configured` 必须是可断言的事实；
 *   ② `NotificationsService` 是唯一入口，且**永不抛错** —— 第三方抛错 / 超时
 *      都不能让一次已经提交的审批变成 500（`01` §4 / `02` §9.23）；
 *   ③ 消息字段**原样转发**（不在 service 里二次改写），换渠道时契约稳定。
 *
 * ★ 本文件只测「端口 + 服务」；「审批真的会调用它」在
 *   `approvals-http.test.ts` 的「推送预留」组（真 HTTP、真装配）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Test } from '@nestjs/testing'

import { NoopPushAdapter } from '../src/notifications/noop-push.adapter'
import { NotificationsModule } from '../src/notifications/notifications.module'
import { NotificationsService } from '../src/notifications/notifications.service'
import {
  PUSH_PORT,
  type ApprovalStatusChangedPush,
  type PushMessage,
  type PushPort,
  type PushResult
} from '../src/notifications/push.port'

/** 一条形状完整的消息；用例只按需覆盖字段。 */
function makeMessage(overrides: Partial<ApprovalStatusChangedPush> = {}): PushMessage {
  return {
    type: 'approval.status_changed',
    approvalId: 'ap-1',
    childId: 'child-1',
    recipientUserId: 'u-kid',
    action: 'redeem',
    status: 'approved',
    decidedByUserId: 'u-dad',
    occurredAt: '2026-10-23T00:00:00.000Z',
    ...overrides
  }
}

/** 记录型替身：可选「抛错」/「永不返回」，用来证明服务的兜底。 */
function makePushFake(
  behaviour: { failWith?: Error; hang?: boolean } = {}
): PushPort & { messages: PushMessage[] } {
  const messages: PushMessage[] = []
  return {
    messages,
    async send(message: PushMessage): Promise<PushResult> {
      messages.push(message)
      if (behaviour.failWith !== undefined) throw behaviour.failWith
      if (behaviour.hang === true) return new Promise<PushResult>(() => {})
      return { delivered: true, providerMessageId: 'pm-1' }
    }
  }
}

describe('默认装配：NoopPushAdapter 如实回答「没配置渠道」', () => {
  it('send() ⇒ delivered:false / provider_not_configured（不假装送达）', async () => {
    const result = await new NoopPushAdapter().send(makeMessage())
    assert.deepEqual(result, { delivered: false, reason: 'provider_not_configured' })
  })

  it('NotificationsModule 把 PUSH_PORT 绑到 NoopPushAdapter，并导出服务', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [NotificationsModule] }).compile()
    try {
      assert.ok(
        moduleRef.get(PUSH_PORT) instanceof NoopPushAdapter,
        '默认绑定不是 no-op —— 没接第三方却可能被当成「已送达」'
      )
      const service = moduleRef.get(NotificationsService)
      const result = await service.notifyApprovalStatusChanged(makeMessage())
      assert.equal(result.delivered, false)
      assert.equal(result.delivered === false ? result.reason : null, 'provider_not_configured')
    } finally {
      await moduleRef.close()
    }
  })
})

describe('NotificationsService：唯一入口的兜底语义', () => {
  it('原样转发消息，并返回适配器结果（不在 service 里改写字段）', async () => {
    const push = makePushFake()
    const service = new NotificationsService(push)
    const message = makeMessage({ status: 'rejected', decidedByUserId: 'u-mom' })

    const result = await service.notifyApprovalStatusChanged(message)

    assert.deepEqual(result, { delivered: true, providerMessageId: 'pm-1' })
    assert.equal(push.messages.length, 1)
    assert.deepEqual(push.messages[0], message, '消息被改写 —— 换渠道时会悄悄丢字段')
  })

  it('适配器抛错 ⇒ 返回 provider_error，**不向调用方抛出**', async () => {
    const push = makePushFake({ failWith: new Error('APNs 证书过期') })
    const service = new NotificationsService(push)

    const result = await service.notifyApprovalStatusChanged(makeMessage())

    assert.equal(push.messages.length, 1, '适配器没被调用 —— 兜底测的不是这条路径')
    assert.equal(result.delivered, false)
    assert.equal(result.delivered === false ? result.reason : null, 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /APNs 证书过期/)
  })

  it('适配器抛非 Error（字符串）⇒ 同样兜住，detail 保留原文', async () => {
    const push: PushPort = {
      async send(): Promise<PushResult> {
        // 故意的非 Error 抛出：第三方 SDK 有时这么干，不能因此炸掉调用链
        throw 'provider exploded'
      }
    }
    const service = new NotificationsService(push)

    const result = await service.notifyApprovalStatusChanged(makeMessage())

    assert.equal(result.delivered, false)
    assert.equal(result.delivered === false ? result.reason : null, 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /provider exploded/)
  })

  it('适配器永不返回 ⇒ 超时兜底为 provider_error（不能把审批请求挂住）', { timeout: 5000 }, async () => {
    const push = makePushFake({ hang: true })
    const service = new NotificationsService(push)

    const result = await service.notifyApprovalStatusChanged(makeMessage())

    assert.equal(result.delivered, false)
    assert.equal(result.delivered === false ? result.reason : null, 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /未返回/)
  })
})

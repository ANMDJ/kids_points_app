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

import { HttpException } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { encodeKeysetCursor } from '../src/common/keyset-cursor'
import { NoopPushAdapter } from '../src/notifications/noop-push.adapter'
import { NotificationsModule } from '../src/notifications/notifications.module'
import {
  type MarkReadInput,
  type NotificationsPort
} from '../src/notifications/notifications.repository'
import { NotificationsService } from '../src/notifications/notifications.service'
import type {
  AppendNotificationInput,
  ListNotificationsInput,
  MarkNotificationReadResult,
  NotificationPageRow,
  NotificationRow
} from '../src/notifications/notifications.types'
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

/** 记录型替身：证明「写站内」与「发推送」互不影响。 */
interface RepositoryBehaviour {
  appendError?: Error
  page?: NotificationPageRow | null
  markReadResult?: MarkNotificationReadResult
}

function makeRepositoryFake(
  behaviour: RepositoryBehaviour = {}
): NotificationsPort & {
  appended: AppendNotificationInput[]
  listInputs: ListNotificationsInput[]
  markReadInputs: MarkReadInput[]
} {
  const appended: AppendNotificationInput[] = []
  const listInputs: ListNotificationsInput[] = []
  const markReadInputs: MarkReadInput[] = []
  return {
    appended,
    listInputs,
    markReadInputs,
    async listForRecipient(input: ListNotificationsInput): Promise<NotificationPageRow | null> {
      listInputs.push(input)
      return behaviour.page ?? null
    },
    async markRead(input: MarkReadInput): Promise<MarkNotificationReadResult> {
      markReadInputs.push(input)
      return behaviour.markReadResult ?? { kind: 'not_found' }
    },
    async append(input: AppendNotificationInput): Promise<void> {
      if (behaviour.appendError !== undefined) throw behaviour.appendError
      appended.push(input)
    }
  }
}

/** 固定时刻的行：ISO 断言才有确定值。 */
const APPROVED_AT = new Date('2026-10-23T02:00:00.000Z')
const OLDER_AT = new Date('2026-10-22T02:00:00.000Z')

function makeRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 'n-1',
    type: 'approval.approved',
    title: '兑换申请已通过',
    body: '家长已同意你的兑换申请，积分与心愿已按约定结算。',
    payload: { approvalId: 'ap-1' },
    readAt: null,
    createdAt: APPROVED_AT,
    ...overrides
  }
}

/** 从 Nest 异常里取「状态码 + 业务 code」（两边都要断言，只有状态码会漏掉语义）。 */
async function expectHttpError(promise: Promise<unknown>): Promise<{
  status: number
  code: string
}> {
  try {
    await promise
  } catch (error) {
    if (!(error instanceof HttpException)) throw error
    const response = error.getResponse()
    const code =
      typeof response === 'object' && response !== null && 'code' in response
        ? String((response as { code: unknown }).code)
        : ''
    return { status: error.getStatus(), code }
  }
  assert.fail('期望抛错，但调用成功返回了')
}

describe('默认装配：NoopPushAdapter 如实回答「没配置渠道」', () => {
  it('send() ⇒ delivered:false / provider_not_configured（不假装送达）', async () => {
    const result = await new NoopPushAdapter().send(makeMessage())
    assert.deepEqual(result, { delivered: false, reason: 'provider_not_configured' })
  })

  it('NotificationsModule 把 PUSH_PORT 绑到 NoopPushAdapter，并导出服务', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [NotificationsModule.register({ hasDatabase: false })] }).compile()
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
    const service = new NotificationsService(push, makeRepositoryFake())
    const message = makeMessage({ status: 'rejected', decidedByUserId: 'u-mom' })

    const result = await service.notifyApprovalStatusChanged(message)

    assert.deepEqual(result, { delivered: true, providerMessageId: 'pm-1' })
    assert.equal(push.messages.length, 1)
    assert.deepEqual(push.messages[0], message, '消息被改写 —— 换渠道时会悄悄丢字段')
  })

  it('适配器抛错 ⇒ 返回 provider_error，**不向调用方抛出**', async () => {
    const push = makePushFake({ failWith: new Error('APNs 证书过期') })
    const service = new NotificationsService(push, makeRepositoryFake())

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
    const service = new NotificationsService(push, makeRepositoryFake())

    const result = await service.notifyApprovalStatusChanged(makeMessage())

    assert.equal(result.delivered, false)
    assert.equal(result.delivered === false ? result.reason : null, 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /provider exploded/)
  })

  it('适配器永不返回 ⇒ 超时兜底为 provider_error（不能把审批请求挂住）', { timeout: 5000 }, async () => {
    const push = makePushFake({ hang: true })
    const service = new NotificationsService(push, makeRepositoryFake())

    const result = await service.notifyApprovalStatusChanged(makeMessage())

    assert.equal(result.delivered, false)
    assert.equal(result.delivered === false ? result.reason : null, 'provider_error')
    assert.match(result.delivered === false ? String(result.detail) : '', /未返回/)
  })
})

describe('站内通知（W5-L）：审批结论落一条，且与推送互不牵连', () => {
  it('批准 ⇒ 写 approval.approved，收件人是申请人，payload 只带跳转 id', async () => {
    const push = makePushFake()
    const repository = makeRepositoryFake()
    const service = new NotificationsService(push, repository)

    await service.notifyApprovalStatusChanged(makeMessage())

    assert.equal(repository.appended.length, 1, '批准后没有站内通知 —— 孩子只能靠推送，而推送未接')
    const row = repository.appended[0]
    assert.equal(row.childId, 'child-1')
    assert.equal(row.recipientUserId, 'u-kid', '收件人不是申请人')
    assert.equal(row.type, 'approval.approved')
    assert.equal(row.title, '兑换申请已通过')
    assert.match(row.body, /同意/)
    assert.deepEqual(row.payload, {
      approvalId: 'ap-1',
      status: 'approved',
      action: 'redeem',
      decidedByUserId: 'u-dad'
    })
  })

  it('拒绝 ⇒ approval.rejected，文案是「没有同意」而不是「已完成」', async () => {
    const repository = makeRepositoryFake()
    const service = new NotificationsService(makePushFake(), repository)

    await service.notifyApprovalStatusChanged(
      makeMessage({ status: 'rejected', action: 'add_wish' })
    )

    const row = repository.appended[0]
    assert.equal(row.type, 'approval.rejected')
    assert.equal(row.title, '心愿申请未通过')
    assert.match(row.body, /没有同意/)
    assert.doesNotMatch(row.body, /结算/)
  })

  it('站内写入失败 ⇒ 仍然推送，且**不向调用方抛出**（审批不能被通知拖垮）', async () => {
    const push = makePushFake()
    const repository = makeRepositoryFake({ appendError: new Error('连接池耗尽') })
    const service = new NotificationsService(push, repository)

    const result = await service.notifyApprovalStatusChanged(makeMessage())

    assert.equal(repository.appended.length, 0)
    assert.deepEqual(result, { delivered: true, providerMessageId: 'pm-1' }, '站内失败把推送也跳过了')
    assert.equal(push.messages.length, 1)
  })
})

describe('站内通知（W5-L）：列表分页', () => {
  it('游标指向本页最后一行；行 → DTO 时 Date 翻成 ISO', async () => {
    const newer = makeRow({ id: 'n-new', createdAt: APPROVED_AT })
    const older = makeRow({
      id: 'n-old',
      type: 'approval.rejected',
      createdAt: OLDER_AT,
      readAt: OLDER_AT
    })
    const repository = makeRepositoryFake({
      page: { rows: [newer, older], hasMore: true, unreadCount: 1 }
    })
    const service = new NotificationsService(makePushFake(), repository)

    const response = await service.list({
      childId: 'child-1',
      recipientUserId: 'u-kid',
      limit: 2
    })

    assert.deepEqual(repository.listInputs, [
      { childId: 'child-1', recipientUserId: 'u-kid', limit: 2 }
    ])
    assert.equal(response.items.length, 2)
    assert.equal(response.items[0].createdAt, '2026-10-23T02:00:00.000Z')
    assert.equal(response.items[0].readAt, null, '未读被标成了已读')
    assert.equal(response.items[1].readAt, '2026-10-22T02:00:00.000Z')
    assert.equal(response.unreadCount, 1)
    assert.equal(response.hasMore, true)
    assert.equal(
      response.nextCursor,
      encodeKeysetCursor({ createdAt: OLDER_AT, id: 'n-old' }),
      '游标不是指向本页最后一行 —— 翻页会漏 / 重'
    )
  })

  it('hasMore=false ⇒ nextCursor 为 null（客户端据此停掉加载更多）', async () => {
    const service = new NotificationsService(
      makePushFake(),
      makeRepositoryFake({ page: { rows: [makeRow()], hasMore: false, unreadCount: 1 } })
    )

    const response = await service.list({
      childId: 'child-1',
      recipientUserId: 'u-kid',
      limit: 20
    })

    assert.equal(response.hasMore, false)
    assert.equal(response.nextCursor, null)
  })

  it('孩子不存在 / 已删（端口 null）⇒ 404 CHILD_NOT_FOUND，**不是**空页', async () => {
    const service = new NotificationsService(makePushFake(), makeRepositoryFake({ page: null }))

    const error = await expectHttpError(
      service.list({ childId: 'child-x', recipientUserId: 'u-kid', limit: 20 })
    )

    assert.deepEqual(error, { status: 404, code: 'CHILD_NOT_FOUND' })
  })

  it('非法 cursor ⇒ 400 INVALID_NOTIFICATION_CURSOR，且端口零调用', async () => {
    const repository = makeRepositoryFake()
    const service = new NotificationsService(makePushFake(), repository)

    const error = await expectHttpError(
      service.list({
        childId: 'child-1',
        recipientUserId: 'u-kid',
        limit: 20,
        cursor: 'not-a-real-cursor'
      })
    )

    assert.deepEqual(error, { status: 400, code: 'INVALID_NOTIFICATION_CURSOR' })
    assert.equal(repository.listInputs.length, 0, '游标坏了还去查库 —— 会静默退回第一页')
  })

  it('cursor 原样解析成 before 传给端口（不自己猜时间）', async () => {
    const repository = makeRepositoryFake({
      page: { rows: [], hasMore: false, unreadCount: 0 }
    })
    const service = new NotificationsService(makePushFake(), repository)
    const cursor = encodeKeysetCursor({ createdAt: APPROVED_AT, id: 'n-9' })

    await service.list({ childId: 'child-1', recipientUserId: 'u-kid', limit: 20, cursor })

    assert.deepEqual(repository.listInputs[0]?.before, { createdAt: APPROVED_AT, id: 'n-9' })
  })
})

describe('站内通知（W5-L）：标记已读', () => {
  it('命中 ⇒ 200 + 原 readAt 的 ISO 串；入参带会话来的 childId / userId', async () => {
    const repository = makeRepositoryFake({
      markReadResult: { kind: 'ok', id: 'n-1', readAt: APPROVED_AT }
    })
    const service = new NotificationsService(makePushFake(), repository)

    const response = await service.markRead({
      childId: 'child-1',
      recipientUserId: 'u-kid',
      notificationId: 'n-1'
    })

    assert.deepEqual(response, { id: 'n-1', readAt: '2026-10-23T02:00:00.000Z' })
    assert.deepEqual(repository.markReadInputs, [
      { childId: 'child-1', recipientUserId: 'u-kid', notificationId: 'n-1' }
    ])
  })

  it('不存在 / 不是发给我的 ⇒ 404 NOTIFICATION_NOT_FOUND（同一个 404，不区分原因）', async () => {
    const service = new NotificationsService(makePushFake(), makeRepositoryFake())

    const error = await expectHttpError(
      service.markRead({
        childId: 'child-1',
        recipientUserId: 'u-kid',
        notificationId: 'someone-elses'
      })
    )

    assert.deepEqual(error, { status: 404, code: 'NOTIFICATION_NOT_FOUND' })
  })
})

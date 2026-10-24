/**
 * notifications.test.ts —— 通知读接口 + 推送适配器（W5-K / W5-L；W6-C 收敛）
 *
 * ── 这个文件在守什么 ──────────────────────────────────────────────────────
 *   ① 默认适配器**不许假装送达**：`provider_not_configured` 必须是可断言的事实；
 *   ② `NotificationsService` 只剩**读**：列表分页 / 标记已读的边界；
 *   ③ 读失败要**响亮**（404 / 501），绝不返回空页冒充「你没有通知」。
 *
 * ★ W6-C 起，「审批提醒写入」不在本文件：它发生在审批事务里，见
 *   `notifications-outbox.test.ts`（离线）与 `test-db/approvals-outbox-db.dbtest.ts`（真库）。
 * ★ 本文件只测「端口 + 服务」；审批路径不再同步发送，见 `approvals-http.test.ts`。
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
  PUSH_DELIVERY_PORT,
  PUSH_PORT,
  type ApprovalStatusChangedPush
} from '../src/notifications/push.port'

/** 一条形状完整的消息；用例只按需覆盖字段。 */
function makeMessage(overrides: Partial<ApprovalStatusChangedPush> = {}): ApprovalStatusChangedPush {
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

/** 记录型替身：证明读接口把收件人 / 游标原样交给端口。 */
interface RepositoryBehaviour {
  appendError?: Error
  page?: NotificationPageRow | null
  markReadResult?: MarkNotificationReadResult
  /** 这个孩子的 active 家长（W5-M）；默认空数组 = 家里没有可通知的人。 */
  guardians?: string[]
  /** 读成员位失败（无库 501 / 连接池耗尽），用来证明「不通知也不影响审批」。 */
  guardianError?: Error
}

function makeRepositoryFake(
  behaviour: RepositoryBehaviour = {}
): NotificationsPort & {
  appended: AppendNotificationInput[]
  listInputs: ListNotificationsInput[]
  markReadInputs: MarkReadInput[]
  guardianInputs: string[]
} {
  const appended: AppendNotificationInput[] = []
  const listInputs: ListNotificationsInput[] = []
  const markReadInputs: MarkReadInput[] = []
  const guardianInputs: string[] = []
  return {
    appended,
    listInputs,
    markReadInputs,
    guardianInputs,
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
    },
    async listActiveGuardianUserIds(childId: string): Promise<string[]> {
      guardianInputs.push(childId)
      if (behaviour.guardianError !== undefined) throw behaviour.guardianError
      return behaviour.guardians ?? []
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
      // ★ W6-C：请求入口与 worker 用同一个投递实例；不是两套适配器。
      assert.equal(moduleRef.get(PUSH_PORT), moduleRef.get(PUSH_DELIVERY_PORT))
      assert.ok(moduleRef.get(NotificationsService) instanceof NotificationsService)
    } finally {
      await moduleRef.close()
    }
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
    const service = new NotificationsService(repository)

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
    const service = new NotificationsService(makeRepositoryFake({ page: null }))

    const error = await expectHttpError(
      service.list({ childId: 'child-x', recipientUserId: 'u-kid', limit: 20 })
    )

    assert.deepEqual(error, { status: 404, code: 'CHILD_NOT_FOUND' })
  })

  it('非法 cursor ⇒ 400 INVALID_NOTIFICATION_CURSOR，且端口零调用', async () => {
    const repository = makeRepositoryFake()
    const service = new NotificationsService(repository)

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
    const service = new NotificationsService(repository)
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
    const service = new NotificationsService(repository)

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
    const service = new NotificationsService(makeRepositoryFake())

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


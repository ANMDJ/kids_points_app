/**
 * habits-service.test.ts —— 应用服务的映射与防御性断言（W4-D）
 *
 * 这里**不**重复验证权限矩阵（`permission-matrix.test.ts` 已穷举）、
 * 也**不**测 HTTP（`habits-http.test.ts` 负责）。只钉住三件事：
 *   ① `childId` 来自调用方（会话），DTO 里没有第二个孩子入口；
 *   ② `source` 只由会话角色决定，客户端无法影响；
 *   ③ `viewer` 直接 new 本服务时也必须被拒（绕过 Guard 的内部调用方）。
 */
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { ForbiddenException } from '@nestjs/common'

import type { CheckInInput, HabitsPort, ReverseRecordInput } from '../src/habits/habits.repository'
import { HabitsService } from '../src/habits/habits.service'
import type { Actor } from '../src/permissions/actor'
import type { RecordRow } from '../src/read/read.repository'

const CHILD_ID = 'child-1'
const HABIT_ID = 'habit-1'
const RECORD_ID = 'rec-1'

const DAD: Actor = { userId: 'u-dad', role: 'guardian' }
const KID: Actor = { userId: 'u-kid', role: 'child' }

function rowOf(overrides: Partial<RecordRow> = {}): RecordRow {
  return {
    id: RECORD_ID,
    titleSnapshot: '番茄钟写作业',
    pointsDelta: 1,
    category: 'praise',
    source: 'child_self',
    operatorRole: 'child',
    note: '',
    habitId: HABIT_ID,
    ruleId: null,
    ruleVersion: null,
    wishId: null,
    reversesRecordId: null,
    reversedAt: null,
    balanceAfter: 125,
    createdAt: new Date('2026-10-19T01:02:03.000Z'),
    ...overrides
  }
}

function makePort(): HabitsPort & { checkIns: CheckInInput[]; reverses: ReverseRecordInput[] } {
  const checkIns: CheckInInput[] = []
  const reverses: ReverseRecordInput[] = []
  return {
    checkIns,
    reverses,
    async checkIn(input) {
      checkIns.push(input)
      return rowOf({ source: input.source, operatorRole: input.operatorRole })
    },
    async reverse(input) {
      reverses.push(input)
      return rowOf({
        id: 'rec-correction',
        titleSnapshot: '撤销：番茄钟写作业',
        pointsDelta: -1,
        category: 'adjust',
        source: 'correction',
        operatorRole: input.operatorRole,
        note: input.note ?? '番茄钟写作业',
        reversesRecordId: RECORD_ID,
        balanceAfter: 124
      })
    }
  }
}

describe('HabitsService.checkIn', () => {
  let port: ReturnType<typeof makePort>
  let service: HabitsService

  beforeEach(() => {
    port = makePort()
    service = new HabitsService(port)
  })

  it('child ⇒ source=child_self；childId 只来自参数，payload 里没有它', async () => {
    const res = await service.checkIn(CHILD_ID, { habitId: HABIT_ID }, KID)

    assert.equal(port.checkIns.length, 1)
    const input = port.checkIns[0]
    assert.equal(input.childId, CHILD_ID)
    assert.equal(input.habitId, HABIT_ID)
    assert.equal(input.source, 'child_self')
    assert.equal(input.operatorUserId, 'u-kid')
    assert.equal(input.operatorRole, 'child')
    assert.equal(input.idempotencyKey, undefined)
    assert.deepEqual(Object.keys(input).sort(), [
      'childId',
      'habitId',
      'idempotencyKey',
      'now',
      'operatorRole',
      'operatorUserId',
      'source'
    ])

    assert.equal(res.executedRecordId, RECORD_ID)
    assert.equal(res.record.title, '番茄钟写作业')
    assert.equal(res.record.points, 1)
    assert.equal(res.record.createdAt, '2026-10-19T01:02:03.000Z')
  })

  it('guardian ⇒ source=guardian（客户端传什么都改不了）', async () => {
    await service.checkIn(CHILD_ID, { habitId: HABIT_ID }, DAD)
    assert.equal(port.checkIns[0].source, 'guardian')
    assert.equal(port.checkIns[0].operatorRole, 'guardian')
  })

  it('幂等键：去空白后透传；空串按“没有 key”处理', async () => {
    await service.checkIn(CHILD_ID, { habitId: HABIT_ID }, KID, '  abc-123  ')
    assert.equal(port.checkIns[0].idempotencyKey, 'abc-123')

    await service.checkIn(CHILD_ID, { habitId: HABIT_ID }, KID, '   ')
    assert.equal(port.checkIns[1].idempotencyKey, undefined)
  })

  it('viewer 直接绕过 Guard 调用本服务 ⇒ 403，端口零调用', async () => {
    await assert.rejects(
      () => service.checkIn(CHILD_ID, { habitId: HABIT_ID }, { userId: 'u-guest', role: 'viewer' }),
      (err: unknown) => {
        assert.ok(err instanceof ForbiddenException)
        assert.equal((err.getResponse() as { code: string }).code, 'ACTION_NOT_ALLOWED')
        return true
      }
    )
    assert.equal(port.checkIns.length, 0)
  })
})

describe('HabitsService.reverse', () => {
  let port: ReturnType<typeof makePort>
  let service: HabitsService

  beforeEach(() => {
    port = makePort()
    service = new HabitsService(port)
  })

  it('撤销：原记录 id 走路径、备注去空白；响应是新的冲正记录', async () => {
    const res = await service.reverse(CHILD_ID, RECORD_ID, { note: '  点错了  ' }, DAD)

    assert.equal(port.reverses.length, 1)
    assert.deepEqual(
      { ...port.reverses[0], now: 'ignored' },
      {
        childId: CHILD_ID,
        recordId: RECORD_ID,
        operatorUserId: 'u-dad',
        operatorRole: 'guardian',
        note: '点错了',
        now: 'ignored'
      }
    )
    assert.equal(res.executedRecordId, 'rec-correction')
    assert.equal(res.record.source, 'correction')
    assert.equal(res.record.category, 'adjust')
    assert.equal(res.record.points, -1)
    assert.equal(res.record.reversesRecordId, RECORD_ID)
  })

  it('备注只有空白 ⇒ 不传 note（不落空字符串冒充用户输入）', async () => {
    await service.reverse(CHILD_ID, RECORD_ID, { note: '   ' }, DAD)
    assert.equal(port.reverses[0].note, undefined)
  })

  it('viewer ⇒ 403，端口零调用', async () => {
    await assert.rejects(
      () => service.reverse(CHILD_ID, RECORD_ID, {}, { userId: 'u-guest', role: 'viewer' }),
      ForbiddenException
    )
    assert.equal(port.reverses.length, 0)
  })
})

describe('HabitsService 时区装配', () => {
  it('非法 KP_TIMEZONE ⇒ 构造时抛错（不是第一笔打卡时按 UTC 算）', () => {
    const previous = process.env.KP_TIMEZONE
    process.env.KP_TIMEZONE = 'Asia/Shanghia'
    try {
      assert.throws(() => new HabitsService(makePort()), RangeError)
    } finally {
      if (previous === undefined) delete process.env.KP_TIMEZONE
      else process.env.KP_TIMEZONE = previous
    }
  })
})

/**
 * 家庭数据删除的**测试替身**（W7-D，2026-10-27）。
 *
 * 与 `export-fake.ts` 同一理由：HTTP 用例关心「请求怎么被读」，
 * 装配用例关心「交给 Prisma 的键」，两处用**同一份**状态形状，
 * 字段增删时才不会只有一边红。
 *
 * ★ 它**不**证明 SQL 真的改了哪些行 —— 那是
 *   `test-db/deletion-db.dbtest.ts` 的事。替身只能证明「调用带着什么参数、
 *   响应长什么样」。
 */
import type {
  CancelDeletionInput,
  DeletionPort,
  ExecuteDueInput,
  FamilyDeletionState,
  FamilyDeletionSummary,
  RequestDeletionInput
} from '../../src/deletion/deletion.repository'

export const DAY_MS = 24 * 60 * 60 * 1000

/** 一份“九段都动过”的执行摘要（与仓储返回的形状一致）。 */
export function makeDeletionSummary(): FamilyDeletionSummary {
  return {
    coolingDays: 7,
    redacted: {
      child: 1,
      members: 2,
      rules: 1,
      ruleVersions: 2,
      habits: 1,
      wishes: 1,
      records: 3,
      approvals: 1,
      consents: 1,
      notifications: 2
    },
    kept: { records: 3, pointsBalance: 4 },
    note: '账本流水与余额按 02 §5.7 I5 保留；描述性文本与身份痕迹已匿名化。'
  }
}

export function makeDeletionState(
  status: FamilyDeletionState['status'] = 'none',
  now: Date = new Date('2026-10-27T00:00:00.000Z')
): FamilyDeletionState {
  if (status === 'none') {
    return {
      childId: 'child-1',
      status: 'none',
      requestedAt: null,
      scheduledFor: null,
      cancelledAt: null,
      executedAt: null,
      daysRemaining: null,
      canCancel: false,
      summary: null
    }
  }

  const requestedAt = now
  const scheduledFor = new Date(now.getTime() + 7 * DAY_MS)
  return {
    childId: 'child-1',
    status,
    requestedAt: requestedAt.toISOString(),
    scheduledFor: scheduledFor.toISOString(),
    cancelledAt: status === 'cancelled' ? now.toISOString() : null,
    executedAt: status === 'executed' ? now.toISOString() : null,
    daysRemaining: status === 'pending' ? 7 : null,
    canCancel: status === 'pending',
    summary: status === 'executed' ? makeDeletionSummary() : null
  }
}

export type DeletionCall =
  | { op: 'read'; childId: string }
  | { op: 'request'; input: RequestDeletionInput }
  | { op: 'cancel'; input: CancelDeletionInput }
  | { op: 'executeDue'; input: ExecuteDueInput }

export interface DeletionFake extends DeletionPort {
  calls: DeletionCall[]
}

/** 记录调用的端口替身。默认每次调用都成功，状态由 `status` 决定。 */
export function makeDeletionFake(status: FamilyDeletionState['status'] = 'none'): DeletionFake {
  const calls: DeletionCall[] = []
  return {
    calls,
    async readState(childId) {
      calls.push({ op: 'read', childId })
      return { ...makeDeletionState(status), childId }
    },
    async requestDeletion(input) {
      calls.push({ op: 'request', input })
      return { ...makeDeletionState('pending', input.now), childId: input.childId }
    },
    async cancelDeletion(input) {
      calls.push({ op: 'cancel', input })
      return { ...makeDeletionState('cancelled', input.now), childId: input.childId }
    },
    async executeDue(input) {
      calls.push({ op: 'executeDue', input })
      return []
    }
  }
}

/**
 * 家长模式端口的**测试替身**（W8-C，2026-10-27）。
 *
 * ── 它必须复刻适配器的哪几条规矩 ────────────────────────────────────────────
 *   替身不是"返回一个对象"，而是**照着 `auth.prisma.repository.ts` 的口径**改内存：
 *   ① `readModeState` 读不到成员位 ⇒ `null`（service 回 409，不是 404）；
 *   ② `enterParentMode` ⇒ `activeRole='guardian'` + 新 `expiresAt` + **清零计数**；
 *   ③ `recordPinFailure` ⇒ 调**同一个** `nextPinFailureState()`（阈值算术只有一处定义，
 *      替身另算一份就等于在用例里验"两套阈值碰巧一样"）；
 *   ④ `exitParentMode` ⇒ `activeRole='child'` 且 `expiresAt = now`（不是"留着未来时间"）。
 *
 * ── 为什么按 `userId` 存多份成员位 ──────────────────────────────────────────
 *   同一个 app 里既有家长设备又有孩子设备（共用手机的真实形态）。若替身只有一份
 *   状态，"孩子的会话也会看到家长的 PIN"这种 bug 在 HTTP 层**看不出来**。
 *
 * ── 替身**证明不了**什么 ────────────────────────────────────────────────────
 *   行锁、事务、审计行、`pinHash` 真的落了库 —— 那需要真 Postgres（`test-db/`）。
 *   替身只证明"控制器把正确的输入交给了端口，并把端口的结果如实翻成了 HTTP"。
 */
import { ConflictException } from '@nestjs/common'

import type {
  AuthPort,
  EnterKidModeInput,
  EnterParentModeInput,
  ExitKidModeInput,
  ExitParentModeInput,
  ModeStateRow,
  ParentPinState,
  ReadModeStateInput,
  RecordPinFailureInput,
  SetParentPinInput
} from '../../src/auth/auth.repository'
import { nextPinFailureState } from '../../src/auth/parent-mode.policy'

export const FAKE_CHILD_ID = 'child-1'
export const FAKE_DAD_ID = 'u-dad'
export const FAKE_KID_ID = 'u-kid'

export interface AuthFakeMember {
  memberRole: string
  /** 直接用 `hashPin()` 造出来的真哈希 —— 替身**不能**伪造它，否则等于跳过 `verifyPin`。 */
  pinHash: string | null
  pinLockedUntil: Date | null
  pinFailedCount: number
  activeRole: string
  expiresAt: Date
  /** W14：孩子模式的到期绝对时刻（null = 没开）。 */
  kidModeUntil: Date | null
}

export interface AuthCall {
  method:
    | 'readModeState'
    | 'enterParentMode'
    | 'exitParentMode'
    | 'recordPinFailure'
    | 'setParentPin'
    | 'enterKidMode'
    | 'exitKidMode'
  input?: unknown
}

export interface AuthFake extends AuthPort {
  calls: AuthCall[]
  members: Record<string, AuthFakeMember>
}

const FIVE_MINUTES_MS = 5 * 60 * 1000

/**
 * @param members 按 `userId` 给出的成员位；省略的字段走默认值：
 *                `memberRole='guardian'` / 无 PIN / 未锁定 / `activeRole='child'`
 *                / `expiresAt=now+5min`（★ 默认是**孩子**：最小权限默认，与 `02` §7 一致）。
 */
export function makeAuthFake(members: Record<string, Partial<AuthFakeMember>> = {}): AuthFake {
  const store: Record<string, AuthFakeMember> = {}
  for (const [userId, patch] of Object.entries(members)) {
    store[userId] = {
      memberRole: patch.memberRole ?? 'guardian',
      pinHash: patch.pinHash ?? null,
      pinLockedUntil: patch.pinLockedUntil ?? null,
      pinFailedCount: patch.pinFailedCount ?? 0,
      activeRole: patch.activeRole ?? 'child',
      expiresAt: patch.expiresAt ?? new Date(Date.now() + FIVE_MINUTES_MS),
      kidModeUntil: patch.kidModeUntil ?? null
    }
  }

  const calls: AuthCall[] = []

  const row = (userId: string, deviceId: string, childId: string): ModeStateRow | null => {
    const member = store[userId]
    if (member === undefined) return null
    return {
      memberId: `member-${userId}`,
      memberRole: member.memberRole,
      pinHash: member.pinHash,
      pinLockedUntil: member.pinLockedUntil,
      pinFailedCount: member.pinFailedCount,
      session: {
        deviceId,
        childId,
        userId,
        activeRole: member.activeRole,
        expiresAt: member.expiresAt,
        kidModeUntil: member.kidModeUntil
      }
    }
  }

  const must = (userId: string): AuthFakeMember => {
    const member = store[userId]
    if (member === undefined) {
      throw new ConflictException({
        code: 'PARENT_MODE_MEMBER_NOT_ACTIVE',
        message: `替身里没有 ${userId} 的成员位（与真适配器同一口径：409 而不是 404）。`
      })
    }
    return member
  }

  return {
    calls,
    members: store,

    async readModeState(input: ReadModeStateInput): Promise<ModeStateRow | null> {
      calls.push({ method: 'readModeState', input })
      return row(input.userId, input.deviceId, input.childId)
    },

    async enterParentMode(input: EnterParentModeInput): Promise<ModeStateRow> {
      calls.push({ method: 'enterParentMode', input })
      const member = must(input.userId)
      member.activeRole = 'guardian'
      member.expiresAt = input.expiresAt
      member.pinFailedCount = 0
      member.pinLockedUntil = null
      const updated = row(input.userId, input.deviceId, input.childId)
      if (updated === null) throw new Error('替身内部错误：写入后读不到行')
      return updated
    },

    async exitParentMode(input: ExitParentModeInput): Promise<ModeStateRow> {
      calls.push({ method: 'exitParentMode', input })
      const member = must(input.userId)
      member.activeRole = 'child'
      member.expiresAt = new Date()
      const updated = row(input.userId, input.deviceId, input.childId)
      if (updated === null) throw new Error('替身内部错误：写入后读不到行')
      return updated
    },

    async recordPinFailure(input: RecordPinFailureInput): Promise<ModeStateRow> {
      calls.push({ method: 'recordPinFailure', input })
      const member = must(input.userId)
      const outcome = nextPinFailureState(member.pinFailedCount, input.now)
      member.pinFailedCount = outcome.failedCount
      member.pinLockedUntil = outcome.lockedUntil
      const updated = row(input.userId, input.deviceId, input.childId)
      if (updated === null) throw new Error('替身内部错误：写入后读不到行')
      return updated
    },

    async setParentPin(input: SetParentPinInput): Promise<ParentPinState> {
      calls.push({ method: 'setParentPin', input })
      const member = must(input.userId)
      member.pinHash = input.pinHash
      member.pinFailedCount = 0
      member.pinLockedUntil = null
      return {
        pinConfigured: true,
        pinSetAt: new Date().toISOString(),
        changed: input.hadPinBefore
      }
    },

    async enterKidMode(input: EnterKidModeInput): Promise<ModeStateRow> {
      calls.push({ method: 'enterKidMode', input })
      const member = must(input.userId)
      member.kidModeUntil = input.kidModeUntil
      const updated = row(input.userId, input.deviceId, input.childId)
      if (updated === null) throw new Error('替身内部错误：写入后读不到行')
      return updated
    },

    async exitKidMode(input: ExitKidModeInput): Promise<ModeStateRow> {
      calls.push({ method: 'exitKidMode', input })
      const member = must(input.userId)
      member.kidModeUntil = null
      const updated = row(input.userId, input.deviceId, input.childId)
      if (updated === null) throw new Error('替身内部错误：写入后读不到行')
      return updated
    }
  }
}

import { ConflictException, Injectable } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type {
  AuthPort,
  EnterParentModeInput,
  ExitParentModeInput,
  ModeStateRow,
  ParentPinState,
  ReadModeStateInput,
  RecordPinFailureInput,
  SetParentPinInput
} from './auth.repository'
import { isPinLocked, nextPinFailureState } from './parent-mode.policy'

type Tx = Prisma.TransactionClient

/**
 * 家长模式 / 家长 PIN 端口的 **Prisma 适配器**（W8-C，2026-10-27 / `02` §7）。
 *
 * ── 五个方法 = 五个事务（顺序都有理由，不要重排）────────────────────────────
 *   readModeState    读成员位 + 读会话行（同一个只读事务 —— 避免"成员是家长、会话是旧角色"）
 *   enterParentMode  锁成员位 → 复核 guardian / PIN 已设 / 未锁定 → 写会话 guardian
 *                    → 清零失败计数 → 写审计
 *   exitParentMode   锁成员位 → 写会话 child（`expiresAt = now`）→ 写审计
 *   recordPinFailure 锁成员位 → **按库里的计数现算** → 写计数/锁定 → 写审计
 *   setParentPin     锁成员位 → 写 `pinHash`/`pinSetAt` → 清零计数 → 写审计
 *
 * ── 为什么每一次写都要先 `SELECT … FOR UPDATE` 成员位 ───────────────────────
 *   ① **连错计数必须是原子的**：两条并发的错误请求若各自读到 `failedCount=4`，
 *      它们会写出两个"第 5 次" —— 锁定窗口被推迟成"错 6 次才锁"。
 *      锁住成员位后，第二个事务看到的已经是第一个写下的 `0 / 锁定`。
 *   ② **PIN 与角色必须一致**：改 PIN 的同时另一个请求在切家长模式，
 *      若两边都在锁外读，就可能"用刚被改掉的旧 PIN 进了家长模式"。
 *      两件事锁同一行 ⇒ 串行化，先到的生效。
 *   ③ 与 `onboarding.prisma.repository.ts` 的 `lockChild()` 同一手法（`$queryRaw`
 *      `FOR UPDATE`）—— Prisma 没有行锁 API，SQL 是唯一诚实的写法。
 *
 * ── 三处"适配器不判"（刻意的）──────────────────────────────────────────────
 *   ① **不**在这里验 PIN：`verifyPin()` 是异步 scrypt，属于 service
 *      （"明文只活在 service 的调用栈里"）；适配器只收 `pinHash`（写入）或返回它（读）。
 *   ② **不**在这里算"该不该锁"：算术是 `parent-mode.policy.ts` 的纯函数，
 *      适配器只负责"锁内用库里的基数调用它、然后如实写回"。
 *   ③ **不**在这里把角色枚举外的值翻成 403：`effectiveRole()` 会抛
 *      `SessionRowShapeError`（500）—— 数据病不能伪装成权限病。
 */
@Injectable()
export class PrismaAuthRepository implements AuthPort {
  constructor(private readonly prisma: PrismaService) {}

  async readModeState(input: ReadModeStateInput): Promise<ModeStateRow | null> {
    const [member, session] = await this.prisma.$transaction([
      this.prisma.childMember.findUnique({
        where: { childId_userId: { childId: input.childId, userId: input.userId } },
        select: MEMBER_SELECT
      }),
      this.prisma.deviceSession.findUnique({
        where: { deviceId_childId: { deviceId: input.deviceId, childId: input.childId } },
        select: SESSION_SELECT
      })
    ])

    // 「成员位没了」或「会话没了」都当作**没有状态可读**（service 回 403/409）。
    // 这里不抛 404：「这个人跟这个孩子没有关系」是正常分支，不是资源缺失。
    if (member === null || session === null) return null
    if (member.status !== 'active') return null
    return toModeState(member, session)
  }

  async enterParentMode(input: EnterParentModeInput): Promise<ModeStateRow> {
    return await this.prisma.$transaction(async (tx) => {
      const now = new Date()
      const member = await this.lockMember(tx, input.childId, input.userId)
      if (member === null) throw memberNotActive(input)

      // ★ 复核（不是重复判定）：service 已经查过一遍，但这中间可能有并发请求
      //   把 PIN 撤掉 / 把角色改掉 / 触发锁定。**锁内**的这三条才是权威输入。
      if (member.role !== 'guardian') {
        throw new ConflictException({
          code: 'PARENT_MODE_REQUIRES_GUARDIAN',
          message: '当前账号在这个孩子上的成员位不是家长，无法进入家长模式。'
        })
      }
      if (member.pinHash === null) {
        throw new ConflictException({
          code: 'PARENT_PIN_NOT_SET',
          message: '还没有设置家长 PIN，无法进入家长模式（先设置 PIN，或用另一台家长设备设置）。'
        })
      }
      if (isPinLocked(member.pinLockedUntil, now)) {
        throw new ConflictException({
          code: 'PARENT_PIN_LOCKED',
          message: '家长 PIN 连续输错已被锁定，请稍后再试。'
        })
      }

      const session = await tx.deviceSession.update({
        where: { deviceId_childId: { deviceId: input.deviceId, childId: input.childId } },
        data: { activeRole: 'guardian', expiresAt: input.expiresAt, lastSeenAt: now },
        select: SESSION_SELECT
      })

      // 成功进入 ⇒ 之前的失败计数不再有意义（否则"错了 4 次"会一直挂着，
      // 下次一错就锁 —— 那等于把 15 分钟惩罚拖成"下次必锁"）。
      await tx.childMember.update({
        where: { id: member.id },
        data: { pinFailedCount: 0, pinLockedUntil: null }
      })

      await tx.auditLog.create({
        data: {
          childId: input.childId,
          actorUserId: input.operator.userId,
          actorRole: input.operator.role,
          action: 'switch_role_mode',
          targetType: 'DeviceSession',
          targetId: `${input.deviceId}:${input.childId}`,
          // 02 §7：角色切换必须记 deviceId —— 它是"哪台设备进了家长模式"的唯一线索。
          deviceId: input.deviceId,
          before: { activeRole: 'child' },
          after: {
            activeRole: 'guardian',
            expiresAt: input.expiresAt.toISOString(),
            // ★ 只记"用 PIN 通过"，不记 PIN 本身、不记哈希、不记长度。
            via: 'parent_pin'
          }
        }
      })

      return toModeState({ ...member, pinFailedCount: 0, pinLockedUntil: null }, session)
    })
  }

  async exitParentMode(input: ExitParentModeInput): Promise<ModeStateRow> {
    return await this.prisma.$transaction(async (tx) => {
      const now = new Date()
      const member = await this.lockMember(tx, input.childId, input.userId)
      if (member === null) throw memberNotActive(input)

      const session = await tx.deviceSession.update({
        where: { deviceId_childId: { deviceId: input.deviceId, childId: input.childId } },
        // `expiresAt = now`：让"退出"在数据层也成立 —— 若只改 activeRole 而留着
        // 旧的未来时间戳，库里的行会读成"child 会话有效期到 4 分钟后"，
        // 之后任何按 expiresAt 巡检的逻辑都会把它当成一次"未到期"的会话。
        data: { activeRole: 'child', expiresAt: now, lastSeenAt: now },
        select: SESSION_SELECT
      })

      await tx.auditLog.create({
        data: {
          childId: input.childId,
          actorUserId: input.operator.userId,
          actorRole: input.operator.role,
          action: 'switch_role_mode',
          targetType: 'DeviceSession',
          targetId: `${input.deviceId}:${input.childId}`,
          deviceId: input.deviceId,
          before: { activeRole: 'guardian' },
          // 退出是**降级**，不需要 PIN —— 谁都可以把家长模式关掉（越严越好）。
          after: { activeRole: 'child', expiresAt: now.toISOString(), via: 'explicit_exit' }
        }
      })

      return toModeState(member, session)
    })
  }

  async recordPinFailure(input: RecordPinFailureInput): Promise<ModeStateRow> {
    return await this.prisma.$transaction(async (tx) => {
      const member = await this.lockMember(tx, input.childId, input.userId)
      if (member === null) throw memberNotActive(input)

      // ★ 基数来自**锁内的库值**，不是 service 读到的快照（见端口注释）。
      const outcome = nextPinFailureState(member.pinFailedCount, input.now)

      const updated = await tx.childMember.update({
        where: { id: member.id },
        data: {
          pinFailedCount: outcome.failedCount,
          pinLockedUntil: outcome.lockedUntil
        },
        select: MEMBER_SELECT
      })

      const session = await tx.deviceSession.findUnique({
        where: { deviceId_childId: { deviceId: input.deviceId, childId: input.childId } },
        select: SESSION_SELECT
      })
      if (session === null) throw memberNotActive(input)

      await tx.auditLog.create({
        data: {
          childId: input.childId,
          actorUserId: input.operator.userId,
          actorRole: input.operator.role,
          // 用 `switch_role_mode` 记：这是一次**尝试**切换被拒绝。
          // 矩阵里没有"尝试失败"这种动作，而伪造一个新动作会让 §7 表格与
          // Prisma enum 的对账（honesty-probe D 项）多出一行没有语义的条目。
          action: 'switch_role_mode',
          targetType: 'DeviceSession',
          targetId: `${input.deviceId}:${input.childId}`,
          deviceId: input.deviceId,
          before: { pinFailedCount: member.pinFailedCount, pinSet: member.pinHash !== null },
          after: {
            outcome: outcome.justLocked ? 'pin_locked' : 'pin_rejected',
            pinFailedCount: outcome.failedCount,
            pinLockedUntil: outcome.lockedUntil === null ? null : outcome.lockedUntil.toISOString()
          }
        }
      })

      return toModeState(updated, session)
    })
  }

  async setParentPin(input: SetParentPinInput): Promise<ParentPinState> {
    return await this.prisma.$transaction(async (tx) => {
      const now = new Date()
      const member = await this.lockMember(tx, input.childId, input.userId)
      if (member === null) throw memberNotActive(input)
      if (member.role !== 'guardian') {
        throw new ConflictException({
          code: 'PARENT_PIN_REQUIRES_GUARDIAN',
          message: '只有家长能设置 / 修改家长 PIN。'
        })
      }

      const updated = await tx.childMember.update({
        where: { id: member.id },
        data: {
          pinHash: input.pinHash,
          pinSetAt: now,
          // 换过 PIN ⇒ 之前的失败计数与锁定都作废（新的钥匙，重新计数）。
          pinFailedCount: 0,
          pinLockedUntil: null
        },
        select: { pinSetAt: true }
      })

      await tx.auditLog.create({
        data: {
          childId: input.childId,
          actorUserId: input.operator.userId,
          actorRole: input.operator.role,
          action: 'manage_parent_pin',
          targetType: 'ChildMember',
          targetId: member.id,
          // ★ 只记"有没有 PIN"，绝不记哈希 / 长度 / 明文（4 位 PIN 的长度本身是信息）。
          before: { pinSet: input.hadPinBefore },
          after: { pinSet: true, changed: input.hadPinBefore }
        }
      })

      return {
        pinConfigured: true,
        pinSetAt: (updated.pinSetAt ?? now).toISOString(),
        changed: input.hadPinBefore
      }
    })
  }

  /**
   * 锁住 `(childId, userId)` 的成员位并读出现状；没有 / 已移除 ⇒ `null`。
   *
   * ★ `status !== 'active'` 当作不存在：与 `lockChild()` 对 `status` 的处理一致 ——
   *   "被移出的成员"和"从来不是成员"对权限问题应当给同一个答案。
   * ★ 这里**读出 `pinHash`** 是刻意的：`enterParentMode` 要用它证明"PIN 已设"，
   *   service 要用它验 PIN；`recordPinFailure` / `exitParentMode` 只读不写。
   */
  private async lockMember(tx: Tx, childId: string, userId: string): Promise<MemberRow | null> {
    const rows = await tx.$queryRaw<MemberRow[]>`
      SELECT id,
             role::text AS role,
             status::text AS status,
             "pinHash",
             "pinLockedUntil",
             "pinFailedCount"
        FROM "ChildMember"
       WHERE "childId" = ${childId}
         AND "userId" = ${userId}
       FOR UPDATE
    `
    const row = rows[0]
    if (row === undefined || row.status !== 'active') return null
    return row
  }
}



interface MemberRow {
  id: string
  role: string
  status: string
  pinHash: string | null
  pinLockedUntil: Date | null
  pinFailedCount: number
}

interface SessionRow {
  deviceId: string
  childId: string
  userId: string
  activeRole: string
  expiresAt: Date
}

const MEMBER_SELECT = {
  id: true,
  role: true,
  status: true,
  pinHash: true,
  pinLockedUntil: true,
  pinFailedCount: true
} as const

const SESSION_SELECT = {
  deviceId: true,
  childId: true,
  userId: true,
  activeRole: true,
  expiresAt: true
} as const

function toModeState(member: MemberRow, session: SessionRow): ModeStateRow {
  return {
    memberId: member.id,
    memberRole: member.role,
    pinHash: member.pinHash,
    pinLockedUntil: member.pinLockedUntil,
    pinFailedCount: member.pinFailedCount,
    session: {
      deviceId: session.deviceId,
      childId: session.childId,
      userId: session.userId,
      activeRole: session.activeRole,
      expiresAt: session.expiresAt
    }
  }
}

function memberNotActive(input: { childId: string; userId: string }): ConflictException {
  return new ConflictException({
    code: 'PARENT_MODE_MEMBER_NOT_ACTIVE',
    message:
      `账号 ${input.userId} 在孩子 ${input.childId} 上没有有效的成员位 —— ` +
      '会话与成员位不一致（可能刚被移出）。请重新登录后再试。'
  })
}

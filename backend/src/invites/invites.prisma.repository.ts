import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import { generateInviteCode, withFreshInviteCode } from './invite-code'
import type {
  AcceptInviteInput,
  AcceptedInviteRow,
  CreateInviteInput,
  InvitesPort,
  RevokeInviteInput
} from './invites.repository'
import type { InviteRevokeResponse, InviteRole, InviteRow } from './invites.types'

/** `InviteCode` 行的读取列 —— 列表 / 创建回包共用，免得两处 `select` 漂移。 */
const INVITE_SELECT = {
  id: true,
  childId: true,
  code: true,
  role: true,
  maxUses: true,
  usedCount: true,
  expiresAt: true,
  revoked: true,
  createdAt: true
} as const

/** 原子占位语句的 `RETURNING` 行（`role` 已 `::text`，避免驱动给枚举对象）。 */
interface ClaimRow {
  id: string
  childId: string
  role: string
  createdByUserId: string
}

/**
 * 邀请码的 **Prisma 适配器**（W5-G，2026-10-22）
 *
 * ── 并发安全只在一条语句里（02 §8）───────────────────────────────────────
 *   加入的核心是这条 `UPDATE ... WHERE ... RETURNING`：
 *
 *     SET "usedCount" = "usedCount" + 1 …
 *     WHERE code = $1 AND "usedCount" < "maxUses"
 *       AND "expiresAt" > now() AND revoked = false
 *     RETURNING id, "childId", role::text, "createdByUserId"
 *
 *   「读剩余次数 → 插入成员 → 次数 +1」分三步就是 TOCTOU：10 个并发请求会
 *   一起通过校验，把 `maxUses=3` 的码用掉 10 次。行锁 + 条件 UPDATE 让
 *   **至多 `maxUses` 个**请求拿到 `RETURNING` 行 —— 这是唯一在库层面成立的判据
 *   （应用内加锁只在单进程成立，分布式锁要多一套基础设施）。
 *
 *   ★ 之后的一切（成员位 / 会话 / 审计）都在**同一个事务**里：占位成功但
 *     成员位写入失败（比如「已经是成员」）必须让占位**回滚** —— 否则用户
 *     什么也没得到，却白白烧掉一次名额。`invites-db.dbtest.ts` 组 C 钉住
 *     这一点（失败后 `usedCount` 必须还是 0）。
 *
 * ── 为什么这里**没有** `findByCode()` ─────────────────────────────────────
 *   对外暴露「只查不占」的方法，等于给下一个人留一条 TOCTOU 捷径。
 *   「这个码还能不能用」这个问题，唯一被允许的答案来自那条 UPDATE。
 *
 * ── 撞码为什么可以重试，而重试为什么不能塞进同一个事务 ────────────────────
 *   `code` 上有唯一约束，两个请求同时生成同一个码时，一个成功一个 P2002 ——
 *   这是**正常的**并发结果，换一个码即可。但 PostgreSQL 的事务一旦报错就
 *   整体进入 aborted 状态，后续语句全部失败，所以在**同一个事务里重试是假的**
 *   （第一次失败后剩下的尝试都会撞「current transaction is aborted」）。
 *   故每次尝试都是一个独立事务：失败 ⇒ 回滚整笔（含审计）⇒ 下一个码重开一笔。
 */
@Injectable()
export class PrismaInvitesRepository implements InvitesPort {
  constructor(private readonly prisma: PrismaService) {}

  async createInvite(input: CreateInviteInput): Promise<InviteRow> {
    try {
      return await withFreshInviteCode(
        () => generateInviteCode(),
        async (code) =>
          await this.prisma.$transaction(async (tx) => {
            // 只给 active 的孩子发码：已删除档案的邀请码等于一张通往空房子的钥匙。
            const child = await tx.child.findFirst({
              where: { id: input.childId, status: 'active' },
              select: { id: true }
            })
            if (child === null) {
              throw new NotFoundException({
                code: 'CHILD_NOT_FOUND',
                message: `孩子 ${input.childId} 不存在或已删除 —— 拒绝为它创建邀请码。`
              })
            }

            const row = await tx.inviteCode.create({
              data: {
                childId: input.childId,
                code,
                role: input.role,
                maxUses: input.maxUses,
                expiresAt: input.expiresAt,
                createdByUserId: input.operatorUserId
              },
              select: INVITE_SELECT
            })

            // ★ 审计里**不写 `code`**：审计的读取面比邀请码列表宽，而码本身就是凭据。
            await tx.auditLog.create({
              data: {
                childId: row.childId,
                actorUserId: input.operatorUserId,
                actorRole: input.operatorRole,
                action: 'invite.create',
                targetType: 'InviteCode',
                targetId: row.id,
                after: {
                  role: row.role,
                  maxUses: row.maxUses,
                  expiresAt: row.expiresAt.toISOString()
                }
              }
            })

            return toInviteRow(row)
          }),
        (error) => this.isCodeCollision(error)
      )
    } catch (error) {
      this.mapWriteError(error)
    }
  }

  async listInvites(childId: string): Promise<InviteRow[]> {
    const rows = await this.prisma.inviteCode.findMany({
      where: { childId },
      // `createdAt` 可能同毫秒（批量造数），再按 id 排一次才有稳定顺序。
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: INVITE_SELECT
    })
    return rows.map(toInviteRow)
  }

  async revokeInvite(input: RevokeInviteInput): Promise<InviteRevokeResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "InviteCode" SET revoked = true
           WHERE id = ${input.inviteId} AND "childId" = ${input.childId} AND revoked = false
          RETURNING id`

        const row = rows[0]
        if (row !== undefined) {
          await tx.auditLog.create({
            data: {
              childId: input.childId,
              actorUserId: input.operatorUserId,
              actorRole: input.operatorRole,
              action: 'invite.revoke',
              targetType: 'InviteCode',
              targetId: row.id,
              before: { revoked: false },
              after: { revoked: true }
            }
          })
          return { id: row.id, revoked: true as const }
        }

        // 0 行有两种可能，必须分开回答：
        //   ① 这个码**已经**吊销过 ⇒ 构造幂等，回同一个 200，**不**写第二条审计
        //      （否则每点一次「吊销」审计就多一条一模一样的记录）；
        //   ② 这个孩子名下根本没有这一行 ⇒ 404（跨孩子一律同答，不泄露别家的 id）。
        const existing = await tx.inviteCode.findFirst({
          where: { id: input.inviteId, childId: input.childId },
          select: { id: true }
        })
        if (existing === null) {
          throw new NotFoundException({
            code: 'INVITE_NOT_FOUND',
            message: '这个邀请码不存在或不属于当前孩子的档案，没有做任何修改。'
          })
        }
        return { id: existing.id, revoked: true as const }
      })
    } catch (error) {
      this.mapWriteError(error)
    }
  }

  async acceptInvite(input: AcceptInviteInput): Promise<AcceptedInviteRow> {
    try {
      return await this.prisma.$transaction(
        async (tx): Promise<AcceptedInviteRow> => {
          // ── 第 1 步：原子占位（整个功能就是这一条语句）────────────────────
          const claimed = await tx.$queryRaw<ClaimRow[]>`
            UPDATE "InviteCode"
               SET "usedCount" = "usedCount" + 1,
                   "usedByUserId" = ${input.userId},
                   "usedAt" = now()
             WHERE code = ${input.code}
               AND "usedCount" < "maxUses"
               AND "expiresAt" > now()
               AND revoked = false
            RETURNING id, "childId", role::text AS role, "createdByUserId"`

          const claim = claimed[0]
          if (claim === undefined) {
            // 「不存在 / 已用完 / 已过期 / 已吊销」四种情况给**同一个**回答：
            // 区分它们会让这个端点变成「哪些码存在」的探测器，而用户能做的
            // 动作完全相同（找家长再要一个）。
            throw new ConflictException({
              code: 'INVITE_CODE_UNAVAILABLE',
              message:
                '邀请码无效、已过期、已用完或已吊销（四种情况回答相同）。' +
                '请向家长确认后换一个新的邀请码。'
            })
          }

          const role = toInviteRole(claim.role)

          // ── 第 2 步：成员位（同一人对同一孩子只有一行，@@unique）──────────
          const existing = await tx.childMember.findUnique({
            where: {
              childId_userId: { childId: claim.childId, userId: input.userId }
            },
            select: { id: true, status: true }
          })

          if (existing !== null && existing.status === 'active') {
            // ★ 抛错 ⇒ 整个事务回滚 ⇒ **邀请码的一次名额不会被烧掉**。
            throw new ConflictException({
              code: 'ALREADY_MEMBER',
              message:
                '你已经是这个孩子的成员了，这次没有消耗邀请码，角色也没有被改变。' +
                '（角色只由家长在成员管理里调整。）'
            })
          }

          const member =
            existing === null
              ? await tx.childMember.create({
                  data: {
                    childId: claim.childId,
                    userId: input.userId,
                    role,
                    status: 'active',
                    invitedByUserId: claim.createdByUserId
                  },
                  select: { id: true }
                })
              : await tx.childMember.update({
                  // 曾被移出（`status='removed'`）的人可以用新码**回来**：
                  // 复用的是同一行（唯一约束不许第二行），`removedAt` 清掉。
                  where: { id: existing.id },
                  data: {
                    role,
                    status: 'active',
                    removedAt: null,
                    joinedAt: new Date(),
                    invitedByUserId: claim.createdByUserId
                  },
                  select: { id: true }
                })

          // ── 第 3 步：本设备在这个孩子上的会话 ─────────────────────────────
          const session = await tx.deviceSession.findUnique({
            where: {
              deviceId_childId: { deviceId: input.deviceId, childId: claim.childId }
            },
            select: { userId: true }
          })
          if (session !== null && session.userId !== input.userId) {
            // 共享平板上常见：这台设备在这个档案上已经有**别人**的会话。
            // 静默覆盖 = 把那位家长的会话悄悄变成新加入者的（一份凭据被顶掉）。
            throw new ConflictException({
              code: 'DEVICE_SESSION_CONFLICT',
              message:
                '这台设备在这个孩子的档案上已经有一个属于其他账号的会话。' +
                '请先在应用里切换账号（或换一台设备）再加入；本次没有消耗邀请码。'
            })
          }

          await tx.deviceSession.upsert({
            where: {
              deviceId_childId: { deviceId: input.deviceId, childId: claim.childId }
            },
            create: {
              deviceId: input.deviceId,
              childId: claim.childId,
              userId: input.userId,
              activeRole: role,
              expiresAt: input.sessionExpiresAt
            },
            update: {
              userId: input.userId,
              activeRole: role,
              expiresAt: input.sessionExpiresAt
            }
          })

          await tx.auditLog.create({
            data: {
              childId: claim.childId,
              actorUserId: input.userId,
              actorRole: role,
              action: 'member.join',
              targetType: 'ChildMember',
              targetId: member.id,
              // 只记「用了哪个邀请码行」，不记码本身（见 createInvite 的同一条理由）。
              after: { role, inviteCodeId: claim.id },
              deviceId: input.deviceId
            }
          })

          return {
            childId: claim.childId,
            role,
            sessionExpiresAt: input.sessionExpiresAt
          }
        }
      )
    } catch (error) {
      this.mapAcceptError(error)
    }
  }

  /** P2002 且目标是 `code` 列 ⇒ 撞码（换一个码即可，不是业务拒绝）。 */
  private isCodeCollision(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
    if (error.code !== 'P2002') return false
    const target = JSON.stringify(error.meta?.target ?? '').toLowerCase()
    return target.includes('code')
  }

  /** 创建 / 吊销路径：只把可预期的库层失败翻成 4xx，其余原样抛（500，不伪装业务拒绝）。 */
  private mapWriteError(error: unknown): never {
    if (error instanceof HttpException) throw error

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (this.isCodeCollision(error)) {
        throw new ConflictException({
          code: 'INVITE_CODE_GENERATION_FAILED',
          message:
            '连续多次生成的邀请码都撞上了已有的码（概率极低），没有创建成功。请重试。',
          details: error.meta ?? null
        })
      }
      if (error.code === 'P2003') {
        throw new NotFoundException({
          code: 'CHILD_NOT_FOUND',
          message: '这个孩子已经不存在了（可能刚被删除），邀请码没有创建。'
        })
      }
    }

    throw error
  }

  /** 加入路径：并发下 `@@unique(childId,userId)` 才是最终裁判（P2002 ⇒ 已经是成员）。 */
  private mapAcceptError(error: unknown): never {
    if (error instanceof HttpException) throw error

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException({
          code: 'ALREADY_MEMBER',
          message: '你已经是这个孩子的成员了，这次没有消耗邀请码。',
          details: error.meta ?? null
        })
      }
      if (error.code === 'P2003') {
        throw new NotFoundException({
          code: 'CHILD_NOT_FOUND',
          message: '这个孩子的档案刚刚被删除了，邀请码没有生效。'
        })
      }
    }

    throw error
  }
}

/** 端口行映射：`Date` 原样留在端口层，ISO 转换只发生在 `InvitesService`。 */
function toInviteRow(row: {
  id: string
  childId: string
  code: string
  role: string
  maxUses: number
  usedCount: number
  expiresAt: Date
  revoked: boolean
  createdAt: Date
}): InviteRow {
  return {
    id: row.id,
    childId: row.childId,
    code: row.code,
    role: toInviteRole(row.role),
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt,
    revoked: row.revoked,
    createdAt: row.createdAt
  }
}

/**
 * 库里只有 `child | guardian | viewer` 三种角色，而邀请只发前两种
 * （`viewer` 在矩阵里没有列 ⇒ 一律 DENY ⇒ 邀请一个 viewer 等于邀请一个
 * 什么都做不了的成员，02 §2 D6）。
 *
 * 读到第三种 ⇒ **500**：这是库里有脏数据（不可能是本模块写的），
 * 混报成 409 会让「有人直接改过库」被当成「这个码不可用」查很久（D3b 同一条纪律）。
 */
function toInviteRole(role: string): InviteRole {
  if (role === 'child' || role === 'guardian') return role
  throw new InternalServerErrorException({
    code: 'INVITE_ROLE_UNUSABLE',
    message:
      `邀请码上的角色是 ${role}，它不是可邀请的角色（只有 child / guardian）。` +
      '这是数据问题，请检查该行是不是被直接改过库。'
  })
}

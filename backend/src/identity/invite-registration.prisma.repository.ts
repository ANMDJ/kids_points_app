import { ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { claimInviteCode, toInviteRole } from '../invites/invite-claim'
import { PrismaService } from '../prisma/prisma.service'
import { rethrowIfIdentifierTaken } from './identifier-conflict'
import type {
  InviteRegistrationPort,
  RegisteredInviteRow,
  RegisterWithInviteInput
} from './invite-registration.repository'

/**
 * 邀请注册的 **Prisma 适配器**（W11-A，2026-11-02 / `45` §2）。
 *
 * ── 为什么要先建 User、再占邀请码（顺序看似反了）────────────────────────────
 *   `InviteCode.usedByUserId` 是外键 ⇒ 占位语句需要**已经存在**的 userId。
 *   所以只能先建 User 再占码。这**不**会造成孤儿账号：整个方法是一个事务，
 *   占码失败（码不存在 / 用完 / 过期 / 吊销）时抛错 ⇒ User 那一行一起回滚。
 *
 * ── 为什么角色只来自邀请码 ─────────────────────────────────────────────────
 *   请求体里没有任何 `role` 字段。否则「用 child 码注册、请求体写 guardian」
 *   就是一条现成的提权路径。
 *
 * ── 唯一约束失败 ⇒ 409，不在这里「先查后写」──────────────────────────────────
 *   `User.phone` / `User.email` 是唯一列。两个请求同时用同一个手机号注册时，
 *   「先查有没有」会双双通过；唯一索引是**唯一**能回答「这个号归谁」的地方。
 *   `P2002` ⇒ 409 `IDENTIFIER_TAKEN`（与 `writeAccount` 同一条口径）。
 */
@Injectable()
export class PrismaInviteRegistrationRepository implements InviteRegistrationPort {
  constructor(private readonly prisma: PrismaService) {}

  async registerWithInvite(input: RegisterWithInviteInput): Promise<RegisteredInviteRow> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<RegisteredInviteRow> => {
        // ── 第 1 步：账号（唯一列冲突由下面的 mapRegistrationError 翻成 409）──
        const user = await tx.user.create({
          data: {
            ...(input.identifierType === 'phone'
              ? { phone: input.identifierValue }
              : { email: input.identifierValue }),
            passwordHash: input.passwordHash,
            passwordSetAt: new Date(),
            displayName: input.displayName,
            status: 'active'
          },
          select: { id: true, displayName: true }
        })

        // ── 第 2 步：原子占码（唯一判据，与 POST /invites/accept 共用）──────
        const claim = await claimInviteCode(tx, { code: input.code, userId: user.id })
        if (claim === null) {
          // 不存在 / 已用完 / 已过期 / 已吊销 —— 故意同一个回答（见 invite-claim.ts）。
          // ★ 抛错 ⇒ User 那一行一起回滚，**没有**留下一个没有家庭的账号。
          throw new ConflictException({
            code: 'INVITE_CODE_UNAVAILABLE',
            message:
              '邀请码无效、已过期、已用完或已吊销（四种情况回答相同）。' +
              '请向家长确认后换一个新的邀请码；已经注册过的话请直接登录。'
          })
        }

        const role = toInviteRole(claim.role)

        // ── 第 3 步：家庭还在不在（软删档案的码 = 通往空房子的钥匙）─────────
        const child = await tx.child.findFirst({
          where: { id: claim.childId, status: 'active' },
          select: { id: true }
        })
        if (child === null) {
          throw new NotFoundException({
            code: 'CHILD_NOT_FOUND',
            message: '这个邀请码对应的孩子档案已经被删除，注册没有生效。请向家长要一个新的邀请码。'
          })
        }

        // ── 第 4 步：成员位（角色来自邀请码，绝不来自请求体）────────────────
        const member = await tx.childMember.create({
          data: {
            childId: claim.childId,
            userId: user.id,
            role,
            status: 'active',
            invitedByUserId: claim.createdByUserId
          },
          select: { id: true }
        })

        // ── 第 5 步：本设备在这个孩子上的会话 ───────────────────────────────
        const existing = await tx.deviceSession.findUnique({
          where: {
            deviceId_childId: { deviceId: input.deviceId, childId: claim.childId }
          },
          select: { userId: true }
        })
        if (existing !== null && existing.userId !== user.id) {
          // 共享平板上常见：这台设备在这个档案上已经有**别人**的会话。
          // 静默覆盖 = 把那位家长的会话悄悄变成新注册者的（一份凭据被顶掉）。
          throw new ConflictException({
            code: 'DEVICE_SESSION_CONFLICT',
            message:
              '这台设备在这个孩子的档案上已经有一个属于其他账号的会话。' +
              '请先在应用里切换账号（或换一台设备）再注册；本次没有创建账号。'
          })
        }

        await tx.deviceSession.upsert({
          where: {
            deviceId_childId: { deviceId: input.deviceId, childId: claim.childId }
          },
          create: {
            deviceId: input.deviceId,
            childId: claim.childId,
            userId: user.id,
            activeRole: role,
            expiresAt: input.deviceSessionExpiresAt
          },
          update: {
            userId: user.id,
            activeRole: role,
            expiresAt: input.deviceSessionExpiresAt
          }
        })

        // ── 第 6 步：认证凭据（明文只在 HTTP 响应里出现一次）────────────────
        await tx.authSession.create({
          data: {
            userId: user.id,
            tokenHash: input.tokenHash,
            method: 'password',
            deviceId: input.deviceId,
            expiresAt: input.authExpiresAt
          }
        })

        // ── 第 7 步：审计（只记码行 id，**不记码本身**，同 invites 模块）────
        await tx.auditLog.create({
          data: {
            childId: claim.childId,
            actorUserId: user.id,
            actorRole: role,
            action: 'member.join',
            targetType: 'ChildMember',
            targetId: member.id,
            after: { role, inviteCodeId: claim.id, via: 'register_invite' },
            deviceId: input.deviceId
          }
        })

        return {
          userId: user.id,
          displayName: user.displayName,
          childId: claim.childId,
          role
        }
      })
    } catch (error) {
      this.mapRegistrationError(error)
    }
  }

  /**
   * 只把**可预期**的库层失败翻成 4xx，其余原样抛（500）。
   *
   * ★ `IDENTIFIER_TAKEN` 是 409 而不是 400：400 会让客户端以为「格式不对」，
   *   用户会反复改写法，而真相是「这个号已经注册过，请直接登录」。
   */
  private mapRegistrationError(error: unknown): never {
    if (error instanceof HttpException) throw error

    // 手机号 / 邮箱的唯一约束冲突（与网站邀请码注册共用一份文案与 field）
    rethrowIfIdentifierTaken(error)

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2003') {
        throw new NotFoundException({
          code: 'CHILD_NOT_FOUND',
          message: '邀请码对应的孩子档案刚刚被删除了，注册没有生效。'
        })
      }
    }

    throw error
  }
}

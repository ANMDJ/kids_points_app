import { ConflictException, HttpException, Injectable } from '@nestjs/common'

import { claimRegistrationInvite } from '../registration-invites/registration-invite-claim'
import { PrismaService } from '../prisma/prisma.service'
import { rethrowIfIdentifierTaken } from './identifier-conflict'
import type {
  PublicRegistrationPort,
  RegisteredPublicRow,
  RegisterWithPublicInviteInput
} from './public-registration.repository'

/**
 * 网站注册邀请码的 **Prisma 适配器**（W12，2026-11-02）。
 *
 * ── 顺序（第 2 步是唯一的安全条款）──────────────────────────────────────────
 *   ① `User`（手机号/邮箱 + 密码哈希；唯一列冲突 ⇒ 409 `IDENTIFIER_TAKEN`）
 *   ② 原子占码（`claimRegistrationInvite()`：已用过 / 过期 / 吊销 / **标识不匹配**
 *      全部返回 null ⇒ 同一个 409 `INVITE_CODE_UNAVAILABLE`）
 *   ③ `AuthSession`（明文 token 只在 HTTP 响应里出现一次）
 *   ④ `AuditLog`（`action='account.register'`；`childId` 为 null —— 这个账号
 *      此刻确实没有任何孩子，**不是**漏写）
 *
 * ── 为什么先建 User、再占码（顺序看似反了）──────────────────────────────────
 *   `RegistrationInvite.usedByUserId` 是外键 ⇒ 占位语句需要已存在的 userId。
 *   这不会留下孤儿账号：整个方法是一笔事务，占码失败抛错时 `User` 一起回滚。
 *
 * ── 为什么不建 `DeviceSession` / `ChildMember` ───────────────────────────────
 *   两者都以 `childId` 为键，而这张码不绑定任何家庭。注册成功后客户端
 *   `GET /auth/session` 会看到 `children: []`，走 `POST /children` 引导 ——
 *   这是既有能力（`40` §7），不需要在这里重造一遍。
 */
@Injectable()
export class PrismaPublicRegistrationRepository implements PublicRegistrationPort {
  constructor(private readonly prisma: PrismaService) {}

  async registerWithInvite(input: RegisterWithPublicInviteInput): Promise<RegisteredPublicRow> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<RegisteredPublicRow> => {
        // ── 第 1 步：账号 ─────────────────────────────────────────────────
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

        // ── 第 2 步：原子占码（唯一判据，见 registration-invite-claim.ts）──
        const claim = await claimRegistrationInvite(tx, {
          code: input.code,
          userId: user.id,
          identifierValue: input.identifierValue
        })
        if (claim === null) {
          // 不存在 / 已用过 / 过期 / 吊销 / 与码上的手机号邮箱都不一致 ——
          // 故意同一个回答（区分它们等于给端点一个「哪些码存在」的探测面）。
          // ★ 抛错 ⇒ 第 1 步的 User 一起回滚，不会留下半成品账号。
          throw new ConflictException({
            code: 'INVITE_CODE_UNAVAILABLE',
            message:
              '邀请码无效、已过期、已使用或已吊销，或者与这里填写的手机号/邮箱不一致' +
              '（这些情况回答相同）。请回到获取页面重新申请，或向已经在用的家长要一张。'
          })
        }

        // ── 第 3 步：认证凭据 ─────────────────────────────────────────────
        await tx.authSession.create({
          data: {
            userId: user.id,
            tokenHash: input.tokenHash,
            method: 'password',
            deviceId: input.deviceId,
            expiresAt: input.authExpiresAt
          }
        })

        // ── 第 4 步：审计（不记码本身，只记码行 id）──────────────────────
        await tx.auditLog.create({
          data: {
            // ★ 这个账号此刻没有孩子 —— 留空是事实，不是缺失。
            childId: null,
            actorUserId: user.id,
            actorRole: null,
            action: 'account.register',
            targetType: 'User',
            targetId: user.id,
            after: { via: 'website_invite', registrationInviteId: claim.id },
            deviceId: input.deviceId
          }
        })

        return { userId: user.id, displayName: user.displayName }
      })
    } catch (error) {
      this.mapError(error)
    }
  }

  /**
   * `HttpException` 原样抛；唯一约束冲突 ⇒ 409 `IDENTIFIER_TAKEN`；
   * 其余（连不上库 / 约束坏了）保持 500。
   */
  private mapError(error: unknown): never {
    if (error instanceof HttpException) throw error
    rethrowIfIdentifierTaken(error)
    throw error
  }
}

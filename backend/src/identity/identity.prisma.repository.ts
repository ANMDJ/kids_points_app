import { randomUUID } from 'node:crypto'

import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import type { RelationKind } from '@prisma/client'

import { INVITE_SESSION_TTL_MS } from '../invites/invite-code'
import { PrismaService } from '../prisma/prisma.service'
import type {
  BootstrapChildInput,
  BootstrapChildResult,
  ChildMembershipRow,
  EnsureChildSessionInput,
  EnsureChildSessionResult,
  IdentityPort,
  LoginUserRow,
  LoginWithOpenIdInput
} from './identity.repository'

/**
 * 登录 / 建孩子 / 补设备会话端口的 **Prisma 适配器**（W9-A，2026-10-29 / `40` §6–§8）。
 *
 * ── 四个方法 = 四个事务边界 ──────────────────────────────────────────────────
 *   loginWithOpenId     `INSERT … ON CONFLICT` 取 User（**单条语句**）→ 写 AuthSession
 *   listChildren        一条只读查询（不写）
 *   bootstrapChild      **7 步同一事务**（`40` §7.4）：占位 Child → 同意 → 成员位 →
 *                       监护关系 → 引导期 DeviceSession → 审计
 *   ensureChildSession  读成员位 → 冲突检查 → upsert DeviceSession（同一事务）
 *
 * ── ★ `loginWithOpenId` 为什么用裸 SQL 的 `ON CONFLICT` ──────────────────────
 *   同一家长在两台设备上**同时**首次登录是正常动作。`findUnique` + `create` 在
 *   READ COMMITTED 下会双双读到 `null`，第二个 `INSERT` 撞 `User.openId` 唯一键 ⇒ 500。
 *   而 `catch (P2002)` 也救不了：Postgres 里一条语句报错会让**整个事务**进入
 *   aborted 状态，后面任何查询都失败（"current transaction is aborted"）。
 *   ⇒ 必须让"取或建"是**一条语句**。
 *   `DO UPDATE SET "updatedAt" = "User"."updatedAt"` 是为了让 `RETURNING` 在
 *   冲突时**也返回那一行**（`DO NOTHING` 会返回 0 行）；它取行锁但仍是一次原子操作。
 *   `id` 由本进程生成（`randomUUID()`）：Prisma 的 `cuid()` 是**客户端**生成的，
 *   裸 SQL 拿不到它。id 是不透明字符串，形状变化不影响任何判定。
 *
 * ── ★ `bootstrapChild` 的语句顺序与"同意先行" ────────────────────────────────
 *   `GuardianConsent.childId` 是外键 ⇒ 不可能在 `Child` 行之前插入同意行。
 *   合规要求的"同意必须早于**采集**"由**请求形状**保证，而不是事务内顺序：
 *   这条路由的请求体**只有** `consent.accepted`，孩子的名字是占位 `'宝贝'`
 *   （用户从未输入过任何儿童个人信息）；真正的采集发生在下一步
 *   `PATCH /child`（`40` §7.3 的两步流程）。
 *
 * ── 三处"适配器不判"（刻意的）────────────────────────────────────────────────
 *   ① 不算 token / TTL：`auth-session.gate.ts` 与 service；
 *   ② 不把 WeChat 错误翻成 HTTP：service；
 *   ③ 不判断"该不该给家长权限"：`MembershipGuard` 与权限矩阵。
 */
@Injectable()
export class PrismaIdentityRepository implements IdentityPort {
  constructor(private readonly prisma: PrismaService) {}

  async loginWithOpenId(input: LoginWithOpenIdInput): Promise<LoginUserRow> {
    return await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; displayName: string | null; status: string }>
      >`
        INSERT INTO "User" ("id", "openId", "displayName", "status", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${input.openId}, NULL, 'active', now(), now())
        ON CONFLICT ("openId") DO UPDATE SET "updatedAt" = "User"."updatedAt"
        RETURNING id, "displayName", status::text AS status`

      const user = rows[0]
      if (user === undefined) {
        // 唯一键冲突必返回行；0 行只可能是有人把 SQL 改成 DO NOTHING。
        throw new Error('loginWithOpenId：ON CONFLICT 没有返回 User 行（SQL 被改动？）')
      }
      if (user.status !== 'active') {
        // 停用 / 已注销的账号**不发凭据**（撤销语义见 `40` §4.5）。
        throw new ForbiddenException({
          code: 'USER_NOT_ACTIVE',
          message: `这个账号当前不可用（status=${user.status}），没有签发登录凭据。`
        })
      }

      await tx.authSession.create({
        data: {
          userId: user.id,
          tokenHash: input.tokenHash,
          method: input.method,
          deviceId: input.deviceId,
          expiresAt: input.expiresAt
        }
      })

      return { userId: user.id, displayName: user.displayName }
    })
  }

  async readUser(userId: string): Promise<LoginUserRow | null> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: 'active' },
      select: { id: true, displayName: true }
    })
    return user === null ? null : { userId: user.id, displayName: user.displayName }
  }

  async listChildren(userId: string): Promise<ChildMembershipRow[]> {
    const members = await this.prisma.childMember.findMany({
      where: { userId, status: 'active', child: { status: 'active' } },
      select: { childId: true, role: true, child: { select: { name: true } } },
      // 稳定顺序：客户端"0 个进建孩子 / 1 个直入 / N 个选择"依赖它可复现。
      orderBy: { joinedAt: 'asc' }
    })
    return members.map((member) => ({
      childId: member.childId,
      name: member.child.name,
      role: member.role
    }))
  }

  async bootstrapChild(input: BootstrapChildInput): Promise<BootstrapChildResult> {
    return await this.prisma.$transaction(async (tx) => {
      // ① 首版**一人一家庭**（§14 Q3）：已有有效成员位 ⇒ 409，且整体回滚。
      const existing = await tx.childMember.findFirst({
        where: { userId: input.userId, status: 'active' },
        select: { id: true }
      })
      if (existing !== null) {
        throw new ConflictException({
          code: 'CHILD_LIMIT_REACHED',
          message:
            '这个账号已经有一个孩子的档案了（首版一人一家庭）。这次没有创建任何数据。' +
            '要再建一个家庭需要先升级产品口径，见 `docs/design/40` §14 Q3。'
        })
      }

      // ② 占位档案（**不含用户输入**：名字是 `'宝贝'`，`onboardedAt=null` 表示未完成引导）。
      const child = await tx.child.create({
        data: { name: PLACEHOLDER_CHILD_NAME, pointsBalance: 0 },
        select: { id: true }
      })

      // ③ 同意：版本由服务端给，IP/UA 只存 HMAC（`hash-pii.ts`，无盐则留空）。
      await tx.guardianConsent.create({
        data: {
          childId: child.id,
          grantedByUserId: input.userId,
          consentVersion: input.consentVersion,
          ipHash: input.ipHash,
          userAgentHash: input.userAgentHash
        }
      })

      // ④ 成员位：屏障一的唯一入口（02 §1）。PIN 为空 ⇒ 引导期 `modeSource` 是 `bootstrap`。
      await tx.childMember.create({
        data: {
          childId: child.id,
          userId: input.userId,
          role: 'guardian',
          status: 'active',
          invitedByUserId: null
        }
      })

      // ⑤ 监护关系：与成员位**不是**同一件事（02 §1），只作关系记录。
      await tx.userChildRelation.create({
        data: { childId: child.id, userId: input.userId, relation: input.relation as RelationKind }
      })

      // ⑥ 引导期会话：5 分钟家长窗口（`parentModeSourceOf()` 会读成 `bootstrap`）。
      await tx.deviceSession.create({
        data: {
          deviceId: input.deviceId,
          childId: child.id,
          userId: input.userId,
          activeRole: 'guardian',
          expiresAt: input.parentModeUntil
        }
      })

      // ⑦ 审计：谁、在哪台设备、建了哪个孩子。
      await tx.auditLog.create({
        data: {
          childId: child.id,
          actorUserId: input.userId,
          actorRole: 'guardian',
          action: 'child.create',
          targetType: 'Child',
          targetId: child.id,
          deviceId: input.deviceId,
          after: { name: PLACEHOLDER_CHILD_NAME, relation: input.relation }
        }
      })

      return { childId: child.id, role: 'guardian' as const, parentModeUntil: input.parentModeUntil }
    })
  }

  async ensureChildSession(input: EnsureChildSessionInput): Promise<EnsureChildSessionResult> {
    return await this.prisma.$transaction(async (tx) => {
      const member = await tx.childMember.findUnique({
        where: { childId_userId: { childId: input.childId, userId: input.userId } },
        select: { role: true, status: true }
      })
      if (member === null || member.status !== 'active') {
        // 403 而不是 404：调用者知道自己是谁，问题在"对这个孩子没有成员位"。
        // ★ 也不泄露"这个孩子存不存在"—— 两种情况回答相同。
        throw new ForbiddenException({
          code: 'NOT_A_MEMBER',
          message: '你在这个孩子的档案上没有有效的成员位，没有创建会话。请向家长要一个邀请码。'
        })
      }

      const existing = await tx.deviceSession.findUnique({
        where: { deviceId_childId: { deviceId: input.deviceId, childId: input.childId } },
        select: { userId: true }
      })
      if (existing !== null && existing.userId !== input.userId) {
        // 共享平板的真实形态：同一台设备在同一档案上已有**别人**的会话。
        // 静默覆盖 = 把那位家长/孩子的会话悄悄变成新登录者的（与邀请码同一条口径）。
        throw new ConflictException({
          code: 'DEVICE_SESSION_CONFLICT',
          message:
            '这台设备在这个孩子的档案上已经有一个属于其他账号的会话。' +
            '请先在应用里切换账号（或换一台设备），本次没有创建任何数据。'
        })
      }

      await tx.deviceSession.upsert({
        where: { deviceId_childId: { deviceId: input.deviceId, childId: input.childId } },
        create: {
          deviceId: input.deviceId,
          childId: input.childId,
          userId: input.userId,
          activeRole: member.role,
          expiresAt: input.sessionExpiresAt
        },
        update: {
          userId: input.userId,
          // 角色以**成员位**为准：登录不改变权限，只补一行"这台设备在这个孩子上"。
          activeRole: member.role,
          expiresAt: input.sessionExpiresAt
        }
      })

      return { role: member.role, sessionExpiresAt: input.sessionExpiresAt }
    })
  }
}

/**
 * 占位昵称（`40` §7.3）。
 *
 * ★ 为什么不用 `'微信用户'` / 空串：前者是**假数据**（成员列表里"这个孩子是谁家的"
 *   不可分辨），后者会撞上 `CHILD_NAME_EMPTY` 的校验。`'宝贝'` 是一个**看得见的占位**：
 *   用户在引导第②步会把它改成真名，`onboardedAt = null` 则保证前端一定回到引导。
 */
export const PLACEHOLDER_CHILD_NAME = '宝贝'

/** 设备会话的登录口径 TTL —— **复用邀请码那条常数**（同一个数字只有一个定义处）。 */
export const CHILD_SESSION_TTL_MS = INVITE_SESSION_TTL_MS

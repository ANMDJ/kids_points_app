import { randomUUID } from 'node:crypto'

import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common'
import { Prisma, type RelationKind } from '@prisma/client'

import { INVITE_SESSION_TTL_MS } from '../invites/invite-code'
import { PrismaService } from '../prisma/prisma.service'
import type { IdentifierType } from './account-identifier'
import type {
  AccountRow,
  AccountViewRow,
  BootstrapChildInput,
  BootstrapChildResult,
  ChildMembershipRow,
  EnsureChildSessionInput,
  EnsureChildSessionResult,
  IdentityPort,
  IssueSessionInput,
  LoginUserRow,
  LoginWithOpenIdInput,
  WriteAccountInput
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

  // ═══════════════ App 账号登录（W9-D，2026-10-30 / `42` §3）═══════════════

  /**
   * 按规范化后的标识查账号。
   *
   * ★ 用 `findFirst` 而不是 `findUnique({ where: { phone } })`：
   *   `phone` / `email` 是**可空唯一列**，Prisma 对 `findUnique` 的可空唯一键
   *   要求写 `phone: value ?? undefined` 之类的前置处理，一旦有人把 `value`
   *   传成 `null`，`findUnique` 会静默返回"第一行 phone 为 NULL 的用户"——
   *   那是把"没填手机号"当成"匹配"。`findFirst({ where: { phone: value } })`
   *   生成的 SQL 是 `WHERE "phone" = $1`，`null` 永远不会等于任何行。
   */
  async readAccountByIdentifier(
    type: IdentifierType,
    value: string
  ): Promise<AccountRow | null> {
    const user = await this.prisma.user.findFirst({
      where: type === 'phone' ? { phone: value } : { email: value },
      select: {
        id: true,
        displayName: true,
        status: true,
        phone: true,
        email: true,
        passwordHash: true
      }
    })
    if (user === null) return null
    return {
      userId: user.id,
      displayName: user.displayName,
      status: user.status,
      phone: user.phone,
      email: user.email,
      passwordHash: user.passwordHash
    }
  }

  /** 读当前登录者的账号（**不过滤 status**：停用账号也要能读出来，好走同一条 403）。 */
  async readAccount(userId: string): Promise<AccountRow | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        displayName: true,
        status: true,
        phone: true,
        email: true,
        passwordHash: true
      }
    })
    if (user === null) return null
    return {
      userId: user.id,
      displayName: user.displayName,
      status: user.status,
      phone: user.phone,
      email: user.email,
      passwordHash: user.passwordHash
    }
  }

  /**
   * 给已存在的用户签发会话（密码登录）。
   *
   * ── 为什么是 `UPDATE … WHERE status='active' RETURNING` 而不是先 `findUnique` ──
   *   服务端在**验完密码之后**才调这里，中间隔了一次 ~50ms 的 scrypt。
   *   若先读后写，这 50ms 里账号被停用就会写出一条属于停用账号的会话。
   *   一条 `UPDATE … WHERE … RETURNING` 让「确认仍然可用」与「拿到行」是同一次
   *   原子操作（行锁在语句结束时释放，但会话行已在同一事务里写入）。
   *
   * `SET "updatedAt" = "User"."updatedAt"` 只是为了让 `RETURNING` 有行可返；
   * 它不改变任何值（同 `loginWithOpenId` 的 `DO UPDATE SET …` 手法）。
   */
  async issueSession(input: IssueSessionInput): Promise<LoginUserRow> {
    return await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; displayName: string | null }>>`
        UPDATE "User" SET "updatedAt" = "User"."updatedAt"
        WHERE "id" = ${input.userId} AND "status" = 'active'
        RETURNING "id", "displayName"`

      const user = rows[0]
      if (user === undefined) {
        throw new ForbiddenException({
          code: 'USER_NOT_ACTIVE',
          message: '这个账号当前不可用（已停用或已删除），没有签发登录凭据。'
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

  /**
   * 绑定标识 / 写密码哈希（**部分更新**，同一语句）。
   *
   * ── 为什么唯一冲突要在这里翻 ─────────────────────────────────────────────────
   *   「这个手机号已被别的家长绑定」是**可预期的正常分支**，不是 500。
   *   Prisma 的 `P2002` 在事务里会让后续语句全部失败（aborted），所以必须
   *   在**单条 update** 上捕获 —— 这里没有外层事务，恰好是最简单的形状。
   *
   * ── 冲突列只用于挑文案，不用于判权限 ────────────────────────────────────────
   *   回 `field: 'phone' | 'email'` 是为了让客户端把错误显示在**正确的输入框**下；
   *   它不泄露"那个账号是谁"（`meta.target` 只有列名）。
   */
  async writeAccount(input: WriteAccountInput): Promise<AccountViewRow> {
    try {
      const updated = await this.prisma.user.update({
        where: { id: input.userId },
        data: {
          ...(input.phone === undefined ? {} : { phone: input.phone }),
          ...(input.email === undefined ? {} : { email: input.email }),
          ...(input.passwordHash === undefined
            ? {}
            : {
                passwordHash: input.passwordHash,
                passwordSetAt: input.passwordSetAt ?? new Date()
              })
        },
        select: { phone: true, email: true, passwordHash: true }
      })
      return {
        phone: updated.phone,
        email: updated.email,
        hasPassword: updated.passwordHash !== null
      }
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const field = conflictField(err)
        throw new ConflictException({
          code: 'IDENTIFIER_TAKEN',
          field,
          message:
            field === 'phone'
              ? '这个手机号已经被另一个账号绑定了。请换一个，或在小程序里解绑后再试。'
              : '这个邮箱已经被另一个账号绑定了。请换一个，或在小程序里解绑后再试。'
        })
      }
      throw err
    }
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

/**
 * `P2002` 撞的是哪一列 —— **只用来挑文案**，不参与任何判定。
 *
 * ── 为什么要容忍三种形状 ─────────────────────────────────────────────────────
 *   Prisma 的 `meta.target` 在不同版本 / 不同驱动下可能是
 *   `['phone']`、`'User_phone_key'` 或带 schema 前缀的 `'public.User_phone_key'`。
 *   依赖其中一种会在升级时静默退化成"永远落在 unknown 分支"。
 *   三者都含列名 ⇒ 子串判断是这里唯一稳定的写法。
 *
 * 认不出 ⇒ `'identifier'`：文案仍然正确（"这个手机号或邮箱已被使用"），
 * 只是不能把错误挂到具体的输入框下。
 */
export function conflictField(
  err: Prisma.PrismaClientKnownRequestError
): 'phone' | 'email' | 'identifier' {
  const target = err.meta?.target
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '')
  if (text.includes('phone')) return 'phone'
  if (text.includes('email')) return 'email'
  return 'identifier'
}

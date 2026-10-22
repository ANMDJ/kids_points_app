import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type {
  ChangeMemberRoleInput,
  ChangeMemberRoleResult,
  MembersPort,
  RemoveMemberInput,
  RemoveMemberResult
} from './members.repository'
import type { MemberRow } from './members.types'

/**
 * 成员行读取列 —— 只取"家里有谁"需要的字段。
 *
 * ★ 嵌套 `select` 而不是 `include: true`：`User` 上有 `openId`，`ChildMember` 上有
 *   PIN 哈希 / 限制 / 失败计数 —— 一次性 include 会把它们带进内存与日志。
 */
const MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  status: true,
  joinedAt: true,
  removedAt: true,
  user: { select: { displayName: true } }
} as const satisfies Prisma.ChildMemberSelect

type MemberSelectRow = Prisma.ChildMemberGetPayload<{ select: typeof MEMBER_SELECT }>

/** 列表顺序：家长 → 孩子 → viewer；同级按加入时间。与枚举声明顺序**解耦**。 */
const ROLE_RANK: Record<string, number> = { guardian: 0, child: 1, viewer: 2 }

/**
 * 成员管理的 **Prisma 适配器**（W5-H，2026-10-22）
 *
 * ── ★ 这里唯一真正难的事情：最后一位家长的保护 ────────────────────────────
 *   「把一个家长降级 / 移出」只有在**还有别的家长**时才允许。这个判断是
 *   **集合**事实（"这个孩子还有几个 active guardian"），所以：
 *
 *     ① 只查一次再写 ⇒ 并发下两个家长互相降级，双方都看到 count=2，双双成功，
 *        家里一个家长都不剩。这是本功能最可能出现的漏洞形态；
 *     ② 单条条件 UPDATE（`WHERE … (SELECT count(*) …) > 1`）也**不够**：
 *        PostgreSQL READ COMMITTED 下，两条并发语句各自看到"语句开始时"的快照，
 *        子查询同样可能双双读到 2；
 *     ③ 所以先 `SELECT … ORDER BY id FOR UPDATE` **锁住这个孩子的全部成员位**，
 *        再计数、再写。第二笔事务会等第一笔提交，然后在**已提交**的数据上重新计数
 *        （`FOR UPDATE` 的 EPQ 重检会丢掉已不满足条件的行），于是多出一位家长的
 *        降级恰好会得到 409。
 *
 *   锁的粒度是"一个孩子的成员位"（家庭规模个位数行），不是全表；两笔事务
 *   **都按 id 升序**加锁，因此不会互相死锁。条件 UPDATE 里的 count 子查询保留，
 *   作为第二道保险（锁若因将来的重构被去掉，它仍能挡住一部分错误）。
 *
 * ── 降级必须与"收回会话"同一事务（02 §7）────────────────────────────────
 *   `DeviceSession.activeRole` 是**服务端权威**。成员位改成 child 之后，那位家长
 *   手上未过期的会话仍然写着 guardian —— 他下一次请求照样是家长。所以降级时
 *   在同一条事务里把 `(childId, userId)` 上 `activeRole='guardian'` 的会话改成
 *   `child`。`MembershipGuard` 另外把会话角色按成员位收口（取更严的那个），
 *   使这条不变量**不依赖写路径是否记得同步**。
 *
 * ── 移出为什么不删会话 ─────────────────────────────────────────────────────
 *   会话行留着，屏障一才能回答 `MEMBER_REMOVED`（403，客户端可以解释
 *   "你已被移出这个家庭"）。删掉会话只会让同一个请求变成 401
 *   `SESSION_NOT_FOUND` —— 安全上等价，但把"被移出"伪装成"没登录"。
 *   曾被移出的人用新邀请码回来时，`acceptInvite` 复用同一行并重签会话。
 *
 * ── 自己不能改自己 ─────────────────────────────────────────────────────────
 *   两条写路径都先比 `target.userId === operatorUserId` ⇒ 403 `CANNOT_MODIFY_SELF`。
 *   这不是"多一层保护"，而是"最后一位家长"保护能成立的前提：只剩一位家长时，
 *   他既不能降自己，也不能移自己，而别人动他会撞上集合判据。
 */
@Injectable()
export class PrismaMembersRepository implements MembersPort {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveMembers(childId: string): Promise<MemberRow[]> {
    const rows = await this.prisma.childMember.findMany({
      where: { childId, status: 'active' },
      // 库只保证确定性（同毫秒加入时按 id），"家长在前"由下面的 rank 排 ——
      // 不依赖 enum 的声明顺序（那是 schema 的偶然，不是契约）。
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
      select: MEMBER_SELECT
    })

    return rows
      .slice()
      .sort((a, b) => {
        const rank = (ROLE_RANK[a.role] ?? 99) - (ROLE_RANK[b.role] ?? 99)
        if (rank !== 0) return rank
        const joined = a.joinedAt.getTime() - b.joinedAt.getTime()
        if (joined !== 0) return joined
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
      .map(toMemberRow)
  }

  async changeMemberRole(input: ChangeMemberRoleInput): Promise<ChangeMemberRoleResult> {
    return await this.prisma.$transaction(async (tx): Promise<ChangeMemberRoleResult> => {
      await lockMemberRows(tx, input.childId)

      const target = await tx.childMember.findFirst({
        where: { id: input.memberId, childId: input.childId },
        select: MEMBER_SELECT
      })

      // 跨孩子一律同答 404：不能让人拿别人的 memberId 探出"这一行存在"。
      if (target === null) throw memberNotFound(input.memberId)

      // 自己改自己：见文件头（这是"最后一位家长"保护的前提，不是附加条款）。
      if (target.userId === input.operatorUserId) throw cannotModifySelf()

      if (target.status !== 'active') {
        throw new ConflictException({
          code: 'MEMBER_NOT_ACTIVE',
          message:
            '这个成员位已被移出（status ≠ active），没有修改任何角色。' +
            '要让他回来，请用新的邀请码重新加入。'
        })
      }

      // 幂等 no-op：目标角色本来就一样 ⇒ 200，不写审计（否则每点一次就多一条）。
      if (target.role === input.role) {
        return { member: toMemberRow(target), changed: false }
      }

      const updated = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "ChildMember" AS m
           SET role = ${input.role}::"MemberRole",
               "updatedAt" = now()
         WHERE m.id = ${input.memberId}
           AND m."childId" = ${input.childId}
           AND m.status = 'active'
           AND (
                ${input.role}::text = 'guardian'
             OR m.role <> 'guardian'
             OR (SELECT count(*) FROM "ChildMember" AS g
                  WHERE g."childId" = ${input.childId}
                    AND g.role = 'guardian'
                    AND g.status = 'active') > 1
           )
        RETURNING m.id`

      if (updated.length === 0) throw lastGuardianProtected('降级')

      // ★ 降级必须同时收回会话：否则他手上那张 guardian 的票还能用到过期。
      if (input.role === 'child') {
        await tx.deviceSession.updateMany({
          where: {
            childId: input.childId,
            userId: target.userId,
            activeRole: 'guardian'
          },
          data: { activeRole: 'child' }
        })
      }

      const after = await tx.childMember.findUniqueOrThrow({
        where: { id: input.memberId },
        select: MEMBER_SELECT
      })

      await tx.auditLog.create({
        data: {
          childId: input.childId,
          actorUserId: input.operatorUserId,
          actorRole: input.operatorRole,
          action: 'member.role_change',
          targetType: 'ChildMember',
          targetId: input.memberId,
          // 只记角色变化：PIN 哈希、限制、openId 都不进审计快照。
          before: { role: target.role },
          after: { role: after.role },
          deviceId: input.deviceId
        }
      })

      return { member: toMemberRow(after), changed: true }
    })
  }

  async removeMember(input: RemoveMemberInput): Promise<RemoveMemberResult> {
    return await this.prisma.$transaction(async (tx): Promise<RemoveMemberResult> => {
      await lockMemberRows(tx, input.childId)

      const target = await tx.childMember.findFirst({
        where: { id: input.memberId, childId: input.childId },
        select: MEMBER_SELECT
      })

      if (target === null) throw memberNotFound(input.memberId)
      if (target.userId === input.operatorUserId) throw cannotModifySelf()

      // 构造幂等：已经移出 ⇒ 同一个 200，**不**写第二条审计。
      // （与 `POST /invites/:id/revoke` 的"再吊销一次"同一手法。）
      if (target.status === 'removed') {
        return {
          memberId: target.id,
          removedAt: target.removedAt ?? new Date(),
          alreadyRemoved: true
        }
      }

      const updated = await tx.$queryRaw<Array<{ id: string; removedAt: Date }>>`
        UPDATE "ChildMember" AS m
           SET status = 'removed'::"MemberStatus",
               "removedAt" = now(),
               "updatedAt" = now()
         WHERE m.id = ${input.memberId}
           AND m."childId" = ${input.childId}
           AND m.status = 'active'
           AND (
                m.role <> 'guardian'
             OR (SELECT count(*) FROM "ChildMember" AS g
                  WHERE g."childId" = ${input.childId}
                    AND g.role = 'guardian'
                    AND g.status = 'active') > 1
           )
        RETURNING m.id, m."removedAt"`

      const row = updated[0]
      if (row === undefined) throw lastGuardianProtected('移出')

      await tx.auditLog.create({
        data: {
          childId: input.childId,
          actorUserId: input.operatorUserId,
          actorRole: input.operatorRole,
          action: 'member.remove',
          targetType: 'ChildMember',
          targetId: input.memberId,
          before: { status: 'active', role: target.role },
          after: { status: 'removed' },
          deviceId: input.deviceId
        }
      })

      // ★ 会话**不删**（见文件头）：让屏障一回 `MEMBER_REMOVED` 而不是 401。
      return { memberId: row.id, removedAt: row.removedAt, alreadyRemoved: false }
    })
  }
}

/**
 * 锁住这个孩子的**全部**成员位（含已移出的行），按 id 升序。
 *
 * 为什么锁"全部"而不只是 active guardian：并发降级时，两笔事务必须以**相同的
 * 顺序**拿到同一组行锁，才不会互相死锁；而"全部行"是最稳定的那组
 * （active 集合本身在事务之间会变）。
 */
async function lockMemberRows(tx: Prisma.TransactionClient, childId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM "ChildMember"
     WHERE "childId" = ${childId}
     ORDER BY id
       FOR UPDATE`
}

/** 端口行映射：`Date` 原样留在端口层，ISO 转换只发生在 `MembersService`。 */
function toMemberRow(row: MemberSelectRow): MemberRow {
  return {
    memberId: row.id,
    userId: row.userId,
    displayName: row.user.displayName,
    role: row.role,
    status: row.status,
    joinedAt: row.joinedAt,
    removedAt: row.removedAt
  }
}

/** 跨孩子 / 不存在：同答 404（不泄露别家 memberId 是否存在）。 */
function memberNotFound(memberId: string): NotFoundException {
  return new NotFoundException({
    code: 'MEMBER_NOT_FOUND',
    message: `成员 ${memberId} 不存在或不属于当前孩子的档案，没有做任何修改。`
  })
}

function cannotModifySelf(): ForbiddenException {
  return new ForbiddenException({
    code: 'CANNOT_MODIFY_SELF',
    message:
      '不能修改自己的成员位（降级或移出自己）。' +
      '自我降级 = 一次误触就把自己锁在门外，而能救你的人也已经被你降掉了；' +
      '「退出家庭」是另一个产品决定，不由这里实现。'
  })
}

function lastGuardianProtected(what: string): ConflictException {
  return new ConflictException({
    code: 'LAST_GUARDIAN_PROTECTED',
    message:
      `这是这个孩子**唯一**的家长，不能${what}：` +
      '没有家长的家庭既不能发邀请码、也不能审批，等于把孩子锁在档案里。' +
      '请先把另一个人提升为家长（PATCH role=guardian），再回来操作。'
  })
}

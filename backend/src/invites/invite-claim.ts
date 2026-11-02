/**
 * 邀请码的**占位语句**与角色映射 —— 共享内核（W11-A，2026-11-02 / `45` §2）
 *
 * ── 为什么它必须单独一个文件，而不是各写一遍 ────────────────────────────────
 *   「这个码还能不能用」有两个调用方：
 *     · `POST /invites/accept`（已登录的人加入已有家庭，`invites.prisma.repository.ts`）；
 *     · `POST /auth/register-invite`（**还没有账号**的人用邀请码注册，`identity` 模块）。
 *   如果两边各写一条 `UPDATE … WHERE …`，那么「过期边界是 `>` 还是 `>=`」
 *   「吊销是否算不可用」就会出现两份判据，而它们迟早不一致 —— 那正是
 *   `02` §8 反复强调的 TOCTOU 之外的第二类坑：**两个都说自己安全的实现**。
 *
 * ── 为什么调用方**必须**把返回值当唯一答案 ──────────────────────────────────
 *   返回 `null` 的含义是「不存在 / 已用完 / 已过期 / 已吊销」四种情况之一，
 *   而不是「查不到」。四种情况**故意不可区分**：区分它们等于给这个端点
 *   一个「哪些码存在」的探测面，而用户能做的动作完全相同（找家长再要一个）。
 *   调用方必须把它翻成同一个 409 `INVITE_CODE_UNAVAILABLE`。
 *
 * ── 为什么参数是事务客户端而不是 `PrismaService` ─────────────────────────────
 *   占位与后续写入（成员位 / 设备会话 / 用户 / 认证会话）必须在**同一个事务**里：
 *   占位成功但后续写入失败时，整笔回滚才能让名额不被白白烧掉。
 *   所以这里只接受 `tx`，不提供「自动开事务」的重载 —— 那会诱使调用方
 *   把占位和写成员位拆到两个事务里。
 */
import { InternalServerErrorException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'

import type { InviteRole } from './invites.types'

/** 原子占位语句的 `RETURNING` 行（`role` 已 `::text`，避免驱动给枚举对象）。 */
export interface ClaimedInviteRow {
  id: string
  childId: string
  role: string
  createdByUserId: string
}

/**
 * 原子占掉一个邀请码名额。
 *
 * 核心是一条 `UPDATE … WHERE "usedCount" < "maxUses" … RETURNING`：
 * 「读剩余次数 → 插入成员 → 次数 +1」分三步就是 TOCTOU（10 个并发请求会
 * 一起通过校验，把 `maxUses=3` 的码用掉 10 次）。行锁 + 条件 UPDATE 让
 * **至多 `maxUses` 个**请求拿到 `RETURNING` 行。
 *
 * `usedByUserId` 会记录**最后一个**使用者（列只有一列，`maxUses>1` 时它必然
 * 只代表最近一次）—— 这是既有表结构的口径，不在这里补一张使用明细表。
 */
export async function claimInviteCode(
  tx: Prisma.TransactionClient,
  input: { code: string; userId: string }
): Promise<ClaimedInviteRow | null> {
  const claimed = await tx.$queryRaw<ClaimedInviteRow[]>`
    UPDATE "InviteCode"
       SET "usedCount" = "usedCount" + 1,
           "usedByUserId" = ${input.userId},
           "usedAt" = now()
     WHERE code = ${input.code}
       AND "usedCount" < "maxUses"
       AND "expiresAt" > now()
       AND revoked = false
    RETURNING id, "childId", role::text AS role, "createdByUserId"`

  return claimed[0] ?? null
}

/**
 * 库里只有 `child | guardian | viewer` 三种角色，而邀请只发前两种
 * （`viewer` 在矩阵里没有列 ⇒ 一律 DENY ⇒ 邀请一个 viewer 等于邀请一个
 * 什么都做不了的成员，02 §2 D6）。
 *
 * 读到第三种 ⇒ **500**：这是库里有脏数据（不可能是本模块写的），
 * 混报成 409 会让「有人直接改过库」被当成「这个码不可用」查很久（D3b 同一条纪律）。
 */
export function toInviteRole(role: string): InviteRole {
  if (role === 'child' || role === 'guardian') return role
  throw new InternalServerErrorException({
    code: 'INVITE_ROLE_UNUSABLE',
    message:
      `邀请码上的角色是 ${role}，它不是可邀请的角色（只有 child / guardian）。` +
      '这是数据问题，请检查该行是不是被直接改过库。'
  })
}

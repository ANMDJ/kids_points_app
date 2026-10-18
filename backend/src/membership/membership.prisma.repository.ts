import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'
import type { MembershipPort } from './membership.repository'
import type { MembershipLookupRow } from './membership.gate'

/**
 * 成员位端口的 **Prisma 适配器**（W2-D，2026-10-16）—— `MembershipPort` 的真实现。
 *
 * ── 它与内核的分工（一句话）───────────────────────────────────────────────
 *   内核（`membership.gate.ts`）回答"**这个人跟这个孩子有没有关系**"（纯函数、可离线穷举）；
 *   本文件只回答"**怎么把那一行读出来**"：用哪个键查、读哪几列。
 *   判定一律留在内核 —— 这里**再判一次**是禁止的（两套判定迟早漂移）。
 *
 * ── ★ 查询键：`@@unique([childId, userId])` ⇒ 用复合唯一键查 ──────────────────
 *     ✅ findUnique({ where: { childId_userId: { childId, userId } } })
 *   两个参数都是**键的一部分**（`02` §1：同一人对同一孩子只有一个成员位）。
 *   用复合键查，比"按 userId 查回来再在内存里筛 childId"诚实得多：
 *   后者在类型上完全过得了编译，但它把"资格"变成了应用层的过滤器 ——
 *   而这一层正是**唯一**应该被判定的地方（`resolveMembership()`）。
 *
 * ── ★★ 一处必须写下来的"不判"：**不按 `status` 过滤** ─────────────────────────
 *   内核要区分两件事（`02` §3），它们的成因与话术都不同：
 *     · 没有那一行        ⇒ `MEMBER_NOT_FOUND`（403「你不是这个孩子的成员」）
 *     · 有行但非 active   ⇒ `MEMBER_REMOVED`   （403「你的成员位已失效」）
 *   若在这里加 `status: 'active'`：两条都塌成 `MEMBER_NOT_FOUND`，于是**被移出的成员**
 *   会收到"你不是成员"—— 对一个刚刚被移出的人来说，这句话在语义上是错的
 *   （他曾经是），在排查上是误导（`ChildMember.removedAt` 明明有值）。
 *   用例两处都钉住这一点：离线（替身返回 removed 行 ⇒ 适配器必须**原样**交出来）
 *   ＋真库（写一行 `status='removed'` ⇒ 查回来仍是它，且内核判成 `MEMBER_REMOVED`）。
 *
 * ── 另一处"不判"：`restrictions` 原样返回 ───────────────────────────────────
 *   它是裸 `Json` 列（`@default("{}")`），形状校验在 `toMembership()` 里（唯一权威：
 *   `validateRestrictions()`）。这里若"顺手"把非法 JSON 过滤成 `{}`，
 *   一条写坏的限制就会**静默失效**（D3b 的典型病），而 500 正是为了让数据病与权限病分得开。
 *
 * ── ✅ 接线状态（W2-D）────────────────────────────────────────────────────
 *   `MembershipModule` 已改成**动态模块**：`register()` 按 `hasDatabaseUrl()`
 *   （`prisma/database-enabled.ts`，判据只有一处）分叉 —— 有库 ⇒ 本文件；无库 ⇒ 显式 501。
 *   于是"屏障一已接线、却从没真的查过库"这件事结束了。
 *   两端各有一半证据（缺一不可）：离线 `test/membership-wiring.test.ts` 管装配**声明**，
 *   真库 `test-db/identity-db.dbtest.ts` 管"**接了库真的通**"（含默认 `restrictions` 能过形状校验）。
 */
@Injectable()
export class PrismaMembershipRepository implements MembershipPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 查 `(childId, userId)` 的成员位；查不到 ⇒ `null`（**不是异常**）——
   * 「不是成员」是正常分支，由内核翻成 403 `MEMBER_NOT_FOUND`。
   *
   * `select` 只取 `MembershipLookupRow` 的五列：多读 `pinHash` / `invitedByUserId` 之类
   * 只会把它们带进守卫填的 `req.kpMember`（往请求上下文里塞不需要的东西是白送的泄漏面）。
   */
  async findMembership(childId: string, userId: string): Promise<MembershipLookupRow | null> {
    // ★ 不过滤 `status`（`removed` 行必须能被读出来，见文件头）；
    //   `restrictions` 原样交出去，形状由 `toMembership()` 校验。
    return this.prisma.childMember.findUnique({
      where: { childId_userId: { childId, userId } },
      select: {
        childId: true,
        userId: true,
        role: true,
        status: true,
        restrictions: true
      }
    })
  }
}

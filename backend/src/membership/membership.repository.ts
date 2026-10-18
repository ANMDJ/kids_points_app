import { Injectable, NotImplementedException } from '@nestjs/common'

import type { MembershipLookupRow } from './membership.gate'

/**
 * 成员位查询的**持久化端口**（端口 / 适配器里的「端口」）。
 *
 * ── 为什么单独一层（而不是让守卫直接 `new PrismaService()`）────────────────
 *   ① 屏障一的**判定**（`membership.gate.ts`）是纯函数，它的输入必须能被替身喂进来 ——
 *      否则"非成员 ⇒ 403"这条用例就得先有一个真库、真数据，CI 立刻变得不可移植；
 *   ② 端口的默认实现是**显式 501**（见文件末尾）：W1 之前它**不许**假装读得到。
 *      这样「成员查询未落地」是一个**可执行断言**，不是注释里的一句话。
 *
 * ✅ **真实现已落地（W2-D，2026-10-16）**：同目录 `membership.prisma.repository.ts`
 *    （`PrismaMembershipRepository`），由 `MembershipModule.register()` 在**有库**时绑定。
 * ⚠️ 本文件末尾的 501 实现**仍然有用**：无 `DATABASE_URL` 的装配（CI / `npm test`）走它 ⇒
 *    "屏障一还没查过库"在那种世界里依然是一个**可执行断言**，而不是注释里的一句话。
 *    `ApprovalsPort` 的真实现仍未落地（见 05 §2）。
 */

/** Nest 注入令牌（用 unique symbol 避免字符串撞名）。 */
export const MEMBERSHIP_REPOSITORY = Symbol('MEMBERSHIP_REPOSITORY')

export interface MembershipPort {
  /**
   * 查 `(childId, userId)` 的成员位。
   *
   * ★ 查不到就返回 `null`，**不抛异常** —— 「不是成员」是**正常分支**，
   *   它对应的是业务上的 403 `MEMBER_NOT_FOUND`（由屏障一决定），
   *   而不是"底层出错了"（那才是异常）。
   */
  findMembership(childId: string, userId: string): Promise<MembershipLookupRow | null>
}

/**
 * **无库装配**时的实现：**一律 501**。
 *
 * ── 为什么它现在还在（W2-D 之后，写清楚免得被当成"忘了删"）────────────────────
 *   ① **有库时不再走它**：`MembershipModule.register()` 在 `hasDatabaseUrl()` 为真时绑
 *      `PrismaMembershipRepository`（见 `membership.prisma.repository.ts`）；
 *   ② **无库时必须走它**：`PrismaService` 的构造函数在缺 `DATABASE_URL` 时**刻意**抛错，
 *      所以无库装配**不能**硬导 `PrismaModule`（否则任何离线用例在装配阶段就崩，
 *      而本仓库的 HTTP 用例全部是**无库**跑的：仓储一律用内存替身）；
 *   ③ 与 `NotImplementedApprovalsRepository` 同一口径：未落地的路径**必须响亮**。
 *
 * ⚠️ 代价同样写清楚（不粉饰）：**无库装配下，屏障一会对每个请求返回 501**
 *    （fail-closed —— 比"拦不住"强；但也别把这条当成"屏障一已完成"）。
 */
@Injectable()
export class NotImplementedMembershipRepository implements MembershipPort {
  private fail(childId: string, userId: string): never {
    throw new NotImplementedException({
      code: 'MEMBERSHIP_QUERY_NOT_IMPLEMENTED',
      message:
        `当前进程没有 DATABASE_URL（无库装配）⇒ 成员位查询不可用：findMembership(${childId}, ${userId}) 没有实现。` +
        '屏障一**已接线**（顺序、403 语义、restrictions 形状校验都有用例）；' +
        '有库装配走的是 PrismaMembershipRepository（真查 ChildMember）；' +
        '这里**拒绝**而不是放行：放行等于把成员资格判定整个跳过（fail-closed）。'
    })
  }

  findMembership(childId: string, userId: string): Promise<MembershipLookupRow | null> {
    return Promise.resolve(this.fail(childId, userId))
  }
}

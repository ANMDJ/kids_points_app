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
 * ⚠️ 目前的真实状态：**没有任何实现**（默认实现只会抛 501）。
 *    真 Prisma 适配器属 W2（与 `ApprovalsPort` 的 Prisma 实现同一批，见 05 §2）。
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
 * 默认实现：**一律 501**。
 *
 * ── 为什么默认不是"直接读 Prisma"（W1-B 的取舍，写清楚免得被误读）────────────
 *   ① **会让无库环境在启动阶段就崩**：`MembershipModule` 一旦注入 `PrismaService`，
 *      则任何装配了审批模块的测试（含无 `.env` 的 CI）都会在 `PrismaService` 的
 *      构造函数里因缺 `DATABASE_URL` 而抛错（那里是**刻意**失败的，见其文件头）。
 *      而本仓库的 HTTP 用例是**无库**跑的（仓储一律用内存替身）。
 *   ② 与 `NotImplementedApprovalsRepository` 同一口径：未落地的路径**必须响亮**。
 *
 * ⚠️ 代价同样写清楚（不粉饰）：**默认装配下，屏障一会对每个请求返回 501**
 *    （fail-closed —— 比"拦不住"强，但它也**还没有真的查过库**）。
 *    真 Prisma 适配器 ＋ "非成员 → 403 `MEMBER_NOT_FOUND`"的**真库**验证属 W2。
 */
@Injectable()
export class NotImplementedMembershipRepository implements MembershipPort {
  private fail(childId: string, userId: string): never {
    throw new NotImplementedException({
      code: 'MEMBERSHIP_QUERY_NOT_IMPLEMENTED',
      message:
        `成员位查询尚未落地（W2）：findMembership(${childId}, ${userId}) 没有实现。` +
        '屏障一**已接线**（顺序、403 语义、restrictions 形状校验都有用例），' +
        '但"谁是这个孩子的成员"目前读不到 —— 所以这里**拒绝**而不是放行：' +
        '放行等于把成员资格判定整个跳过（fail-closed）。'
    })
  }

  findMembership(childId: string, userId: string): Promise<MembershipLookupRow | null> {
    return Promise.resolve(this.fail(childId, userId))
  }
}

import { Injectable, NotImplementedException } from '@nestjs/common'
import type { MemberRole } from '@prisma/client'

import type { WishRow } from '../read/read.repository'

/**
 * 心愿写入口的**持久化端口**（W5-B，2026-10-20）。
 *
 * ── 为什么只有两条动作 ──────────────────────────────────────────────────
 *   · 「新增心愿」`add_wish`：矩阵里孩子 = REQUIRE_APPROVAL、家长 = ALLOW。
 *     家长走本端口**直写**；孩子的请求由 `POST /approvals`（`snapshotAddWish`）承载，
 *     批准时由 `approvals.prisma.repository` 里的执行器落库 —— 同一个 `Wish` 表，
 *     两条入口，**不变量只有一处需要守**：配色不与活动心愿撞（`pickCoverStyle`）。
 *   · 「删除心愿」`delete_wish`：软删（`status='deleted'` + `deletedAt`，与修 C9 同口径）。
 *     这里**不**碰账本：心愿只是「想要的东西」，删掉它不产生任何积分变动。
 *   · 「兑换」**不在本端口**：它必须写流水 + 改余额 + 标记 `redeemed`，
 *     那是 `POST /approvals`（action=`redeem`）的事 —— 见 `approvals` 模块。
 *     把它们并进来会得到第二个「扣分入口」，I2/I4 立刻裂开。
 *
 * ── 判据在哪一层 ────────────────────────────────────────────────────────
 *   · 权限：`PERMISSION_MATRIX` + `PermissionsGuard`（本端口不判角色能做什么）；
 *   · 形状（标题非空、积分区间、emoji）：DTO + `WishesService`；
 *   · 库层事实（孩子是否存在/软删、心愿是否属于该孩子、是否已软删、配色空档）：
 *     只有持库连接的人能回答，故在本端口里判。
 */

export const WISHES_REPOSITORY = Symbol('WISHES_REPOSITORY')

/** 新增心愿：`coverStyle` **不由调用方指定** —— 由库层按空档/哈希算出（03 E16）。 */
export interface CreateWishInput {
  childId: string
  title: string
  /** 1..100000（与 `snapshotAddWish` 的 DTO 同区间）。 */
  cost: number
  emoji: string
  operatorUserId: string
  operatorRole: MemberRole
}

export interface DeleteWishInput {
  childId: string
  wishId: string
  operatorUserId: string
  operatorRole: MemberRole
}

export interface WishesPort {
  /**
   * 新增心愿（含配色落定 + 审计，同一事务）。
   *
   * 失败语义：404 `CHILD_NOT_FOUND`（孩子不存在 / 已软删）。
   */
  createWish(input: CreateWishInput): Promise<WishRow>

  /**
   * 软删心愿（`status=deleted` + `deletedAt`），**不删**历史流水的 `wishId` 回指。
   *
   * 幂等语义：已删除的同一心愿再删一次 ⇒ 原样返回，不再写第二条审计。
   * 失败语义：404 `WISH_NOT_FOUND`（含跨孩子 —— 跨孩子一律按不存在回答）。
   */
  deleteWish(input: DeleteWishInput): Promise<string>
}

/**
 * 无库装配的默认实现：**每个方法都 501**。
 * ★ 不返回假心愿、不改内存 —— 那会让「没落库」看起来像「已经加好了」。
 */
@Injectable()
export class NotImplementedWishesRepository implements WishesPort {
  async createWish(): Promise<WishRow> {
    throw new NotImplementedException({
      code: 'WISHES_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '心愿写入尚未接线（无数据库装配）—— 拒绝假装成功：孩子会以为心愿已经在列表里了。' +
        '请配置 DATABASE_URL 后重启（判据只有 prisma/database-enabled.ts 一处）。'
    })
  }

  async deleteWish(): Promise<string> {
    throw new NotImplementedException({
      code: 'WISHES_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '心愿删除尚未接线（无数据库装配）—— 拒绝假装成功：家长会以为心愿已经移入回收站。' +
        '请配置 DATABASE_URL 后重启（判据只有 prisma/database-enabled.ts 一处）。'
    })
  }
}

/**
 * 屏障一 · 成员资格门 —— **判定内核**（docs/design/02 §3）
 *
 * 回答一句话：**这个人跟这个孩子，有没有关系？**
 *
 *     (childId, userId) 的成员位  →  本内核  →  ALLOW（带着那一行）| DENY（MEMBER_NOT_FOUND / MEMBER_REMOVED）
 *
 * ── 为什么它必须独立成第一道（而不是塞进矩阵）──────────────────────────────
 *   权限矩阵是「角色 × 动作」，前提是**先有角色**。若把资格判定混进矩阵，
 *   非成员会被当成「未知角色」，判定语义就模糊了 —— 403 到底是"矩阵拒绝这个角色"
 *   还是"你根本不是这个家的人"？这两件事对客户端、对排查、对审计的含义完全不同。
 *
 * ── 口径逐字对齐 02 §3 / §9.21 ────────────────────────────────────────────
 *     ChildMember(childId, userId).status === 'active' ？
 *     ✗ → 403 MEMBER_NOT_FOUND / MEMBER_REMOVED
 *
 * ★ 本文件是**纯函数**：不碰 HTTP、不碰数据库、不构造 `Actor`。
 *   查询归端口（`membership.repository.ts`），翻成 HTTP 归守卫（`membership.guard.ts`）——
 *   于是"判定"可以离线穷举（`test/membership-gate.test.ts`），"装配"由 HTTP 用例钉住
 *   （`test/membership-http.test.ts`）。两者分开，才不会互相冒充证据。
 *
 * ── ★ 资格与形状是**两件事**，刻意分开 ──────────────────────────────────
 *   · `status` / 有没有那一行        → **资格**（本文件）→ 判定 → **403**
 *   · `restrictions` 是不是合法形状  → **数据形状**（裸 `Json`！）→ 校验失败 → **500**
 *   混在一起的后果很具体：库里某个孩子的 `restrictions` 写坏了（D3b 的典型病：
 *   `childCannotAddWish` 拼成 `childCannotAddwis`），会表现为"你没有权限"，
 *   于是被当成权限问题排查很久 —— 而真正的病在**数据**。500 让这两种病分得开。
 */

import {
  validateRestrictions,
  type ChildMemberRestrictions
} from '../contracts/member-restrictions'
import type { Role } from '../contracts/permission-matrix'

/**
 * 端口返回的**原始**行 —— `restrictions` 故意是 `unknown`：
 * 它来自 Prisma 的裸 `Json` 列，**形状未经验证**，不许直接当类型用。
 */
export interface MembershipLookupRow {
  childId: string
  userId: string
  /** 原始 `MemberRole` 字符串 —— 形状校验在 `toMembership()`，不进判定。 */
  role: string
  /** 原始 `MemberStatus` 字符串。 */
  status: string
  /** 裸 `Json`（`@default("{}")`）。 */
  restrictions: unknown
}

/** 校验通过的成员位 —— 屏障三（成员级收紧）的输入。 */
export interface Membership {
  childId: string
  userId: string
  role: Role
  /** ★ 已通过 `validateRestrictions()`：从这里出去就可以当类型用了。 */
  restrictions: ChildMemberRestrictions
}

/** 屏障一的两条拒绝码（`02` §3：`MEMBER_NOT_FOUND` / `MEMBER_REMOVED`）。 */
export type MembershipDenial = 'MEMBER_NOT_FOUND' | 'MEMBER_REMOVED'

export type MembershipVerdict =
  | { kind: 'ALLOW'; row: MembershipLookupRow }
  | { kind: 'DENY'; code: MembershipDenial }

/**
 * 屏障一的判定（纯函数，可穷举）。
 *
 * 两条 fail-closed：
 *   ① **`null` ⇒ `MEMBER_NOT_FOUND`** —— 查不到不是异常，但**绝不是"那就放行吧"**。
 *      这是本仓库的头号教训：一个"查不到就跳过"的分支，等于把整道屏障变成可选。
 *   ② **任何非 `active` 的状态 ⇒ `MEMBER_REMOVED`** —— 包括将来新增的状态。
 *      「不认识的状态」**不等于**「有效资格」；将来若加状态，必须在 `02` §3 与这里同时登记。
 */
export function resolveMembership(row: MembershipLookupRow | null): MembershipVerdict {
  if (row === null) return { kind: 'DENY', code: 'MEMBER_NOT_FOUND' }
  if (row.status !== 'active') return { kind: 'DENY', code: 'MEMBER_REMOVED' }
  return { kind: 'ALLOW', row }
}

/**
 * 形状问题（**不是**权限判定）的专用错误。
 *
 * 为什么要有自己的类型：守卫要把它翻成 **500 + 具体 code**，而其它异常（网络 / 连接池）
 * 不该被同一段代码吞掉 —— `instanceof` 是这里唯一能区分"数据坏了"与"依赖挂了"的东西。
 */
export class MemberRowShapeError extends Error {
  constructor(
    readonly code: 'INVALID_MEMBER_ROLE' | 'INVALID_MEMBER_RESTRICTIONS',
    message: string
  ) {
    super(message)
    this.name = 'MemberRowShapeError'
  }
}

/**
 * 形状把关（fail-closed）：把**原始行**变成可用的 `Membership`。
 *
 * ★ 两处校验的必要性（都不许省）：
 *   ① `role` 必须是 `guardian | child` —— `RemoteRole` 之外的值（例如 `viewer`）
 *      会让**屏障二**的矩阵查不到列；这里拦下，报"数据角色非法"，而不是让它去矩阵里
 *      变成一次语义模糊的 `DENY`。
 *   ② `restrictions` 必须过 `validateRestrictions()`（D3b 的唯一权威守卫）——
 *      **这是 `validateRestrictions()` 的第一个真实调用方**：在此之前它只有离线闸门
 *      （`npm run restrictions:check`）在调，请求路径上从来没人查过。裸 `Json` 的病
 *      （键名拼错、类型不对、多余键）正是在**读**的时候才最危险：限制会**静默失效**。
 */
export function toMembership(row: MembershipLookupRow): Membership {
  if (row.role !== 'guardian' && row.role !== 'child') {
    throw new MemberRowShapeError(
      'INVALID_MEMBER_ROLE',
      `成员位上的角色非法：${JSON.stringify(row.role)}（MemberRole 只有 guardian / child）。` +
        `childId=${row.childId} userId=${row.userId} —— 这是**数据/实现**的问题，不是权限问题，故 500 而不是 403。`
    )
  }

  const errors = validateRestrictions(row.restrictions)
  if (errors.length > 0) {
    throw new MemberRowShapeError(
      'INVALID_MEMBER_RESTRICTIONS',
      `成员位的 restrictions 形状非法（childId=${row.childId} userId=${row.userId}）：` +
        `${errors.join('；')}。` +
        '★ 这里**不能**当成"没有限制"继续 —— 那样一条写坏的限制会静默失效，' +
        '正是 D3b 要防的失败形态（形状=集合封闭，多余键也拒，见 member-restrictions.ts）。'
    )
  }

  return {
    childId: row.childId,
    userId: row.userId,
    role: row.role,
    restrictions: row.restrictions as ChildMemberRestrictions
  }
}

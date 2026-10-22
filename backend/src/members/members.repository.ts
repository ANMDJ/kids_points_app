import { Injectable, NotImplementedException } from '@nestjs/common'
import type { MemberRole } from '@prisma/client'

import type { MutableMemberRole, MemberRow } from './members.types'

/**
 * 成员管理的**持久化端口**（W5-H，2026-10-22）
 *
 * ── 三个方法对应三条路由，不多不少 ──────────────────────────────────────────
 *   `listActiveMembers` / `changeMemberRole` / `removeMember`。
 *   没有 `findMember()`：一旦对外暴露"只查不判"，下一个人就会写成
 *   「先查人数 → 再决定能不能降级」—— 那正是**并发下漏掉最后一位家长**的经典写法
 *   （见 `members.prisma.repository.ts` 的串行化说明）。
 *
 * ── 判据在哪一层 ────────────────────────────────────────────────────────────
 *   · 权限：`PERMISSION_MATRIX.view_members` / `change_member_role` / `remove_member`；
 *   · 形状：DTO（`role` 只能 child / guardian）；
 *   · 业务事实（"这是最后一位家长吗" / "这行还是 active 吗" / "这是我吗"）：
 *     **适配器** —— 需要库里的事实、且必须与写入在同一条事务里回答；
 *   · 原子性：只有持库连接的人能保证 ⇒ 适配器。
 */
export const MEMBERS_REPOSITORY = Symbol('MEMBERS_REPOSITORY')

export interface ChangeMemberRoleInput {
  /** 由身份 Guard 从会话解析 —— **绝不**取请求体。 */
  childId: string
  /** `ChildMember.id`（路径参数）。 */
  memberId: string
  /** 目标角色（已由 DTO 收敛到 child / guardian）。 */
  role: MutableMemberRole
  operatorUserId: string
  operatorRole: MemberRole
  /** 审计要记"从哪台设备改的"（与 `switch_role_mode` 同口径）；缺省时记 null。 */
  deviceId: string | null
}

export interface ChangeMemberRoleResult {
  member: MemberRow
  /**
   * 这一次调用**真的改变了角色**吗？
   *
   * `false` 有两种情况：目标角色本来就等于 `role`（幂等 no-op；不写审计），
   * 或——将来可能的——没有变化。服务层据此告诉调用方"没发生什么"，
   * 而不是让 200 假装一切都被改了一遍。
   */
  changed: boolean
}

export interface RemoveMemberInput {
  childId: string
  memberId: string
  operatorUserId: string
  operatorRole: MemberRole
  deviceId: string | null
}

export interface RemoveMemberResult {
  memberId: string
  removedAt: Date
  /**
   * 这一行**之前就已经是** `removed` 吗（构造幂等：同一个 200，不写第二条审计）。
   * 与 `POST /invites/:id/revoke` 的"再吊销一次"同一条纪律。
   */
  alreadyRemoved: boolean
}

export interface MembersPort {
  /** 只回 `active` 的成员位（被移出的历史留在库里，不在列表里）。 */
  listActiveMembers(childId: string): Promise<MemberRow[]>
  changeMemberRole(input: ChangeMemberRoleInput): Promise<ChangeMemberRoleResult>
  removeMember(input: RemoveMemberInput): Promise<RemoveMemberResult>
}

/**
 * 无库装配：三个方法**全部 501**。
 *
 * 绝不返回空列表 —— 那会被读成「这个家庭只有我一个人」，而真实情况是
 * 「根本没连库」。也绝不假装改成功：角色/状态都不存在下一次请求就会打回原样，
 * 比当场说「没落库」难排查得多（与 `NotImplementedInvitesRepository` 同一口径）。
 */
@Injectable()
export class NotImplementedMembersRepository implements MembersPort {
  async listActiveMembers(_childId: string): Promise<MemberRow[]> {
    throw this.notImplemented('列出家庭成员')
  }

  async changeMemberRole(_input: ChangeMemberRoleInput): Promise<ChangeMemberRoleResult> {
    throw this.notImplemented('修改成员角色')
  }

  async removeMember(_input: RemoveMemberInput): Promise<RemoveMemberResult> {
    throw this.notImplemented('移出成员')
  }

  private notImplemented(what: string): NotImplementedException {
    return new NotImplementedException({
      code: 'MEMBERS_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        `当前装配没有数据库连接：${what}无处落库，拒绝假装成功。` +
        '请配置 DATABASE_URL 后重试。'
    })
  }
}

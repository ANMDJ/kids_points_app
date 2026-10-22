import { Injectable, NotImplementedException } from '@nestjs/common'
import type { MemberRole } from '@prisma/client'

/**
 * 孩子档案写入的**持久化端口**（W5-E，2026-10-21）。
 *
 * ── 为什么只有一个方法 ──────────────────────────────────────────────────────
 *   `edit_child_profile` 在权限矩阵里早已存在（仅 guardian ALLOW），但一直没有
 *   端点。本轮只兑现**昵称**：它是「我的」页唯一能改、且改了必须落库的字段。
 *   头像 / 生日 / 成员增删留给后续轮次 —— 端口不预先编造没人调用的方法。
 *
 * ── 判据在哪一层 ────────────────────────────────────────────────────────────
 *   · 权限：`PERMISSION_MATRIX.edit_child_profile` + `PermissionsGuard`（孩子 403）；
 *   · 形状 / 长度：DTO + `ChildrenService`（端口只收已 trim、已限长的 `name`）；
 *   · 库层事实（孩子是否还存在 / 是否已被软删）：只有持库连接的人能回答 ⇒ 端口里判。
 */
export const CHILDREN_REPOSITORY = Symbol('CHILDREN_REPOSITORY')

export interface RenameChildInput {
  /** 由身份 Guard 从会话解析 —— **绝不**取请求体。 */
  childId: string
  /** 已 trim、已按码点校验过的昵称。 */
  name: string
  operatorUserId: string
  operatorRole: MemberRole
}

/** 改名的回包行；与 `PATCH /child` 的响应同构（客户端不需要再读一次 `/home`）。 */
export interface ChildProfileRow {
  childId: string
  name: string
}

export interface ChildrenPort {
  renameChild(input: RenameChildInput): Promise<ChildProfileRow>
}

/**
 * 无库装配：**显式 501**，绝不假装改名成功。
 *
 * 与 `NotImplementedRulesRepository` 同一手法 —— 静默 no-op 会让界面显示一个
 * 只存在于内存里的新昵称，刷新后又变回去（这正是 W4 反复修的「假成功」）。
 */
@Injectable()
export class NotImplementedChildrenRepository implements ChildrenPort {
  async renameChild(_input: RenameChildInput): Promise<ChildProfileRow> {
    throw new NotImplementedException({
      code: 'CHILDREN_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        '当前装配没有数据库连接：`PATCH /child` 无处落库，拒绝假装改名成功。' +
        '请配置 DATABASE_URL 后重试。'
    })
  }
}

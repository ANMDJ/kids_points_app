import { Injectable, NotImplementedException } from '@nestjs/common'
import type { MemberRole } from '@prisma/client'

import type {
  InviteRole,
  InviteRow,
  InviteRevokeResponse
} from './invites.types'

/**
 * 邀请码的**持久化端口**（W5-G，2026-10-22）
 *
 * ── 四个方法对应四条路由，不多不少 ──────────────────────────────────────────
 *   `createInvite` / `listInvites` / `revokeInvite` / `acceptInvite`。
 *   没有 `findByCode()`：邀请码的校验**必须**和占位在同一条语句里，
 *   对外暴露一个「只查不占」的方法，就是给下一个人留一个 TOCTOU 入口（02 §8）。
 *
 * ── 判据在哪一层 ────────────────────────────────────────────────────────────
 *   · 权限：`PERMISSION_MATRIX.invite_member`（guardian ALLOW / child DENY）；
 *   · 形状：DTO（`role` / `maxUses` / `expiresInDays` / `code`）；
 *   · 业务值（天 → 毫秒、`ALREADY_MEMBER`、`DEVICE_SESSION_CONFLICT`）：
 *     `InvitesService` 与适配器 —— 需要库里的事实才能回答的那部分在适配器；
 *   · 原子性：**只有持库连接的人**能保证 ⇒ 适配器。
 */
export const INVITES_REPOSITORY = Symbol('INVITES_REPOSITORY')

export interface CreateInviteInput {
  /** 由身份 Guard 从会话解析 —— **绝不**取请求体。 */
  childId: string
  role: InviteRole
  maxUses: number
  /** 已由 Service 把「天」换算成绝对时刻（库与应用对「现在」的理解只保留一处）。 */
  expiresAt: Date
  operatorUserId: string
  operatorRole: MemberRole
}

export interface RevokeInviteInput {
  childId: string
  inviteId: string
  operatorUserId: string
  operatorRole: MemberRole
}

export interface AcceptInviteInput {
  /** **已规范化**的裸码（8 位大写，无连字符/空格）。 */
  code: string
  /** 被邀请人：来自身份 Guard 的会话，不是请求体。 */
  userId: string
  /** 本设备：加入后要在这台设备上签发会话。 */
  deviceId: string
  /** 会话到期的绝对时刻（Service 用 `INVITE_SESSION_TTL_MS` 算）。 */
  sessionExpiresAt: Date
}

/** 加入成功的结果：成员位已 active、会话已就绪。 */
export interface AcceptedInviteRow {
  childId: string
  role: InviteRole
  sessionExpiresAt: Date
}

export interface InvitesPort {
  createInvite(input: CreateInviteInput): Promise<InviteRow>
  listInvites(childId: string): Promise<InviteRow[]>
  revokeInvite(input: RevokeInviteInput): Promise<InviteRevokeResponse>
  acceptInvite(input: AcceptInviteInput): Promise<AcceptedInviteRow>
}

/**
 * 无库装配：四个方法**全部 501**。
 *
 * 绝不返回空列表（那会被读成「这个孩子还没有任何邀请码」，进而生成第二个
 * 一模一样的码），也不假装加入成功（成员位与会话都不存在，下一次请求就 401
 * —— 比当场说「没落库」难排查得多）。
 */
@Injectable()
export class NotImplementedInvitesRepository implements InvitesPort {
  async createInvite(_input: CreateInviteInput): Promise<InviteRow> {
    throw this.notImplemented('创建邀请码')
  }

  async listInvites(_childId: string): Promise<InviteRow[]> {
    throw this.notImplemented('列出邀请码')
  }

  async revokeInvite(_input: RevokeInviteInput): Promise<InviteRevokeResponse> {
    throw this.notImplemented('吊销邀请码')
  }

  async acceptInvite(_input: AcceptInviteInput): Promise<AcceptedInviteRow> {
    throw this.notImplemented('用邀请码加入')
  }

  private notImplemented(what: string): NotImplementedException {
    return new NotImplementedException({
      code: 'INVITES_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        `当前装配没有数据库连接：${what}无处落库，拒绝假装成功。` +
        '请配置 DATABASE_URL 后重试。'
    })
  }
}

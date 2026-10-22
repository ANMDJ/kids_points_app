import { BadRequestException, Inject, Injectable } from '@nestjs/common'

import type { Actor } from '../permissions/actor'
import {
  INVITE_CODE_LENGTH,
  INVITE_SESSION_TTL_MS,
  isWellFormedInviteCode,
  normalizeInviteCode
} from './invite-code'
import type { AcceptInviteDto } from './dto/accept-invite.dto'
import type { CreateInviteDto } from './dto/create-invite.dto'
import { INVITES_REPOSITORY, type InvitesPort } from './invites.repository'
import type {
  InviteAcceptResponse,
  InviteCodeDto,
  InviteListResponse,
  InviteRevokeResponse,
  InviteRow
} from './invites.types'

/** 一天的毫秒 —— 「有效期 N 天」→ 绝对时刻只在这里换算一次。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 邀请码的**业务层**（W5-G，2026-10-22）。
 *
 * 只做三件事：
 *   ① 把 `expiresInDays` / TTL 换算成**绝对时刻**（`Date` 只在这一层与端口之间流动）；
 *   ② 规范化并校验用户输入的码（唯一判据在 `invite-code.ts`）；
 *   ③ 把端口行映射成 HTTP 契约（`Date` → ISO 串）。
 *
 * ★ 这里**不**判断「码还能不能用」—— 那必须和占位在同一条 SQL 里完成
 *   （02 §8），在服务层先查一次就等于重新引入 TOCTOU。
 * ★ 这里**也**不判断「这个孩子还在不在」—— 同样是为了不把存在性判断
 *   放到锁外（适配器在事务里用 `status='active'` 回答）。
 */
@Injectable()
export class InvitesService {
  constructor(@Inject(INVITES_REPOSITORY) private readonly repository: InvitesPort) {}

  async createInvite(
    childId: string,
    dto: CreateInviteDto,
    actor: Actor
  ): Promise<InviteCodeDto> {
    const row = await this.repository.createInvite({
      childId,
      role: dto.role,
      maxUses: dto.maxUses,
      // 「N 天后过期」由服务端换算：客户端只说想要多久，不说具体到哪一刻。
      expiresAt: new Date(Date.now() + dto.expiresInDays * DAY_MS),
      operatorUserId: actor.userId,
      operatorRole: actor.role
    })
    return toInviteCodeDto(row)
  }

  async listInvites(childId: string): Promise<InviteListResponse> {
    const rows = await this.repository.listInvites(childId)
    return { items: rows.map(toInviteCodeDto) }
  }

  async revokeInvite(
    childId: string,
    inviteId: string,
    actor: Actor
  ): Promise<InviteRevokeResponse> {
    return await this.repository.revokeInvite({
      childId,
      inviteId,
      operatorUserId: actor.userId,
      operatorRole: actor.role
    })
  }

  async acceptInvite(
    dto: AcceptInviteDto,
    actor: Actor,
    deviceId: string
  ): Promise<InviteAcceptResponse> {
    // 用户会把码抄成 `abcd-efgh` / `ABCD EFGH` / 前后带空格 —— 这些都在这里
    // 归一化（一份实现），**不**在 DTO 里偷偷改写输入。
    const code = normalizeInviteCode(dto.code)

    if (!isWellFormedInviteCode(code)) {
      // 形状不对是**客户端/输入**问题（400），不是「码不可用」（409）：
      // 把「少输了一位」说成「邀请码已失效」会让人去找家长重发，
      // 而他其实只是抄漏了一位。
      throw new BadRequestException({
        code: 'INVITE_CODE_MALFORMED',
        message:
          `邀请码是 ${INVITE_CODE_LENGTH} 位字母数字（不含容易认错的 0/O/1/I/L），` +
          `收到的是「${dto.code.trim()}」。请检查是否抄漏或抄错了字符。`
      })
    }

    const row = await this.repository.acceptInvite({
      code,
      userId: actor.userId,
      deviceId,
      sessionExpiresAt: new Date(Date.now() + INVITE_SESSION_TTL_MS)
    })

    return {
      childId: row.childId,
      role: row.role,
      sessionExpiresAt: row.sessionExpiresAt.toISOString()
    }
  }
}

/** 端口行 → 线格式：时间一律 ISO 串（与 `GET /trash` 的 `deletedAt` 同口径）。 */
function toInviteCodeDto(row: InviteRow): InviteCodeDto {
  return {
    id: row.id,
    code: row.code,
    role: row.role,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt.toISOString(),
    revoked: row.revoked,
    createdAt: row.createdAt.toISOString()
  }
}

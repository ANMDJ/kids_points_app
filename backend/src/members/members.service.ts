import { Inject, Injectable } from '@nestjs/common'

import type { Actor } from '../permissions/actor'
import type { UpdateMemberRoleDto } from './dto/update-member-role.dto'
import { MEMBERS_REPOSITORY, type MembersPort } from './members.repository'
import type {
  MemberDto,
  MemberListResponse,
  MemberRemoveResponse,
  MemberRow
} from './members.types'

/**
 * 成员管理的**业务层**（W5-H，2026-10-22）。
 *
 * 只做三件事：
 *   ① 把端口行映射成 HTTP 契约（`Date` → ISO 串）；
 *   ② 标出 `isSelf`（**只有服务端知道**"你是谁"，见 `members.types.ts`）；
 *   ③ 把 actor 的身份与设备 id 透传给端口（审计用）。
 *
 * ★ 这里**不**判断「是不是最后一位家长」「是不是自己」—— 那两件事都需要
 *   库里的事实，并且必须与写入在同一条事务里回答（适配器）。
 *   在服务层先查一次再写，就重新引入了并发漏洞（02 §8 的同一条纪律）：
 *   两个家长同时把对方降级，"先查后改"会让两个请求都看到"还有 2 位家长"。
 */
@Injectable()
export class MembersService {
  constructor(@Inject(MEMBERS_REPOSITORY) private readonly repository: MembersPort) {}

  async listMembers(childId: string, actor: Actor): Promise<MemberListResponse> {
    const rows = await this.repository.listActiveMembers(childId)
    return { items: rows.map((row) => toMemberDto(row, actor.userId)) }
  }

  async changeMemberRole(
    childId: string,
    memberId: string,
    dto: UpdateMemberRoleDto,
    actor: Actor,
    deviceId: string | null
  ): Promise<MemberDto> {
    const result = await this.repository.changeMemberRole({
      childId,
      memberId,
      role: dto.role,
      operatorUserId: actor.userId,
      operatorRole: actor.role,
      deviceId
    })
    return toMemberDto(result.member, actor.userId)
  }

  async removeMember(
    childId: string,
    memberId: string,
    actor: Actor,
    deviceId: string | null
  ): Promise<MemberRemoveResponse> {
    const result = await this.repository.removeMember({
      childId,
      memberId,
      operatorUserId: actor.userId,
      operatorRole: actor.role,
      deviceId
    })
    return {
      memberId: result.memberId,
      status: 'removed',
      removedAt: result.removedAt.toISOString()
    }
  }
}

/** 端口行 → 线格式：时间一律 ISO 串（与 `GET /invites` 同口径）。 */
function toMemberDto(row: MemberRow, selfUserId: string): MemberDto {
  return {
    memberId: row.memberId,
    userId: row.userId,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    joinedAt: row.joinedAt.toISOString(),
    removedAt: row.removedAt === null ? null : row.removedAt.toISOString(),
    isSelf: row.userId === selfUserId
  }
}

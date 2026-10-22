import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import type { MemberRole } from '@prisma/client'

import {
  CHILDREN_REPOSITORY,
  type ChildrenPort
} from './children.repository'
import type { UpdateChildProfileDto } from './dto/update-child-profile.dto'

/**
 * 昵称上限 —— **唯一**的业务判据，在 `renameChild()` 里按**码点**数。
 *
 * 双端输入框那侧只做两件事：trim + 拒空（Flutter 的 `maxLength: 16` 只是输入框
 * 计数器，小程序干脆不截断）。长度规则只留一份：客户端判一遍、服务端再判一遍，
 * 两套数法（UTF-16 code unit vs 码点 vs grapheme）迟早会不一致。
 */
export const MAX_CHILD_NAME_LENGTH = 16

/** 请求里的操作人 —— 由 Controller 从已鉴权的会话里取，**绝不**读请求体。 */
export interface ChildOperator {
  userId: string
  role: MemberRole
}

/** `PATCH /child` 的响应；客户端据此直接更新档案，不必再拉一次 `/home`。 */
export interface ChildProfileDto {
  childId: string
  name: string
}

/**
 * 孩子档案写入的**业务层**（W5-E，2026-10-21）。
 *
 * 只做两件事：
 *   ① 规范化（trim）与校验（非空 / ≤16 个字符）—— 唯一判据点；
 *   ② 把端口行映射成 HTTP 契约 `{ childId, name }`。
 *
 * ★ 不在这里查库判断「孩子还在不在」—— 那是 TOCTOU；存在性由持库的行锁回答。
 * ★ DTO 层已经有 `MinLength(1)`，但 `"   "` 能过 DTO（长度是 3）而 trim 后为空，
 *   所以非空判定必须在这里再做一次，否则会往库里写一个空白昵称。
 */
@Injectable()
export class ChildrenService {
  constructor(
    @Inject(CHILDREN_REPOSITORY) private readonly repository: ChildrenPort
  ) {}

  async renameChild(
    childId: string,
    dto: UpdateChildProfileDto,
    operator: ChildOperator
  ): Promise<ChildProfileDto> {
    const name = dto.name.trim()

    if (name === '') {
      throw new BadRequestException({
        code: 'CHILD_NAME_EMPTY',
        message: '昵称不能为空（去掉首尾空格后没有内容），这次没有保存。'
      })
    }

    // 按**码点**数，而不是 UTF-16 code unit：一个 emoji 是 1 个字符。
    const length = Array.from(name).length
    if (length > MAX_CHILD_NAME_LENGTH) {
      throw new BadRequestException({
        code: 'CHILD_NAME_TOO_LONG',
        message: `昵称最多 ${MAX_CHILD_NAME_LENGTH} 个字符（表情按 1 个算），收到 ${length} 个。`
      })
    }

    const row = await this.repository.renameChild({
      childId,
      name,
      operatorUserId: operator.userId,
      operatorRole: operator.role
    })
    return { childId: row.childId, name: row.name }
  }
}

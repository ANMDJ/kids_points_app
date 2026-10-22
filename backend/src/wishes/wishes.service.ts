import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import type { MemberRole } from '@prisma/client'

import type { WishDto } from '../read/read.mapper'
import type { WishRow } from '../read/read.repository'
import type { CreateWishDto } from './dto/create-wish.dto'
import {
  WISHES_REPOSITORY,
  type CreateWishInput,
  type DeleteWishInput,
  type WishesPort
} from './wishes.repository'

/** 请求里的操作人 —— 由 Controller 从已鉴权的会话里取，**绝不**读请求体。 */
export interface WishOperator {
  userId: string
  role: MemberRole
}

/** 缺省表情：与双端「没选图标」时的占位一致（`🎁`）。 */
export const DEFAULT_WISH_EMOJI = '🎁'

/** 积分区间：与 `CreateWishDto` / `CreateApprovalRequestDto.cost` 同一区间。 */
const WISH_COST_MIN = 1
const WISH_COST_MAX = 100_000

/**
 * 心愿写入的**业务层**（W5-B，2026-10-20）。
 *
 * 只做三件事（与 `RulesService` 同一分工）：
 *   ① 规范化客户端输入（标题去首尾空白、表情缺省）—— 唯一一处；
 *   ② 防御性校验（DTO 已经挡过一遍；绕过 HTTP 直接调 service 也必须安全）；
 *   ③ 把行形状映射成与只读端点**同一份** `WishDto`（客户端无需区分数据从哪来）。
 *
 * ★ 不在这里查库判断「配色是否撞」/「心愿是否还存在」—— 那是 TOCTOU。
 *   集合级事实必须由持库的 `wishes.prisma.repository` 在事务里判。
 */
@Injectable()
export class WishesService {
  constructor(@Inject(WISHES_REPOSITORY) private readonly repository: WishesPort) {}

  async createWish(
    childId: string,
    dto: CreateWishDto,
    operator: WishOperator
  ): Promise<WishDto> {
    const title = normalizeWishTitle(dto.title)
    assertWishCost(dto.cost)
    const emoji = normalizeWishEmoji(dto.emoji)

    const input: CreateWishInput = {
      childId,
      title,
      cost: dto.cost,
      emoji,
      operatorUserId: operator.userId,
      operatorRole: operator.role
    }
    return toWishDto(await this.repository.createWish(input))
  }

  async deleteWish(
    childId: string,
    wishId: string,
    operator: WishOperator
  ): Promise<{ wishId: string }> {
    const id = normalizeWishId(wishId)
    const input: DeleteWishInput = {
      childId,
      wishId: id,
      operatorUserId: operator.userId,
      operatorRole: operator.role
    }
    return { wishId: await this.repository.deleteWish(input) }
  }
}

/** 行 → 响应（与 `read.mapper.ts` 的 `WishDto` 字段一一对应）。 */
function toWishDto(row: WishRow): WishDto {
  return {
    id: row.id,
    title: row.title,
    cost: row.cost,
    emoji: row.emoji,
    coverStyle: row.coverStyle,
    redeemed: row.redeemed
  }
}

/** 标题：去首尾空白后必须非空（全空白标题在列表上是「看不见的一张卡」）。 */
function normalizeWishTitle(raw: string): string {
  const title = raw.trim()
  if (title === '') {
    throw new BadRequestException({
      code: 'WISH_TITLE_REQUIRED',
      message: '心愿名称不能为空（全是空白字符也不算）。'
    })
  }
  return title
}

/** 表情：空串/缺省 → `🎁`（与双端本地实现同口径，而不是存一个空字符串）。 */
function normalizeWishEmoji(raw: string | undefined): string {
  const emoji = (raw ?? '').trim()
  return emoji === '' ? DEFAULT_WISH_EMOJI : emoji
}

function assertWishCost(cost: number): void {
  if (!Number.isInteger(cost) || cost < WISH_COST_MIN || cost > WISH_COST_MAX) {
    throw new BadRequestException({
      code: 'WISH_COST_INVALID',
      message: `心愿所需积分必须是 ${WISH_COST_MIN}..${WISH_COST_MAX} 的整数（收到 ${cost}）。`
    })
  }
}

function normalizeWishId(raw: string): string {
  const id = raw.trim()
  if (id === '' || id.length > 64) {
    throw new BadRequestException({
      code: 'WISH_ID_INVALID',
      message: '心愿 id 必须是 1..64 字符（cuid 尺度）。'
    })
  }
  return id
}

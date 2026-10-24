import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type { DeviceTokensPort } from './device-tokens.repository'
import {
  MAX_ACTIVE_TOKENS_PER_USER,
  type ActivePushToken,
  type DeviceTokenRow,
  type RegisterDeviceTokenInput,
  type RegisterDeviceTokenResult,
  type RevokeDeviceTokenResult
} from './device-tokens.types'

/**
 * 设备推送 token 端口的 **Prisma 适配器**（W6-A，2026-10-24）。
 *
 * ── 这一层只回答「行怎么读 / 写」，不回答「谁能做」───────────────────────────
 *   谁能做 ⇒ 矩阵 `manage_device_tokens`；做的是谁 ⇒ 会话 actor（controller 传入）。
 *   归属冲突 ⇒ 这里回答 `owned_by_other`（只有库知道这个 token 现在属于谁）。
 *
 * ── 四个口径，写下来免得后来者「优化」掉 ────────────────────────────────────
 *   ① **`token` 是唯一键，冲突即「别人的」**：一个 token 换主人不能让后一次注册
 *      悄悄接管前一个账号的推送。冲突用 `P2002` 兜住并发，不靠「先查后写」。
 *   ② **注销是条件 UPDATE**（`where: { id, active: true }`）：两个并发注销只有
 *      第一条写 `revokedAt`，第二条回读到的就是第一次的值 ⇒ 幂等是**结构性的**，
 *      不是「代码里记得 if」。
 *   ③ **`lastSeenAt` 每次注册都刷新**，并据此做 LRU 淘汰（最多 10 条）：
 *      网关每次要收全部 token，不设上限就成了放大器入口。
 *   ④ **`childId` 只是记录**（`SetNull`）：它不是收口条件，推送按 `userId`。
 *      孩子换档案不需要重新上报 token。
 */
const DEVICE_TOKEN_SELECT = {
  id: true,
  platform: true,
  active: true,
  lastSeenAt: true,
  createdAt: true,
  revokedAt: true
} as const

@Injectable()
export class PrismaDeviceTokensRepository implements DeviceTokensPort {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: RegisterDeviceTokenInput): Promise<RegisterDeviceTokenResult> {
    const existing = await this.prisma.deviceToken.findUnique({
      where: { token: input.token },
      select: { id: true, userId: true }
    })

    if (existing !== null) {
      // 见文件头 ①：先判归属，再刷新 —— 别人的 token 一个字节都不改。
      if (existing.userId !== input.userId) return { kind: 'owned_by_other' }
      return { kind: 'ok', row: await this.refresh(existing.id, input), created: false }
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.deviceToken.create({
          data: {
            userId: input.userId,
            childId: input.childId,
            platform: input.platform,
            token: input.token
          },
          select: DEVICE_TOKEN_SELECT
        })
        // 见文件头 ③：把超出上限的最旧行标成失效（与创建同一事务）。
        await this.evictOverflow(tx, input.userId)
        return created
      })
      return { kind: 'ok', row: row as DeviceTokenRow, created: true }
    } catch (error) {
      // 并发注册同一个 token：唯一约束是这里唯一可信的判据。
      if (!isUniqueViolation(error)) throw error
      const winner = await this.prisma.deviceToken.findUnique({
        where: { token: input.token },
        select: { id: true, userId: true }
      })
      // 极端情况：赢家在两次查询之间被删了 ⇒ 让调用方重试，而不是编一个结果。
      if (winner === null) throw error
      if (winner.userId !== input.userId) return { kind: 'owned_by_other' }
      return { kind: 'ok', row: await this.refresh(winner.id, input), created: false }
    }
  }

  async revoke(input: {
    userId: string
    token: string
  }): Promise<RevokeDeviceTokenResult> {
    const existing = await this.prisma.deviceToken.findUnique({
      where: { token: input.token },
      select: { ...DEVICE_TOKEN_SELECT, userId: true }
    })
    // 不是我的 = **不存在**（同 `Notification` 的 404 口径：区分两者等于给出探测口）。
    if (existing === null || existing.userId !== input.userId) return { kind: 'not_found' }

    // 见文件头 ②：条件 UPDATE ⇒ 只有「当时还是 active」的那一条会写 `revokedAt`。
    if (existing.active) {
      await this.prisma.deviceToken.updateMany({
        where: { id: existing.id, active: true },
        data: { active: false, revokedAt: new Date() }
      })
    }

    // 回读：并发注销时回的是**先写进去的**那个时间（幂等由库保证）。
    const after = await this.prisma.deviceToken.findUnique({
      where: { id: existing.id },
      select: DEVICE_TOKEN_SELECT
    })
    return { kind: 'ok', row: (after ?? { ...existing, active: false }) as DeviceTokenRow }
  }

  async listActiveForUser(userId: string): Promise<ActivePushToken[]> {
    const rows = await this.prisma.deviceToken.findMany({
      where: { userId, active: true, revokedAt: null },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: MAX_ACTIVE_TOKENS_PER_USER,
      select: { token: true, platform: true }
    })
    return rows
  }

  async deactivateTokens(tokens: string[]): Promise<number> {
    if (tokens.length === 0) return 0
    const result = await this.prisma.deviceToken.updateMany({
      where: { token: { in: tokens }, active: true },
      data: { active: false, revokedAt: new Date() }
    })
    return result.count
  }

  /** 刷新一行（同账号重复上报）：token 不变，其余字段以最新上报为准。 */
  private async refresh(
    id: string,
    input: RegisterDeviceTokenInput
  ): Promise<DeviceTokenRow> {
    const row = await this.prisma.deviceToken.update({
      where: { id },
      data: {
        platform: input.platform,
        childId: input.childId,
        active: true,
        revokedAt: null,
        lastSeenAt: new Date()
      },
      select: DEVICE_TOKEN_SELECT
    })
    return row as DeviceTokenRow
  }

  /**
   * 超出 `MAX_ACTIVE_TOKENS_PER_USER` 的最旧行 ⇒ `active=false`。
   *
   * `take: MAX + 1` 就够了：每次注册最多淘汰**一条**，反复注册会收敛到上限。
   * 全部取出反而给了「一次注册写一万行」的放大成本。
   */
  private async evictOverflow(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const active = await tx.deviceToken.findMany({
      where: { userId, active: true },
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: MAX_ACTIVE_TOKENS_PER_USER + 1,
      select: { id: true }
    })
    const overflow = active.slice(MAX_ACTIVE_TOKENS_PER_USER).map((row) => row.id)
    if (overflow.length === 0) return
    await tx.deviceToken.updateMany({
      where: { id: { in: overflow } },
      data: { active: false, revokedAt: new Date() }
    })
  }
}

/** `P2002` = 唯一约束冲突（`token`）。其它错误必须原样抛出，不许被吞成 409。 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

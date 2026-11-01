import { Injectable } from '@nestjs/common'

import { PrismaService } from '../prisma/prisma.service'
import type { AuthSessionPort, CreateAuthSessionInput } from './auth-session.repository'
import type { AuthSessionRow } from './auth-session.gate'

/**
 * 认证会话端口的 **Prisma 适配器**（W9-A，2026-10-29）。
 *
 * ── 与内核的分工（一句话）───────────────────────────────────────────────────
 *   内核（`auth-session.gate.ts`）回答"**这个 token 现在是谁 / 算不算过期**"；
 *   本文件只回答"**怎么把那一行读出来 / 写进去**"。判定一律留在内核 ——
 *   这里再判一次是禁止的（两套判定迟早漂移，与账本 / 设备会话适配器同一条纪律）。
 *
 * ── ★ 三个"不在 SQL 里判"（都是刻意的）────────────────────────────────────────
 *   ① **不**加 `revokedAt: null` / `expiresAt: { gt: now }`：那样"已撤销"与"已到期"
 *      会合并成同一个 401，而 §9.3 要求它们分开（一个能静默重登，一个不能）；
 *   ② **不**把"查不到"抛成异常：`null` 是正常分支（守卫翻 401）；
 *   ③ **不**在 `select` 里多带列：`userId` / `method` / `expiresAt` 是内核要的全部，
 *      `tokenHash` 必须带上（内核要用它做"适配器有没有查错键"的同源校验）。
 *
 * ── `touch()` 只写 `lastSeenAt` ──────────────────────────────────────────────
 *   §4.3 的硬口径：**绝对到期，不滑动**。`lastSeenAt` 只回答"这台设备还活着吗"。
 *   顺手把它拿去做续期，会让"手机丢了"变成"凭据无限期有效"。
 */
@Injectable()
export class PrismaAuthSessionRepository implements AuthSessionPort {
  constructor(private readonly prisma: PrismaService) {}

  async findByTokenHash(tokenHash: string): Promise<AuthSessionRow | null> {
    return await this.prisma.authSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        tokenHash: true,
        method: true,
        deviceId: true,
        issuedAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true
      }
    })
  }

  async create(input: CreateAuthSessionInput): Promise<void> {
    await this.prisma.authSession.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        method: input.method,
        deviceId: input.deviceId,
        expiresAt: input.expiresAt
      }
    })
  }

  async touch(tokenHash: string, now: Date): Promise<void> {
    await this.prisma.authSession.updateMany({
      // `updateMany` 而不是 `update`：tokenHash 查不到时不该抛 P2025（那是并发撤销的正常竞态）。
      where: { tokenHash },
      data: { lastSeenAt: now }
    })
  }

  async revoke(tokenHash: string, now: Date, reason: string): Promise<boolean> {
    const result = await this.prisma.authSession.updateMany({
      // 幂等：已撤销的行不再改（`revokedAt` 保留**第一次**撤销的时刻 —— 那是证据）。
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason }
    })
    return result.count > 0
  }

  /**
   * 撤销该用户除 `keepTokenHash` 之外的全部未撤销会话（W9-D）。
   *
   * ★ 一条 `updateMany` 就够 —— 不需要事务：改密与踢会话之间没有"必须同生共死"
   *   的第二个写入。即使这条失败（抛错），调用方（改密）也会整体回滚在 HTTP 层
   *   表现为 500，用户重试即可；**绝不能**吞掉错误后回 200 ——
   *   那会让"密码已改、旧会话还活着"变成一个静默的安全缺口。
   */
  async revokeOthers(
    userId: string,
    keepTokenHash: string | null,
    now: Date,
    reason: string
  ): Promise<number> {
    const result = await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(keepTokenHash === null ? {} : { tokenHash: { not: keepTokenHash } })
      },
      data: { revokedAt: now, revokedReason: reason }
    })
    return result.count
  }
}

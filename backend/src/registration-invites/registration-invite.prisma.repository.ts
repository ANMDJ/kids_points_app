import { HttpException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { generateInviteCode, withFreshInviteCode } from '../invites/invite-code'
import { PrismaService } from '../prisma/prisma.service'
import type { RegistrationInvitePort } from './registration-invite.repository'
import type {
  CreateRegistrationInviteInput,
  CreateRegistrationInviteResult,
  RegistrationInviteLookup,
  RegistrationInviteQuotaSnapshot
} from './registration-invite.types'

/**
 * 网站注册邀请码的 **Prisma 适配器**（W12，2026-11-02）。
 *
 * ── 「占额度」与「落码」必须在同一个事务里 ──────────────────────────────────
 *   先自增额度、再插码：插码若撞唯一约束（`P2002`），整笔回滚，
 *   额度那一格也回到原值 —— 否则一次撞码会白烧一个名额。
 *   `withFreshInviteCode()` 换码重试的每一次都是一笔**独立事务**，
 *   所以「第一次撞码」不会留下任何痕迹（包括额度）。
 *
 * ── 撞码为什么能直接重试 ────────────────────────────────────────────────────
 *   码是 31 个字符里取 8 位（≈ 8.5×10¹¹ 种），撞码概率可忽略；
 *   唯一约束是**唯一**能回答「这个码归谁」的地方（`invite-code.ts` 文件头）。
 *   这里不「先查一次」，那仍然是 TOCTOU。
 */
@Injectable()
export class PrismaRegistrationInviteRepository implements RegistrationInvitePort {
  constructor(private readonly prisma: PrismaService) {}

  async createInvite(
    input: CreateRegistrationInviteInput
  ): Promise<CreateRegistrationInviteResult> {
    try {
      return await withFreshInviteCode(
        () => generateInviteCode(),
        (code) => this.insertWithQuota(code, input),
        (error) => isInviteCodeCollision(error)
      )
    } catch (error) {
      this.mapWriteError(error)
    }
  }

  async findByCode(code: string): Promise<RegistrationInviteLookup | null> {
    const row = await this.prisma.registrationInvite.findUnique({
      where: { code },
      select: { phone: true, email: true, expiresAt: true, usedAt: true, revoked: true }
    })
    return row
  }

  async readQuota(input: {
    day: string
    dailyLimit: number
  }): Promise<RegistrationInviteQuotaSnapshot> {
    const row = await this.prisma.registrationInviteQuota.findUnique({
      where: { day: input.day },
      select: { issued: true }
    })
    const issued = row?.issued ?? 0
    return {
      dailyLimit: input.dailyLimit,
      issued,
      remainingToday: Math.max(0, input.dailyLimit - issued)
    }
  }

  /**
   * 一个事务：**原子占额度 → 落码**。
   *
   * ★ 额度用一条条件 UPDATE，不用 `COUNT(*)`：并发下 count 会一起数到 49，
   *   于是发出第 50、51 张（`schema.prisma` 的 `RegistrationInviteQuota` 注释）。
   * ★ `INSERT … ON CONFLICT DO NOTHING` 先把当天那一行建出来：没有它时，
   *   第一次发放会走「UPDATE 0 行 ⇒ 误判为额度用完」。
   */
  private async insertWithQuota(
    code: string,
    input: CreateRegistrationInviteInput
  ): Promise<CreateRegistrationInviteResult> {
    return await this.prisma.$transaction(async (tx): Promise<CreateRegistrationInviteResult> => {
      // ★ W12 边界（2026-11-04）：同一个 IP 每业务日最多 `ipDailyLimit` 张。
      //   放在占额度**之前**：被限流的请求不该烧掉一个当日名额。
      //   用 `createdAt` 窗口而不是"哪天"列：表里没有 day 列，
      //   而窗口边界由 service 按 `KP_TIMEZONE` 的业务日算好（同一份 `businessDayOf`）。
      if (input.issuedIpHash !== null) {
        const used = await tx.registrationInvite.count({
          where: {
            issuedIpHash: input.issuedIpHash,
            createdAt: { gte: input.dayStart, lt: input.dayEnd }
          }
        })
        if (used >= input.ipDailyLimit) {
          return { kind: 'ip_limited', used, limit: input.ipDailyLimit }
        }
      }

      await tx.$executeRaw`
        INSERT INTO "RegistrationInviteQuota" ("day", "issued", "updatedAt")
        VALUES (${input.day}, 0, now())
        ON CONFLICT ("day") DO NOTHING`

      const bumped = await tx.$queryRaw<Array<{ issued: number }>>`
        UPDATE "RegistrationInviteQuota"
           SET "issued" = "issued" + 1,
               "updatedAt" = now()
         WHERE "day" = ${input.day}
           AND "issued" < ${input.dailyLimit}
        RETURNING "issued"`

      if (bumped.length === 0) {
        // 额度用完是**正常结局**。这里再读一次只是为了把「已发多少」如实带回去，
        // 不参与任何判定（判定已经由上面那条 UPDATE 做完）。
        const current = await tx.registrationInviteQuota.findUnique({
          where: { day: input.day },
          select: { issued: true }
        })
        return { kind: 'quota_exhausted', issued: current?.issued ?? input.dailyLimit }
      }

      const created = await tx.registrationInvite.create({
        data: {
          code,
          phone: input.phone,
          email: input.email,
          expiresAt: input.expiresAt,
          issuedIpHash: input.issuedIpHash
        },
        select: { code: true, expiresAt: true }
      })

      const issued = bumped[0].issued
      return {
        kind: 'created',
        row: {
          code: created.code,
          expiresAt: created.expiresAt,
          remainingToday: Math.max(0, input.dailyLimit - issued)
        }
      }
    })
  }

  /**
   * `HttpException` 原样抛；其余（真库连不上 / 约束坏了）保持 500。
   * ★ 不把未知错误翻成 409：那会让「数据库挂了」看起来像「你今天不能申请」。
   */
  private mapWriteError(error: unknown): never {
    if (error instanceof HttpException) throw error
    throw error
  }
}

/** 唯一约束撞的是 `code`（这是唯一可能撞的列；额度表主键由 `day` 决定）。 */
function isInviteCodeCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code !== 'P2002') return false
  return JSON.stringify(error.meta?.target ?? '').toLowerCase().includes('code')
}

import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException
} from '@nestjs/common'
import { Prisma, type GuardianConsent } from '@prisma/client'

import { PrismaService } from '../prisma/prisma.service'
import type {
  ConsentPort,
  ConsentState,
  RecordConsentInput,
  WithdrawConsentInput
} from './consent.repository'

/**
 * 监护人同意的 **Prisma 适配器**（W7-A，2026-10-26）。
 *
 * ── 为什么每条写操作都要先锁 `Child` 行 ────────────────────────────────────
 *   同意与撤回都是「先读最新状态、再决定写什么」：
 *   两位家长同时点「撤回」、或一位撤一位授权，先读后写就会让其中一次的
 *   `before` / `after` 快照失真（甚至出现「撤回→授予→撤回」丢掉中间一段）。
 *   `SELECT … FOR UPDATE` 把三件事收进同一临界区：
 *     ① 确认孩子还存在且 active；② 读最新同意行；③ 写状态 + 写审计。
 *   事实上 `GuardianConsent` 没有 `(childId)` 唯一约束（历史上可能有多行），
 *   所以「最新一行」这个读法也必须落在锁内 —— 否则两次并发授予会各建一行。
 *
 * ── 幂等的两条判定（都在锁内）─────────────────────────────────────────────
 *   · 授予：已有 `granted` 且 `consentVersion` 相同 ⇒ 直接回当前状态，
 *     **不写 UPDATE、不写审计**（客户端重试不会在审计里留下两条一样的同意）。
 *   · 撤回：最新一行已是 `withdrawn` ⇒ 同上。
 *   ★ 版本变了（例如法务把文本从 v1 升到 v2）不算幂等：要更新 version + grantedAt
 *     并写一条审计 —— 否则库里会留下「同意了 v2、记录写着 v1」的谎。
 *
 * ── 撤回一条从未授予过的同意 ⇒ 409，不是 200 ────────────────────────────────
 *   返回 200 会凭空造出一段「曾经同意过」的历史。`CONSENT_NOT_GRANTED` 让调用方
 *   知道它这次什么都没撤回（而不是"撤回成功"）。
 */
@Injectable()
export class PrismaConsentRepository implements ConsentPort {
  constructor(private readonly prisma: PrismaService) {}

  async readState(childId: string): Promise<ConsentState> {
    const row = await this.prisma.guardianConsent.findFirst({
      where: { childId },
      orderBy: { createdAt: 'desc' }
    })
    return row === null ? emptyState(childId) : toState(row)
  }

  async recordGrant(input: RecordConsentInput): Promise<ConsentState> {
    try {
      return await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient): Promise<ConsentState> => {
          await this.lockChild(tx, input.childId)
          const current = await this.latestConsent(tx, input.childId)

          if (
            current !== null &&
            current.status === 'granted' &&
            current.consentVersion === input.consentVersion
          ) {
            return toState(current)
          }

          const now = new Date()
          const row =
            current === null
              ? await tx.guardianConsent.create({
                  data: {
                    childId: input.childId,
                    grantedByUserId: input.operator.userId,
                    consentVersion: input.consentVersion,
                    status: 'granted',
                    grantedAt: now,
                    ipHash: input.ipHash,
                    userAgentHash: input.userAgentHash
                  }
                })
              : await tx.guardianConsent.update({
                  where: { id: current.id },
                  data: {
                    grantedByUserId: input.operator.userId,
                    consentVersion: input.consentVersion,
                    status: 'granted',
                    grantedAt: now,
                    withdrawnAt: null,
                    ipHash: input.ipHash,
                    userAgentHash: input.userAgentHash
                  }
                })

          await tx.auditLog.create({
            data: {
              childId: input.childId,
              actorUserId: input.operator.userId,
              actorRole: input.operator.role,
              action: 'consent.grant',
              targetType: 'GuardianConsent',
              targetId: row.id,
              before:
                current === null
                  ? Prisma.JsonNull
                  : { status: current.status, consentVersion: current.consentVersion },
              after: { status: row.status, consentVersion: row.consentVersion }
            }
          })

          return toState(row)
        }
      )
    } catch (error) {
      this.mapWriteError(error)
    }
  }

  async recordWithdrawal(input: WithdrawConsentInput): Promise<ConsentState> {
    try {
      return await this.prisma.$transaction(
        async (tx: Prisma.TransactionClient): Promise<ConsentState> => {
          await this.lockChild(tx, input.childId)
          const current = await this.latestConsent(tx, input.childId)

          if (current === null) {
            throw new ConflictException({
              code: 'CONSENT_NOT_GRANTED',
              message:
                '这个孩子没有可撤回的监护人同意记录 —— 这次什么都没有撤回。' +
                '（把「从未同意」当成「撤回成功」会在库里造出一段没发生过的历史。）'
            })
          }

          if (current.status === 'withdrawn') {
            return toState(current)
          }

          const now = new Date()
          const row = await tx.guardianConsent.update({
            where: { id: current.id },
            data: {
              status: 'withdrawn',
              withdrawnAt: now,
              ipHash: input.ipHash,
              userAgentHash: input.userAgentHash
            }
          })

          await tx.auditLog.create({
            data: {
              childId: input.childId,
              actorUserId: input.operator.userId,
              actorRole: input.operator.role,
              action: 'consent.withdraw',
              targetType: 'GuardianConsent',
              targetId: row.id,
              before: { status: current.status, consentVersion: current.consentVersion },
              after: { status: row.status, withdrawnAt: row.withdrawnAt?.toISOString() ?? null }
            }
          })

          return toState(row)
        }
      )
    } catch (error) {
      this.mapWriteError(error)
    }
  }

  /** 锁住 active 的孩子；不存在 / 已删除 ⇒ 404（跨孩子一律同答）。 */
  private async lockChild(tx: Prisma.TransactionClient, childId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Child"
      WHERE id = ${childId} AND status = 'active'
      FOR UPDATE`
    if (rows[0] === undefined) {
      throw new NotFoundException({
        code: 'CHILD_NOT_FOUND',
        message: `孩子 ${childId} 不存在或已删除 —— 拒绝在不存在的主体上记录同意。`
      })
    }
  }

  /** 最新一行总在锁内读：并发授予时不会各建一行（见文件头）。 */
  private async latestConsent(
    tx: Prisma.TransactionClient,
    childId: string
  ): Promise<GuardianConsent | null> {
    return await tx.guardianConsent.findFirst({
      where: { childId },
      orderBy: { createdAt: 'desc' }
    })
  }

  /** 把可预期的库层失败翻成 4xx（其余原样抛出 ⇒ 500，不伪装成业务拒绝）。 */
  private mapWriteError(err: unknown): never {
    if (err instanceof HttpException) throw err

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') {
        throw new NotFoundException({
          code: 'CONSENT_NOT_FOUND',
          message: '同意记录已经不存在了（可能刚被删除），这次没有写入。',
          details: err.meta ?? null
        })
      }
      if (err.code === 'P2003') {
        throw new ConflictException({
          code: 'CONSENT_USER_MISSING',
          message: '操作人账号已不存在，同意记录没有写入（审计不能指向一个不存在的人）。',
          details: err.meta ?? null
        })
      }
    }

    throw err
  }
}

function emptyState(childId: string): ConsentState {
  return {
    childId,
    status: 'none',
    consentVersion: null,
    grantedAt: null,
    withdrawnAt: null
  }
}

function toState(row: GuardianConsent): ConsentState {
  return {
    childId: row.childId,
    status: row.status,
    consentVersion: row.consentVersion,
    grantedAt: row.grantedAt.toISOString(),
    withdrawnAt: row.withdrawnAt === null ? null : row.withdrawnAt.toISOString()
  }
}


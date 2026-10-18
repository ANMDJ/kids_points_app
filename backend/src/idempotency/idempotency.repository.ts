import { Injectable, InternalServerErrorException, NotImplementedException } from '@nestjs/common'
import { Prisma } from '@prisma/client'

import type { ActionType } from '../contracts/permission-matrix'
import { PrismaService } from '../prisma/prisma.service'

/**
 * 幂等记录的**持久化端口**（`02` §4.4）。
 *
 * ── 它回答的问题（一句话）─────────────────────────────────────────────────
 *   「同一个 `Idempotency-Key` 又来了一次：这是**重放**（返回首次响应）、
 *     还是**同键不同请求**（409）、还是**上一次还没写完**（409）？」
 *
 * ★ 唯一约束必须在**数据库层**（`@@unique([childId, key])`）：
 *   应用层「先查再插」在并发下必然漏 —— 两个请求同时查不到，然后都插进去。
 *   本端口把 P2002 当成**正常分支**（不是 500），再读回首次记录。
 */
export const IDEMPOTENCY_REPOSITORY = Symbol('IDEMPOTENCY_REPOSITORY')

export interface BeginIdempotencyInput {
  key: string
  /** `IdempotencyRecord` 的唯一键一半 —— 跨孩子复用同一个 key 是两件独立的事。 */
  childId: string
  userId: string | null
  actionType: ActionType
  /** 方法 + 路径 + 规范化请求体的 SHA-256；同键不同 hash ⇒ 冲突。 */
  requestHash: string
}

export type BeginIdempotencyResult =
  | { kind: 'started' }
  | { kind: 'replay'; statusCode: number; body: Record<string, unknown> }
  | { kind: 'conflict'; reason: 'HASH_MISMATCH' | 'IN_PROGRESS' }

export interface CompleteIdempotencyInput {
  key: string
  childId: string
  requestHash: string
  statusCode: number
  body: Record<string, unknown>
  /** 本次执行产出的流水 id（若有）。 */
  recordId: string | null
}

export interface IdempotencyPort {
  begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult>
  complete(input: CompleteIdempotencyInput): Promise<void>
  /** 业务失败时丢弃「进行中」记录，允许客户端用同一个 key 重试。 */
  abort(input: { key: string; childId: string; requestHash: string }): Promise<void>
}

/**
 * 无库装配：只在**真的带了 key** 时才会被调用 → 显式 501。
 * 不带 key 的请求完全不碰本端口（见 `IdempotencyService.run`）。
 */
@Injectable()
export class NotImplementedIdempotencyRepository implements IdempotencyPort {
  private fail(method: keyof IdempotencyPort): never {
    throw new NotImplementedException({
      code: 'IDEMPOTENCY_NOT_IMPLEMENTED',
      message:
        `幂等记录在本装配里不可用（无数据库）：${String(method)} 没有实现。` +
        '带 `Idempotency-Key` 的请求一律 501（fail-closed），绝不假装重放保护已生效。'
    })
  }

  begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult> {
    void input
    return Promise.resolve(this.fail('begin'))
  }

  complete(input: CompleteIdempotencyInput): Promise<void> {
    void input
    return Promise.resolve(this.fail('complete'))
  }

  abort(input: { key: string; childId: string; requestHash: string }): Promise<void> {
    void input
    return Promise.resolve(this.fail('abort'))
  }
}

/** `02` §4.4 的 Prisma 实现。 */
@Injectable()
export class PrismaIdempotencyRepository implements IdempotencyPort {
  /** 幂等窗口 24h：覆盖网络重试 / 用户手动重试，过期后允许 key 复用。 */
  static readonly TTL_MS = 24 * 60 * 60 * 1000

  constructor(private readonly prisma: PrismaService) {}

  async begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult> {
    const now = new Date()

    // 过期记录先删掉：同一个 key 在 24h 后是**新请求**，不是重放。
    await this.prisma.idempotencyRecord.deleteMany({
      where: { childId: input.childId, key: input.key, expiresAt: { lte: now } }
    })

    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          key: input.key,
          childId: input.childId,
          userId: input.userId,
          actionType: input.actionType,
          requestHash: input.requestHash,
          expiresAt: new Date(now.getTime() + PrismaIdempotencyRepository.TTL_MS)
        }
      })
      return { kind: 'started' }
    } catch (err) {
      // 并发下第二个请求会撞唯一约束 —— 这是**端口设计的一部分**，不是异常。
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err
      }
    }

    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { childId_key: { childId: input.childId, key: input.key } }
    })
    if (existing === null) {
      // 撞了唯一约束却读不到：只可能是别的请求刚好删了过期行。按「进行中」返回，
      // 让客户端重试，而不是在这里再插一次（那会把并发变成不可预测）。
      return { kind: 'conflict', reason: 'IN_PROGRESS' }
    }
    if (existing.requestHash !== input.requestHash) {
      return { kind: 'conflict', reason: 'HASH_MISMATCH' }
    }
    if (existing.responseStatus === null) {
      return { kind: 'conflict', reason: 'IN_PROGRESS' }
    }

    const body = existing.responseBody
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new InternalServerErrorException({
        code: 'INVALID_IDEMPOTENCY_RESPONSE',
        message: `幂等记录 ${input.key} 的 responseBody 形状不对 —— 拒绝把坏数据当首次响应返回。`
      })
    }
    return {
      kind: 'replay',
      statusCode: existing.responseStatus,
      body: body as Record<string, unknown>
    }
  }

  async complete(input: CompleteIdempotencyInput): Promise<void> {
    const updated = await this.prisma.idempotencyRecord.updateMany({
      where: {
        childId: input.childId,
        key: input.key,
        requestHash: input.requestHash,
        responseStatus: null
      },
      data: {
        responseStatus: input.statusCode,
        responseBody: input.body as Prisma.InputJsonObject,
        recordId: input.recordId
      }
    })
    if (updated.count !== 1) {
      throw new InternalServerErrorException({
        code: 'IDEMPOTENCY_RECORD_LOST',
        message:
          `幂等记录 ${input.key} 在业务执行完却写不回响应（可能已过期被删）—— ` +
          '本次请求已执行，但重放保护没有落库。'
      })
    }
  }

  async abort(input: { key: string; childId: string; requestHash: string }): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({
      where: {
        childId: input.childId,
        key: input.key,
        requestHash: input.requestHash,
        responseStatus: null
      }
    })
  }
}

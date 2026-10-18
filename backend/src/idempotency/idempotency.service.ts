import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common'
import { createHash } from 'node:crypto'

import type { ActionType } from '../contracts/permission-matrix'
import {
  IDEMPOTENCY_REPOSITORY,
  type IdempotencyPort
} from './idempotency.repository'

/** 审批端点的结果形状（与 `ApprovalsService.ServiceResult` 同构）。 */
export interface IdempotentResult {
  statusCode: number
  body: unknown
}

export interface IdempotentRunInput {
  /** 请求头里的 `Idempotency-Key`；缺省 ⇒ **完全跳过**幂等（不是生成一个）。 */
  key: string | undefined
  childId: string
  userId: string
  actionType: ActionType
  requestHash: string
}

/**
 * 幂等执行器（`02` §4.4）—— 把「HTTP 重试」与「业务执行」隔开。
 *
 * ── 它怎么工作 ────────────────────────────────────────────────────────────
 *   带 key：`begin()`（插入进行中记录）
 *     · 重放  → 直接返回首次的 `responseStatus` / `responseBody`，**不再调用业务**
 *     · 冲突  → 同键不同请求 409 `IDEMPOTENCY_KEY_REUSED`；
 *               上次没写完 409 `IDEMPOTENCY_IN_PROGRESS`
 *     · 新建  → 执行 `fn()`，成功后 `complete()` 存响应；失败则 `abort()` 删记录
 *   不带 key：直接执行 —— 幂等是**可选**的（客户端要防重试才带）。
 *
 * ── 诚实标注：响应缓存与业务事务**不是**同一个事务 ───────────────────────
 *   `ApprovalRequest` 的写入本身已经是幂等的（`PointRecord.idempotencyKey = approval:<id>`
 *   ＋ 行锁 ＋ 条件 UPDATE）；本层缓存的是**HTTP 响应**。若进程恰好在
 *   「业务已提交、响应还没写回」之间崩溃，重放会得到 409 `IDEMPOTENCY_IN_PROGRESS`
 *   （fail-closed），直到 24h 记录过期 —— 它**不会**导致重复扣分。
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(IDEMPOTENCY_REPOSITORY) private readonly port: IdempotencyPort) {}

  async run<T extends IdempotentResult>(
    input: IdempotentRunInput,
    execute: () => Promise<T>
  ): Promise<T> {
    if (input.key === undefined) return execute()

    const key = normalizeKey(input.key)
    const begin = await this.port.begin({
      key,
      childId: input.childId,
      userId: input.userId,
      actionType: input.actionType,
      requestHash: input.requestHash
    })

    if (begin.kind === 'replay') {
      return { statusCode: begin.statusCode, body: begin.body } as T
    }
    if (begin.kind === 'conflict') {
      if (begin.reason === 'HASH_MISMATCH') {
        throw new ConflictException({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message:
            `幂等键 ${JSON.stringify(key)} 已经用于**另一个请求**（requestHash 不同）—— ` +
            '不得静默复用首次结果。换一个 key，或原样重发首次请求。'
        })
      }
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message:
          `幂等键 ${JSON.stringify(key)} 的上一次请求还没有写完响应 —— ` +
          '请稍后用**同一个请求**重试（本次没有执行任何业务）。'
      })
    }

    let result: T
    try {
      result = await execute()
    } catch (err) {
      // 业务失败（4xx/5xx）不缓存：删掉进行中记录，允许同一个 key 重试。
      // ★ abort 自己失败时**保留原始错误**（不要用「删记录失败」盖住真正的 4xx/5xx）。
      try {
        await this.port.abort({ key, childId: input.childId, requestHash: input.requestHash })
      } catch {
        // 记录会留在「进行中」直到过期 → 重试得到 409 IN_PROGRESS，绝不会重复执行。
      }
      throw err
    }

    const body = jsonObjectOf(result.body)
    await this.port.complete({
      key,
      childId: input.childId,
      requestHash: input.requestHash,
      statusCode: result.statusCode,
      body,
      recordId: recordIdOf(body)
    })
    return result
  }

  /**
   * 请求指纹：`METHOD path canonical(body)` 的 SHA-256。
   *
   * ★ 必须**规范化键序**：`{a:1,b:2}` 与 `{b:2,a:1}` 是同一个请求，
   *   不能因为客户端序列化顺序不同就误判成「同键不同请求」。
   */
  static hashRequest(method: string, path: string, body: unknown): string {
    return createHash('sha256')
      .update(`${method.toUpperCase()} ${path} ${canonicalJson(body ?? null)}`)
      .digest('hex')
  }
}

const MAX_KEY_LENGTH = 200

function normalizeKey(raw: string): string {
  const key = raw.trim()
  if (key === '' || key.length > MAX_KEY_LENGTH) {
    throw new BadRequestException({
      code: 'INVALID_IDEMPOTENCY_KEY',
      message: `Idempotency-Key 必须是 1..${MAX_KEY_LENGTH} 个字符（收到 ${raw.length} 字符）。`
    })
  }
  return key
}

/** 递归按键排序，保证同一个请求体得到同一个 hash。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/** 响应体必须是 JSON 对象（`IdempotencyRecord.responseBody` 的形状）。 */
function jsonObjectOf(body: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(JSON.stringify(body ?? null))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`幂等响应体不是 JSON 对象：${JSON.stringify(parsed)}`)
  }
  return parsed as Record<string, unknown>
}

function recordIdOf(body: Record<string, unknown>): string | null {
  const value = body.executedRecordId
  return typeof value === 'string' && value !== '' ? value : null
}

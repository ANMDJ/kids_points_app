import {
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException
} from '@nestjs/common'
import { Prisma } from '@prisma/client'

import { appendDraftInTx, lockChildBalance } from '../ledger/ledger.append'
import {
  buildRecordDraft,
  LedgerDeniedError,
  LedgerShapeError
} from '../ledger/ledger.gate'
import { PrismaService } from '../prisma/prisma.service'
import type { RecordRow } from '../read/read.repository'
import type { AdjustRecordInput, RecordsPort } from './records.repository'

/**
 * 「记一笔」的 **Prisma 适配器**（W5-B，2026-10-20）。
 *
 * ── 一个事务里发生什么（顺序有理由，不要重排）──────────────────────────────
 *   ① `SELECT … FOR UPDATE` 锁住孩子余额行 ⇒ 同一孩子的写入**排队**；
 *      （并顺手回答"这个孩子还在不在"：已软删 ⇒ 404，绝不记到已删除孩子名下）
 *   ② 内核 `buildRecordDraft()` 构造草稿 —— 符号 / 余额 / 标题快照全由它算，
 *      本文件**不重算**（余额算不出来就拒绝，绝不截断到 0 —— 修 B6）；
 *   ③ `appendDraftInTx()`：再锁一次 + 库钟 + 余额 CAS + 严格递增 `createdAt`；
 *   ④ 同事务写 `AuditLog` —— 与流水同一个 `tx`，不会出现"分记了、审计没写"。
 *
 * ★ 为什么**不**查每日上限、不查规则版本：记一笔没有习惯也没有规则，
 *   `points` 就是家长当下的意思。硬塞一条上限只会凭空造出一个产品语义。
 *
 * ★ 为什么 `createdAt` 不在这里 `new Date()`：时间由 `appendDraftInTx()` 从**库钟**
 *   取并保证严格递增。进程时钟与库钟差几秒，在这里取会破坏 `(createdAt, id)` 游标序。
 */
@Injectable()
export class PrismaRecordsRepository implements RecordsPort {
  constructor(private readonly prisma: PrismaService) {}

  async adjust(input: AdjustRecordInput): Promise<RecordRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const balance = await lockChildBalance(tx, input.childId)

        const note = input.note?.trim()

        const draft = buildRecordDraft({
          childId: input.childId,
          ruleVersionRow: null,
          // ★ 完整标题直接落库（修 B8：截断只允许发生在渲染层）。
          titleSnapshot: input.title,
          pointsDelta: input.points,
          category: 'adjust',
          source: input.source,
          operator: { userId: input.operatorUserId, role: input.operatorRole },
          note: note === undefined || note === '' ? undefined : note,
          idempotencyKey: input.idempotencyKey ?? null,
          currentBalance: balance,
          now: input.now
        })

        const record = await appendDraftInTx(tx, draft)

        await tx.auditLog.create({
          data: {
            childId: input.childId,
            actorUserId: input.operatorUserId,
            actorRole: input.operatorRole,
            action: 'point_record.adjust',
            targetType: 'PointRecord',
            targetId: record.id,
            after: {
              recordId: record.id,
              title: record.titleSnapshot,
              pointsDelta: record.pointsDelta,
              balanceAfter: record.balanceAfter,
              category: record.category,
              source: record.source,
              note: record.note,
              idempotencyKey: input.idempotencyKey ?? null
            }
          }
        })

        return record
      })
    } catch (err) {
      mapWriteError(err)
    }
  }
}

/**
 * 把库层 / 内核的失败翻成 4xx（其余原样抛出 ⇒ 500，不伪装成业务拒绝）。
 *
 * ★ 与 `PrismaHabitsRepository.mapWriteError()` 同一口径；差异只有一处：
 *   记一笔**没有**「同一原记录只能冲正一次」的语义，所以 P2002 + 幂等键
 *   一律按 `RECORD_DUPLICATE_IDEMPOTENCY_KEY` 报（不存在 `RECORD_ALREADY_REVERSED` 分支）。
 */
function mapWriteError(err: unknown): never {
  if (err instanceof HttpException) throw err

  if (err instanceof LedgerDeniedError) {
    // 余额不足（INSUFFICIENT_POINTS） / 零变动（ZERO_DELTA）——“规则赢了”，不是服务器炸了。
    throw new ConflictException({ code: err.code, message: err.message })
  }
  if (err instanceof LedgerShapeError) {
    // 形状错误代表数据/装配坏了（例如标题为空却漏过 DTO 校验）⇒ 500，绝不静默落库。
    throw new InternalServerErrorException({
      code: 'LEDGER_SHAPE_ERROR',
      detail: err.code,
      message: err.message
    })
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      if (JSON.stringify(err.meta ?? {}).includes('idempotencyKey')) {
        throw new ConflictException({
          code: 'RECORD_DUPLICATE_IDEMPOTENCY_KEY',
          message:
            '这个 Idempotency-Key 在这个孩子上已经产生过一笔流水 —— 重放被数据库唯一约束拦下。' +
            '（若上一次响应丢失，请用同一个 key 重试；幂等层会返回首次结果。）'
        })
      }
      throw new ConflictException({
        code: 'RECORD_UNIQUE_VIOLATION',
        message: `写入违反唯一约束：${JSON.stringify(err.meta ?? {})}`
      })
    }
    if (err.code === 'P2003') {
      throw new ConflictException({
        code: 'RECORD_FOREIGN_KEY_VIOLATION',
        message: '写入违反外键（孩子 id 不存在？）—— 拒绝这笔无主流水。'
      })
    }
  }
  throw err
}

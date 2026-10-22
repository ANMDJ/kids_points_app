import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common'
import type { RecordSource } from '@prisma/client'

import type { Actor } from '../permissions/actor'
import { toRecordDto, type WrittenRecordResponse } from '../read/read.mapper'
import type { RecordRow } from '../read/read.repository'
import type { AdjustRecordDto } from './dto/adjust-record.dto'
import { RECORDS_REPOSITORY, type RecordsPort } from './records.repository'

/** 单笔记账的分值上限 —— 与两端 `PointsStepper(max: 999)`、DTO 同口径。 */
const MAX_ABS_POINTS = 999
/** 事由长度上限 —— 与 DTO 的 `@MaxLength(120)` 同口径。 */
const MAX_TITLE_LENGTH = 120
/** 附注长度上限 —— 与 DTO 的 `@MaxLength(200)` 同口径。 */
const MAX_NOTE_LENGTH = 200

/**
 * 「记一笔」的**应用服务**（W5-B，2026-10-20）。
 *
 * ── 它只做三件事（与 `HabitsService` 的分工完全同构）───────────────────────
 *   ① 把"会话里的操作人"翻成账本需要的 `source`；
 *   ② 把 DTO 翻成端口入参（`childId` 从会话传下来，**绝不**读请求体）；
 *   ③ 把端口返回的行翻成客户端契约（与 `GET /records` 同一个 `toRecordDto`）。
 *
 * ── 为什么这里还要再校验一遍 DTO 已经校验过的字段 ──────────────────────────
 *   DTO 的 class-validator 判据只在 **HTTP 路径**上生效（`applyGlobalPipes()` 装配的
 *   全局 `ValidationPipe`，`whitelist + forbidNonWhitelisted`）。直接 `new RecordsService()`
 *   的调用方（未来的脚本 / 内部任务 / 单元测试）绕过了 HTTP，那时一条 `points=0`
 *   或空白标题会一路落到内核：前者被内核 409，后者被内核判成 **500**（`MISSING_TITLE_SNAPSHOT`）。
 *   输入错误应当在 400 就拦住，而不是让服务端 500 —— 所以本方法里的判据是
 *   端口前的**最后一道**，不是"重复"。
 */
@Injectable()
export class RecordsService {
  constructor(@Inject(RECORDS_REPOSITORY) private readonly port: RecordsPort) {}

  async adjust(
    childId: string,
    dto: AdjustRecordDto,
    actor: Actor,
    idempotencyKey?: string
  ): Promise<WrittenRecordResponse> {
    this.assertWritable(actor)

    const title = typeof dto.title === 'string' ? dto.title.trim() : ''
    // 纯空白也拒：`'   '` 会让内核报 MISSING_TITLE_SNAPSHOT（500）——
    // 输入问题必须在 400 就拦住，而不是让服务端 500。
    if (title === '' || title.length > MAX_TITLE_LENGTH) {
      throw new BadRequestException({
        code: 'INVALID_TITLE',
        message: `事由必须是 1–${MAX_TITLE_LENGTH} 个字符（去掉首尾空白后不能为空）。`
      })
    }

    const points = dto.points
    if (!Number.isInteger(points) || points === 0 || Math.abs(points) > MAX_ABS_POINTS) {
      throw new BadRequestException({
        code: 'INVALID_POINTS',
        message: `分值必须是 −${MAX_ABS_POINTS}..−1 或 1..${MAX_ABS_POINTS} 之间的整数（0 没有语义）。`
      })
    }

    const note = dto.note?.trim()
    if (note !== undefined && note.length > MAX_NOTE_LENGTH) {
      throw new BadRequestException({
        code: 'INVALID_NOTE',
        message: `附注最多 ${MAX_NOTE_LENGTH} 个字符。`
      })
    }

    const key = idempotencyKey?.trim()
    const row = await this.port.adjust({
      childId,
      title,
      points,
      // 空串按"没写"处理：不落一个空字符串冒充用户输入。
      note: note === undefined || note === '' ? undefined : note,
      operatorUserId: actor.userId,
      operatorRole: actor.role,
      source: this.sourceOf(actor),
      // ★ 控制器在 `IdempotencyService.run()` 之后调用本方法：有 key 时已被规范化。
      //   无 key 的两次点击**就是两笔**（产品语义），不会在这里被"帮忙"去重。
      idempotencyKey: key === undefined || key === '' ? undefined : key,
      now: new Date()
    })
    return this.toResponse(row)
  }

  private toResponse(row: RecordRow): WrittenRecordResponse {
    return { record: toRecordDto(row), executedRecordId: row.id }
  }

  /**
   * 防御性断言（与 `HabitsService.assertWritable` 同一理由）：
   * 矩阵里 `adjust_points` 对孩子是 **DENY**，`PermissionsGuard` 已经拦住；
   * 但直接 new 本服务的调用方绕过 Guard，那时 `child` / `viewer` 会一路落到账本。
   */
  private assertWritable(actor: Actor): asserts actor is Actor & { role: 'guardian' } {
    if (actor.role !== 'guardian') {
      throw new ForbiddenException({
        code: 'ACTION_NOT_ALLOWED',
        message:
          `角色 ${actor.role} 不能手动记分（矩阵 adjust_points：guardian ALLOW，其余 DENY）—— ` +
          '孩子的诉求走「申请加分」审批（request_points_bonus），不是直接改账本。'
      })
    }
  }

  /** `PointRecord.source` 只由**会话角色**决定；客户端传什么都不影响它。 */
  private sourceOf(actor: Actor): Extract<RecordSource, 'child_self' | 'guardian'> {
    // 当前断言只放行 guardian，`child` 分支是为「将来允许孩子自助记分」留的映射；
    // 它今天不可能被走到，但少了它，改矩阵时就得重新想一遍 source 该怎么填。
    return actor.role === 'child' ? 'child_self' : 'guardian'
  }
}

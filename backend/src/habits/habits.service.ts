import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common'
import type { RecordSource } from '@prisma/client'

import type { Actor } from '../permissions/actor'
import { toRecordDto, type WrittenRecordResponse } from '../read/read.mapper'
import type { RecordRow } from '../read/read.repository'
import { resolveBusinessTimeZone } from './business-day'
import type { CheckInHabitDto } from './dto/check-in-habit.dto'
import type { ReverseRecordDto } from './dto/reverse-record.dto'
import { HABITS_REPOSITORY, type HabitsPort } from './habits.repository'

/**
 * 打卡 / 撤销打卡的**应用服务**（W4-D，2026-10-19）。
 *
 * ── 它只做三件事 ─────────────────────────────────────────────────────────
 *   ① 把"会话里的操作人"翻成账本需要的 `source`；
 *   ② 把 DTO 翻成端口入参（`childId` 从会话传下来，**绝不**读请求体）；
 *   ③ 把端口返回的行翻成客户端契约（与 `GET /records` 同一个 `toRecordDto`）。
 *
 * ── 它刻意**不**做的事 ───────────────────────────────────────────────────
 *   · 不判权限（矩阵 + Guard 已判；此处只有一道防御性断言，见 `assertWritable`）；
 *   · 不读库、不判每日上限、不构造草稿（端口 + `ledger.gate` 各管一段）；
 *   · 不写幂等记录（控制器用 `IdempotencyService.run` 包住整个调用）。
 */
@Injectable()
export class HabitsService {
  /**
   * 业务时区在**装配时**校验一次：配错 ⇒ 启动就炸，而不是第一笔打卡时静默按 UTC 算。
   * 每日上限的判定在 Prisma 适配器里（那里同时拿库钟），本服务不参与。
   */
  private readonly timeZone: string

  constructor(@Inject(HABITS_REPOSITORY) private readonly port: HabitsPort) {
    this.timeZone = resolveBusinessTimeZone(process.env.KP_TIMEZONE)
  }

  async checkIn(
    childId: string,
    dto: CheckInHabitDto,
    actor: Actor,
    idempotencyKey?: string
  ): Promise<WrittenRecordResponse> {
    this.assertWritable(actor)
    const key = idempotencyKey?.trim()
    const row = await this.port.checkIn({
      childId,
      habitId: dto.habitId,
      operatorUserId: actor.userId,
      operatorRole: actor.role,
      source: this.sourceOf(actor),
      // ★ 控制器在 `IdempotencyService.run()` **之后**调用本方法：有 key 时它已
      //   被规范化（非空、≤200）；无 key 时保持 undefined ⇒ 流水不写幂等键。
      //   无 key 的两次点击**就是两笔**（产品语义），不会在这里被"帮忙"去重。
      idempotencyKey: key === undefined || key === '' ? undefined : key,
      now: new Date()
    })
    return this.toResponse(row)
  }

  async reverse(
    childId: string,
    recordId: string,
    dto: ReverseRecordDto,
    actor: Actor
  ): Promise<WrittenRecordResponse> {
    this.assertWritable(actor)
    const note = dto.note?.trim()
    const row = await this.port.reverse({
      childId,
      recordId,
      operatorUserId: actor.userId,
      operatorRole: actor.role,
      note: note === undefined || note === '' ? undefined : note,
      now: new Date()
    })
    return this.toResponse(row)
  }

  /**
   * 软删一个习惯（W5-F）—— 移出今日清单，进回收站。
   *
   * 与打卡 / 撤销同一分工：本层只做规范化与防御性断言，库层事实（是否存在、
   * 是否已删）在 Prisma 适配器的事务里判。
   */
  async deleteHabit(childId: string, habitId: string, actor: Actor): Promise<{ habitId: string }> {
    this.assertWritable(actor)
    const id = habitId.trim()
    if (id === '' || id.length > 64) {
      throw new BadRequestException({
        code: 'HABIT_ID_INVALID',
        message: '习惯 id 必须是 1..64 字符（cuid 尺度）。'
      })
    }
    return {
      habitId: await this.port.deleteHabit({
        childId,
        habitId: id,
        operatorUserId: actor.userId,
        operatorRole: actor.role
      })
    }
  }

  /** 本服务当前使用的业务时区（供日志/诊断；不参与 HTTP 契约）。 */
  getTimeZone(): string {
    return this.timeZone
  }

  private toResponse(row: RecordRow): WrittenRecordResponse {
    return { record: toRecordDto(row), executedRecordId: row.id }
  }

  /**
   * 防御性断言：矩阵已经保证只有 guardian / child 能到这里（viewer 一律 DENY）。
   * 仍然再判一次，是因为**直接 new 本服务**的调用方（未来的内部任务、脚本）
   * 绕过了 Guard —— 那时 `viewer` 会一路落到账本里，成为一条"只读成员写了账"的记录。
   */
  private assertWritable(actor: Actor): asserts actor is Actor & { role: 'guardian' | 'child' } {
    if (actor.role !== 'guardian' && actor.role !== 'child') {
      throw new ForbiddenException({
        code: 'ACTION_NOT_ALLOWED',
        message: `角色 ${actor.role} 不能写账本（viewer 只读）—— 拒绝，而不是落一条无权限来源的流水。`
      })
    }
  }

  /** `PointRecord.source` 只由**会话角色**决定；客户端传什么都不影响它。 */
  private sourceOf(actor: Actor & { role: 'guardian' | 'child' }): Extract<
    RecordSource,
    'child_self' | 'guardian'
  > {
    return actor.role === 'child' ? 'child_self' : 'guardian'
  }
}

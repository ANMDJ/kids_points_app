import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards
} from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { IdempotencyService } from '../idempotency/idempotency.service'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { RequestWithActor } from '../permissions/actor'
import type { WrittenRecordResponse } from '../read/read.mapper'
import { CheckInHabitDto } from './dto/check-in-habit.dto'
import { ReverseRecordDto } from './dto/reverse-record.dto'
import { HabitsService } from './habits.service'

/**
 * 习惯打卡 / 撤销打卡的 HTTP 入口（W4-D，2026-10-19）。
 *
 * ── 路由为什么是 `POST /records/check-in` 而不是 `/habits/:id/check-in` ─────
 *   `docs/design/01-overview.md` §3 的契约是 `POST /records/check-in`；
 *   客户端（`kids_points_mp/src/data/store.ts` / `lib/data/app_store.dart`）也按它
 *   实现，且流水（record）本来就是这条写入的产物 —— 用资源名而不是动词路径。
 *   文件放在 `habits/` 是因为**业务**是习惯，不是"流水 CRUD"。
 *
 * ── 三道屏障（顺序不能反）──────────────────────────────────────────────────
 *   `DeviceSessionGuard`（身份/孩子上下文）→ `MembershipGuard`（成员资格）→
 *   `PermissionsGuard`（矩阵）× 成员级收紧。缺任何一道都会 401/403，
 *   根本到不了本控制器的方法体。
 *
 * ── 幂等（`02` §4.4）──────────────────────────────────────────────────────
 *   带 `Idempotency-Key`：重放直接返回首次响应，**不再调用业务**；
 *   不带：直接执行 —— 两次点击**就是两笔**（产品语义，不是漏洞）。
 *   无论带不带，账本层都还会用 `(childId, idempotencyKey)` 唯一约束兜底。
 */
@Controller('records')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class HabitsController {
  constructor(
    private readonly service: HabitsService,
    private readonly idempotency: IdempotencyService
  ) {}

  /**
   * 打卡（`check_in_habit`：guardian ALLOW / child ALLOW）。
   *
   * 201 响应：`{ record, executedRecordId }`（`record` 与 `GET /records` 的行同构）。
   * 失败：400 形状 / 401 身份 / 403 权限或成员 / 404 `HABIT_NOT_FOUND` /
   *       409 上限或规则问题。
   */
  @Post('check-in')
  @HttpCode(201)
  @RequireAction('check_in_habit')
  async checkIn(
    @Body() dto: CheckInHabitDto,
    @Req() req: RequestWithActor,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<WrittenRecordResponse> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)

    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'check_in_habit',
        requestHash: IdempotencyService.hashRequest('POST', '/records/check-in', dto)
      },
      async () => ({
        statusCode: 201,
        body: await this.service.checkIn(childId, dto, actor, idempotencyKey)
      })
    )
    return result.body
  }

  /**
   * 撤销打卡（`undo_check_in`：guardian ALLOW / child DENY）。
   *
   * 201 响应：`{ record, executedRecordId }` —— `record` 是**新写的冲正记录**
   * （`pointsDelta` 为负、`source='correction'`、`reversesRecordId=原记录 id`），
   * 原记录一字未改（append-only，I5）。
   *
   * 失败：404 `RECORD_NOT_FOUND`（含跨孩子）/ 409 `NOT_A_HABIT_CHECK_IN` /
   *       `ALREADY_REVERSED` / `CANNOT_REVERSE_REVERSAL` / `INSUFFICIENT_POINTS`。
   */
  @Post(':id/reverse')
  @HttpCode(201)
  @RequireAction('undo_check_in')
  async reverse(
    @Param('id') id: string,
    @Body() dto: ReverseRecordDto,
    @Req() req: RequestWithActor,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<WrittenRecordResponse> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)

    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'undo_check_in',
        requestHash: IdempotencyService.hashRequest('POST', `/records/${id}/reverse`, dto)
      },
      async () => ({
        statusCode: 201,
        body: await this.service.reverse(childId, id, dto, actor)
      })
    )
    return result.body
  }

  /**
   * Guard 已保证 `kpActor` 存在（否则请求在 401 就结束了）。
   * 这里再断言一次是**编译期**需要，不是为了再判一遍权限。
   */
  private actorOf(req: RequestWithActor): NonNullable<RequestWithActor['kpActor']> {
    if (req.kpActor === undefined) {
      throw new Error('HabitsController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）')
    }
    return req.kpActor
  }

  /**
   * `kpChildId` 由身份 Guard 写、屏障一验过（成员关系就是对着它查的）。
   * ★ 绝不能从请求体取孩子 id —— 那等于让客户端决定"给谁加分"。
   */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'HabitsController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { IdempotencyService } from '../idempotency/idempotency.service'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { RequestWithActor } from '../permissions/actor'
import type { WrittenRecordResponse } from '../read/read.mapper'
import { AdjustRecordDto } from './dto/adjust-record.dto'
import { RecordsService } from './records.service'

/**
 * 「记一笔」的 HTTP 入口（W5-B，2026-10-20）。
 *
 * ── 为什么是 `POST /records/adjust` ────────────────────────────────────────
 *   `docs/design/01-overview.md` §3 / `02` §6 的动作名就是 `adjust_points`，
 *   而它的产物是一条流水；`POST /records/check-in` 已经在用「`/records` + 动作」
 *   这个形状，这里沿用同一命名，不另造 `/points/adjust`。
 *
 * ── 三道屏障（顺序不能反，与 `HabitsController` 完全一致）───────────────────
 *   `DeviceSessionGuard`（身份/孩子上下文）→ `MembershipGuard`（成员资格）→
 *   `PermissionsGuard`（矩阵 `adjust_points`：guardian ALLOW / child DENY）。
 *   孩子**不能**直接记账：他有正当诉求，但要走 `request_points_bonus` 审批
 *   （`02` §6 的归一化），否则「孩子给自己加分」就成了后门。
 *
 * ── 幂等（`02` §4.4）──────────────────────────────────────────────────────
 *   带 `Idempotency-Key`：重放直接返回首次响应，**不再调用业务**；
 *   不带：直接执行 —— 两次保存**就是两笔**（产品语义）。
 *   账本层再用 `(childId, idempotencyKey)` 唯一约束兜底。
 */
@Controller('records')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class RecordsController {
  constructor(
    private readonly service: RecordsService,
    private readonly idempotency: IdempotencyService
  ) {}

  /**
   * 记一笔（`adjust_points`：guardian ALLOW / child DENY）。
   *
   * 201 响应：`{ record, executedRecordId }`（`record` 与 `GET /records` 的行同构，
   * `category='adjust'`、`points` 带符号、`balanceAfter` 来自锁内余额）。
   *
   * 失败：400 形状（分值 0 / 超界、事由空白） / 401 身份 / 403 权限或成员 /
   *       404 `CHILD_NOT_FOUND` / 409 `INSUFFICIENT_POINTS`。
   */
  @Post('adjust')
  @HttpCode(201)
  @RequireAction('adjust_points')
  async adjust(
    @Body() dto: AdjustRecordDto,
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
        actionType: 'adjust_points',
        requestHash: IdempotencyService.hashRequest('POST', '/records/adjust', dto)
      },
      async () => ({
        statusCode: 201,
        body: await this.service.adjust(childId, dto, actor, idempotencyKey)
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
      throw new Error('RecordsController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）')
    }
    return req.kpActor
  }

  /**
   * `kpChildId` 由身份 Guard 写、屏障一验过。
   * ★ 绝不能从请求体取孩子 id —— 那等于让客户端决定"给谁加分"。
   */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'RecordsController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

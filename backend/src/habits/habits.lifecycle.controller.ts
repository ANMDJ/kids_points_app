import {
  Controller,
  Delete,
  Headers,
  HttpCode,
  Param,
  Req,
  UseGuards
} from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { IdempotencyService } from '../idempotency/idempotency.service'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { Actor, RequestWithActor } from '../permissions/actor'
import { HabitsService } from './habits.service'

/**
 * 习惯的**生命周期**入口（W5-F，2026-10-21）。
 *
 * ── 为什么只有一条路由 ────────────────────────────────────────────────────
 *   · **新建**：`POST /point-rules/:id/habits`（W5-A）—— 首页习惯必须是某条
 *     规则的派生，否则「按什么加分」会变成自由文本。这里不再开 `POST /habits`
 *     （第二个创建入口 = 第二套“习惯从哪来”的判据）。
 *   · **编辑**：当前产品没有「改习惯」的界面语义 —— 要改分值/上限，改的是**规则**
 *     （`PATCH /point-rules/:id` 会同步派生习惯）。开 `PATCH /habits/:id` 会让
 *     习惯与规则出现两个互相矛盾的分值（打卡时 `HABIT_RULE_POINTS_MISMATCH`）。
 *   · **删除**：`DELETE /habits/:id` —— 软删（进回收站 90 天，修 C9）。
 *     只把「今天该做的事」移出清单，**不碰流水**：历史打卡仍带 `habitId` 回指。
 *
 * ── 三道屏障 + 幂等（与 `HabitsController` 同一手法）────────────────────────
 *   `DeviceSessionGuard` → `MembershipGuard` → `PermissionsGuard`；
 *   矩阵 `delete_habit` = 家长 ALLOW / 孩子 DENY。带 `Idempotency-Key` 时重放
 *   不会产生第二条审计。★ W7-A 起另有 `ConsentGuard`（第四道）：撤回同意后
 *   `DELETE /habits/:id` 回 `403 CONSENT_REQUIRED`。
 *
 * ── 状态码 ────────────────────────────────────────────────────────────────
 *   200 `{ habitId }`（幂等：已经删过也回同一个 id）；404 `HABIT_NOT_FOUND`（含跨孩子）。
 */
@Controller('habits')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
export class HabitsLifecycleController {
  constructor(
    private readonly service: HabitsService,
    private readonly idempotency: IdempotencyService
  ) {}

  @Delete(':id')
  @HttpCode(200)
  @RequireAction('delete_habit')
  async remove(
    @Param('id') id: string,
    @Req() req: RequestWithActor,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<{ habitId: string }> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)

    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'delete_habit',
        // DELETE 没有请求体：目标已经在路径里，幂等哈希也按 null body 计算。
        requestHash: IdempotencyService.hashRequest('DELETE', `/habits/${id}`, null)
      },
      async () => ({
        statusCode: 200,
        body: await this.service.deleteHabit(childId, id, actor)
      })
    )
    return result.body
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄。 */
  private actorOf(req: RequestWithActor): Actor {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error(
        'HabitsLifecycleController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）'
      )
    }
    return actor
  }

  /** `kpChildId` 由身份 Guard 写、屏障一验过。**绝不**从请求体取孩子 id。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'HabitsLifecycleController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

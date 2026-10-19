import {
  Body,
  Controller,
  Delete,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  BadRequestException
} from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { IdempotencyService } from '../idempotency/idempotency.service'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { RequestWithActor } from '../permissions/actor'
import type { HabitDto, RuleDto } from '../read/read.mapper'
import { CreateRuleDto } from './dto/create-rule.dto'
import { UpdateRuleDto } from './dto/update-rule.dto'
import { RulesService, type RuleOperator } from './rules.service'

/**
 * 规则写入口（W5-A，2026-10-19）。
 *
 * ── 四条路由为什么都挂在 `/point-rules` 下 ────────────────────────────────
 *   规则是资源；"加入今天的习惯"是规则的**派生**动作，故 `POST /point-rules/:id/habits`
 *   —— 而不是 `/habits` 带一个 `ruleId` 请求体：后者会让"习惯从哪来"变成可选字段，
 *   而这里它是**路径**的一部分（不可能漏传）。
 *
 * ── 三道屏障 + 幂等（与 `HabitsController` 同一手法）────────────────────────
 *   `DeviceSessionGuard` → `MembershipGuard` → `PermissionsGuard`；
 *   **孩子一律 403**（矩阵四条 `*_rule` 动作都是 guardian ALLOW / child DENY）。
 *   四个写入口都支持 `Idempotency-Key`：双击"保存" / "删除"不会产生两个版本或两条审计。
 *
 * ── 状态码 ────────────────────────────────────────────────────────────────
 *   建规则 201；改规则 200（返回新版本）；删规则 200 `{ ruleId }`（幂等）；
 *   加习惯 201（返回与 `GET /home` 的 `habits[]` 同构的行）。
 */
@Controller('point-rules')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class RulesController {
  constructor(
    private readonly service: RulesService,
    private readonly idempotency: IdempotencyService
  ) {}

  @Post()
  @HttpCode(201)
  @RequireAction('add_rule')
  async create(
    @Body() dto: CreateRuleDto,
    @Req() req: RequestWithActor,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<RuleDto> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)

    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'add_rule',
        requestHash: IdempotencyService.hashRequest('POST', '/point-rules', dto)
      },
      async () => ({
        statusCode: 201,
        body: await this.service.createRule(childId, dto, actor)
      })
    )
    return result.body
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireAction('update_rule')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateRuleDto,
    @Req() req: RequestWithActor,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<RuleDto> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)

    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'update_rule',
        requestHash: IdempotencyService.hashRequest('PATCH', `/point-rules/${id}`, dto)
      },
      async () => ({
        statusCode: 200,
        body: await this.service.updateRule(childId, id, dto, actor)
      })
    )
    return result.body
  }

  @Delete(':id')
  @HttpCode(200)
  @RequireAction('delete_rule')
  async remove(
    @Param('id') id: string,
    @Req() req: RequestWithActor,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<{ ruleId: string }> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)

    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'delete_rule',
        // DELETE 没有请求体：路径里已经包含唯一目标；重复删除由仓储幂等处理。
        requestHash: IdempotencyService.hashRequest('DELETE', `/point-rules/${id}`, null)
      },
      async () => ({
        statusCode: 200,
        body: await this.service.deleteRule(childId, id, actor)
      })
    )
    return result.body
  }

  @Post(':id/habits')
  @HttpCode(201)
  @RequireAction('add_habit_from_rule')
  async addHabit(
    @Param('id') id: string,
    @Req() req: RequestWithActor,
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<HabitDto> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)

    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'add_habit_from_rule',
        requestHash: IdempotencyService.hashRequest(
          'POST',
          `/point-rules/${id}/habits`,
          null
        )
      },
      async () => ({
        statusCode: 201,
        body: await this.service.addHabitFromRule(childId, id, actor)
      })
    )
    return result.body
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄。 */
  private actorOf(req: RequestWithActor): RuleOperator {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error('RulesController 缺少 DeviceSessionGuard：请求没有 actor')
    }
    if (actor.role === 'viewer') {
      // 矩阵对 viewer 一律 DENY；Guard 理应已拦下。这里再挡一次是防御纵深。
      throw new BadRequestException({
        code: 'RULE_ACTOR_ROLE_INVALID',
        message: 'viewer 不能写规则。'
      })
    }
    return { userId: actor.userId, role: actor.role }
  }

  /**
   * `kpChildId` 由身份 Guard 写、屏障一验过。
   * ★ 绝不从请求体取孩子 id —— 那等于让客户端决定改谁家的规则。
   */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'RulesController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

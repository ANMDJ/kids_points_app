import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import type { RequestWithActor } from '../permissions/actor'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { DeletionOperator, FamilyDeletionState } from './deletion.repository'
import { DeletionService } from './deletion.service'
import { RequestDeletionDto } from './dto/request-deletion.dto'

/**
 * 家庭数据删除（W7-D，2026-10-27）—— `02` §9.20 的「可删除」半边。
 *
 *      GET  /family-deletion          → 看状态（有无待执行请求 / 剩余天数 / 执行摘要）
 *      POST /family-deletion          → 申请删除（`{ confirmed: true }`，7 天冷却期）
 *      POST /family-deletion/cancel   → 撤销待执行的请求
 *
 * ── 为什么路由是 `/family-deletion`（无 childId）────────────────────────────
 *   与 `/export` / `/child` 同一原则：**孩子身份只来自会话**。路径里再带一个
 *   id 就给了客户端第二种「删谁」的写法；不一致时只能二选一 —— 不必要的歧义，
 *   而且那正是「跨孩子删除」这类事故的入口。
 *
 * ── 三道屏障，**没有** `ConsentGuard` ──────────────────────────────────────
 *   `DeviceSessionGuard` → `MembershipGuard` → `PermissionsGuard`。
 *   `view_family_deletion` / `manage_family_deletion` 都是 guardian ALLOW /
 *   child DENY ⇒ 孩子设备 403。
 *   ★ 这里**刻意不挂** `ConsentGuard`：撤回同意后仍必须能删除自己的数据
 *     （`contracts/consent-policy.ts` 把它们归入豁免集合，04 §5）。
 *     若有人「顺手统一守卫顺序」把同意闸门加进来，撤回同意的家长就再也删不掉
 *     数据 —— 而所有用例仍会全绿（因为大家都跑在 granted 上）。这条由
 *     `test/deletion-wiring.test.ts` 对着守卫元数据钉住。
 *
 * ── 200 而不是 201 ─────────────────────────────────────────────────────────
 *   申请删除是对**同一资源状态**的幂等推进（已在冷却期时回同一条请求、
 *   不重复写审计），与 `POST /consent` 同一口径。
 */
@Controller('family-deletion')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class DeletionController {
  constructor(private readonly service: DeletionService) {}

  @Get()
  @RequireAction('view_family_deletion')
  async state(@Req() req: RequestWithActor): Promise<FamilyDeletionState> {
    return await this.service.read(this.childIdOf(req))
  }

  @Post()
  @HttpCode(200)
  @RequireAction('manage_family_deletion')
  async request(
    @Body() dto: RequestDeletionDto,
    @Req() req: RequestWithActor
  ): Promise<FamilyDeletionState> {
    return await this.service.request(this.childIdOf(req), dto, this.actorOf(req))
  }

  @Post('cancel')
  @HttpCode(200)
  @RequireAction('manage_family_deletion')
  async cancel(@Req() req: RequestWithActor): Promise<FamilyDeletionState> {
    return await this.service.cancel(this.childIdOf(req), this.actorOf(req))
  }

  /** 孩子上下文由身份 Guard 填入（同 `ReadController` / `ExportController`）。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'DeletionController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }

  /** 操作人由身份 Guard 填入；缺了是装配错误（与 `ApprovalsController` 同一口径）。 */
  private actorOf(req: RequestWithActor): DeletionOperator {
    if (req.kpActor === undefined) {
      throw new Error('DeletionController 缺少 DeviceSessionGuard：请求没有 kpActor')
    }
    return { userId: req.kpActor.userId, role: req.kpActor.role }
  }
}

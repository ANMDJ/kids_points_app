import {
  Body,
  Controller,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards
} from '@nestjs/common'

import { TemporaryRoleHeaderGuard } from '../device-session/temporary-role.guard'
import { MembershipGuard } from '../membership/membership.guard'
import type { RequestWithActor } from '../permissions/actor'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import { ApprovalsService } from './approvals.service'
import { CreateApprovalRequestDto } from './dto/create-approval-request.dto'
import { DecideApprovalRequestDto } from './dto/decide-approval-request.dto'

/**
 * 审批 HTTP 入口（**本仓库第一个真实 controller**，2026-10-14 阶段 B4）。
 *
 * ── 这一步在修什么 ────────────────────────────────────────────────────
 *   `approval-policy.ts` 此前是**死代码**：判定写对了，但**没有任何请求路径调用它**
 *   （B3 的诚实标注：「HTTP 路径尚未开工」）。判定不被消费 = 没有被验证过的判定。
 *   本文件把它接上线上路径，且**只做搬运** —— 判定在 service，落库在 port。
 *
 * ── 状态码口径（`02` §9）──────────────────────────────────────────────
 *   · `202` 建了 `pending`（§9.3：孩子申请加分 → 202 + `status:pending`）
 *   · `201` 显式自批 → 直接 `approved` ＋ 流水（§9.25）
 *   · `400 SELF_APPROVAL_NOT_ALLOWED` 显式要求自批却没资格（§9.26）
 *   · `200` 批准 / 拒绝成功；`403` 无批准资格；`409 ALREADY_DECIDED` 已决；`404` 没有这条
 *   · `401` 身份头不全（`x-kp-role` / `x-kp-user-id` / `x-kp-child-id`）；`503` 生产环境（身份未落地）
 *   · **`403 MEMBER_NOT_FOUND` / `MEMBER_REMOVED`** 屏障一（§9.21，W1-B 起）
 *   · **`500 INVALID_MEMBER_RESTRICTIONS` / `INVALID_MEMBER_ROLE`** 成员位形状坏了（**不是**权限问题）
 *   · `501 APPROVALS_PERSISTENCE_NOT_IMPLEMENTED` / `MEMBERSHIP_QUERY_NOT_IMPLEMENTED`
 *     **默认装配**下的两个 fail-closed 端口（见各自 repository）
 *
 * ★ 响应状态码随「判定结果」变化，故由 service 带出来、controller 落到 `res.status()`；
 *   这里**不做任何 if (role …) 判断**（判定只有一处，见 service 头注释）。
 */
@Controller('approvals')
// ★ `@UseGuards` 的**数组顺序就是语义** = 三道屏障的顺序（02 §3）：
//     身份（填 kpActor / kpChildId） → **屏障一**（成员资格门，填 kpMember） → **屏障二/三**（矩阵 ＋ 成员级收紧）
//   反着写的后果各不相同，但都属于"看起来在安全"：
//     · 判定在身份之前 ⇒ `PermissionsGuard` 读到空 actor 并**抛错**（刻意响亮，见 guard 类注释）；
//     · 资格在矩阵之后 ⇒ 非成员先收到"角色不被允许"这种**含义错误**的 403（02 §3 的顺序是有理由的）。
//   Nest 的执行顺序是「全局 → 控制器 → 方法」，同一层级内按数组顺序 —— 这也是
//   屏障二**不能**改成 `APP_GUARD` 的原因。
@UseGuards(TemporaryRoleHeaderGuard, MembershipGuard, PermissionsGuard)
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly service: ApprovalsService) {}

  /** 只用到 `status()`：用结构类型而非 import express 类型，免得为一行代码引入新依赖。 */
  private static applyStatus(res: { status(code: number): unknown }, code: number): void {
    res.status(code)
  }

  // 屏障二：矩阵 `request_approval`（guardian ALLOW / child ALLOW）——
  // 两个角色都**有权提出**申请；「谁能批」是另一个动作（见下一个端点）。
  @Post()
  @RequireAction('request_approval')
  async create(
    @Body() dto: CreateApprovalRequestDto,
    @Req() req: RequestWithActor,
    @Res({ passthrough: true }) res: { status(code: number): unknown }
  ): Promise<unknown> {
    const result = await this.service.createRequest(dto, this.actorOf(req))
    ApprovalsController.applyStatus(res, result.statusCode)
    return result.body
  }

  // 屏障二：矩阵 `review_approvals`（guardian ALLOW / child DENY）——
  // 孩子在**这里**就被拦下（403），不会走到 service：这正是屏障二该干的事。
  @Post(':id/decide')
  @RequireAction('review_approvals')
  async decide(
    @Param('id') id: string,
    @Body() dto: DecideApprovalRequestDto,
    @Req() req: RequestWithActor,
    @Res({ passthrough: true }) res: { status(code: number): unknown }
  ): Promise<unknown> {
    const result = await this.service.decide(id, dto, this.actorOf(req))
    ApprovalsController.applyStatus(res, result.statusCode)
    return result.body
  }

  /**
   * Guard 已保证 `kpActor` 存在（否则请求在 401 就结束了）。
   * 这里再断言一次是**编译期**需要（`kpActor` 是可选字段），不是为了再判一遍权限。
   */
  private actorOf(req: RequestWithActor): NonNullable<RequestWithActor['kpActor']> {
    if (req.kpActor === undefined) {
      // 走到这里 = Guard 没执行（装配漏了 @UseGuards）—— 响亮失败，绝不落到默认角色。
      throw new Error('ApprovalsController 缺少 TemporaryRoleHeaderGuard：请求没有 actor')
    }
    return req.kpActor
  }
}

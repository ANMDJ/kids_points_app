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

import {
  TemporaryRoleHeaderGuard,
  type RequestWithActor
} from '../device-session/temporary-role.guard'
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
 *   · `401` 缺身份；`503` 生产环境（身份未落地，见 guard）
 *   · `501 APPROVALS_PERSISTENCE_NOT_IMPLEMENTED` **默认装配**下的写入路径（见 repository）
 *
 * ★ 响应状态码随「判定结果」变化，故由 service 带出来、controller 落到 `res.status()`；
 *   这里**不做任何 if (role …) 判断**（判定只有一处，见 service 头注释）。
 */
@Controller('approvals')
@UseGuards(TemporaryRoleHeaderGuard)
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly service: ApprovalsService) {}

  /** 只用到 `status()`：用结构类型而非 import express 类型，免得为一行代码引入新依赖。 */
  private static applyStatus(res: { status(code: number): unknown }, code: number): void {
    res.status(code)
  }

  @Post()
  async create(
    @Body() dto: CreateApprovalRequestDto,
    @Req() req: RequestWithActor,
    @Res({ passthrough: true }) res: { status(code: number): unknown }
  ): Promise<unknown> {
    const result = await this.service.createRequest(dto, this.actorOf(req))
    ApprovalsController.applyStatus(res, result.statusCode)
    return result.body
  }

  @Post(':id/decide')
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

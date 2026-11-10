import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards
} from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { IdempotencyService } from '../idempotency/idempotency.service'
import { MembershipGuard } from '../membership/membership.guard'
import type { RequestWithActor } from '../permissions/actor'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import { ApprovalsService } from './approvals.service'
import type { ApprovalDetailDto, ApprovalInboxPageDto } from './approval-inbox.mapper'
import { CreateApprovalRequestDto } from './dto/create-approval-request.dto'
import { DecideApprovalRequestDto } from './dto/decide-approval-request.dto'
import { ListApprovalsQueryDto } from './dto/list-approvals.query'

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
 *   · `200` 批准 / 拒绝 / **撤回**成功；`403` 无批准资格 / `403 NOT_REQUESTER` 不是申请人本人撤回；
 *     `403 ACTION_NOT_ALLOWED` 目标动作在矩阵里是 `DENY`（连申请都不许提，W3-C）；
 *     `409 ALREADY_DECIDED` 已决（含已撤回后再撤）；`404` 没有这条**或不属于这个孩子**（W3-B 起同一回答）
 *   · `401 UNAUTHENTICATED` 缺 `x-kp-device-id` / `x-kp-child-id`；`401 SESSION_NOT_FOUND` 没会话（有库时由真适配器回答）；
 *     `503 IDENTITY_NOT_IMPLEMENTED` 生产环境（设备凭据尚不可验）；`501 SESSION_LOOKUP_NOT_IMPLEMENTED` **仅无库装配**
 *     ★ **W1-C 起角色/身份不再来自请求头**（`x-kp-role` / `x-kp-user-id` 已废弃、不被读取）
 *   · **`403 MEMBER_NOT_FOUND` / `MEMBER_REMOVED`** 屏障一（§9.21，W1-B 起；W2-D 起有库时真查 `ChildMember`）
 *   · **`500 INVALID_MEMBER_RESTRICTIONS` / `INVALID_MEMBER_ROLE`** 成员位形状坏了（**不是**权限问题）
 *   · **`500 INVALID_SESSION_ROLE` / `INVALID_SESSION_EXPIRY` / `SESSION_CHILD_MISMATCH`**
 *     会话行形状坏了（**不是**权限问题，W1-C 起）
 *   · `501 APPROVALS_PERSISTENCE_NOT_IMPLEMENTED`（**仅无库装配**）/
 *     `MEMBERSHIP_QUERY_NOT_IMPLEMENTED`、`SESSION_LOOKUP_NOT_IMPLEMENTED`（**仅无库装配**）
 *   ★ W3-A 起有库时审批端口是真 Prisma 适配器（不再 501）；W3-B 起 decide / withdraw
 *     都按 `x-kp-child-id` 收口 —— 跨孩子的审批 id 与「不存在」同样返回 404。
 *
 * ★ 响应状态码随「判定结果」变化，故由 service 带出来、controller 落到 `res.status()`；
 *   这里**不做任何 if (role …) 判断**（判定只有一处，见 service 头注释）。
 */
@Controller('approvals')
// ★ `@UseGuards` 的**数组顺序就是语义** = 三道屏障的顺序（02 §3）：
//     身份（会话解析 → 填 kpActor / kpChildId） → **屏障一**（成员资格门，填 kpMember） → **屏障二/三**（矩阵 ＋ 成员级收紧）
//   反着写的后果各不相同，但都属于"看起来在安全"：
//     · 判定在身份之前 ⇒ `PermissionsGuard` 读到空 actor 并**抛错**（刻意响亮，见 guard 类注释）；
//     · 资格在矩阵之后 ⇒ 非成员先收到"角色不被允许"这种**含义错误**的 403（02 §3 的顺序是有理由的）。
//   Nest 的执行顺序是「全局 → 控制器 → 方法」，同一层级内按数组顺序 —— 这也是
//   屏障二**不能**改成 `APP_GUARD` 的原因。
//   ★ W7-A 起数组**末尾**多了 `ConsentGuard`（第四道：同意闸门）。它排在矩阵之后，
//     因为「你准不准做」比「现在能不能做」更根本（见 consent.guard.ts 类注释）。
//     `withdraw_request` / `view_own_approvals` 是它的豁免动作 —— 撤回后仍能撤回自己的申请。
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
export class ApprovalsController {
  constructor(
    @Inject(ApprovalsService) private readonly service: ApprovalsService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService
  ) {}

  /** 只用到 `status()`：用结构类型而非 import express 类型，免得为一行代码引入新依赖。 */
  private static applyStatus(res: { status(code: number): unknown }, code: number): void {
    res.status(code)
  }

  /** 「我的申请」（W5-J）：孩子 / 家长都能查**自己**提的；别人提的永远看不到。 */
  @Get('mine')
  @RequireAction('view_own_approvals')
  async listMine(
    @Query() query: ListApprovalsQueryDto,
    @Req() req: RequestWithActor
  ): Promise<ApprovalInboxPageDto> {
    return this.service.listMine(query, this.actorOf(req), this.childIdOf(req))
  }

  /**
   * 单条详情（P1-3，2026-11-10）：`GET /approvals/:id`。
   *
   * ★ 为什么用 `view_own_approvals` 而不是 `review_approvals`：
   *   详情页同时服务家长（收件箱 / 「有人提交了申请」通知）与申请人
   *   （「我的申请」/ 审批结果通知）。矩阵里 `view_own_approvals` 两侧 ALLOW，
   *   真正的收口在 service 的 `detailDenial()`（家长按批准资格、其余按本人）。
   *   若挂 `review_approvals`，孩子会被拦在 403，通知深链就永远打不开自己的申请。
   *
   * ★ 路由顺序：`mine` 必须排在 `:id` 之前声明，否则 `/approvals/mine`
   *   会被当成 id=`mine` 的行去查（Nest 按声明顺序匹配）。
   */
  @Get(':id')
  @RequireAction('view_own_approvals')
  async detail(@Param('id') id: string, @Req() req: RequestWithActor): Promise<ApprovalDetailDto> {
    return this.service.detail(id, this.actorOf(req), this.childIdOf(req))
  }

  /**
   * 家长收件箱（W5-D）：`GET /approvals?status=pending&limit=20&cursor=…`
   *
   * 屏障二：矩阵 `review_approvals`（guardian ALLOW / child **DENY**）——
   * 孩子在这里就被 403 拦下，不会走到 service。这解决了一个具体事故：
   * 之前孩子端只能看到「我提交的那条」的返回体，而家长端**完全没有**列表，
   * 唯一能看到待批申请的途径是消息通知（不存在）——审批写进去了却没人看得到。
   *
   * ★ 响应 `200` 恒为分页对象（`items` / `hasMore` / `nextCursor`），
   *   即使 `items` 为空也是 `200`：空收件箱是**正常状态**，不是错误。
   *   权限 / 身份 / 游标错误分别是 403 / 401 / 400，码见 controller 头部。
   */
  @Get()
  @RequireAction('review_approvals')
  async list(
    @Query() query: ListApprovalsQueryDto,
    @Req() req: RequestWithActor
  ): Promise<ApprovalInboxPageDto> {
    return this.service.list(query, this.childIdOf(req))
  }

  // 屏障二：矩阵 `request_approval`（guardian ALLOW / child ALLOW）——
  // 两个角色都**有权提出**申请；「谁能批」是另一个动作（见下一个端点）。
  @Post()
  @RequireAction('request_approval')
  async create(
    @Body() dto: CreateApprovalRequestDto,
    @Req() req: RequestWithActor,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<unknown> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)
    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: dto.action,
        requestHash: IdempotencyService.hashRequest('POST', '/approvals', dto)
      },
      () => this.service.createRequest(dto, actor, childId)
    )
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
    @Res({ passthrough: true }) res: { status(code: number): unknown },
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<unknown> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)
    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'review_approvals',
        requestHash: IdempotencyService.hashRequest('POST', `/approvals/${id}/decide`, dto)
      },
      () => this.service.decide(id, dto, actor, childId)
    )
    ApprovalsController.applyStatus(res, result.statusCode)
    return result.body
  }

  /**
   * 申请人撤回（`02` §4.1 的 `withdrawn` 终态）。
   *
   * 屏障二：矩阵 `withdraw_request`（guardian / child 都是 ALLOW）。
   * 「是不是**本人**的申请」不在这里判 —— 那需要读行，属于 service / 端口；
   * 本端点因此对两个角色都开放，非本人会得到 `403 NOT_REQUESTER`（而不是 403 FORBIDDEN）。
   *
   * ★ 为什么单独一个端点，而不是 `decide: { decision: 'withdrawn' }`：
   *   批准/拒绝是**有权批的人**的动作，撤回是**申请人**的动作；合并会让
   *   「谁能写哪个状态」变成一句含糊的矩阵，且 `child` 能批自己的申请会绕过 §4.5。
   */
  @Post(':id/withdraw')
  @RequireAction('withdraw_request')
  async withdraw(
    @Param('id') id: string,
    @Req() req: RequestWithActor,
    @Res({ passthrough: true }) res: { status(code: number): unknown },
    @Headers('idempotency-key') idempotencyKey?: string
  ): Promise<unknown> {
    const actor = this.actorOf(req)
    const childId = this.childIdOf(req)
    const result = await this.idempotency.run(
      {
        key: idempotencyKey,
        childId,
        userId: actor.userId,
        actionType: 'withdraw_request',
        requestHash: IdempotencyService.hashRequest('POST', `/approvals/${id}/withdraw`, null)
      },
      () => this.service.withdraw(id, actor, childId)
    )
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
      throw new Error('ApprovalsController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）')
    }
    return req.kpActor
  }

  /**
   * 同理：`kpChildId` 由身份 Guard 写、屏障一验过（成员关系就是对着它查的）。
   *
   * ★ 为什么不能从 `dto.targetId` / 请求体里取孩子 id：那等于让客户端决定
   *   「这条审批挂谁」，而权限校验的是会话里的另一个孩子 —— 最糟的一类越权。
   */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'ApprovalsController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

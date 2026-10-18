import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import type { RequestWithActor } from '../permissions/actor'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import { ListRecordsQueryDto } from './dto/list-records.query'
import type { HomeResponse, RecordsResponse } from './read.mapper'
import { ReadService } from './read.service'

/** 记录页的默认页大小（客户端不传 `limit` 时）。 */
export const DEFAULT_RECORD_LIMIT = 50

/**
 * 只读 HTTP 入口（W4-A，2026-10-18）：`GET /home` ＋ `GET /records`。
 *
 * ── 它补的是哪一段 ──────────────────────────────────────────────────────────
 *   此前后端只有审批的三条写端点（`POST /approvals…`），而双端 AppStore 的数据
 *   全部来自 `seed_data.dart` / `seed.ts`。**一个只写不读的后端**无法支撑 W4
 *   的「双端接 API」：客户端就算把打卡换成 HTTP，刷新后仍然读不到任何东西。
 *
 * ── 屏障与动作 ──────────────────────────────────────────────────────────────
 *   `@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)` —— 与
 *   `/approvals` **同一顺序**（身份 → 资格 → 矩阵＋收紧），理由见 `approvals.controller.ts`。
 *   · `GET /home`    → 矩阵 `view_child_points`（guardian / child 均 ALLOW）
 *   · `GET /records` → 矩阵 `view_records`      （guardian / child 均 ALLOW）
 *   ★ 两个端点都**只读**：没有 202、没有幂等键 —— 重复请求不会改变任何东西。
 *     因此它们也不消费 `approval-policy.ts`（那是写路径的判定）。
 *
 * ── 状态码 ──────────────────────────────────────────────────────────────────
 *   · 200 正常；
 *   · 401 `UNAUTHENTICATED` / `SESSION_NOT_FOUND`（缺身份头 / 无会话）；
 *   · 403 `MEMBER_NOT_FOUND` / `MEMBER_REMOVED`（屏障一）；
 *   · 404 `CHILD_NOT_FOUND`（成员位还在，但 Child 行已删）；
 *   · 400（`?limit=0` / `?limit=201` / 未知分类 / 未知查询键 / 非法 `cursor`）；
 *   · 501 `READ_MODEL_NOT_IMPLEMENTED`（**仅无库装配**，绝不返回空数据冒充成功）。
 */
@Controller()
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class ReadController {
  constructor(@Inject(ReadService) private readonly service: ReadService) {}

  /** 首页 / 规则 / 心愿 / 我的页共用的一份快照。 */
  @Get('home')
  @RequireAction('view_child_points')
  async home(@Req() req: RequestWithActor): Promise<HomeResponse> {
    return this.service.home(this.childIdOf(req))
  }

  /** 记录页：按分类筛选 + 分页。 */
  @Get('records')
  @RequireAction('view_records')
  async records(
    @Query() query: ListRecordsQueryDto,
    @Req() req: RequestWithActor
  ): Promise<RecordsResponse> {
    return this.service.records(
      this.childIdOf(req),
      query.category,
      query.limit ?? DEFAULT_RECORD_LIMIT,
      query.cursor
    )
  }

  /**
   * 孩子上下文由身份 Guard 填入，且屏障一已经**对着它**查过成员位。
   *
   * ★ 绝不从 query / body 取 childId：那等于让客户端决定读谁的数据，
   *   而权限校验的是会话里的另一个孩子 —— 最糟的一类越权（与审批 controller 同一条）。
   */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'ReadController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

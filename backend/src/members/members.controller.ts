import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Req,
  UseGuards
} from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import {
  DEVICE_ID_HEADER,
  DeviceSessionGuard
} from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { Actor, RequestWithActor } from '../permissions/actor'
import { UpdateMemberRoleDto } from './dto/update-member-role.dto'
import { MembersService } from './members.service'
import type {
  MemberDto,
  MemberListResponse,
  MemberRemoveResponse
} from './members.types'

/**
 * 家庭成员（W5-H，2026-10-22）—— 三条路由，全部三道屏障。
 *
 *   GET    /members       `view_members`        guardian ALLOW / child ALLOW
 *   PATCH  /members/:id   `change_member_role`  guardian ALLOW / child **DENY**
 *   DELETE /members/:id   `remove_member`       guardian ALLOW / child **DENY**
 *
 * ── 为什么 `GET /members` 对孩子开放 ────────────────────────────────────────
 *   孩子本来就看得见"家里有谁"（选择器里能切到的家庭成员就是他认识的），
 *   藏起来只会让界面出现"一个匿名家长"。列表只含 `displayName` / 角色 / 时间，
 *   **不含**手机号、openId、PIN 任何字段 —— 它不是敏感数据，是"这个家有几口人"。
 *   与 `view_trash` 同一判断：删之前本来就看得见的内容，隐藏没有意义。
 *
 * ── 为什么改角色与移出都是"改别人"而不是"改自己" ───────────────────────────
 *   两条路由都**禁止**作用于自己（适配器回答 403 `CANNOT_MODIFY_SELF`）：
 *   · 自我降级 = 一次误触就把自己锁在门外，而**没有家长能把你救回来**
 *     （能救的人也被你降掉了）；
 *   · "退出家庭"是**另一个**产品决定（需要迁移数据、决定流水归属），
 *     不该由 `DELETE /members/:id` 顺手实现。
 *   两条都拒绝后，"最后一位家长"保护才真正成立：只剩一位家长时，他既不能
 *   降自己、也不能被自己移出，而别人动他就撞上 `LAST_GUARDIAN_PROTECTED`。
 *
 * ── 为什么没有 `Idempotency-Key` ────────────────────────────────────────────
 *   · `PATCH`：目标角色相同 ⇒ 200 且**不写审计**（构造幂等）；
 *   · `DELETE`：已经移出 ⇒ 200 且不写第二条审计（同 `revoke` 的手法）。
 *   两者都不需要缓存一个"重放结果" —— 结果本来就一样。
 *
 * ── 为什么没有 `expectedVersion` / `If-Match` ───────────────────────────────
 *   最后一个家长的保护由**库层面的串行化**保证（适配器里锁住该孩子的成员位
 *   再计数），不靠客户端版本号。版本号只能防"基于旧视图的覆盖"，而这里真正
 *   危险的并发是**两个家长同时把对方降级**，他们看到的是同一个版本。
 */
@Controller('members')
export class MembersController {
  constructor(private readonly service: MembersService) {}

  @Get()
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
  @RequireAction('view_members')
  async list(@Req() req: RequestWithActor): Promise<MemberListResponse> {
    return await this.service.listMembers(this.childIdOf(req), this.actorOf(req))
  }

  @Patch(':id')
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
  @RequireAction('change_member_role')
  async changeRole(
    @Param('id') id: string,
    @Body() dto: UpdateMemberRoleDto,
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<MemberDto> {
    return await this.service.changeMemberRole(
      this.childIdOf(req),
      id,
      dto,
      this.actorOf(req),
      this.deviceIdOf(deviceId)
    )
  }

  @Delete(':id')
  @UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
  @HttpCode(200)
  @RequireAction('remove_member')
  async remove(
    @Param('id') id: string,
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Req() req: RequestWithActor
  ): Promise<MemberRemoveResponse> {
    return await this.service.removeMember(
      this.childIdOf(req),
      id,
      this.actorOf(req),
      this.deviceIdOf(deviceId)
    )
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄（缺失 = 装配错误）。 */
  private actorOf(req: RequestWithActor): Actor {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error(
        'MembersController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）'
      )
    }
    return actor
  }

  /** `kpChildId` 由身份 Guard 写、屏障一验过。**绝不**从请求体 / 路径取孩子 id。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'MembersController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }

  /**
   * 设备 id 只用于审计（"从哪台设备改的"）。
   *
   * 与邀请码的 `accept` 不同，这里**不是**必需项：身份 Guard 已经确认头存在，
   * 但审计字段缺失不该把一次合法操作变成 500 —— 留 null 比编一个假设备 id 诚实。
   */
  private deviceIdOf(deviceId: string | undefined): string | null {
    if (typeof deviceId !== 'string') return null
    const trimmed = deviceId.trim()
    return trimmed === '' ? null : trimmed
  }
}

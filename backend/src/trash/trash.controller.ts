import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards
} from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { Actor, RequestWithActor } from '../permissions/actor'
import { TrashService } from './trash.service'
import type { TrashListResponse, TrashMutationResponse } from './trash.types'

/**
 * 回收站（W5-F，2026-10-21）—— 三条路由，三条权限，各自独立。
 *
 *   GET    /trash                `view_trash`          家长 ALLOW / 孩子 ALLOW（只读）
 *   POST   /trash/:kind/:id/restore  `restore_trash_item` 家长 ALLOW / 孩子 DENY
 *   DELETE /trash/:kind/:id          `purge_trash_item`   家长 ALLOW / 孩子 DENY
 *
 * ── 为什么孩子能看、不能改 ────────────────────────────────────────────────
 *   "我删掉的那张卡不见了" 是孩子最需要自己确认的事（C9 的原始抱怨）。
 *   看见回收站能消除"东西凭空消失"的恐惧；恢复/彻底删除是不可逆的配置变更，
 *   仍然只属于监护人（与 `delete_rule` / `delete_wish` 同侧）。
 *
 * ── 为什么不做幂等键 ──────────────────────────────────────────────────────
 *   · 恢复本身就是幂等的：重复调用返回同一 `{kind,id}`，不写第二条审计；
 *   · 彻底删除重复调用得到 404（这一项真的不在了）—— 这正是**应当**给出的答案。
 *   再加一层响应缓存只会多一个"缓存说成功、库里已没有"的中间态。
 */
@Controller('trash')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)
export class TrashController {
  constructor(private readonly service: TrashService) {}

  @Get()
  @RequireAction('view_trash')
  async list(@Req() req: RequestWithActor): Promise<TrashListResponse> {
    return this.service.list(this.childIdOf(req))
  }

  @Post(':kind/:id/restore')
  @HttpCode(200)
  @RequireAction('restore_trash_item')
  async restore(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Req() req: RequestWithActor
  ): Promise<TrashMutationResponse> {
    const actor = this.actorOf(req)
    return this.service.restore(this.childIdOf(req), kind, id, actor)
  }

  @Delete(':kind/:id')
  @HttpCode(200)
  @RequireAction('purge_trash_item')
  async purge(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Req() req: RequestWithActor
  ): Promise<TrashMutationResponse> {
    const actor = this.actorOf(req)
    return this.service.purge(this.childIdOf(req), kind, id, actor)
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄（缺失 = 装配错误）。 */
  private actorOf(req: RequestWithActor): Actor {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error(
        'TrashController 缺少 DeviceSessionGuard：请求没有 actor（身份解析没跑）'
      )
    }
    return actor
  }

  /** `kpChildId` 由身份 Guard 写、屏障一验过。**绝不**从查询串/请求体取孩子 id。 */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'TrashController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

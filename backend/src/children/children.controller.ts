import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Patch,
  Req,
  UseGuards
} from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { MembershipGuard } from '../membership/membership.guard'
import { PermissionsGuard } from '../permissions/permissions.guard'
import { RequireAction } from '../permissions/require-action.decorator'
import type { RequestWithActor } from '../permissions/actor'
import type { ChildOperator, ChildProfileDto } from './children.service'
import { ChildrenService } from './children.service'
import { UpdateChildProfileDto } from './dto/update-child-profile.dto'

/**
 * 孩子档案（W5-E，2026-10-21）—— `PATCH /child` 改昵称。
 *
 * ── 路由为什么是 `/child`（单数、无 id）────────────────────────────────────
 *   孩子身份**只**来自会话（`x-kp-device-id` + `x-kp-child-id` 解析出的
 *   `kpChildId`）。路径里再带一个 id 就等于给客户端第二种「改谁」的写法，
 *   两者不一致时我们只能二选一 —— 那是不必要的歧义。与
 *   `POST /records/check-in`（习惯 id 在体内、孩子 id 在会话）同一原则：
 *   身份永远来自会话，业务目标才来自请求。
 *
 * ── 三道屏障 ───────────────────────────────────────────────────────────────
 *   `DeviceSessionGuard` → `MembershipGuard` → `PermissionsGuard`；
 *   `edit_child_profile` 在矩阵里是 guardian ALLOW / child DENY ⇒ 孩子设备 403，
 *   viewer 也不是成员 ⇒ 屏障一就拦下。
 *   ★ W7-A 起还有**第四道** `ConsentGuard`（同意闸门）：撤回同意后 `PATCH /child`
 *   一律 `403 CONSENT_REQUIRED`（清单见 `contracts/consent-policy.ts`）。
 *
 * ── 为什么不需要 `Idempotency-Key` ─────────────────────────────────────────
 *   PATCH 是**幂等**的：重复提交同一个昵称，第二次在仓储里命中「同名」分支，
 *   不写 UPDATE、不写审计，回同一个 200。客户端重试不会产生第二条
 *   `child.rename` 审计 —— 这比额外维护一份响应缓存更简单也更诚实。
 */
@Controller('child')
@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard, ConsentGuard)
export class ChildrenController {
  constructor(private readonly service: ChildrenService) {}

  @Patch()
  @HttpCode(200)
  @RequireAction('edit_child_profile')
  async rename(
    @Body() dto: UpdateChildProfileDto,
    @Req() req: RequestWithActor
  ): Promise<ChildProfileDto> {
    return await this.service.renameChild(
      this.childIdOf(req),
      dto,
      this.actorOf(req)
    )
  }

  /** Guard 已保证 `kpActor` 存在；这里断言是为了编译期类型收窄。 */
  private actorOf(req: RequestWithActor): ChildOperator {
    const actor = req.kpActor
    if (actor === undefined) {
      throw new Error('ChildrenController 缺少 DeviceSessionGuard：请求没有 actor')
    }
    if (actor.role === 'viewer') {
      // 矩阵对 viewer 一律 DENY；Guard 理应已拦下。这里再挡一次是防御纵深。
      throw new BadRequestException({
        code: 'CHILD_ACTOR_ROLE_INVALID',
        message: 'viewer 不能修改孩子档案。'
      })
    }
    return { userId: actor.userId, role: actor.role }
  }

  /**
   * `kpChildId` 由身份 Guard 写、屏障一验过。
   * ★ 绝不从请求体取孩子 id —— 那等于让客户端决定改谁家的档案。
   */
  private childIdOf(req: RequestWithActor): string {
    if (req.kpChildId === undefined) {
      throw new Error(
        'ChildrenController 缺少 DeviceSessionGuard：请求没有 kpChildId（孩子上下文没解析）'
      )
    }
    return req.kpChildId
  }
}

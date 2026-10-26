import { DynamicModule, Module, type Type } from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { ConsentModule } from '../consent/consent.module'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { MembersController } from './members.controller'
import { PrismaMembersRepository } from './members.prisma.repository'
import {
  MEMBERS_REPOSITORY,
  NotImplementedMembersRepository,
  type MembersPort
} from './members.repository'
import { MembersService } from './members.service'

/**
 * 家庭成员（W5-H，2026-10-22；02 §1 / §2 / §3）
 *
 * ── 接线 ──────────────────────────────────────────────────────────────────
 *   GET    /members       列出（`view_members`，孩子也看得见）
 *   PATCH  /members/:id   改角色（`change_member_role`，仅家长）
 *   DELETE /members/:id   移出（`remove_member`，仅家长；构造幂等）
 *
 * ── ★ 本模块是"角色"的一次真实写入点，所以必须同时回答三件事 ────────────────
 *   ① **谁能做**：矩阵（`change_member_role` / `remove_member` child DENY）。
 *      注意矩阵判的是**发起者**的角色；被改的那个人是不是家长，矩阵管不着。
 *   ② **会不会把家弄成没有家长**：最后一位家长既不能被降级、也不能被移出
 *      （`LAST_GUARDIAN_PROTECTED`）—— 判定必须在**库的事务里**完成，
 *      因为它是"还有几个家长"这种**集合**事实。
 *   ③ **改了之后，那个人此刻手上的会话怎么办**：`DeviceSession.activeRole`
 *      是服务端权威（02 §7），降级时不收回会话，那个人下一分钟仍是家长。
 *      ⇒ 降级与"把他的家长会话收回 child"必须**同一事务**；
 *        另外 `MembershipGuard` 把会话角色按成员位收口（`min`），
 *        作为第二道保险 —— 两条都做到，才不依赖"写路径记得同步"。
 *
 * ── 世界钉死（与 `InvitesModule` 同一手法）────────────────────────────────
 *   有库 ⇒ `PrismaMembersRepository`；无库 ⇒ `NotImplementedMembersRepository`
 *   （三个方法全 501：不返回空列表冒充"家里只有我一个人"，也不假装改成功）。
 *   `hasDatabase` 向下传给身份 / 成员模块，**只有一个来源**；用例必须显式传值。
 */
export function resolveMembersRepositoryClass(hasDatabase: boolean): Type<MembersPort> {
  return hasDatabase ? PrismaMembersRepository : NotImplementedMembersRepository
}

export interface MembersAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class MembersModule {
  static register(options: MembersAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: MembersModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule,
        // ★ W7-A：同意闸门（`change_member_role` / `remove_member` 是写动作；
        //   `view_members` 在 consent-policy 里是豁免 —— 不查库）。
        ConsentModule.register({ hasDatabase })
      ],
      controllers: [MembersController],
      providers: [
        MembersService,
        // 控制器上的 Guard 在本模块注入器里实例化 —— 依赖由上面三个模块 exports 提供。
        DeviceSessionGuard,
        // ★ W7-A：同意闸门（依赖 CONSENT_REPOSITORY 由 ConsentModule.exports 提供）。
        ConsentGuard,
        {
          provide: MEMBERS_REPOSITORY,
          useClass: resolveMembersRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

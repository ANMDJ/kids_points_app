import { DynamicModule, Module, type Type } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { ChildrenController } from './children.controller'
import { PrismaChildrenRepository } from './children.prisma.repository'
import {
  CHILDREN_REPOSITORY,
  NotImplementedChildrenRepository,
  type ChildrenPort
} from './children.repository'
import { ChildrenService } from './children.service'

/**
 * 孩子档案模块（W5-E，2026-10-21）。
 *
 * ── 接线 ──────────────────────────────────────────────────────────────────
 *   `PATCH /child`  改昵称（200 `{ childId, name }`，同事务写 `child.rename` 审计）
 *
 * ── 世界钉死（与 `RulesModule` / `HabitsModule` 同一手法）──────────────────
 *   有库 ⇒ `PrismaChildrenRepository`；无库 ⇒ `NotImplementedChildrenRepository`（501）。
 *   `hasDatabase` 向下传给身份 / 成员模块，**只有一个来源**；用例必须显式传值。
 */
export function resolveChildrenRepositoryClass(
  hasDatabase: boolean
): Type<ChildrenPort> {
  return hasDatabase ? PrismaChildrenRepository : NotImplementedChildrenRepository
}

export interface ChildrenAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class ChildrenModule {
  static register(options: ChildrenAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: ChildrenModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule
      ],
      controllers: [ChildrenController],
      providers: [
        ChildrenService,
        // 控制器上的三个 Guard 在本模块注入器里实例化 —— 依赖由上面三个模块 exports 提供。
        DeviceSessionGuard,
        {
          provide: CHILDREN_REPOSITORY,
          useClass: resolveChildrenRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

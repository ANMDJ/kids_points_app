import { DynamicModule, Module, type Type } from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { ConsentModule } from '../consent/consent.module'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { NotImplementedTrashRepository, TRASH_REPOSITORY, type TrashPort } from './trash.repository'
import { PrismaTrashRepository } from './trash.prisma.repository'
import { TrashController } from './trash.controller'
import { TrashService } from './trash.service'

/**
 * 回收站（W5-F，2026-10-21）—— 修 C9「删掉就找不回来」。
 *
 * ── 为什么不在 rules / wishes / habits 各自挂三条回收站路由 ────────────────
 *   回收站是**一个**界面、**一套**权限（见权限矩阵 `view_trash` 等）。
 *   拆进三个模块会让"能不能彻底删除"出现三份实现，而它们必须永远一致。
 *
 * ── 世界钉死（与 HabitsModule / ReadModule 同一手法）──────────────────────
 *   有库 ⇒ `PrismaTrashRepository`；无库 ⇒ `NotImplementedTrashRepository`（三个方法全 501）。
 *   用例必须写 `TrashModule.register({ hasDatabase: false })` —— 否则同一份用例
 *   在有 `.env` 的开发机与 CI 上验的是两件事。
 */
export function resolveTrashRepositoryClass(hasDatabase: boolean): Type<TrashPort> {
  return hasDatabase ? PrismaTrashRepository : NotImplementedTrashRepository
}

export interface TrashAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class TrashModule {
  static register(options: TrashAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: TrashModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错，
        // 静态导入会让离线 `npm test` 在装配阶段就崩（同 HabitsModule）。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule,
        // ★ W7-A：同意闸门（`restore_trash_item` / `purge_trash_item` 是写动作）。
        ConsentModule.register({ hasDatabase })
      ],
      controllers: [TrashController],
      providers: [
        TrashService,
        // 控制器上的四个 Guard 在本模块注入器里实例化 —— 依赖由上面四个模块
        // （身份 / 成员 / 矩阵 / **同意**）的 exports 提供。
        DeviceSessionGuard,
        // ★ W7-A：同意闸门（依赖 CONSENT_REPOSITORY 由 ConsentModule.exports 提供）。
        ConsentGuard,
        {
          provide: TRASH_REPOSITORY,
          useClass: resolveTrashRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

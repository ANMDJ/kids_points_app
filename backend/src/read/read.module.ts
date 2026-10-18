import { DynamicModule, Module, type Type } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { PrismaReadRepository } from './read.prisma.repository'
import { READ_REPOSITORY, NotImplementedReadRepository, type ReadPort } from './read.repository'
import { ReadController } from './read.controller'
import { ReadService } from './read.service'

/**
 * 只读端口的实现选择（**唯一分叉点**，与 `LedgerModule` / `ApprovalsModule` 同一手法）。
 *
 * 有库 ⇒ `PrismaReadRepository`（真查）；
 * 无库 ⇒ `NotImplementedReadRepository`（两个方法都 501）。
 * ★ 两个分支**不许是同一个类** —— 否则「无库时仍然有数据」就是一种假绿，
 *   由 `test/read-wiring.test.ts` 直接钉住。
 */
export function resolveReadRepositoryClass(hasDatabase: boolean): Type<ReadPort> {
  return hasDatabase ? PrismaReadRepository : NotImplementedReadRepository
}

/**
 * 装配选项。**用例必须显式传值**：`hasDatabase` 省略时按环境推断，
 * 而同一份离线用例在「有 .env」的开发机与「没有」的 CI 上会验两件事。
 */
export interface ReadAssemblyOptions {
  hasDatabase?: boolean
}

/**
 * 只读模块（W4-A）—— `GET /home` / `GET /records`。
 *
 * ★ 宿主模块负责实例化控制器上的三个 Guard，因此必须 import 提供它们的三个模块
 *   （身份 / 屏障一 / 屏障二＋三），只 import 类是不够的：
 *   `Nest can't resolve dependencies of the DeviceSessionGuard (?)` 会在启动时炸
 *   （W1-B 在 `MembershipModule` 上实测过）。
 */
@Module({})
export class ReadModule {
  static register(options: ReadAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: ReadModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错，
        // 静态导入会让离线 `npm test` 在装配阶段就崩（同 LedgerModule）。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule
      ],
      controllers: [ReadController],
      providers: [
        ReadService,
        // 控制器上的 Guard 在本模块注入器里实例化 —— 依赖由上面三个模块的 exports 提供。
        DeviceSessionGuard,
        {
          provide: READ_REPOSITORY,
          useClass: resolveReadRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

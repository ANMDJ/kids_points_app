import { DynamicModule, Module, type Type } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { ExportController } from './export.controller'
import { PrismaExportRepository } from './export.prisma.repository'
import {
  EXPORT_REPOSITORY,
  NotImplementedExportRepository,
  type ExportPort
} from './export.repository'
import { ExportService } from './export.service'

/**
 * 导出端口的实现选择（**唯一分叉点**，与 `ReadModule` / `MembersModule` 同一手法）。
 *
 * 有库 ⇒ `PrismaExportRepository`（真查、一个事务读全份）；
 * 无库 ⇒ `NotImplementedExportRepository`（501）。
 * ★ 两个分支**不许是同一个类** —— 否则「无库时导出一份空文件」就是一种假绿，
 *   由 `test/export-wiring.test.ts` 直接钉住。
 */
export function resolveExportRepositoryClass(hasDatabase: boolean): Type<ExportPort> {
  return hasDatabase ? PrismaExportRepository : NotImplementedExportRepository
}

/** 装配选项。**用例必须显式传值**（理由同 `ReadAssemblyOptions`）。 */
export interface ExportAssemblyOptions {
  hasDatabase?: boolean
}

/**
 * 家庭数据导出模块（W7-C）—— `GET /export`。
 *
 * ★ 与 `ReadModule` 一样是**动态模块**：无库时不导入 `PrismaModule`
 *   （`PrismaService` 缺连接串会刻意抛错，静态导入会让离线 `npm test`
 *   在装配阶段就崩）。
 * ★ 控制器上的三个 Guard 在本模块注入器里实例化 —— 必须 import 提供它们的
 *   三个模块（只 import 类是不够的），否则 Nest 启动时解析依赖失败。
 */
@Module({})
export class ExportModule {
  static register(options: ExportAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: ExportModule,
      imports: [
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule
      ],
      controllers: [ExportController],
      providers: [
        ExportService,
        DeviceSessionGuard,
        {
          provide: EXPORT_REPOSITORY,
          useClass: resolveExportRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

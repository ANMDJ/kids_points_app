import { DynamicModule, Module, type Type } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { DeletionController } from './deletion.controller'
import { PrismaDeletionRepository } from './deletion.prisma.repository'
import {
  DELETION_REPOSITORY,
  NotImplementedDeletionRepository,
  type DeletionPort
} from './deletion.repository'
import { DeletionService } from './deletion.service'
import {
  DELETION_WORKER_CONFIG,
  FamilyDeletionWorker,
  resolveDeletionWorkerConfig
} from './deletion.worker'

/**
 * 删除端口的实现选择（**唯一分叉点**，与 `ReadModule` / `ExportModule` 同一手法）。
 *
 * 有库 ⇒ `PrismaDeletionRepository`；无库 ⇒ `NotImplementedDeletionRepository`（501）。
 * ★ 两个分支**不许是同一个类**：无库时回 200「已删除」是比报错更危险的假绿 ——
 *   家长会以为数据没了，而事实上一个字段都没动。
 */
export function resolveDeletionRepositoryClass(hasDatabase: boolean): Type<DeletionPort> {
  return hasDatabase ? PrismaDeletionRepository : NotImplementedDeletionRepository
}

export interface DeletionAssemblyOptions {
  hasDatabase?: boolean
  /** 用例可注入假时钟无关的 worker 参数；生产用环境变量解析结果。 */
  worker?: { enabled: boolean; intervalMs: number; batchSize: number }
}

/**
 * 家庭数据删除模块（W7-D）—— `/family-deletion` 三条路由 + 执行 worker。
 *
 * ★ 动态模块：无库时不导入 `PrismaModule`（缺连接串会在构造期抛错，
 *   静态导入会让离线 `npm test` 在装配阶段就崩）。
 * ★ 控制器上的三个 Guard 在本模块注入器里实例化，必须 import 提供它们的模块
 *   （只 import 类不够），否则 Nest 解析依赖失败。
 * ★ worker 也在这里注册：`main.ts` 通过 `app.get(FamilyDeletionWorker).start()` 启停。
 *   与 `PushRetryWorker` / 保留清理 worker 同一纪律：**定时器只有 `main.ts` 一个启动点**
 *   （模块装配不偷偷起线程），因此离线用例可以直接 `tick()` 而不必和后台定时器抢时序。
 *   无库装配时配置被强制禁用：端口本来就是 501，空转只会刷错误日志。
 */
@Module({})
export class DeletionModule {
  static register(options: DeletionAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    const requested = options.worker ?? resolveDeletionWorkerConfig()
    // 无库装配下端口一律 501：让定时器空转只会每 10 分钟写一条错误日志。
    const workerConfig = options.worker ?? { ...requested, enabled: hasDatabase && requested.enabled }

    return {
      module: DeletionModule,
      imports: [
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule
      ],
      controllers: [DeletionController],
      providers: [
        DeletionService,
        DeviceSessionGuard,
        FamilyDeletionWorker,
        { provide: DELETION_WORKER_CONFIG, useValue: workerConfig },
        {
          provide: DELETION_REPOSITORY,
          useClass: resolveDeletionRepositoryClass(hasDatabase)
        }
      ],
      exports: [FamilyDeletionWorker]
    }
  }
}

import { DynamicModule, Module, type Type } from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { ConsentModule } from '../consent/consent.module'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { IdempotencyModule } from '../idempotency/idempotency.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { HabitsController } from './habits.controller'
import { HabitsLifecycleController } from './habits.lifecycle.controller'
import { PrismaHabitsRepository } from './habits.prisma.repository'
import {
  HABITS_REPOSITORY,
  NotImplementedHabitsRepository,
  type HabitsPort
} from './habits.repository'
import { HabitsService } from './habits.service'

/**
 * 习惯（docs/design/03 A2 / A3 / E17）—— **W4-D 写入切片**（2026-10-19）。
 *
 * ── 本模块负责什么 ────────────────────────────────────────────────────────
 *   ① `POST /records/check-in`：孩子/家长打卡，经 `ledger.gate` 写一笔 praise 流水；
 *   ② `POST /records/:id/reverse`：家长撤销一条打卡（append-only 冲正，I5 / I6）。
 *   两件事都**不是**"直接改余额"：余额、顺序、审计与幂等全部走同一条
 *   `appendDraftInTx()`（`ledger/ledger.append.ts`）—— 这是 I2 能在真库上成立的前提。
 *
 * ── 结构字段（不是自由文本）──────────────────────────────────────────────
 *   `dailyLimit: Int`（修 A2）；`checked` / `doneText` / `limitText` **不落库**，
 *   由"本业务日仍有效的打卡数"推导（修 A3 / E17）—— 本模块的每日上限判定就是
 *   那个推导的写侧对应物。时区默认 `Asia/Shanghai`，可用 `KP_TIMEZONE` 覆盖。
 *
 * ── 世界钉死（与 `ReadModule` / `ApprovalsModule` 同一手法）────────────────
 *   有库 ⇒ `PrismaHabitsRepository`；无库 ⇒ `NotImplementedHabitsRepository`（两个方法都 501）。
 *   `hasDatabase` 同时向下传给身份 / 成员 / 幂等三个子模块，**只有一个来源**。
 *   用例必须写 `HabitsModule.register({ hasDatabase: false })`，否则同一份用例
 *   在有 `.env` 的开发机与 CI 上验的是两件事。
 *
 * ⚠️ 尚未落地（W5+）：习惯 CRUD（`addHabitFromRule` 仍只有注释里的验收要求）。
 *   2026-10-21 起 `DELETE /habits/:id`（软删 → 回收站）已在
 *   `HabitsLifecycleController` 落地；创建/编辑仍然只经由规则（没有第二个入口）。
 */
export function resolveHabitsRepositoryClass(hasDatabase: boolean): Type<HabitsPort> {
  return hasDatabase ? PrismaHabitsRepository : NotImplementedHabitsRepository
}

export interface HabitsAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class HabitsModule {
  static register(options: HabitsAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: HabitsModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错，
        // 静态导入会让离线 `npm test` 在装配阶段就崩（同 LedgerModule / ReadModule）。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule,
        // ★ W7-A：同意闸门。有库 ⇒ PrismaConsentRepository；无库 ⇒ 501（见 ConsentModule）。
        ConsentModule.register({ hasDatabase }),
        // 带 `Idempotency-Key` 的请求要先过幂等层；无库时它自己 501（不假装保护已生效）。
        IdempotencyModule.register({ hasDatabase })
      ],
      controllers: [HabitsController, HabitsLifecycleController],
      providers: [
        HabitsService,
        // 控制器上的四个 Guard 在本模块注入器里实例化 —— 依赖由上面四个模块
        // （身份 / 成员 / 矩阵 / **同意**）的 exports 提供。
        DeviceSessionGuard,
        // ★ W7-A：同意闸门（依赖 CONSENT_REPOSITORY 由 ConsentModule.exports 提供）。
        ConsentGuard,
        {
          provide: HABITS_REPOSITORY,
          useClass: resolveHabitsRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

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
import { PrismaRecordsRepository } from './records.prisma.repository'
import { RecordsController } from './records.controller'
import {
  NotImplementedRecordsRepository,
  RECORDS_REPOSITORY,
  type RecordsPort
} from './records.repository'
import { RecordsService } from './records.service'

/**
 * 积分流水写入（docs/design/03 C1 / B6 / B8）—— **W5-B 切片**（2026-10-20）。
 *
 * ── 本模块只负责一件事 ────────────────────────────────────────────────────
 *   `POST /records/adjust`：「记一笔」（家长手动加 / 扣分）。它不是"直接改余额"：
 *   余额、顺序、审计与幂等全部走 `appendDraftInTx()`（`ledger/ledger.append.ts`）
 *   —— 与打卡共用同一条内核，这是 `Σ流水 = 余额`（I2）能在真库上成立的前提。
 *
 * ── 为什么不并进 `HabitsModule` ────────────────────────────────────────────
 *   记一笔**没有习惯**：不读 `Habit`、不数每日上限、不查规则版本。共享的只有
 *   内核与追加器（代码复用），不是同一张表。并进去会让「习惯」这个词同时表示
 *   "check-in 的 host 实体"和"UI 上的一个分组"。
 *
 * ── 世界钉死（与 `HabitsModule` / `ReadModule` 同一手法）────────────────────
 *   有库 ⇒ `PrismaRecordsRepository`；无库 ⇒ `NotImplementedRecordsRepository`（501）。
 *   用例必须写 `RecordsModule.register({ hasDatabase: false })`，否则同一份用例
 *   在有 `.env` 的开发机与 CI 上验的是两件事。
 *
 * ⚠️ 仍未落地：心愿兑换（`exchange`）与「孩子申请加分」（`request_points_bonus`，
 *    走审批链路，见 `approvals` 模块）。
 */
export function resolveRecordsRepositoryClass(hasDatabase: boolean): Type<RecordsPort> {
  return hasDatabase ? PrismaRecordsRepository : NotImplementedRecordsRepository
}

export interface RecordsAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class RecordsModule {
  static register(options: RecordsAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: RecordsModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错，
        // 静态导入会让离线 `npm test` 在装配阶段就崩（同 HabitsModule / ReadModule）。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule,
        // ★ W7-A：同意闸门。有库 ⇒ PrismaConsentRepository；无库 ⇒ 501（见 ConsentModule）。
        ConsentModule.register({ hasDatabase }),
        // 带 `Idempotency-Key` 的请求要先过幂等层；无库时它自己 501。
        IdempotencyModule.register({ hasDatabase })
      ],
      controllers: [RecordsController],
      providers: [
        RecordsService,
        DeviceSessionGuard,
        // ★ W7-A：同意闸门（依赖 CONSENT_REPOSITORY 由 ConsentModule.exports 提供）。
        ConsentGuard,
        {
          provide: RECORDS_REPOSITORY,
          useClass: resolveRecordsRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

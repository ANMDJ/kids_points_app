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
import { PrismaRulesRepository } from './rules.prisma.repository'
import {
  NotImplementedRulesRepository,
  RULES_REPOSITORY,
  type RulesPort
} from './rules.repository'
import { RulesController } from './rules.controller'
import { RulesService } from './rules.service'

/**
 * 规则 + 规则版本化（docs/design/02 §5.3–§5.6 / 03 C10 / E15）。
 *
 * ── W5-A 接线（2026-10-19）────────────────────────────────────────────────
 *   `POST   /point-rules`            新建（v1 + AuditLog `point_rule.create`）
 *   `PATCH  /point-rules/:id`        编辑（v+1 + 条件更新 + 同步派生习惯 + 审计）
 *   `DELETE /point-rules/:id`        软删（版本行**永不删**）
 *   `POST   /point-rules/:id/habits` 从规则复制出首页习惯（保留 `sourceRuleId`）
 *
 * ── `update_rule` 事务（**原子**，02 §5.3）────────────────────────────────
 *   1. 读 currentVersion = v（并校验 `expectedVersion`）
 *   2. 写 PointRuleVersion { version: v+1, ...新值 }
 *   3. 条件更新 PointRule（`WHERE currentVersion = v`，含 currentVersion = v+1）
 *   4. 写 AuditLog { action:'point_rule.update', before:{...v}, after:{...v+1} }
 *   ↑ 四步同一 $transaction；第二步在第三步之前，任何隔离级别下都不会出现
 *     "currentVersion 指向不存在的版本行"的中间态。
 *
 * ── 改规则对「今天已打卡」的语义（02 §5.5，验收标准）──────────────────────
 *   历史不可回溯、未来从新规；派生习惯同步新值，于是今日额度按新规重算；
 *   已得的分不补差、不追扣（流水里的 `(ruleId, ruleVersion)` 一字不动）。
 *
 * ── 世界钉死（与 `HabitsModule` 同一手法）──────────────────────────────────
 *   有库 ⇒ `PrismaRulesRepository`；无库 ⇒ `NotImplementedRulesRepository`（四方法全 501）。
 *   `hasDatabase` 向下传给身份 / 成员 / 幂等，**只有一个来源**；用例必须显式传值。
 */
export function resolveRulesRepositoryClass(hasDatabase: boolean): Type<RulesPort> {
  return hasDatabase ? PrismaRulesRepository : NotImplementedRulesRepository
}

export interface RulesAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class RulesModule {
  static register(options: RulesAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: RulesModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule,
        // ★ W7-A：同意闸门。有库 ⇒ PrismaConsentRepository；无库 ⇒ 501（见 ConsentModule）。
        ConsentModule.register({ hasDatabase }),
        // 带 `Idempotency-Key` 的请求先过幂等层；无库时它自己 501。
        IdempotencyModule.register({ hasDatabase })
      ],
      controllers: [RulesController],
      providers: [
        RulesService,
        // 控制器上的四个 Guard 在本模块注入器里实例化 —— 依赖由上面四个模块
        // （身份 / 成员 / 矩阵 / **同意**）的 exports 提供。
        DeviceSessionGuard,
        // ★ W7-A：同意闸门（依赖 CONSENT_REPOSITORY 由 ConsentModule.exports 提供）。
        ConsentGuard,
        {
          provide: RULES_REPOSITORY,
          useClass: resolveRulesRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

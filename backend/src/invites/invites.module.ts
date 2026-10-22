import { DynamicModule, Module, type Type } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { InvitesController } from './invites.controller'
import { PrismaInvitesRepository } from './invites.prisma.repository'
import {
  INVITES_REPOSITORY,
  NotImplementedInvitesRepository,
  type InvitesPort
} from './invites.repository'
import { InvitesService } from './invites.service'

/**
 * 邀请码（W5-G，2026-10-22；docs/design/02 §8）
 *
 * ── 接线 ──────────────────────────────────────────────────────────────────
 *   POST /invites                     生成（guardian，`invite_member`）
 *   GET  /invites                     列出（guardian，`invite_member`）
 *   POST /invites/:id/revoke          吊销（guardian，`invite_member`；构造幂等）
 *   POST /invites/accept              加入（**只有身份屏障**，理由见 controller 头注释）
 *
 * ── ★ 并发安全：不能用「先查后改」────────────────────────────────────────
 *   校验剩余次数 → 插入成员 → 次数 +1 若分步执行，**并发下会超发**。
 *   必须用**单条条件 UPDATE** 原子占位（在 `PrismaInvitesRepository.acceptInvite`）：
 *
 *     UPDATE "InviteCode"
 *        SET "usedCount" = "usedCount" + 1, "usedByUserId" = $1, "usedAt" = now()
 *      WHERE code = $2 AND "usedCount" < "maxUses"
 *        AND "expiresAt" > now() AND revoked = false
 *      RETURNING id
 *     -- 返回 0 行 → 409 INVITE_CODE_UNAVAILABLE
 *
 *   数据库行锁保证至多 maxUses 个请求拿到 RETURNING 行。
 *   比「先查后改」或分布式锁都更简单可靠。
 *
 * ⚠ 与 02 §8 示例的差异：示例 SQL 用了 snake_case 列名（`used_count`），
 *   而 prisma/schema.prisma **未使用 @map**，故列名是 camelCase 且必须带引号。
 *   —— 见 docs/design/06-w0-report.md §3「待确认决策 D5」。
 *
 * ── 世界钉死（与 `ChildrenModule` / `TrashModule` 同一手法）────────────────
 *   有库 ⇒ `PrismaInvitesRepository`；无库 ⇒ `NotImplementedInvitesRepository`
 *   （四个方法全 501：不返回空列表冒充「还没有邀请码」，也不假装加入成功）。
 *   `hasDatabase` 向下传给身份 / 成员模块，**只有一个来源**；用例必须显式传值。
 */
export function resolveInvitesRepositoryClass(
  hasDatabase: boolean
): Type<InvitesPort> {
  return hasDatabase ? PrismaInvitesRepository : NotImplementedInvitesRepository
}

export interface InvitesAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class InvitesModule {
  static register(options: InvitesAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: InvitesModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule
      ],
      controllers: [InvitesController],
      providers: [
        InvitesService,
        // 控制器上的 Guard 在本模块注入器里实例化 —— 依赖由上面三个模块 exports 提供。
        DeviceSessionGuard,
        {
          provide: INVITES_REPOSITORY,
          useClass: resolveInvitesRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}


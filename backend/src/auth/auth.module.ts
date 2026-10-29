import { DynamicModule, Module, type Type } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { AuthController } from './auth.controller'
import { PrismaAuthRepository } from './auth.prisma.repository'
import {
  AUTH_REPOSITORY,
  NotImplementedAuthRepository,
  type AuthPort
} from './auth.repository'
import { AuthService } from './auth.service'

/**
 * 家长模式 / 家长 PIN 模块（W8-C，2026-10-27 / `docs/design/02` §7、§9.18）。
 *
 * ── 它补的是哪个洞 ────────────────────────────────────────────────────────
 *   在 W8-C 之前，`DeviceSession.activeRole` **没有写入方**：
 *   `DeviceSessionGuard` 只读，`ChildMember.pinHash` / `pinLockedUntil` 没有任何
 *   代码使用 —— 于是 `02` §7 的「PIN 换 5 分钟家长模式」在库里只剩默认值。
 *   本模块是那个**写入口**：改了角色、写了 TTL、记了失败次数、落了审计。
 *
 * ── 接线 ──────────────────────────────────────────────────────────────────
 *   `GET    /auth/parent-mode`  `switch_role_mode`
 *   `POST   /auth/parent-mode`  `switch_role_mode`
 *   `DELETE /auth/parent-mode`  `switch_role_mode`
 *   `POST   /auth/parent-pin`   `manage_parent_pin`
 *   ⚠ 四条都**不**经 `ConsentGuard`（两个 action 都是豁免，理由见 controller）。
 *
 * ── 世界钉死 ──────────────────────────────────────────────────────────────
 *   有库 ⇒ `PrismaAuthRepository`（真写 `DeviceSession` / `ChildMember` / `AuditLog`）；
 *   无库 ⇒ 501。**绝不能**回一个"已切到家长模式"的假状态：那会让下一次请求
 *   （仍按 `DeviceSession` 判定）表现为"切了但没权限"，把故障指向权限矩阵。
 *   `hasDatabase` 向下传给身份 / 成员模块，**只有一个来源**；用例必须显式传值。
 */
export function resolveAuthRepositoryClass(hasDatabase: boolean): Type<AuthPort> {
  return hasDatabase ? PrismaAuthRepository : NotImplementedAuthRepository
}

export interface AuthAssemblyOptions {
  /** `true` ⇒ 真 Prisma 适配器；`false` ⇒ 501。省略 ⇒ `hasDatabaseUrl()`。 */
  hasDatabase?: boolean
}

@Module({})
export class AuthModule {
  static register(options: AuthAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: AuthModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule
      ],
      controllers: [AuthController],
      providers: [
        AuthService,
        // 控制器上的 `@UseGuards` 在本模块的注入器里解析：身份 Guard 要显式列出，
        // 它的端口由 `DeviceSessionModule.exports` 提供。
        // 屏障一 / 屏障二 的 Guard 由上面两个模块 `exports` 提供（与 OnboardingModule 同一写法）。
        DeviceSessionGuard,
        {
          provide: AUTH_REPOSITORY,
          useClass: resolveAuthRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

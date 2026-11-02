import { DynamicModule, Module, type Type } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { PrismaRegistrationInviteRepository } from './registration-invite.prisma.repository'
import {
  REGISTRATION_INVITE_REPOSITORY,
  NotImplementedRegistrationInviteRepository,
  type RegistrationInvitePort
} from './registration-invite.repository'

/**
 * 网站注册邀请码的**核心装配**（W12，2026-11-02）—— 只有端口，没有路由。
 *
 * ── 为什么拆成核心 / HTTP 两层（与 `ConsentModule` / `ConsentHttpModule` 同形）
 *   同一个端口有两个使用方：
 *     · 网站发放端点（`RegistrationInvitesHttpModule`）；
 *     · 注册端点的**来源路由**（`IdentityModule` 要先知道这张码是不是网站发的）。
 *   若把 controller 挂在核心模块上，`IdentityModule` 导入它时会把
 *   `POST /public/registration-invites` 再注册一遍 —— Nest 启动即报重复路径
 *   （`identity.module.ts` 文件头同一个坑）。
 *   ⇒ 控制器只在 `RegistrationInvitesHttpModule` 里声明一次。
 *
 * ── 无库世界 ────────────────────────────────────────────────────────────────
 *   有库 ⇒ `PrismaRegistrationInviteRepository`；
 *   无库 ⇒ `NotImplementedRegistrationInviteRepository`（发放 / 读额度 501；
 *   `findByCode` 回 null —— 理由见该实现）。
 */
export function resolveRegistrationInviteRepositoryClass(
  hasDatabase: boolean
): Type<RegistrationInvitePort> {
  return hasDatabase
    ? PrismaRegistrationInviteRepository
    : NotImplementedRegistrationInviteRepository
}

export interface RegistrationInvitesAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class RegistrationInvitesCoreModule {
  static register(options: RegistrationInvitesAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()

    return {
      module: RegistrationInvitesCoreModule,
      // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错，
      // 而 Nest 会急切实例化被导入模块的全部 provider。
      imports: [...(hasDatabase ? [PrismaModule] : [])],
      providers: [
        {
          provide: REGISTRATION_INVITE_REPOSITORY,
          useClass: resolveRegistrationInviteRepositoryClass(hasDatabase)
        }
      ],
      exports: [REGISTRATION_INVITE_REPOSITORY]
    }
  }
}

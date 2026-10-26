import { DynamicModule, Module, type Type } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { ConsentGuard } from './consent.guard'
import { PrismaConsentRepository } from './consent.prisma.repository'
import {
  CONSENT_REPOSITORY,
  NotImplementedConsentRepository,
  type ConsentPort
} from './consent.repository'

/**
 * 同意闸门的**核心模块**（W7-A，2026-10-26）—— 只提供端口与 Guard，
 * **不含 controller**（HTTP 入口在 `ConsentHttpModule`）。
 *
 * ── 为什么要拆成"核心 / HTTP"两个模块 ───────────────────────────────────────
 *   `ConsentGuard` 要挂到**每一个写端点**所在的模块上（rules / habits / records /
 *   wishes / approvals / trash / children / invites / members / device-tokens），
 *   于是 `ConsentModule.register()` 会被导入十几次。
 *   若 controller 也在这里，动态模块的**每次注册**都会带上一份 controller ——
 *   同一条路由被注册多次，最后一个生效（`DeviceTokensHttpModule` 踩过同一个坑，
 *   见 `app.module.ts` 的注释）。拆开后：核心可安全重复导入，HTTP 只注册一次。
 *
 * ── 世界钉死 ──────────────────────────────────────────────────────────────
 *   有库 ⇒ `PrismaConsentRepository`；无库 ⇒ 501（**不返回** `status: 'none'`，
 *   理由见 `consent.repository.ts` 文件头）。`hasDatabase` 由调用方传入、
 *   用例必须显式传值；只有生产代码走环境推断。
 *
 * ── `exports` 必须同时带 Guard 与令牌 ────────────────────────────────────────
 *   宿主模块在自己的注入器里实例化 `ConsentGuard`，它的构造依赖
 *   `CONSENT_REPOSITORY` 必须能从这里解析到 —— 只导出 Guard 不导出令牌会在启动时报
 *   `Nest can't resolve dependencies of the ConsentGuard (?, ?)`
 *   （W1-B 在 `MembershipGuard` 上实测过，这里照抄结论）。
 */
export function resolveConsentRepositoryClass(hasDatabase: boolean): Type<ConsentPort> {
  return hasDatabase ? PrismaConsentRepository : NotImplementedConsentRepository
}

export interface ConsentAssemblyOptions {
  /** `true` ⇒ 真 Prisma 适配器；`false` ⇒ 501。省略 ⇒ `hasDatabaseUrl()`。 */
  hasDatabase?: boolean
}

@Module({})
export class ConsentModule {
  static register(options: ConsentAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: ConsentModule,
      // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
      imports: hasDatabase ? [PrismaModule] : [],
      providers: [
        ConsentGuard,
        { provide: CONSENT_REPOSITORY, useClass: resolveConsentRepositoryClass(hasDatabase) }
      ],
      exports: [ConsentGuard, CONSENT_REPOSITORY]
    }
  }
}

import { DynamicModule, Module, type Type } from '@nestjs/common'

import { ConsentGuard } from '../consent/consent.guard'
import { ConsentModule } from '../consent/consent.module'
import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { MembershipModule } from '../membership/membership.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { OnboardingController } from './onboarding.controller'
import { PrismaOnboardingRepository } from './onboarding.prisma.repository'
import {
  NotImplementedOnboardingRepository,
  ONBOARDING_REPOSITORY,
  type OnboardingPort
} from './onboarding.repository'
import { OnboardingService } from './onboarding.service'

/**
 * 首启引导模块（W8-A，2026-10-27 / `docs/design/04`）。
 *
 * ── 它为什么存在 ──────────────────────────────────────────────────────────
 *   现状首启直接进首页并展示 seed 假数据（124 分 / 324 好习惯）——
 *   新用户看到「我完成了 324 个好习惯」，荒谬且必须下架（`03` E18）。
 *   引导把「第一次打开」变成「选学段 → 选关注点 → 采纳几条约定」，
 *   让首页的数据**全部来自用户自己刚才的选择**。
 *
 * ── 接线 ──────────────────────────────────────────────────────────────────
 *   `GET   /onboarding`          读状态 + 已排序模板（`view_onboarding`）
 *   `PATCH /onboarding/profile`  学段 / 关注点草稿（`apply_onboarding`）
 *   `POST  /onboarding/complete` 采纳模板 + 可选设置 PIN（`apply_onboarding`）
 *
 * ── 为什么**不**拆成「核心 / HTTP」两个模块 ─────────────────────────────────
 *   `ConsentModule` 之所以拆，是因为它会被十来个特性模块重复导入
 *   （每个写端点都要 `ConsentGuard`），controller 跟着动态注册会重复挂载路由。
 *   本模块**只被 `app.module.ts` 导入一次**，没有第二个宿主，所以单模块即可。
 *   若将来有别的模块要复用 `OnboardingService`，再拆也不迟 —— 现在拆只是多一层。
 *
 * ── 世界钉死 ──────────────────────────────────────────────────────────────
 *   有库 ⇒ `PrismaOnboardingRepository`；无库 ⇒ 501（**不**返回
 *   `{ onboarded: false }` 冒充「这个家还没走引导」，理由见 `onboarding.repository.ts`）。
 *   `hasDatabase` 向下传给身份 / 成员 / 同意模块，**只有一个来源**；用例必须显式传值。
 *
 * ── 4 个 Guard 都要在这里实例化 ────────────────────────────────────────────
 *   控制器上的 `@UseGuards` 在**本模块的注入器**里解析：
 *   `DeviceSessionGuard` / `MembershipGuard` / `ConsentGuard` 都要显式列为 provider，
 *   它们的构造依赖（`DEVICE_SESSION_REPOSITORY` / membership 端口 / `CONSENT_REPOSITORY`）
 *   由上面导入的模块 `exports` 提供。少写一个就是启动期
 *   `Nest can't resolve dependencies of ...`。
 */
export function resolveOnboardingRepositoryClass(hasDatabase: boolean): Type<OnboardingPort> {
  return hasDatabase ? PrismaOnboardingRepository : NotImplementedOnboardingRepository
}

export interface OnboardingAssemblyOptions {
  /** `true` ⇒ 真 Prisma 适配器；`false` ⇒ 501。省略 ⇒ `hasDatabaseUrl()`。 */
  hasDatabase?: boolean
}

@Module({})
export class OnboardingModule {
  static register(options: OnboardingAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: OnboardingModule,
      imports: [
        // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错。
        ...(hasDatabase ? [PrismaModule] : []),
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule,
        // 同意闸门：`view_onboarding` 豁免、`apply_onboarding` 受管（见 controller 注释）。
        ConsentModule.register({ hasDatabase })
      ],
      controllers: [OnboardingController],
      providers: [
        OnboardingService,
        DeviceSessionGuard,
        ConsentGuard,
        {
          provide: ONBOARDING_REPOSITORY,
          useClass: resolveOnboardingRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}

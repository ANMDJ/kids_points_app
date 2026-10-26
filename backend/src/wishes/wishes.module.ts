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
import { PrismaWishesRepository } from './wishes.prisma.repository'
import {
  NotImplementedWishesRepository,
  WISHES_REPOSITORY,
  type WishesPort
} from './wishes.repository'
import { WishesController } from './wishes.controller'
import { WishesService } from './wishes.service'

/**
 * 心愿（docs/design/03 B8 / C9 / E16）。
 *
 * ── W5-B 接线（2026-10-20）────────────────────────────────────────────────
 *   `POST   /wishes`      新增（`add_wish`；家长 ALLOW / 孩子 REQUIRE_APPROVAL）
 *   `DELETE /wishes/:id`  软删（`delete_wish`；孩子 DENY）
 *   `POST /approvals`（action=`redeem`）兑换 —— **不在**本模块，见下面的分工。
 *
 * ── `coverStyle` 是稳定枚举（A|B|C|D）—— 修 E16 ───────────────────────────
 *   原实现 `backgroundIndex = wishes.length % 4` 由**插入时的列表长度**决定：
 *   删掉中间一个心愿后，后续新增会与既有心愿撞色，既有心愿的配色也可能跳变。
 *   现在的算法在 `contracts/wish-cover-style.ts`（空档优先 → 四色占满则按 id 哈希），
 *   三端同一算式：服务端落库定色，客户端离线/预览时也能算出同一个颜色。
 *
 * ── 兑换为什么走审批模块 ──────────────────────────────────────────────────
 *   兑换要「写流水 + 改余额 + 标记 `redeemed`」，且成本必须**快照进 payload 的
 *   `costSnapshot`**（02 §4.3）：否则家长同意时心愿价格已被改过，扣分金额与孩子
 *   申请时看到的不一致 —— 又一次账对不上。这套东西的唯一实现点是
 *   `approvals.prisma.repository.ts` 的执行器，本模块**不**提供第二条扣分入口。
 *
 * ── 软删除（C9）──────────────────────────────────────────────────────────
 *   `status=deleted` + `deletedAt`，回收站保留 90 天；
 *   **流水永不删除** —— 回收站只作用于「配置」，永不作用于「账本」（02 §5.6）。
 *
 * ── 世界钉死（与 `RulesModule` 同一手法）──────────────────────────────────
 *   有库 ⇒ `PrismaWishesRepository`；无库 ⇒ `NotImplementedWishesRepository`（方法全 501）。
 *   `hasDatabase` 向下传给身份 / 成员 / 幂等，**只有一个来源**；用例必须显式传值。
 */
export function resolveWishesRepositoryClass(hasDatabase: boolean): Type<WishesPort> {
  return hasDatabase ? PrismaWishesRepository : NotImplementedWishesRepository
}

export interface WishesAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class WishesModule {
  static register(options: WishesAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: WishesModule,
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
      controllers: [WishesController],
      providers: [
        WishesService,
        // 控制器上的四个 Guard 在本模块注入器里实例化 —— 依赖由上面四个模块
        // （身份 / 成员 / 矩阵 / **同意**）的 exports 提供。
        DeviceSessionGuard,
        // ★ W7-A：同意闸门（依赖 CONSENT_REPOSITORY 由 ConsentModule.exports 提供）。
        ConsentGuard,
        {
          provide: WISHES_REPOSITORY,
          useClass: resolveWishesRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}


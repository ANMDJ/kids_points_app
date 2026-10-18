import { DynamicModule, Module, Type } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { MembershipGuard } from './membership.guard'
import { PrismaMembershipRepository } from './membership.prisma.repository'
import {
  MEMBERSHIP_REPOSITORY,
  NotImplementedMembershipRepository,
  type MembershipPort
} from './membership.repository'

/**
 * 屏障一 · 成员资格门（docs/design/02 §3）
 *
 * 回答「这个人跟这个孩子有没有关系」：
 *   ChildMember(childId, userId).status === 'active' ？
 *   ✗ → 403 MEMBER_NOT_FOUND / MEMBER_REMOVED
 *
 * 为什么必须独立成第一道：权限矩阵是「角色 × 动作」，前提是**先有角色**。
 * 若把资格判定混进矩阵，非成员会被当成「未知角色」，判定语义就模糊了。
 *
 * ✅ **已接线（2026-10-15，W1-B）**：`MembershipGuard` ＋ 端口 `MembershipPort`
 *   ＋ 纯内核 `resolveMembership()`；挂载点是**控制器级**
 *   `@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)` ——
 *   数组顺序即语义（身份 → 资格 → 矩阵），理由见 guard 文件头「顺序」。
 *   用例：`test/membership-gate.test.ts`（纯内核）＋ `test/membership-http.test.ts`（真 HTTP）。
 *
 * ✅ **真查询已落地（2026-10-16，W2-D）**：本模块改成**动态模块** ——
 *   `register()` 按 `hasDatabaseUrl()` 分叉：**有库** ⇒ `PrismaMembershipRepository`
 *   （真查 `ChildMember`，复合唯一键 `(childId, userId)`；**不过滤 `status`**，
 *   否则 `MEMBER_REMOVED` 会永远塌成 `MEMBER_NOT_FOUND`）；**无库** ⇒ 显式 501。
 *   两端各有一半证据：`test/membership-wiring.test.ts`（离线装配声明）＋
 *   `test-db/identity-db.dbtest.ts`（真库读出来的行能过 `toMembership()`，含默认 `{}`）。
 */
/**
 * 装配选项。**用例必须显式传值**（只有生产代码才允许省略、走环境推断）：
 * CI 机器上多半没有 `DATABASE_URL`、开发机上多半有 —— 靠环境推断的话，
 * 同一份用例在两台机器上验的其实是两件事（而"CI 绿了"会被当成"验过了"）。
 */
export interface MembershipAssemblyOptions {
  /** `true` ⇒ 真 Prisma 适配器；`false` ⇒ 501。省略 ⇒ `hasDatabaseUrl()`。 */
  hasDatabase?: boolean
}

/**
 * 装配判据的**纯函数形态**：给定"有没有库"，返回该绑哪个实现。
 * （用例直接断言这个映射，不需要实例化 Prisma、不需要连库；见 `w2d-canfail.mjs`。）
 */
export function resolveMembershipRepositoryClass(hasDatabase: boolean): Type<MembershipPort> {
  return hasDatabase ? PrismaMembershipRepository : NotImplementedMembershipRepository
}

/**
 * ★ 为什么必须是**动态模块**（不能像原来那样在 `@Module` 里写死 provider）────────
 *   `PrismaService` 的构造函数在缺 `DATABASE_URL` 时**刻意**抛错，而 Nest 会**急切地**
 *   实例化被导入模块的全部 provider ⇒ 若静态地 `imports: [PrismaModule]`，
 *   `npm test`（离线用例，本机/CI 都没有库）会在**装配阶段**就炸，
 *   连"无库 ⇒ 501"这条用例都跑不到。所以"要不要导入 `PrismaModule`"
 *   必须在**装配时**就有答案。（与 `LedgerModule` 同一个取舍，判据只有一处：
 *   `prisma/database-enabled.ts` 的 `hasDatabaseUrl()`。）
 */
@Module({})
export class MembershipModule {
  /**
   * 建图。`app.module.ts` / `ApprovalsModule` 调**不带参数**的版本（按环境推断，
   * 而 `main.ts` 第一行已加载 dotenv）；用例调带参数的版本（把"在哪个世界"钉死）。
   *
   * ★ `exports` 里**必须**同时带上守卫**和**端口令牌（W1-B 实测踩到）：
   *   `@UseGuards(某个类)` 时，Nest 在**宿主模块**（声明那个 controller 的模块）的
   *   上下文里实例化守卫并解析它的构造依赖 —— 只导出 `MembershipGuard` 而把
   *   `MEMBERSHIP_REPOSITORY` 留在本模块内部，`ApprovalsModule` / 测试探针模块会直接报
   *     `Nest can't resolve dependencies of the MembershipGuard (?) … Symbol(MEMBERSHIP_REPOSITORY)`
   *   （导入本模块**不等于**能看到它未导出的 provider）。导出后，真实现与替身
   *   都能被上层模块正常注入、替换。
   */
  static register(options: MembershipAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: MembershipModule,
      imports: hasDatabase ? [PrismaModule] : [],
      providers: [
        MembershipGuard,
        // 与 PermissionsGuard 一样**不**改成全局 `APP_GUARD`：全局注册会先于身份解析执行，
        // 拿到空的 kpActor / kpChildId（理由与屏障二完全相同）。
        { provide: MEMBERSHIP_REPOSITORY, useClass: resolveMembershipRepositoryClass(hasDatabase) }
      ],
      exports: [MembershipGuard, MEMBERSHIP_REPOSITORY]
    }
  }
}

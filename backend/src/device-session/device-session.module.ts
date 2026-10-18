import { DynamicModule, Module, Type } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { DeviceSessionGuard } from './device-session.guard'
import { PrismaDeviceSessionRepository } from './device-session.prisma.repository'
import {
  DEVICE_SESSION_REPOSITORY,
  NotImplementedDeviceSessionRepository,
  type DeviceSessionPort
} from './device-session.repository'

/**
 * 设备会话 / 角色模式切换（docs/design/02 §7）
 *
 * ★ 核心原则：**客户端不可信**。
 *   `activeRole` 由服务端 `DeviceSession` 持有，而非小程序 storage ——
 *   否则改一下小程序 storage 即可把自己提权成家长。
 *   服务端持有，才能让「家长模式」成为**真实的权限提升**，而不是一个 UI 开关。
 *
 * | 规则      | 说明
 * | 默认角色  | `child`（最小权限默认）—— 手机在孩子手里时不能是家长模式
 * | 切 guardian | 需输入 PIN（scrypt 哈希，落在 ChildMember.pinHash）
 * | TTL       | 5 分钟无操作回落 child；每次 guardian 操作刷新
 * | PIN 错误  | 5 次锁定 15 分钟（防暴力）
 * | 审计      | 每次切换写 AuditLog（含 deviceId）
 *
 * ── 状态（W1-C，2026-10-15）────────────────────────────────────────────
 *   ✅ **已落地**：`DeviceSessionGuard`（身份解析）＋ `session.gate.ts`（判定内核，纯函数）
 *      —— 「我是谁 / 我是什么角色」**由服务端会话行给出**，
 *      客户端只被允许回答「我是哪台设备、在哪个孩子的档案上」。
 *      由此 `temporary-role.guard.ts`（客户端自报角色）**已删除**。
 *   ✅ **TTL 口径**：`guardian` 会话过期 ⇒ **回落 `child`**（§9.19；降级而非 401），
 *      边界（`expiresAt === now` 即过期）在 `session.gate.ts` 一处定死并有用例。
 *   ⛔ **仍未落地**（与本模块"已完成"严格分开记）：
 *      · ~~**查询实现**~~ → ✅ **已落地（W2-D，2026-10-16）**：本模块改成**动态模块**，
 *        `register()` 按 `hasDatabaseUrl()` 分叉 —— **有库** ⇒ `PrismaDeviceSessionRepository`
 *        （真查 `DeviceSession`，复合唯一键 `(deviceId, childId)`）；
 *        **无库** ⇒ `NotImplementedDeviceSessionRepository`（**显式 501**，此时连
 *        `PrismaService` 都不会被实例化）。⇒ "身份层已接线却从没查过库"这一句到此为止。
 *      · **切 guardian / PIN 校验 / 锁 15 分钟 / 审计**：没有端点，`pinHash` /
 *        `pinLockedUntil` 目前**无人使用**（§9.18 的验收用例尚无对应路径）。
 *      · **会话刷新**：§7 的「每次 guardian 操作刷新 TTL」要写库 ⇒ 属 W2 的**写路径**
 *        （W2-D 只交付**读路径**：`findSession` 真查库；写路径仍未落地）。
 *      · **凭据认证**：`x-kp-device-id` 仍可被伪造 ⇒ 生产 503（见 guard 的 ④）。
 *
 * ★ `exports` 里**必须**带上 `DEVICE_SESSION_REPOSITORY`：宿主模块
 *   （`ApprovalsModule`）会实例化 `DeviceSessionGuard`，而它的依赖要由**宿主模块**的
 *   注入器解析 —— 只导出 Guard 不导出令牌，会在启动时报
 *   `Nest can't resolve dependencies of the DeviceSessionGuard (?)`。
 *   （W1-B 在 `MembershipModule` 上实测过同一个坑，这里照抄结论。）
 */
/**
 * 装配选项。**用例必须显式传值**（只有生产代码才允许省略、走环境推断）：
 * CI 机器上多半没有 `DATABASE_URL`、开发机上多半有 —— 靠环境推断的话，
 * 同一份用例在两台机器上验的其实是两件事（而"CI 绿了"会被当成"验过了"）。
 */
export interface DeviceSessionAssemblyOptions {
  /** `true` ⇒ 真 Prisma 适配器；`false` ⇒ 501。省略 ⇒ `hasDatabaseUrl()`。 */
  hasDatabase?: boolean
}

/**
 * 装配判据的**纯函数形态**：给定"有没有库"，返回该绑哪个实现。
 *
 * 单拎出来是为了让用例能直接断言这个映射（不需要实例化 Prisma、不需要连库），
 * 也让"映射有两个分支、且互不重叠"这句话可以被**证伪**
 * （见 `tools/_scratch/w2d-canfail.mjs`：两条分支对调 ⇒ 用例点名变红）。
 */
export function resolveDeviceSessionRepositoryClass(
  hasDatabase: boolean
): Type<DeviceSessionPort> {
  return hasDatabase ? PrismaDeviceSessionRepository : NotImplementedDeviceSessionRepository
}

/**
 * ★ 为什么必须是**动态模块**（不能像原来那样在 `@Module` 里写死 provider）────────
 *   `PrismaService` 的构造函数在缺 `DATABASE_URL` 时**刻意**抛错，而 Nest 会**急切地**
 *   实例化被导入模块的全部 provider ⇒ 若静态地 `imports: [PrismaModule]`，
 *   `npm test`（离线用例，本机/CI 都没有库）会在**装配阶段**就炸，
 *   连"无库 ⇒ 501"这条用例都跑不到。所以"要不要导入 `PrismaModule`"
 *   必须在**装配时**就有答案。（与 `LedgerModule` 同一个取舍，判据也只有一处：
 *   `prisma/database-enabled.ts` 的 `hasDatabaseUrl()`。）
 *
 * ★ 有库时把 `PrismaModule`（`@Global`）放进 `imports`，而不是在工厂里 `new PrismaService()`：
 *   全仓共用**一个**连接池、一套生命周期（`onModuleInit` 连库 / `onModuleDestroy` 断库）——
 *   自己 new 会绕过它，并让"同一次请求里的多表读写"落在两个池上。
 */
@Module({})
export class DeviceSessionModule {
  /**
   * 建图。`app.module.ts` / `ApprovalsModule` 调**不带参数**的版本（按环境推断，
   * 而 `main.ts` 第一行已加载 dotenv）；用例调带参数的版本（把"在哪个世界"钉死）。
   */
  static register(options: DeviceSessionAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: DeviceSessionModule,
      imports: hasDatabase ? [PrismaModule] : [],
      providers: [
        DeviceSessionGuard,
        {
          provide: DEVICE_SESSION_REPOSITORY,
          useClass: resolveDeviceSessionRepositoryClass(hasDatabase)
        }
      ],
      exports: [DeviceSessionGuard, DEVICE_SESSION_REPOSITORY]
    }
  }
}


import { DynamicModule, Module, type Type } from '@nestjs/common'

import { DeviceSessionGuard } from '../device-session/device-session.guard'
import { DeviceSessionModule } from '../device-session/device-session.module'
import { IdempotencyModule } from '../idempotency/idempotency.module'
import { MembershipModule } from '../membership/membership.module'
import { NotificationsModule } from '../notifications/notifications.module'
import { PermissionsModule } from '../permissions/permissions.module'
import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { ApprovalsController } from './approvals.controller'
import { ApprovalsExpiryService } from './approvals-expiry.service'
import { PrismaApprovalsRepository } from './approvals.prisma.repository'
import {
  APPROVALS_REPOSITORY,
  NotImplementedApprovalsRepository,
  type ApprovalsPort
} from './approvals.repository'
import { ApprovalsService } from './approvals.service'

/**
 * 审批端口的实现选择（**唯一分叉点**，与 `resolveMembershipRepositoryClass` 同一手法）。
 *
 * 有库 ⇒ 真 Prisma 适配器（批准即同事务写流水/余额/审计）；
 * 无库 ⇒ 显式 501（`npm test` 不需要库，也**不许**假装写入成功）。
 */
export function resolveApprovalsRepositoryClass(hasDatabase: boolean): Type<ApprovalsPort> {
  return hasDatabase ? PrismaApprovalsRepository : NotImplementedApprovalsRepository
}


/**
 * 审批（docs/design/02 §4）
 *
 * 状态机：pending → approved | rejected | withdrawn | invalidated | expired
 * ★ `invalidated`（第 5 个终态）不可省略 —— 审批是**跨时间**的：
 *   家长 3 小时后才点「同意」时，前提可能已消失（心愿被删 / 积分被花掉 /
 *   规则被删 / 成员被移出）。没有它就只能返回 500 或静默丢弃（02 §4.2）。
 *
 * ★ `rejected` 与 `invalidated` 的语义**必须在 UI 上区分**：
 *   rejected    = 家长不同意（人的决定）→「爸爸说这次先不换」
 *   invalidated = 前提消失了（系统判定）→「这个心愿已经不在心愿单里了」
 *   混用会让家长「莫名其妙背锅」—— 必须避免的体验缺陷。
 *
 * 批准执行必须**幂等**（02 §4.4）：
 *   UPDATE ... WHERE id = ? AND status = 'pending'  ← 乐观锁，单条条件 UPDATE
 *   未命中 → 409 ALREADY_DECIDED（防双击）；命中 → 同事务写账本 + status + executedRecordId
 *
 * ★ **谁可以批准**（2026-10-14 裁定 P4）：审批**不额外定义"批准人名单"** ——
 *   批准资格 = 矩阵的 `review_approvals` 行；**申请人本人可以自批，但必须显式**
 *   （① 提交后本人二次确认，或 ② 申请时勾选"自动审批"）。缺省一律 `pending`，
 *   绝不因为"只有一位家长"就自动批准。判据见 `src/contracts/approval-policy.ts`（02 §4.5），
 *   本模块**必须消费它**，不得在 controller / service 里另写一份。
 *
 * 状态（2026-10-14 阶段 B4）：
 *   · **HTTP 路径已建**（`POST /approvals`、`POST /approvals/:id/decide`），判定**真实消费**
 *     `approval-policy.ts`；用例见 `test/approvals-http.test.ts`（真 HTTP，非直接调 service）。
 *   · 持久化端口 `ApprovalsPort` 的默认实现是显式 501（**无库装配**）；
 *   · **W3-A（2026-10-18）已接真库**：有库 ⇒ `PrismaApprovalsRepository` ——
 *     批准 / 自批在**同一事务**里写 `ApprovalRequest` 终态 ＋ `PointRecord` 流水 ＋
 *     `Child.pointsBalance` ＋ `AuditLog`；无库 ⇒ 仍显式 501（不假装写入成功）。
 *     即：**有库时\"批准\"真的会扣分**，且双击只扣一次（乐观锁 + 幂等键）。
 *   · **W3-C（2026-10-18）收尾**：执行器覆盖 `redeem` / `request_redeem` /
 *     `request_points_bonus` / `add_wish`；`autoReason` 五种全部可复现
 *     （`WISH_DELETED` / `RULE_DELETED` / `HABIT_GONE` / `INSUFFICIENT_POINTS` / `MEMBER_REMOVED`）；
 *     `expireDue()` 由 `ApprovalsExpiryService` 在 `main.ts` 里按周期扫描；
 *     `Idempotency-Key` 已在 create / decide / withdraw 三个写端点接线（无库 ⇒ 501）。
 *   · **W3-B（2026-10-18）**：① `decide` / `withdraw` / `findById` 全部按 `childId` 收口，
 *     跨孩子的审批 id 与「不存在」一样返回 **404**（此前只验请求头里的孩子是不是自己的，
 *     拿到别家 id 就能批别家的账）；② 新增 `POST /approvals/:id/withdraw` —— 第 5 个终态
 *     `withdrawn` 可达，**只有申请人本人**能撤回，且**不写流水、不动余额**；重复撤回 → 409。
 *   · 身份是**服务端确立的**（W1-C，2026-10-15）：`DeviceSessionGuard` 按
 *     `x-kp-device-id` ＋ `x-kp-child-id` 查会话 ⇒ 角色/ userId **由会话行给出**
 *     （客户端自报的 `x-kp-role` / `x-kp-user-id` 已废弃、不被读取）。生产 503
 *     （设备凭据仍可伪造，见 guard ④）。
 *   · **W1-B（2026-10-15）**：三道屏障在控制器上串成一条链 ——
 *     `@UseGuards(DeviceSessionGuard, MembershipGuard, PermissionsGuard)`
 *     （身份 → 资格 → 矩阵＋成员级收紧）。
 *   · **W2-D（2026-10-16）**：身份与资格**两个端口已接真库** ⇒ 本模块 `imports` 里那两行
 *     改成 `register()`：有库 ⇒ 真 Prisma 适配器（会话行给身份/角色，成员位给资格）；
 *     无库 ⇒ 显式 501，整条路径仍然 fail-closed（不会"没查就过"）。
 *     即：**有库时这三道屏障的输入全部来自库**——`x-kp-role` / `x-kp-user-id` 早已不被读取，
 *     现在连"有没有这个会话""是不是这个孩子的成员"也都是查出来的。
 *   · **W2-D（2026-10-16，第二处）**：本模块**也**改成动态模块（`register({ hasDatabase? })`）。
 *     它当时**不选实现**（`ApprovalsPort` 当时仍是显式 501；✅ W3-A 起自己选），它做的是把"在哪个世界"这个决定
 *     **向下传递**：同一个 `hasDatabase` 交给 `DeviceSessionModule` / `MembershipModule`。
 *     ★ 为什么非传不可（这不是整齐，是**可复现性**）：那两个子模块按环境推断，
 *     而 `Test.createTestingModule({ imports: [ApprovalsModule] })` 的用例**够不着**它们的
 *     options ⇒ 谁在本机导出了 `DATABASE_URL`，谁跑的离线用例就会在装配阶段把 `PrismaModule`
 *     拉进图里、**悄悄连上真库**（三个端口都被替身覆盖，所以它不会红，只会变慢 ＋ 碰真数据）。
 *     那与本仓库"同一份用例不许在两台机器上验两件事"的口径直接冲突。
 *     现在用例写 `ApprovalsModule.register({ hasDatabase: false })` 就把世界钉死了。
 *
 * 验收用例见 02 §9.3 / §9.7 / §9.8 / §9.10 / §9.25–§9.27。
 */
/**
 * 装配选项。**用例必须显式传值**（只有生产代码才允许省略、走环境推断）：
 * CI 机器上多半没有 `DATABASE_URL`、开发机上多半有 —— 靠环境推断的话，
 * 同一份用例在两台机器上验的其实是两件事（而"CI 绿了"会被当成"验过了"）。
 * ★ 与 `LedgerAssemblyOptions` / `DeviceSessionAssemblyOptions` 同名同义，只是**转发**给子模块。
 */
export interface ApprovalsAssemblyOptions {
  /** 转发给 `DeviceSessionModule` / `MembershipModule`；省略 ⇒ `hasDatabaseUrl()`。 */
  hasDatabase?: boolean
}

@Module({})
export class ApprovalsModule {
  /**
   * 建图。`app.module.ts` 调**不带参数**的版本（按环境推断；`main.ts` 第一行已加载 dotenv）；
   * 用例调带参数的版本（把"在哪个世界"钉死 —— 理由见文件头 W2-D 的第二处）。
   *
   * ★ 三个子模块**都要** import：宿主模块（本文件）负责实例化控制器上的 Guard，
   *   而 Guard 的依赖由**宿主模块**的注入器解析 —— 光导入 Guard 类、不导入提供它的模块，
   *   启动时会报 `Nest can't resolve dependencies of the DeviceSessionGuard (?)`。
   *     · 身份 → `DeviceSessionModule`（DeviceSessionGuard）：这台设备是谁、什么角色；
   *     · 屏障一 → `MembershipModule`（MembershipGuard）：资格（这人跟这孩子有没有关系）；
   *     · 屏障二／三 → `PermissionsModule`（PermissionsGuard）：矩阵 ＋ 成员级收紧。
   *   挂载顺序（身份 → 资格 → 判定）见 approvals.controller.ts 的 @UseGuards。
   */
  static register(options: ApprovalsAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: ApprovalsModule,
      imports: [
        // 只有\"有库\"的世界才把 PrismaModule 拉进图：`PrismaService` 在缺 DATABASE_URL 时
        // **刻意**抛错，静态导入会让离线 `npm test` 在装配阶段就炸（同 MembershipModule）。
        ...(hasDatabase ? [PrismaModule] : []),
        // ★ 同一个 `hasDatabase` 往下传（W2-D）：两个子模块的装配分叉由此**只有一个来源**。
        DeviceSessionModule.register({ hasDatabase }),
        MembershipModule.register({ hasDatabase }),
        PermissionsModule,
        // ★ W3-C：`Idempotency-Key` 的持久化端口也必须按同一个世界选实现
        //   （无库 ⇒ 501，带 key 的请求不会假装重放保护已生效）。
        IdempotencyModule.register({ hasDatabase }),
        // ★ W5-K：推送预留端口（默认 no-op）。它**不依赖库**，故静态导入即可；
        //   与「在哪个世界」无关 —— 无论有没有库，都不能因为推送失败影响审批。
        NotificationsModule
      ],
      controllers: [ApprovalsController],
      providers: [
        ApprovalsService,
        // ★ W3-C：TTL 后台扫描的**执行体**。计时器只由 `main.ts` 调 `start()` 启动
        //   （测试里不会留下 setInterval，见该文件头）。
        ApprovalsExpiryService,
        // ★ 控制器上的 Guard 在**本模块**的注入器里实例化 —— 它的依赖（端口令牌）
        //   由上面三个模块的 `exports` 提供。漏 export 就崩在启动：
        //   `Nest can't resolve dependencies of the DeviceSessionGuard (?)`
        //   （W1-B 在 MembershipModule 上实测过；W1-C 给 DeviceSessionModule 补齐了 exports）。
        DeviceSessionGuard,
        // ★ W3-A（2026-10-18）：**有库 ⇒ 真实现**（同事务写 ApprovalRequest + PointRecord +
        //   Child.pointsBalance + AuditLog）；无库 ⇒ 显式 501（不假装写入成功）。
        //   service / controller 一行都不用改 —— 这正是端口存在的意义。
        {
          provide: APPROVALS_REPOSITORY,
          useClass: resolveApprovalsRepositoryClass(hasDatabase)
        }
      ]
    }
  }
}


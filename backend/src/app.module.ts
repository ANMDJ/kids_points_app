import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ApprovalsModule } from './approvals/approvals.module'
import { AuditModule } from './audit/audit.module'
import { AuthModule } from './auth/auth.module'
import { ChildrenModule } from './children/children.module'
import { ConsentHttpModule } from './consent/consent-http.module'
import { DeletionModule } from './deletion/deletion.module'
import { DeviceSessionModule } from './device-session/device-session.module'
import { DeviceTokensHttpModule } from './device-tokens/device-tokens-http.module'
import { ExportModule } from './export/export.module'
import { HabitsModule } from './habits/habits.module'
import { AuthGuard } from './identity/auth.guard'
import { IdentityModule } from './identity/identity.module'
import { IdempotencyModule } from './idempotency/idempotency.module'
import { InvitesModule } from './invites/invites.module'
import { LedgerModule } from './ledger/ledger.module'
import { MembershipModule } from './membership/membership.module'
import { MembersModule } from './members/members.module'
import { NotificationsModule } from './notifications/notifications.module'
import { OnboardingModule } from './onboarding/onboarding.module'
import { PermissionsModule } from './permissions/permissions.module'
import { PrismaModule } from './prisma/prisma.module'
import { ReadModule } from './read/read.module'
import { RecordsModule } from './records/records.module'
import { RulesModule } from './rules/rules.module'
import { TrashModule } from './trash/trash.module'
import { WishesModule } from './wishes/wishes.module'

/**
 * 应用装配 —— 模块边界 = 02 §3 的三道屏障 + 01 §4 的事务边界。
 *
 * ┌ 成员资格门  membership       屏障一：这个人跟这个孩子有没有关系
 * ├ 权限判定    permissions      屏障二(矩阵) + 屏障三(成员级收紧) + action-dispatcher
 * ├ 账本内核    ledger           ★ 不可变 PointRecord / 冲正 / balanceAfter
 * ├ 规则        rules            PointRule + PointRuleVersion（只增不删）
 * ├ 习惯        habits
 * ├ 心愿        wishes
 * ├ 审批        approvals        5 终态状态机（含 invalidated）
 * ├ 引导        onboarding       模板库 + 监护人同意
 * ├ 邀请码      invites          条件 UPDATE 原子占位（02 §8）
 * ├ 设备会话    device-session   服务端持有的 activeRole（02 §7）
 * ├ 设备 token  device-tokens    推送目标（W6-A）；guardian/child 都能登记**自己的**
 * ├ 审计        audit            追加式，DB 层 REVOKE UPDATE/DELETE
 * ├ 通知        notifications    ★ 必须在账本事务**之外**（01 §4）
 * └ 幂等        idempotency      防重放重复扣分
 */
@Module({
  imports: [
    PrismaModule,
    // ★ 动态模块（W2-D，2026-10-16）：有 DATABASE_URL ⇒ PrismaMembershipRepository
    //   （真查 ChildMember，屏障一读的就是库）；没有 ⇒ NotImplementedMembershipRepository（501）。
    MembershipModule.register(),
    PermissionsModule,
    // ★ 动态模块（W2-B）：有 DATABASE_URL ⇒ 绑 PrismaLedgerRepository（真查库）；
    //   没有 ⇒ 绑 NotImplementedLedgerRepository（六个方法全抛 501，响亮失败而非静默 no-op）。
    //   这里**不传参**＝按环境推断，而 dotenv 已在 main.ts 第一行加载 —— 顺序是这个判断的前提。
    LedgerModule.register(),
    // ★ W5-A（2026-10-19）：写入口 `POST/PATCH/DELETE /point-rules` 与
    //   `POST /point-rules/:id/habits`。有库 ⇒ PrismaRulesRepository；无库 ⇒ 501。
    RulesModule.register(),
    // ★ W4-D（2026-10-19）：写入口 `POST /records/check-in` / `POST /records/:id/reverse`。
    //   有库 ⇒ PrismaHabitsRepository（同事务写流水/余额/审计）；无库 ⇒ 501（不假装打卡成功）。
    //   不传参 ⇒ 按环境推断，而 dotenv 已在 main.ts 第一行加载 —— 顺序是这个判断的前提。
    HabitsModule.register(),
    // ★ 动态模块（W5-B，2026-10-20）：「记一笔」POST /records/adjust。
    //   有库 ⇒ PrismaRecordsRepository（同事务写流水/余额/审计）；无库 ⇒ 501。
    //   与 HabitsModule 分成两个模块：记一笔没有习惯，共享的只有账本内核。
    RecordsModule.register(),
    WishesModule.register(),
    // ★ W5-F（2026-10-21）：回收站 `GET /trash` / `POST /trash/:kind/:id/restore` /
    //   `DELETE /trash/:kind/:id`。有库 ⇒ PrismaTrashRepository；无库 ⇒ 501
    //   （不返回空列表冒充"回收站是空的"）。
    TrashModule.register(),
    // ★ W5-E（2026-10-21）：`PATCH /child` 改昵称（guardian 专属，写 `child.rename` 审计）。
    //   有库 ⇒ PrismaChildrenRepository；无库 ⇒ 501（不假装改名成功）。
    ChildrenModule.register(),
    // ★ 动态模块（W2-D，2026-10-16）：它自己不选实现，但把"在哪个世界"转发给
    //   DeviceSessionModule / MembershipModule（同一个 hasDatabase 只有一个来源）。
    //   不传参 ⇒ 按环境推断，而 dotenv 已在 main.ts 第一行加载 —— 顺序是这个判断的前提。
    ApprovalsModule.register(),
    // ★ W4-A（2026-10-18）：只读入口 `GET /home` / `GET /records`。
    //   有库 ⇒ PrismaReadRepository；无库 ⇒ 501（不返回空数据冒充成功）。
    // ★ W7-C（2026-10-27）：家庭数据导出 `GET /export`（guardian 专属；
    //   child 在矩阵里为 DENY）。有库 ⇒ PrismaExportRepository（**一个事务**
    //   读全份快照）；无库 ⇒ 501（**绝不**返回空文档冒充「孩子没有数据」）。
    //   ★ 它**不**经 `ConsentGuard`：导出在豁免集合里，撤回同意后仍须可用
    //   （04 §5 的可携带承诺）。
    ExportModule.register(),
    // ★ W7-D（2026-10-27）：家庭数据删除 `/family-deletion`（guardian 专属；
    //   child 在矩阵里为 DENY）。有库 ⇒ PrismaDeletionRepository（申请/撤销/执行
    //   都在事务内；执行 = 就地匿名化）；无库 ⇒ 501（**绝不**回「已删除」）。
    //   ★ 三条路由都**不**经 `ConsentGuard`：删除权在豁免集合里，撤回同意后
    //   仍必须可用（02 §9.20 / 04 §5）。
    DeletionModule.register(),
    ReadModule.register(),
    // ★ W8-A（2026-10-27）：首启引导 `GET /onboarding`、`PATCH /onboarding/profile`、
    //   `POST /onboarding/complete`。有库 ⇒ PrismaOnboardingRepository（**一个事务**
    //   完成「标记 onboardedAt + 按提交顺序复制模板为 PointRule + v1 版本行 +
    //   可选设 PIN + 写审计」）；无库 ⇒ 501（**绝不**回 `{ onboarded: false }`
    //   冒充「还没走引导」，否则客户端会走完 6 步才在最后一步失败）。
    //   ★ `view_onboarding` 在同意闸门**豁免**（第①步就是同意，页要先能打开）；
    //   `apply_onboarding` 受管（第②步起采集昵称，04 §5 要求同意先于采集）。
    OnboardingModule.register(),
    // ★ W9-A（2026-10-29）：登录 / 认证会话 / 新用户 bootstrap。
    //   `POST /auth/login`（**免认证**）、`POST /auth/logout`、`GET /auth/session`、
    //   `POST /auth/child-session`、`POST /children`。
    //   有库 ⇒ PrismaAuthSessionRepository + PrismaIdentityRepository（真写 `User`/`AuthSession`）；
    //   无库 ⇒ 两个都是 **501**（绝不"假装登录成功"—— 那会让客户端在
    //   "登录成功"与"请重新登录"之间无限循环，而病是装配）。
    //   微信实现按 `WECHAT_MP_APPID` / `WECHAT_MP_SECRET` 分叉：没配 ⇒ 503 `WECHAT_NOT_CONFIGURED`。
    //   ⚠ 本模块注册的是**路由**，只能被 AppModule 导入一次（见模块文件头的说明）。
    IdentityModule.register(),
    // ★ W8-C（2026-10-27）：家长模式 `GET/POST/DELETE /auth/parent-mode` +
    //   家长 PIN `POST /auth/parent-pin`。有库 ⇒ PrismaAuthRepository（**一个事务**
    //   改会话 activeRole / TTL + 失败计数 + 审计，并先 `SELECT … FOR UPDATE` 成员位）；
    //   无库 ⇒ 501（**绝不**回"已切到家长模式"——下一次请求仍按 DeviceSession 判定，
    //   假成功会把故障指向权限矩阵）。
    //   ★ 两个 action（`switch_role_mode` / `manage_parent_pin`）在同意闸门**豁免**：
    //   撤回同意后家长必须仍能进入家长模式，否则"重新同意"永远做不到（死锁）。
    AuthModule.register(),
    // ★ W5-G（2026-10-22）：邀请码 `POST/GET /invites`、`POST /invites/:id/revoke`、
    //   `POST /invites/accept`。有库 ⇒ PrismaInvitesRepository（条件 UPDATE 原子占位，
    //   占位 + 成员位 + 会话 + 审计同一事务）；无库 ⇒ 501（不返回空列表冒充
    //   「还没有邀请码」，也不假装加入成功）。
    InvitesModule.register(),
    // ★ W5-H（2026-10-22）：家庭成员 `GET /members` / `PATCH /members/:id` /
    //   `DELETE /members/:id`。有库 ⇒ PrismaMembersRepository（最后一位家长保护 +
    //   同事务收回会话 + 审计）；无库 ⇒ 501（不返回空列表冒充「家里只有我一个人」）。
    MembersModule.register(),
    // ★ W7-A（2026-10-26）：监护人对儿童数据处理的同意 `GET /consent` /
    //   `POST /consent` / `POST /consent/withdraw`。有库 ⇒ PrismaConsentRepository
    //   （`Child` 行加锁 ⇒ 读最新一版 ⇒ 写新行 + 审计同一事务）；无库 ⇒ 三个端点全 501
    //   （**不**返回 `status:'none'` 冒充「这个家还没同意」）。
    //   ⚠ 这里挂的是 **Http** 层：`ConsentModule.register()` 还会被 ~10 个特性模块导入
    //   （它们只要 `ConsentGuard` + 端口），若 controller 跟着核心模块走，路由会被注册多次。
    ConsentHttpModule.register(),
    // ★ 动态模块（W2-D，2026-10-16）：有库 ⇒ PrismaDeviceSessionRepository
    //   （真查 DeviceSession，身份/角色由库给出）；没有 ⇒ 501（无库时连 PrismaService 都不建）。
    DeviceSessionModule.register(),
    AuditModule,
    // ★ W5-L（2026-10-23）：站内通知中心 `GET /notifications` /
    //   `PATCH /notifications/:id/read`。有库 ⇒ PrismaNotificationsRepository；
    //   无库 ⇒ 501（不返回空列表冒充「你没有通知」，也不假装标记成功）。
    //   ⚠ 这里与 `ApprovalsModule` 内部的导入**必须**推断出同一个 hasDatabase
    //   （两者都走 `hasDatabaseUrl()`，且 main.ts 第一行已加载 dotenv）。
    NotificationsModule.register(),
    // ★ W6-A（2026-10-24）：设备推送 token 的登记 / 撤销
    //   `POST /device-tokens` / `POST /device-tokens/revoke`。
    //   有库 ⇒ PrismaDeviceTokensRepository；无库 ⇒ 501（不假装登记成功）。
    //   ⚠ 这里挂的是 **Http** 层：controller 必须只声明一次，否则同一条路由被注册
    //   多次（最后一个装配顺序生效）。核心 `DeviceTokensModule` 已被
    //   `NotificationsModule` 导入 —— 那个没有 controller，可安全重复导入。
    DeviceTokensHttpModule.register(),
    // ★ W3-C：动态模块 —— 有库 ⇒ PrismaIdempotencyRepository（唯一约束兜底），
    //   无库 ⇒ 501（只在请求真的带 `Idempotency-Key` 时触发）。
    IdempotencyModule.register()
  ],
  providers: [
    /**
     * ★ W9-A：**认证守卫注册为全局第 0 位**（`40` §9.1）。
     *
     * ── 为什么是它、而不是另外三道屏障 ──────────────────────────────────────
     *   另外三道是**授权**守卫：它们消费 `kpActor`，必须先由 `DeviceSessionGuard`
     *   填好，因此只能挂在控制器上（顺序见 `permissions.guard.ts` 的"顺序"一节）。
     *   本守卫是**认证**守卫：它**产出**身份、不消费身份 —— 全局注册正是要把
     *   它排到所有控制器级守卫**之前**（Nest 的顺序：全局 → 控制器 → 路由）。
     *
     * ── 为什么用 `useExisting` 而不是 `useClass` ─────────────────────────────
     *   `IdentityModule` 已经提供了 `AuthGuard`（控制器上的 `@UseGuards(AuthGuard)`
     *   用的就是那个实例）。`useClass` 会**再建一个**实例 —— 两份状态看起来一样，
     *   但"同一个 Guard 有两个实例"是之后加缓存/计数时最容易出错的形状。
     *
     * ── 它拦住了谁 ──────────────────────────────────────────────────────────
     *   除 `@Public()` 之外**所有**路由。这防的不是"某条路由忘了写守卫"
     *   （那类错误没有测试会红），而是"新加的控制器默认是公开的"这一默认值。
     */
    { provide: APP_GUARD, useExisting: AuthGuard }
  ]
})
export class AppModule {}

import { Module } from '@nestjs/common'
import { ApprovalsModule } from './approvals/approvals.module'
import { AuditModule } from './audit/audit.module'
import { DeviceSessionModule } from './device-session/device-session.module'
import { HabitsModule } from './habits/habits.module'
import { IdempotencyModule } from './idempotency/idempotency.module'
import { InvitesModule } from './invites/invites.module'
import { LedgerModule } from './ledger/ledger.module'
import { MembershipModule } from './membership/membership.module'
import { NotificationsModule } from './notifications/notifications.module'
import { OnboardingModule } from './onboarding/onboarding.module'
import { PermissionsModule } from './permissions/permissions.module'
import { PrismaModule } from './prisma/prisma.module'
import { ReadModule } from './read/read.module'
import { RulesModule } from './rules/rules.module'
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
    RulesModule,
    HabitsModule,
    WishesModule,
    // ★ 动态模块（W2-D，2026-10-16）：它自己不选实现，但把"在哪个世界"转发给
    //   DeviceSessionModule / MembershipModule（同一个 hasDatabase 只有一个来源）。
    //   不传参 ⇒ 按环境推断，而 dotenv 已在 main.ts 第一行加载 —— 顺序是这个判断的前提。
    ApprovalsModule.register(),
    // ★ W4-A（2026-10-18）：只读入口 `GET /home` / `GET /records`。
    //   有库 ⇒ PrismaReadRepository；无库 ⇒ 501（不返回空数据冒充成功）。
    ReadModule.register(),
    OnboardingModule,
    InvitesModule,
    // ★ 动态模块（W2-D，2026-10-16）：有库 ⇒ PrismaDeviceSessionRepository
    //   （真查 DeviceSession，身份/角色由库给出）；没有 ⇒ 501（无库时连 PrismaService 都不建）。
    DeviceSessionModule.register(),
    AuditModule,
    NotificationsModule,
    // ★ W3-C：动态模块 —— 有库 ⇒ PrismaIdempotencyRepository（唯一约束兜底），
    //   无库 ⇒ 501（只在请求真的带 `Idempotency-Key` 时触发）。
    IdempotencyModule.register()
  ]
})
export class AppModule {}

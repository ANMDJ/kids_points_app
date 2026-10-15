/**
 * ledger.module.ts —— 账本端口的**装配处**：决定 `LEDGER_REPOSITORY` 由谁来实现。
 *
 * ── 这个文件为什么值得单独存在（而不是在 `app.module.ts` 里写一行 provider）──────
 *   `ledger.repository.ts` 定义了 `LedgerPort`（端口），`ledger.prisma.repository.ts`
 *   是它的真实现，`ledger.gate.ts` 是内核。三者的关系是"内核产出草稿 → 端口落库"。
 *   把"谁来落库"这件事收在一个文件里，是为了让下面这条**唯一的分叉**看得见、测得到。
 *
 * ── ★ 唯一的那个分叉：有没有数据库 ──────────────────────────────────────────
 *     有 `DATABASE_URL` ⇒ `PrismaLedgerRepository`（真查库）
 *     没有          ⇒ `NotImplementedLedgerRepository`（六个方法全部抛 501）
 *
 *   为什么不做"无库时静默跳过记账"：那正是本项目要根除的病（B6 —— 扣分被静默截断，
 *   流水与余额对不上）。**少一个实现就等于少一条写入路径**，所以缺实现必须响亮地 501，
 *   而不是悄悄变成 no-op。判据只有一处：`hasDatabaseUrl()`（见 `prisma/database-enabled.ts`）。
 *
 *   为什么必须是**动态模块**（`register()`）而不能在 `@Module` 里写死 provider：
 *   `PrismaService` 的构造函数在缺 `DATABASE_URL` 时**刻意**抛错，而 Nest 会急切地
 *   实例化被导入模块的全部 provider ⇒ 若静态地 `imports: [PrismaModule]`，那么
 *   `npm run test`（离线用例，本机/CI 都没有库）会在**装配阶段**就炸，
 *   连"501 是默认行为"这条用例都跑不到。所以"要不要导入 PrismaModule"必须在装配时定。
 *
 *   为什么装配后还要把 `PrismaModule` 放进 `imports`（而不是 `new PrismaService()`）：
 *   全仓共用**一个**连接池、一套生命周期（`onModuleInit` 连库 / `onModuleDestroy` 断库）。
 *   自己在工厂里 `new` 一个客户端，会让"同一次请求里的多表写入"落在两个池、两个事务域上
 *   （§9.13 的原子性就没了）。
 *
 * ── 用例怎么钉住它 ─────────────────────────────────────────────────────────
 *   离线：`test/ledger-gate.test.ts` 组 G —— 显式传 `hasDatabase`，
 *         并**叠加一个替身 Prisma** 断言"有库时真的绑 Prisma 适配器、且走的是注入的客户端"。
 *   真库：`test-db/ledger-db.dbtest.ts` 组 J —— 用真 `register()` 建图，
 *         从注入器取出端口，**读出的余额等于库里那一行**。
 *   ⇒ 离线管"声明对不对"，真库管"接了库真的通"。两边缺一不可：
 *     只测声明的话，"接了一条断线"照样全绿。
 */
import { DynamicModule, Module, Type } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'

import { PrismaLedgerRepository } from './ledger.prisma.repository'
import {
  LEDGER_REPOSITORY,
  NotImplementedLedgerRepository,
  type LedgerPort
} from './ledger.repository'

/**
 * 装配选项。**用例必须显式传值**（生产代码才允许省略、走环境推断）：
 * CI 机器上多半没有 `DATABASE_URL`、开发机上多半有 —— 靠环境推断的话，
 * 同一份用例在两台机器上验的其实是两件事（而"CI 绿了"会被当成"验过了"）。
 */
export interface LedgerAssemblyOptions {
  /** `true` ⇒ 真 Prisma 适配器；`false` ⇒ 501。省略 ⇒ `hasDatabaseUrl()`。 */
  hasDatabase?: boolean
}

/**
 * 装配判据的**纯函数形态**：给定"有没有库"，返回该绑哪个实现。
 *
 * 单拎出来是为了让用例能直接断言这个映射（不需要实例化 Prisma、不需要连库），
 * 也让"映射有两个分支、且互不重叠"这句话可以被证伪（见 `tools/_scratch/w2b-canfail.mjs`）。
 */
export function resolveLedgerRepositoryClass(hasDatabase: boolean): Type<LedgerPort> {
  return hasDatabase ? PrismaLedgerRepository : NotImplementedLedgerRepository
}

@Module({})
export class LedgerModule {
  /**
   * 建图。`app.module.ts` 调**不带参数**的版本（按环境推断）；
   * 用例调带参数的版本（把"在哪个世界"钉死）。
   *
   * 注意 `imports` 也跟着分叉：无库时**不**导入 `PrismaModule`，
   * 于是 `PrismaService` 根本不会被实例化 —— 这不是优化，是"无库也能把离线用例跑完"的前提。
   */
  static register(options: LedgerAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: LedgerModule,
      imports: hasDatabase ? [PrismaModule] : [],
      providers: [{ provide: LEDGER_REPOSITORY, useClass: resolveLedgerRepositoryClass(hasDatabase) }],
      exports: [LEDGER_REPOSITORY]
    }
  }
}

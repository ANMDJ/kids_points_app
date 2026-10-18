import { DynamicModule, Module, type Type } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import {
  IDEMPOTENCY_REPOSITORY,
  NotImplementedIdempotencyRepository,
  PrismaIdempotencyRepository,
  type IdempotencyPort
} from './idempotency.repository'
import { IdempotencyService } from './idempotency.service'

/**
 * 幂等（docs/design/02 §4.4）
 *
 * 问题：网络重试 / 双击「同意」/ 前端重复提交，都会导致**重复扣分**。
 *
 * 设计：客户端生成幂等键（`Idempotency-Key` 请求头），服务端：
 *   1. 插入 `IdempotencyRecord`（`@@unique([childId, key])` 兜底）；
 *   2. 唯一冲突 → 返回首次的 `responseStatus` / `responseBody`（而不是再执行一次）；
 *   3. 同一键但 `requestHash` 不同 → `409 IDEMPOTENCY_KEY_REUSED`，**不得静默复用**首次结果；
 *   4. 上一次还没写完 → `409 IDEMPOTENCY_IN_PROGRESS`（fail-closed，不会重复执行）。
 *
 * ★ 唯一约束必须在**数据库层**，不能只靠应用层「先查有没有」——
 *   并发下应用层检查必然漏（与 02 §8 邀请码是同一类错误）。
 *
 * ★ 无库装配 ⇒ 显式 501（只在请求**真的带了 key** 时触发；不带 key 的请求不碰本模块）。
 *   这与「无库时审批端口 501」同一口径：绝不假装重放保护已生效。
 */
export function resolveIdempotencyRepositoryClass(
  hasDatabase: boolean
): Type<IdempotencyPort> {
  return hasDatabase ? PrismaIdempotencyRepository : NotImplementedIdempotencyRepository
}

export interface IdempotencyAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
}

@Module({})
export class IdempotencyModule {
  static register(options: IdempotencyAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    return {
      module: IdempotencyModule,
      imports: hasDatabase ? [PrismaModule] : [],
      providers: [
        IdempotencyService,
        {
          provide: IDEMPOTENCY_REPOSITORY,
          useClass: resolveIdempotencyRepositoryClass(hasDatabase)
        }
      ],
      exports: [IdempotencyService]
    }
  }
}

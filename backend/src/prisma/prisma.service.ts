import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

/**
 * Prisma 7 接入 —— ★ 与 01 §1 不同的一点：
 *
 * Prisma 7 起 schema 里**不能再写** `url`，客户端必须通过 **driver adapter** 接入。
 * 因此这里是 `new PrismaPg({ connectionString })` 而非什么都不传。
 * CLI 侧走 prisma.config.ts（迁移用），两者读同一个 DATABASE_URL。
 *
 * 全库唯一的数据库入口（全局模块）—— 账本的不变量都建立在「所有写入都经此」之上。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name)

  constructor() {
    const connectionString = process.env.DATABASE_URL
    if (connectionString === undefined || connectionString === '') {
      // 失败要**响亮**：静默降级成「无数据库」会让后面所有测试变成假绿（D12 同类错误）。
      throw new Error(
        'DATABASE_URL 未设置。复制 .env.example 为 .env（W0 验收门前置项，见 05 §6 L1）。'
      )
    }
    super({ adapter: new PrismaPg({ connectionString }) })
  }

  async onModuleInit(): Promise<void> {
    await this.$connect()
    this.logger.log('数据库已连接')
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }
}

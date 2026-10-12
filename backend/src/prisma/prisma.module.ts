import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'

/**
 * 全局模块：任何域模块都可注入 PrismaService，无需重复 imports。
 * 设为 @Global 是有意的 —— 账本不变量要求「所有写入都经同一入口」，
 * 若每个模块各自 new PrismaClient，事务边界会立刻失控（01 §4）。
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService]
})
export class PrismaModule {}

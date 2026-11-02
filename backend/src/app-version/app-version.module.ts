import { Module } from '@nestjs/common'

import { AppVersionController } from './app-version.controller'

/**
 * App 版本信息模块（W10-B，2026-11-02）。
 *
 * ★ 没有 provider、没有仓储：版本信息是**配置**，不是数据。
 *   把它接到 Prisma 上只会让\"改一个版本号\"需要一次迁移。
 */
@Module({
  controllers: [AppVersionController]
})
export class AppVersionModule {}

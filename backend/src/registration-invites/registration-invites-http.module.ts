import { DynamicModule, Module } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { RegistrationInvitesController } from './registration-invites.controller'
import {
  RegistrationInvitesCoreModule,
  type RegistrationInvitesAssemblyOptions
} from './registration-invites.module'
import { RegistrationInvitesService } from './registration-invites.service'

/**
 * 网站「邀请码获取」的 **HTTP 装配**（W12，2026-11-02）。
 *
 * ★ 只被 `AppModule` 导入一次。`IdentityModule` 导入的是核心模块
 *   （`RegistrationInvitesCoreModule`），不带控制器 —— 否则同一批路由
 *   被注册两遍，Nest 启动即报重复路径。
 *
 * 无库 ⇒ 核心端口是 501；`GET /invite` 页面本身**仍然可用**（它不碰库），
 * 但页面上的额度与提交会如实报错 —— 画一个「点了没反应」的按钮才是撒谎。
 */
@Module({})
export class RegistrationInvitesHttpModule {
  static register(
    options: RegistrationInvitesAssemblyOptions = {}
  ): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()

    return {
      module: RegistrationInvitesHttpModule,
      imports: [RegistrationInvitesCoreModule.register({ hasDatabase })],
      controllers: [RegistrationInvitesController],
      providers: [RegistrationInvitesService]
    }
  }
}

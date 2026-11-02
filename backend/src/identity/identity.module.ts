import { DynamicModule, Module, type Type } from '@nestjs/common'

import { hasDatabaseUrl } from '../prisma/database-enabled'
import { PrismaModule } from '../prisma/prisma.module'
import { RegistrationInvitesCoreModule } from '../registration-invites/registration-invites.module'
import { AuthGuard } from './auth.guard'
import { PrismaAuthSessionRepository } from './auth-session.prisma.repository'
import {
  AUTH_SESSION_REPOSITORY,
  NotImplementedAuthSessionRepository,
  type AuthSessionPort
} from './auth-session.repository'
import { ChildrenBootstrapController } from './children-bootstrap.controller'
import { IdentityController } from './identity.controller'
import { PrismaIdentityRepository } from './identity.prisma.repository'
import { PrismaInviteRegistrationRepository } from './invite-registration.prisma.repository'
import {
  INVITE_REGISTRATION_REPOSITORY,
  NotImplementedInviteRegistrationRepository,
  type InviteRegistrationPort
} from './invite-registration.repository'
import {
  IDENTITY_REPOSITORY,
  NotImplementedIdentityRepository,
  type IdentityPort
} from './identity.repository'
import { IdentityService } from './identity.service'
import { LoginRateLimiter } from './login-rate-limiter'
import { PrismaPublicRegistrationRepository } from './public-registration.prisma.repository'
import {
  PUBLIC_REGISTRATION_REPOSITORY,
  NotImplementedPublicRegistrationRepository,
  type PublicRegistrationPort
} from './public-registration.repository'
import {
  HttpWechatCode2Session,
  readWechatConfig
} from './wechat/wechat-code2session.http'
import {
  UnconfiguredWechatCode2Session,
  WECHAT_CODE2SESSION,
  type WechatCode2SessionPort
} from './wechat/wechat-code2session.port'

/**
 * 身份层（**登录 / 认证会话 / 新用户 bootstrap**）的装配（W9-A，2026-10-29）。
 *
 * 判据：`docs/design/40-login-and-session-design.md` §5、§8、§9.4、§12.2。
 *
 * ── 七条路由，两个控制器 ────────────────────────────────────────────────────
 *   `POST /auth/login` / `POST /auth/login-account` / `POST /auth/register-invite`
 *   / `POST /auth/date-code` / `POST /auth/logout` / `GET /auth/session`
 *   / `POST /auth/child-session` → `IdentityController`
 *   `POST /children`（新用户建占位档案 + 同意）        → `ChildrenBootstrapController`
 *   ★ `POST /auth/date-code`（W9-C）**不碰库**：它只按服务器时钟算 6 位码并比对，
 *     所以「没有库」对它不是故障（`hasDatabase: false` 下照样 200）。
 *
 * ── 四处**世界分叉**，每处都必须能显式钉住（用例不许靠环境推断）───────────────
 *   ① `AUTH_SESSION_REPOSITORY`：有库 ⇒ `PrismaAuthSessionRepository`（每个请求真查一行）；
 *      无库 ⇒ `NotImplementedAuthSessionRepository`（**501**，绝不返回"查不到"——
 *      那会把装配缺失伪装成 401 `TOKEN_INVALID`，把用户送去反复重新登录）；
 *   ② `IDENTITY_REPOSITORY`：有库 ⇒ `PrismaIdentityRepository`（登录/建孩子/补会话的写路径）；
 *      无库 ⇒ `NotImplementedIdentityRepository`（**501**，绝不"假装登录成功"）；
 *   ③ `INVITE_REGISTRATION_REPOSITORY`（W11-A）：有库 ⇒ `PrismaInviteRegistrationRepository`；
 *      无库 ⇒ **501**（同样不假装注册成功）；
 *   ④ `WECHAT_CODE2SESSION`：配了 AppID/Secret ⇒ HTTP 适配器；
 *      没配 ⇒ `UnconfiguredWechatCode2Session`（**503 `WECHAT_NOT_CONFIGURED`**）。
 *      注意 ④ **不依赖数据库**：`npm start` 没有库时它照样按配置分叉，
 *      这样"没配 secret"与"没有库"是两个可区分的故障。
 *
 * ── ★ 本模块**导出** `AuthGuard` 与两个仓库 token ─────────────────────────────
 *   `AuthGuard` 要注册成 `APP_GUARD`（全局第 0 位）—— 它必须能拿到
 *   `AUTH_SESSION_REPOSITORY`，而 `APP_GUARD` 的 provider 定义在 `AppModule` 里，
 *   所以本模块必须导出那个 token（导出 Guard 本身则让只导入本模块的用例也能用它）。
 *
 * ── 为什么**不**把 `IdentityModule` 做成"每个域模块都 import" ─────────────────
 *   它注册的是**路由**（`/auth/*`、`/children`）。被两个模块导入 = 同一批路由
 *   注册两遍 ⇒ Nest 启动即报重复路径（`consent-http.module.ts` 的存在就是为了
 *   这个坑：那里是 `ConsentModule` 被到处 import，所以 HTTP 层被单独拆出去）。
 *   本模块只被 `AppModule` 导入一次。
 */
export function resolveAuthSessionRepositoryClass(hasDatabase: boolean): Type<AuthSessionPort> {
  return hasDatabase ? PrismaAuthSessionRepository : NotImplementedAuthSessionRepository
}

export function resolveIdentityRepositoryClass(hasDatabase: boolean): Type<IdentityPort> {
  return hasDatabase ? PrismaIdentityRepository : NotImplementedIdentityRepository
}

/**
 * 邀请注册（W11-A）：有库 ⇒ 真写 5 张表（同一事务）；无库 ⇒ **501**。
 *
 * 为什么它不并进 `IdentityPort`：那个接口的 7 个方法每个都有两个测试替身，
 * 加第 8 个方法 = 一次性改 4 个替身，而 3 个永远用不到它。详见端口文件头。
 */
export function resolveInviteRegistrationRepositoryClass(
  hasDatabase: boolean
): Type<InviteRegistrationPort> {
  return hasDatabase
    ? PrismaInviteRegistrationRepository
    : NotImplementedInviteRegistrationRepository
}

export function resolveWechatCode2SessionClass(
  wechatConfigured: boolean
): Type<WechatCode2SessionPort> {
  return wechatConfigured ? HttpWechatCode2Session : UnconfiguredWechatCode2Session
}

/**
 * 网站注册邀请码的**写入端口**（W12，2026-11-02）：有库 ⇒ 一个事务写
 * `User` + 占码 + `AuthSession` + 审计；无库 ⇒ **501**（不假装注册成功）。
 *
 * ★ 与 `REGISTRATION_INVITE_REPOSITORY` 分工不同：那个（由
 *   `RegistrationInvitesCoreModule` 提供）只负责「这张码是不是网站发的」，
 *   本端口才负责「用它建账号」。拆开是为了让无库世界里的**路由查询**
 *   不会把注册的 501 说成发码的 501。
 */
export function resolvePublicRegistrationRepositoryClass(
  hasDatabase: boolean
): Type<PublicRegistrationPort> {
  return hasDatabase ? PrismaPublicRegistrationRepository : NotImplementedPublicRegistrationRepository
}

export interface IdentityAssemblyOptions {
  /** 省略 ⇒ 按环境推断（只有生产代码允许省略；用例必须显式钉死世界）。 */
  hasDatabase?: boolean
  /** 省略 ⇒ 按 `WECHAT_MP_APPID` / `WECHAT_MP_SECRET` 是否齐全推断。 */
  wechatConfigured?: boolean
}

@Module({})
export class IdentityModule {
  static register(options: IdentityAssemblyOptions = {}): DynamicModule {
    const hasDatabase = options.hasDatabase ?? hasDatabaseUrl()
    const wechatConfigured = options.wechatConfigured ?? readWechatConfig().kind === 'OK'

    return {
      module: IdentityModule,
      // 无库时**不**导入 PrismaModule：`PrismaService` 缺连接串会刻意抛错，
      // 而 Nest 会急切实例化被导入模块的全部 provider。
      imports: [
        ...(hasDatabase ? [PrismaModule] : []),
        // 网站注册邀请码的**只读路由**（findByCode）：判断这张码是不是网站发的。
        // ★ 只导入核心模块（无控制器）—— HTTP 层由 `RegistrationInvitesHttpModule`
        //   在 `AppModule` 里注册一次，避免同一批路由被注册两遍。
        RegistrationInvitesCoreModule.register({ hasDatabase })
      ],
      controllers: [IdentityController, ChildrenBootstrapController],
      providers: [
        IdentityService,
        LoginRateLimiter,
        AuthGuard,
        {
          provide: AUTH_SESSION_REPOSITORY,
          useClass: resolveAuthSessionRepositoryClass(hasDatabase)
        },
        { provide: IDENTITY_REPOSITORY, useClass: resolveIdentityRepositoryClass(hasDatabase) },
        {
          provide: INVITE_REGISTRATION_REPOSITORY,
          useClass: resolveInviteRegistrationRepositoryClass(hasDatabase)
        },
        {
          provide: PUBLIC_REGISTRATION_REPOSITORY,
          useClass: resolvePublicRegistrationRepositoryClass(hasDatabase)
        },
        {
          provide: WECHAT_CODE2SESSION,
          useClass: resolveWechatCode2SessionClass(wechatConfigured)
        }
      ],
      exports: [AuthGuard, AUTH_SESSION_REPOSITORY, IDENTITY_REPOSITORY]
    }
  }
}

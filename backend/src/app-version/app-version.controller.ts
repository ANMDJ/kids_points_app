import { Controller, Get } from '@nestjs/common'

import { Public } from '../identity/public.decorator'
import { resolveAppVersion, type AppVersionView } from './app-version.policy'

/**
 * `GET /app/version` —— App 自更新用的版本信息（W10-B，2026-11-02）。
 *
 * ── 为什么是 `@Public()` ────────────────────────────────────────────────────
 *   第三处匿名路由的判据（`identity.controller.ts` 文件头）：**要么不返回凭据，
 *   要么它就是签发凭据的那一个**。本端点两样都不占：它只返回公开的版本号与
 *   下载地址，不读任何用户数据、不需要设备头、也不改变任何状态。
 *   客户端在**登录之前**就要检查更新（否则\"版本太旧登不进去\"就没法自救）。
 *
 * ── 为什么不接受 `platform` 参数 ────────────────────────────────────────────
 *   目前只发布 Android。多一个参数就多一套\"平台×字段\"的校验矩阵，而现在
 *   没有任何第二种平台需要区分。等真上 iOS 时再加，并在那时写清 iOS 的
 *   响应里**没有** `downloadUrl`（App Store 链接不是直链）。
 */
@Controller('app')
export class AppVersionController {
  @Get('version')
  @Public()
  version(): AppVersionView {
    return resolveAppVersion()
  }
}

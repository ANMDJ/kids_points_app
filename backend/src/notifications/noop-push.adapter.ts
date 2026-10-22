import { Injectable } from '@nestjs/common'

import type { PushMessage, PushPort, PushResult } from './push.port'

/**
 * 默认推送适配器：**什么都不发**，并如实回答「没配置渠道」。
 *
 * ── 为什么默认实现不是「假装成功」──────────────────────────────────────────
 *   若这里 `return { delivered: true }`，日志与用例都会显示「推送已送达」，
 *   而真实用户一条也收不到 —— 这正是本仓库反复记过的「假绿」。
 *   `provider_not_configured` 让「还没接第三方」成为一个**可断言的事实**，
 *   而不是注释里的一句话。
 *
 * ── 接入第三方时怎么改 ────────────────────────────────────────────────────
 *   新增 `WechatSubscribePushAdapter` / `ApnsPushAdapter` / `FcmPushAdapter`
 *   实现 `PushPort`，在 `NotificationsModule` 里替换 `PUSH_PORT` 的 `useClass`。
 *   （需要按环境选择时，把 `NotificationsModule` 改成 `register(options)`，
 *   与 `ApprovalsModule` 的「有库 / 无库」分叉同一手法。）
 */
@Injectable()
export class NoopPushAdapter implements PushPort {
  async send(_message: PushMessage): Promise<PushResult> {
    return { delivered: false, reason: 'provider_not_configured' }
  }
}

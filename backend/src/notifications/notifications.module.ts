import { Module } from '@nestjs/common'

import { NoopPushAdapter } from './noop-push.adapter'
import { NotificationsService } from './notifications.service'
import { PUSH_PORT } from './push.port'

/**
 * 站内通知 / 推送（docs/design/01 §4 / 03 L3）
 *
 * ★ 本模块的**唯一不可妥协点**：通知发送必须在账本事务**之外**。
 *
 *   推送服务不可靠。若把推送放进事务，一次 APNs / 微信模板消息失败会
 *   **回滚一笔已经成立的加分** —— 孩子明明完成了、账却没了。这是不可接受的。
 *   反之，推送失败只意味着「晚一点知道」。
 *
 *   验收用例：02 §9.23（通知发送失败 → 账本已提交不受影响）。
 *
 * 状态（W5-K，2026-10-23）：**已打通「可调用接口」，尚未接任何第三方渠道**。
 *   · `PUSH_PORT` —— 渠道无关的推送端口（`push.port.ts`）；
 *   · `NoopPushAdapter` —— 默认实现，如实返回 `provider_not_configured`，
 *     **不假装送达**；
 *   · `NotificationsService` —— 唯一入口 `notifyApprovalStatusChanged()`，
 *     带 1s 超时、**永不抛错**，只记日志；
 *   · 审批 `decide()` 在账本事务提交后调用它（`approvals.service.ts`）。
 *
 * 仍未落地（不粉饰）：第三方 SDK / 凭据（L3）、`DeviceToken` 上报接口、
 * 站内 `Notification` 落库与未读红点。接入方式见 `28-w5k-handoff.md` §5。
 *
 * ⚠ 不要在 controller 里直接注入 `PUSH_PORT` —— 业务只能经
 *   `NotificationsService`，否则「失败不外抛 / 超时兜底」会被绕过。
 */
@Module({
  providers: [
    NotificationsService,
    // ★ 唯一换绑点：接第三方时把 useClass 换成真实 adapter（或改 register(options) 按环境选）。
    { provide: PUSH_PORT, useClass: NoopPushAdapter }
  ],
  exports: [NotificationsService, PUSH_PORT]
})
export class NotificationsModule {}


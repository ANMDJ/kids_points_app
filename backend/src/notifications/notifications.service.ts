import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  PUSH_PORT,
  type ApprovalStatusChangedPush,
  type PushPort,
  type PushResult
} from './push.port'

/**
 * 推送适配器的等待上限。
 *
 * ★ 为什么需要它：即使适配器不抛错，**永不 resolve** 也一样能把一次审批请求挂住。
 *   第三方推送不可靠是 `01` §4 的前提，所以「失败」必须包含「太慢」。
 *   真实适配器应当入队后立即返回；这条上限只是最后一道兜底，不承担重试。
 */
const PUSH_TIMEOUT_MS = 1000

/**
 * 通知 / 推送的**唯一业务入口**（W5-K，2026-10-23）。
 *
 * ── 一条不可妥协的口径 ────────────────────────────────────────────────────
 *   `notify*` 方法**永不抛错**：适配器抛错、超时、返回未送达，都只记日志并
 *   返回 `PushResult`。调用点（审批 `decide`）因此不需要 try/catch，
 *   也不会因为第三方故障把一次已经提交的批准变成 500。
 *
 * ── 调用时机 ──────────────────────────────────────────────────────────────
 *   **必须在账本事务提交之后**（`01` §4 / `02` §9.23）。
 *   本 service 不打开任何事务、不写业务表；它只把事件转交给 `PushPort`。
 *
 * ── 当前状态（诚实标注）──────────────────────────────────────────────────
 *   默认绑定 `NoopPushAdapter` ⇒ 每次调用返回 `provider_not_configured`，
 *   即「代码路径已接通，渠道未接」。第三方推送 SDK / 凭据 / 设备 token 上报
 *   都仍未落地，见 `docs/design/28-w5k-handoff.md` §5。
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name)

  constructor(@Inject(PUSH_PORT) private readonly push: PushPort) {}

  /**
   * 「审批结论变了」→ 通知申请人。
   *
   * 只应由 `ApprovalsService.decide()` 在端口返回终态**之后**调用；
   * 撤回（`withdrawn`）不推：那是申请人自己收回，没有第二个人需要被通知。
   */
  async notifyApprovalStatusChanged(message: ApprovalStatusChangedPush): Promise<PushResult> {
    try {
      const result = await this.sendWithTimeout(message)
      if (result.delivered) {
        this.log.debug(`推送已送达 approval=${message.approvalId}`)
      } else if (result.reason === 'provider_error') {
        this.log.error(
          `推送失败但已忽略（approval=${message.approvalId}）：${result.detail ?? '未知原因'}`
        )
      } else {
        // 「没配渠道 / 没 token」是当前常态，不刷 error 日志（否则真故障会被淹没）。
        this.log.debug(`推送未送达（${result.reason}）：approval=${message.approvalId}`)
      }
      return result
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log.error(`推送异常但已忽略（approval=${message.approvalId}）：${detail}`)
      return { delivered: false, reason: 'provider_error', detail }
    }
  }

  /** 超时与真实调用赛跑；无论谁赢都清掉计时器（否则测试进程会多等 1s）。 */
  private async sendWithTimeout(message: ApprovalStatusChangedPush): Promise<PushResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.push.send(message),
        new Promise<PushResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                delivered: false,
                reason: 'provider_error',
                detail: `推送适配器超过 ${PUSH_TIMEOUT_MS}ms 未返回`
              }),
            PUSH_TIMEOUT_MS
          )
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

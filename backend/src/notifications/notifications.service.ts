import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common'

import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  type KeysetPosition
} from '../common/keyset-cursor'
import type { ActionType } from '../contracts/permission-matrix'
import {
  NOTIFICATIONS_REPOSITORY,
  type NotificationsPort
} from './notifications.repository'
import type {
  MarkNotificationReadResponse,
  NotificationDto,
  NotificationsListResponse
} from './notifications.types'
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
 * 通知的**唯一业务入口**（W5-K 推送 / W5-L 站内，2026-10-23）。
 *
 * ── 一条不可妥协的口径 ────────────────────────────────────────────────────
 *   `notify*` 方法**永不抛错**：站内写库失败、推送适配器抛错 / 超时 / 未送达，
 *   都只记日志并返回 `PushResult`。调用点（审批 `decide`）因此不需要 try/catch，
 *   也不会因为通知故障把一次已经提交的批准变成 500。
 *
 * ── 两个渠道，一条顺序 ────────────────────────────────────────────────────
 *   ① **站内**（`Notification` 表）先写：它和账本在同一个库，是用户真的能看到的那条；
 *   ② 第三方推送后发：渠道未接（`NoopPushAdapter`）时返回 `provider_not_configured`。
 *   反过来的顺序会让「推送成功、站内丢了」变成一条查不到来源的消息 ——
 *   站内是事实来源，推送只是提醒。两者都失败也不回滚审批（事务早已提交）。
 *
 * ── 调用时机 ──────────────────────────────────────────────────────────────
 *   **必须在账本事务提交之后**（`01` §4 / `02` §9.23）。
 *   本 service 不打开业务事务、不改任何账本 / 审批状态；站内通知是**追加**一行。
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name)

  constructor(
    @Inject(PUSH_PORT) private readonly push: PushPort,
    @Inject(NOTIFICATIONS_REPOSITORY) private readonly repository: NotificationsPort
  ) {}

  /**
   * 「审批结论变了」→ 通知申请人。
   *
   * 只应由 `ApprovalsService.decide()` 在端口返回终态**之后**调用；
   * 撤回（`withdrawn`）不通知：那是申请人自己收回，没有第二个人需要被通知。
   */
  async notifyApprovalStatusChanged(message: ApprovalStatusChangedPush): Promise<PushResult> {
    // ① 站内先写（失败只记日志，永不影响 ② / 调用点）。
    await this.appendInApp(message)
    // ② 第三方推送：与 W5-K 完全一致（含 1s 超时兜底）。
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

  /**
   * `GET /notifications` —— 读「发给我的」一页（W5-L）。
   *
   * ── 收件人从哪里来 ──────────────────────────────────────────────────────
   *   `recipientUserId` 由 controller 从**会话**取出后传入，没有 query 入口。
   *   `childId` 同理（身份 Guard）。两者都不是客户端可选的过滤条件。
   *
   * ── `null` 与空页的区别 ────────────────────────────────────────────────
   *   端口回 `null` = 孩子不存在 / 已软删 ⇒ 404 `CHILD_NOT_FOUND`；
   *   空 `rows` = 真的没有通知 ⇒ 200 + `items: []`。
   *   把前者做成 200 空页，会让「数据被删了」伪装成「你没有新消息」。
   */
  async list(input: {
    childId: string
    recipientUserId: string
    limit: number
    cursor?: string
  }): Promise<NotificationsListResponse> {
    const before =
      input.cursor === undefined ? undefined : this.decodeCursor(input.cursor)

    const page = await this.repository.listForRecipient({
      childId: input.childId,
      recipientUserId: input.recipientUserId,
      limit: input.limit,
      ...(before === undefined ? {} : { before })
    })
    if (page === null) {
      throw new NotFoundException({
        code: 'CHILD_NOT_FOUND',
        message: '这个孩子不存在或已被移出，读不到通知。'
      })
    }

    // 游标指向**本页最后一行**（不是多取的那一行），两页之间不会重叠。
    const last = page.rows[page.rows.length - 1]
    const nextCursor =
      page.hasMore && last !== undefined
        ? encodeKeysetCursor({ createdAt: last.createdAt, id: last.id })
        : null

    return {
      items: page.rows.map(toNotificationDto),
      nextCursor,
      hasMore: page.hasMore,
      unreadCount: page.unreadCount
    }
  }

  /**
   * `PATCH /notifications/:id/read` —— 标记一条通知已读（W5-L）。
   *
   * ── 幂等，且**不重复写** ────────────────────────────────────────────────
   *   已读再点一次返回**原来的** `readAt`（不是新的时间戳）：否则「什么时候
   *   第一次看到」会被最后一次点击覆盖，红点逻辑也会跟着抖。
   *
   * ── 不属于我的通知 = 不存在 ────────────────────────────────────────────
   *   别人的 id 与不存在的 id 回同一个 404 `NOTIFICATION_NOT_FOUND`：
   *   区分两者等于给出「这个 id 存在」的探测口（与 W3-B 的审批同一条纪律）。
   */
  async markRead(input: {
    childId: string
    recipientUserId: string
    notificationId: string
  }): Promise<MarkNotificationReadResponse> {
    const result = await this.repository.markRead({
      childId: input.childId,
      recipientUserId: input.recipientUserId,
      notificationId: input.notificationId
    })
    if (result.kind === 'not_found') {
      throw new NotFoundException({
        code: 'NOTIFICATION_NOT_FOUND',
        message: '这条通知不存在，或者不是发给你的。'
      })
    }
    return { id: result.id, readAt: result.readAt.toISOString() }
  }

  /**
   * 落一条站内通知。**永不抛错**（见类注释）。
   *
   * ★ 为什么 `catch` 在这里而不是调用方：`notifyApprovalStatusChanged` 有一条
   *   「无论如何都要尝试推送」的义务 —— 站内失败不该把推送也一起跳过。
   *   反过来，推送失败也不会影响这条已经写好的站内通知。
   */
  private async appendInApp(message: ApprovalStatusChangedPush): Promise<void> {
    const content = approvalNotificationContent(message)
    try {
      await this.repository.append({
        childId: message.childId,
        recipientUserId: message.recipientUserId,
        type: content.type,
        title: content.title,
        body: content.body,
        payload: {
          approvalId: message.approvalId,
          status: message.status,
          action: message.action,
          decidedByUserId: message.decidedByUserId
        }
      })
      this.log.debug(`站内通知已写入 approval=${message.approvalId}`)
    } catch (error) {
      // 无库装配（501）也走这里：通知写不进去，但审批结论已经落库。
      const detail = error instanceof Error ? error.message : String(error)
      this.log.warn(`站内通知写入失败但已忽略（approval=${message.approvalId}）：${detail}`)
    }
  }

  /** 游标只在 service 里解析；格式错 = 400，绝不静默退回第一页。 */
  private decodeCursor(cursor: string): KeysetPosition {
    const position = decodeKeysetCursor(cursor)
    if (position === null) {
      throw new BadRequestException({
        code: 'INVALID_NOTIFICATION_CURSOR',
        message: 'cursor 不是本接口上一页返回的 nextCursor，请从第一页重新加载。'
      })
    }
    return position
  }
}

/** `ApprovalRequest.action` → 用户在通知里看到的那个名词。 */
function approvalLabel(action: ActionType): string {
  switch (action) {
    case 'redeem':
    case 'request_redeem':
      return '兑换申请'
    case 'request_points_bonus':
      return '加分申请'
    case 'add_wish':
      return '心愿申请'
    default:
      return '申请'
  }
}

/**
 * 站内通知的**文案与类型**（渠道无关，只在这里定义一次）。
 *
 * ── 为什么文案由服务端定 ────────────────────────────────────────────────
 *   两端（Flutter / 小程序）各自拼字符串，会在某一次改文案后不一致；
 *   更糟的是两端都可能把「被拒绝」写成「已完成」。这里只放**事实**：
 *   申请类型 + 结论；金额 / 心愿标题留在账本里（`payload` 只带跳转所需的 id）。
 */
function approvalNotificationContent(message: ApprovalStatusChangedPush): {
  type: string
  title: string
  body: string
} {
  const label = approvalLabel(message.action)
  if (message.status === 'approved') {
    return {
      type: 'approval.approved',
      title: `${label}已通过`,
      body: `家长已同意你的${label}，积分与心愿已按约定结算。`
    }
  }
  return {
    type: 'approval.rejected',
    title: `${label}未通过`,
    body: `家长没有同意这次${label}，积分没有变动。`
  }
}

/** 行 → 线格式：`Date` 只在这一处翻成 ISO 串（与 `read.mapper.ts` 同一个口径）。 */
function toNotificationDto(row: {
  id: string
  type: string
  title: string
  body: string
  payload: unknown
  readAt: Date | null
  createdAt: Date
}): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: row.payload,
    readAt: row.readAt === null ? null : row.readAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  }
}

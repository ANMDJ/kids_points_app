import { Injectable, NotImplementedException } from '@nestjs/common'

import type {
  AppendNotificationInput,
  ListNotificationsInput,
  MarkNotificationReadResult,
  NotificationPageRow
} from './notifications.types'

/**
 * 站内通知的**持久化端口**（W5-L，2026-10-23）。
 *
 * ── 三个方法，对应三件事 ──────────────────────────────────────────────────
 *   `listForRecipient`          —— 读「发给我的」一页（含未读数）；
 *   `markRead`                  —— 把一条**发给我的**标成已读（幂等）；
 *   `append`                    —— 审批结论落一条站内通知；
 *   `listActiveGuardianUserIds` —— 这个孩子的 active 家长（W5-M：新申请待确认）。
 *
 * ── 为什么读方法也带 `recipientUserId` ────────────────────────────────────
 *   收件人是**查询键的一半**，不是事后过滤。只按 `childId` 读、再到内存里筛，
 *   会让「漏写一次 where」直接变成越权（看到全家人的通知）。
 *   与 W3-B「跨孩子的审批 id 与不存在返回同一个 404」同一条纪律：
 *   不属于我的通知 = **不存在**。
 *
 * ── 为什么 `append` 没有返回值 / 不返回 id ────────────────────────────────
 *   调用点（审批 `decide`）在账本事务**之后**、且**永不因通知失败改变响应**。
 *   回 id 只会诱导调用方把它写进业务响应或重试逻辑；这里只需要「尽力写一条」。
 *
 * ── 无库装配 ──────────────────────────────────────────────────────────────
 *   四个方法全部 501。`append` / `listActiveGuardianUserIds` 的 501 会被
 *   `NotificationsService` 吞掉并记日志（通知失败不影响审批）；两个读方法则
 *   **响亮失败** —— 绝不返回空列表冒充「你没有通知」，那会让「审批被拒了」永远没人知道。
 */
export const NOTIFICATIONS_REPOSITORY = Symbol('NOTIFICATIONS_REPOSITORY')

export interface MarkReadInput {
  childId: string
  recipientUserId: string
  notificationId: string
}

export interface NotificationsPort {
  /**
   * 读一页「发给我的」通知。
   *
   * ★ 孩子不存在 / 已软删 ⇒ `null`（**不是**空页）：与 `/home` / `/records`
   *   同一口径 —— 空页会把「这个孩子不在库里」显示成「你没有新消息」。
   */
  listForRecipient(input: ListNotificationsInput): Promise<NotificationPageRow | null>

  markRead(input: MarkReadInput): Promise<MarkNotificationReadResult>

  /** 尽力写一条；失败由调用方（`NotificationsService`）记录，**不得**影响业务事务。 */
  append(input: AppendNotificationInput): Promise<void>

  /**
   * 这个孩子的 **active 家长** userId（W5-M）。
   *
   * ── 为什么放在通知端口，而不是让审批 service 查成员位 ────────────────────
   *   「谁该收到待确认」是**通知的收件人解析**，不是审批状态机的一部分。
   *   放到这里，`ApprovalsService` 只需要说「有新申请（谁、哪个动作）」，
   *   不必知道成员表长什么样、也不必在审批事务里多一次查询。
   *
   * ── 一条口径 ──────────────────────────────────────────────────────────────
   *   只回 `status = 'active'` 且 `role = 'guardian'` 的行；**不**按角色猜、
   *   **不**包含 child / viewer。提交人由调用方负责排除（端口只回答结构事实）。
   *
   * ★ 该方法**必须**在审批事务提交之后调用（`01` §4）：它只读成员位，
   *   但后续的 `append` / 推送都在事务外，先读后写不能反过来包进事务。
   */
  listActiveGuardianUserIds(childId: string): Promise<string[]>
}

/** 无库装配：三个方法全部 501（不假装读过、不假装写过）。 */
@Injectable()
export class NotImplementedNotificationsRepository implements NotificationsPort {
  async listForRecipient(_input: ListNotificationsInput): Promise<NotificationPageRow | null> {
    throw this.notImplemented('读取站内通知')
  }

  async markRead(_input: MarkReadInput): Promise<MarkNotificationReadResult> {
    throw this.notImplemented('标记通知已读')
  }

  async append(_input: AppendNotificationInput): Promise<void> {
    throw this.notImplemented('写入站内通知')
  }

  async listActiveGuardianUserIds(_childId: string): Promise<string[]> {
    throw this.notImplemented('读取家长列表')
  }

  private notImplemented(what: string): NotImplementedException {
    return new NotImplementedException({
      code: 'NOTIFICATIONS_PERSISTENCE_NOT_IMPLEMENTED',
      message:
        `当前装配没有数据库连接：${what}无处落库，拒绝假装成功。` +
        '请配置 DATABASE_URL 后重试。'
    })
  }
}

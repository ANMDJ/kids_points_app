import { Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import SheetFrame from '../components/SheetFrame'
import { useStore } from '../data/store'
import {
  formatNotificationTime,
  isApprovalSubmittedNotification,
  isNotificationUnread
} from '../data/notification'
import type { NotificationItem } from '../data/notification'
import { pushPage } from '../utils/nav'
import { toast } from '../utils/toast'
import './sheets.scss'

export interface NotificationsSheetProps {
  visible: boolean
  onClose: () => void
}

/**
 * 站内通知中心（W5-L）：审批结果等消息的**收件箱**。
 *
 * ── 收件人恒为「我」 ──────────────────────────────────────────────────────
 *   客户端没有「看谁的」参数：服务端按会话 `userId` 收口，别人的 id 与
 *   不存在的 id 返回同一句 404。界面因此**不需要**任何角色判断 ——
 *   两条路由在矩阵里两侧都 ALLOW。
 *
 * ── 未读只有一种事实源 ────────────────────────────────────────────────────
 *   行上的灰化 / 圆点全部由 `readAt === null` 现算；数量用服务端下发的整份
 *   `unreadCount`，**不**对 `items` 求和（本页 20 条之外的未读会被漏掉）。
 *
 * ── 点开 = 标记已读，但不强制跳转 ─────────────────────────────────────────
 *   点一条就打一次 `PATCH /notifications/:id/read`（失败原样提示，
 *   界面不回滚成未读 —— 服务端回包才是权威值）。
 *   审批类消息多一个胶囊，点它打开**这一条**的详情（P1-3）：
 *     · `approval.submitted` ⇒ 详情页可批 / 拒（`mode=decide`）；
 *     · `approval.approved` / `rejected` ⇒ 只看结果（`mode=view`）。
 *   普通消息（没有 `approvalId`）只是读掉，不做无意义的跳转。
 *
 * 列表与分页状态放在 store（`notifications` / `notificationsHasMore`）：
 * 未读角标与面板读的是同一份 `unreadCount`，本地再存一份就会两处不一致。
 */
export default function NotificationsSheet({
  visible,
  onClose
}: NotificationsSheetProps) {
  const store = useStore()
  /** 有读请求（首次拉取 / 重试 / 加载更多）在途；写请求的忙碌状态由 store 表达。 */
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!visible) return
    let alive = true
    setBusy(true)
    // 失败不弹窗：错误留在 `store.notificationsError` 里由面板照实展示。
    void store.refreshNotifications().finally(() => {
      if (alive) setBusy(false)
    })
    return () => {
      alive = false
    }
  }, [visible, store])

  const items = store.notifications
  const unread = store.unreadNotificationCount

  /**
   * 标记已读。**不**在预览模式 / 只读模式下假装成功：直接说明原因。
   * 返回「这次是否已经读掉」，供「查看申请」决定要不要继续跳转。
   */
  const markRead = async (item: NotificationItem): Promise<boolean> => {
    if (!isNotificationUnread(item)) return true
    if (store.isNotificationWriteReadOnly) {
      toast(store.notificationReadOnlyWriteMessage)
      return false
    }
    const message = await store.markNotificationRead(item)
    if (message !== null) toast(message)
    return message === null
  }

  const reload = () => {
    if (busy) return
    setBusy(true)
    void store.refreshNotifications().finally(() => setBusy(false))
  }

  const loadMore = () => {
    if (busy) return
    setBusy(true)
    void store.loadMoreNotifications().finally(() => setBusy(false))
  }

  /**
   * 空态必须区分**没拉到**与**真的没有** —— 403 / 断网时显示「没有消息」
   * 会让用户以为审批结果从来没来过。
   */
  const emptyText = (): string => {
    if (store.notificationsError !== null) return '消息列表没能加载'
    if (store.notificationsStatus === 'loading') return '正在加载消息…'
    if (!store.isLiveMode) return '预览模式没有站内消息'
    return '还没有消息'
  }

  return (
    <SheetFrame
      visible={visible}
      title={unread > 0 ? `消息（${unread} 条未读）` : '消息'}
      subtitle='审批申请与结果会在这里留一条；点一下即标记已读'
      onClose={onClose}
    >
      {store.notificationsError !== null ? (
        <View className='kp-notif__status-row'>
          <Text className='kp-notif__error-text'>
            消息加载失败：{store.notificationsError.userMessage}
          </Text>
          <View
            className={`kp-notif__chip ${busy ? 'is-disabled' : ''}`}
            onClick={reload}
          >
            <Text className='kp-notif__chip-text'>重试</Text>
          </View>
        </View>
      ) : null}

      {items.length === 0 ? (
        <View className='kp-notif__empty'>
          <Text className='kp-notif__empty-text'>{emptyText()}</Text>
        </View>
      ) : null}

      <View className='kp-notif__list'>
        {items.map((item) => (
          <NotificationRow
            key={item.id}
            item={item}
            busy={store.busyNotificationId === item.id}
            onOpen={() => {
              void markRead(item)
            }}
            onOpenApplication={() => {
              // P1-3：打开**这一条**的详情（结果类消息只看，不显示动作）。
              void (async () => {
                await markRead(item)
                pushPage(
                  `/pages/approval-detail/index?id=${encodeURIComponent(
                    item.approvalId ?? ''
                  )}&mode=view`
                )
              })()
            }}
            onOpenSubmitted={() => {
              // 「有人提交了申请」⇒ 家长可批 / 拒（同一详情页，mode=decide）。
              void (async () => {
                await markRead(item)
                pushPage(
                  `/pages/approval-detail/index?id=${encodeURIComponent(
                    item.approvalId ?? ''
                  )}&mode=decide`
                )
              })()
            }}
          />
        ))}
      </View>

      {items.length > 0 && store.notificationsHasMore ? (
        <View className='kp-notif__more'>
          <View
            className={`kp-notif__chip ${busy ? 'is-disabled' : ''}`}
            onClick={loadMore}
          >
            <Text className='kp-notif__chip-text'>
              {busy ? '正在加载…' : '加载更多'}
            </Text>
          </View>
        </View>
      ) : null}
    </SheetFrame>
  )
}

/**
 * 一行通知：未读圆点 + 标题 + 时间 + 正文；审批类多一个胶囊。
 *
 * 已读的行**不隐藏**（那不是「消息没了」），只是颜色变浅 ——
 * 用户回头找「上周那条被拒的原因」时还得看得见。
 */
function NotificationRow({
  item,
  busy,
  onOpen,
  onOpenApplication,
  onOpenSubmitted
}: {
  item: NotificationItem
  busy: boolean
  onOpen: () => void
  onOpenApplication: () => void
  onOpenSubmitted: () => void
}) {
  const unread = isNotificationUnread(item)
  const submitted = isApprovalSubmittedNotification(item)

  return (
    <View
      className={`kp-notif__row ${unread ? 'is-unread' : 'is-read'}`}
      onClick={() => {
        // 已读行再点不重复请求（store 也会提前返回）。
        if (busy) return
        onOpen()
      }}
    >
      <View className='kp-notif__head'>
        {unread ? <View className='kp-notif__dot' /> : null}
        <Text className='kp-notif__title'>{item.title}</Text>
        <Text className='kp-notif__time'>
          {formatNotificationTime(item.createdAt)}
        </Text>
      </View>
      <Text className='kp-notif__body'>{item.body}</Text>
      {item.approvalId === null ? null : (
        <View className='kp-notif__foot'>
          <View
            className={`kp-notif__chip ${busy ? 'is-disabled' : ''}`}
            onClick={(event) => {
              // 这一层在行内：不拦冒泡会顺带触发整行的标记已读。
              event.stopPropagation()
              if (busy) return
              if (submitted) {
                onOpenSubmitted()
                return
              }
              onOpenApplication()
            }}
          >
            <Text className='kp-notif__chip-text'>
              {busy ? '处理中…' : submitted ? '去审批' : '查看申请'}
            </Text>
          </View>
        </View>
      )}
    </View>
  )
}

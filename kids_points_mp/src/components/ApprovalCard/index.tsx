import { Text, View } from '@tarojs/components'

import AppCard from '../AppCard'
import Icon from '../Icon'
import type { IconName } from '../Icon/icons'
import {
  approvalAutoReasonLabel,
  approvalBlockedReason,
  approvalDetail,
  approvalHeadline,
  approvalRemainingText,
  approvalStatusLabel,
  formatApprovalTime,
  isApprovalExpired,
  isApprovalPending
} from '../../data/approval'
import type { ApprovalInboxItem } from '../../data/approval'
import './index.scss'

export interface ApprovalCardProps {
  item: ApprovalInboxItem
  /** 当前时间（epoch 毫秒）：剩余有效期 / 过期判断都按它算。 */
  now: number
  /** 有任意一条在提交中：所有卡片的按钮都禁用，避免串批。 */
  busy: boolean
  /** 这一条正在提交：按钮位置显示转圈。 */
  deciding: boolean
  /** 收件箱写入是否可用（live + 有写客户端）。 */
  canWrite: boolean
  onApprove: () => void
  onReject: () => void
  /** 点整张卡 → 详情（P1-3）；按钮各自 `stopPropagation`，不会误触。 */
  onOpen?: () => void
}

/** 摘要图标 + 底色：让家长一眼分清「兑换 / 加分 / 新增心愿」。 */
function badgeOf(item: ApprovalInboxItem): { icon: IconName; color: string } {
  const summary = item.summary
  if (summary === null) return { icon: 'unknown', color: '#b6bdb0' }
  switch (summary.kind) {
    case 'redeem':
      return { icon: 'gift', color: '#f5a24b' }
    case 'bonus':
      return { icon: 'plus', color: '#6fbf4b' }
    case 'add_wish':
      return { icon: 'heart', color: '#f6c64a' }
  }
}

/**
 * 收件箱里的一条申请。
 *
 * 三种按钮状态都来自模型的纯函数，页面不自己判断：
 *   · `blocked !== null` → 批准禁用并显示原因（读不懂 payload / 已过期）；
 *   · 过期 → 拒绝也禁用（服务端同样会 409）；
 *   · `canWrite === false` → 两个都禁用（只读模式没有写端点）。
 *   拒绝在「读不懂」时仍然可用，否则坏数据会永久卡在列表里。
 */
export default function ApprovalCard({
  item,
  now,
  busy,
  deciding,
  canWrite,
  onApprove,
  onReject,
  onOpen
}: ApprovalCardProps) {
  const pending = isApprovalPending(item)
  const expired = isApprovalExpired(item, now)
  const blocked = pending ? approvalBlockedReason(item, now) : null
  const remaining = approvalRemainingText(item, now)
  const badge = badgeOf(item)
  const autoReason = approvalAutoReasonLabel(item)

  return (
    <AppCard paddingLtrb={[14, 13, 14, 12]} marginBottom={10} onClick={onOpen}>
      <View className='kp-approval__head'>
        <View
          className='kp-approval__badge'
          style={{ backgroundColor: `${badge.color}1f` }}
        >
          <Icon name={badge.icon} size={20} color={badge.color} />
        </View>
        <View className='kp-approval__titles'>
          <Text className='kp-approval__headline'>
            {item.summary === null ? '内容无法识别' : approvalHeadline(item.summary)}
          </Text>
          <Text className='kp-approval__detail'>
            {item.summary === null
              ? '服务端返回的申请内容无法解析（数据异常），不能批准。'
              : approvalDetail(item.summary)}
          </Text>
        </View>
        <StatusPill item={item} expired={expired} remaining={remaining} />
      </View>

      <Text className='kp-approval__time'>
        提交于 {formatApprovalTime(item.createdAt)}
      </Text>

      {pending ? null : (
        <Text className='kp-approval__status'>
          {autoReason === ''
            ? approvalStatusLabel(item)
            : `${approvalStatusLabel(item)} · ${autoReason}`}
        </Text>
      )}

      {pending ? (
        <View className='kp-approval__actions'>
          {blocked !== null ? (
            <Text className='kp-approval__blocked'>{blocked}</Text>
          ) : (
            <View className='kp-approval__spacer' />
          )}
          {deciding ? (
            <View className='kp-approval__spinner' />
          ) : (
            <>
              <View
                className={`kp-approval__button is-reject ${
                  !canWrite || expired ? 'is-disabled' : ''
                }`}
                onClick={(event) => {
                  // 卡片的 onClick 是「打开详情」：按钮必须拦住冒泡。
                  event.stopPropagation()
                  if (!canWrite || expired) return
                  onReject()
                }}
              >
                <Text className='kp-approval__button-label'>拒绝</Text>
              </View>
              <View
                className={`kp-approval__button is-approve ${
                  !canWrite || expired || blocked !== null || busy
                    ? 'is-disabled'
                    : ''
                }`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (!canWrite || expired || blocked !== null || busy) return
                  onApprove()
                }}
              >
                <Text className='kp-approval__button-label'>批准</Text>
              </View>
            </>
          )}
        </View>
      ) : null}
    </AppCard>
  )
}

/** 右上角状态胶囊：待处理显示剩余时间，已处理显示状态名。 */
function StatusPill({
  item,
  expired,
  remaining
}: {
  item: ApprovalInboxItem
  expired: boolean
  remaining: string | null
}) {
  if (isApprovalPending(item)) {
    if (expired) {
      return (
        <View className='kp-approval__pill'>
          <Text className='kp-approval__pill-label'>已过期</Text>
        </View>
      )
    }
    return (
      <View className='kp-approval__pill is-filled'>
        <Text className='kp-approval__pill-label'>
          {remaining ?? '待处理'}
        </Text>
      </View>
    )
  }

  const tone =
    item.status === 'approved'
      ? 'is-approved'
      : item.status === 'rejected'
        ? 'is-rejected'
        : ''
  return (
    <View className={`kp-approval__pill is-flat ${tone}`}>
      <Text className='kp-approval__pill-label'>{approvalStatusLabel(item)}</Text>
    </View>
  )
}

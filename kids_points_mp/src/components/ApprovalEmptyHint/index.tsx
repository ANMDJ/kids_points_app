import { Text, View } from '@tarojs/components'

import type { ReadApiException } from '../../data/read_api_errors'
import './index.scss'

export interface ApprovalEmptyHintProps {
  /** false = 预览模式（没有后端可问）。 */
  isLiveMode: boolean
  /** 当前不是「全部」筛选（空列表的措辞要跟着变）。 */
  isFiltered: boolean
  /** 读取失败时的原因（区分 403 与一般错误）。 */
  error: ReadApiException | null
  onRetry: () => void
}

/**
 * 空态：必须区分「预览模式」「没权限（403）」「读取失败」「真的没有」。
 *
 * 把 403 说成「暂无待审批」是最糟的谎 —— 家长会以为孩子没提交，
 * 实际是这台设备的身份根本批不了。所以这里按 `error.kind` 分开写。
 */
export default function ApprovalEmptyHint({
  isLiveMode,
  isFiltered,
  error,
  onRetry
}: ApprovalEmptyHintProps) {
  if (!isLiveMode) {
    return (
      <Hint
        emoji='🌱'
        text={
          '预览模式没有审批数据。\n连上后端后，孩子的兑换 / 加分申请会出现在这里。'
        }
      />
    )
  }

  if (error !== null) {
    if (error.kind === 'forbidden') {
      return (
        <Hint
          emoji='🔒'
          text={
            '当前身份没有批准申请的权限（403）。\n审批只能由家长设备处理；孩子设备可以继续提交申请。'
          }
          actionLabel='重试'
          onAction={onRetry}
        />
      )
    }
    return (
      <Hint
        emoji='⚠️'
        text={`${error.userMessage}\n这不是「没有待审批」。`}
        actionLabel='重试'
        onAction={onRetry}
      />
    )
  }

  return (
    <Hint
      emoji='🍃'
      text={isFiltered ? '没有符合条件的申请。' : '还没有任何申请。'}
    />
  )
}

function Hint({
  emoji,
  text,
  actionLabel,
  onAction
}: {
  emoji: string
  text: string
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <View className='kp-approval-hint'>
      <Text className='kp-approval-hint__emoji'>{emoji}</Text>
      <Text className='kp-approval-hint__text'>{text}</Text>
      {actionLabel && onAction ? (
        <View className='kp-approval-hint__action' onClick={onAction}>
          <Text className='kp-approval-hint__action-label'>{actionLabel}</Text>
        </View>
      ) : null}
    </View>
  )
}

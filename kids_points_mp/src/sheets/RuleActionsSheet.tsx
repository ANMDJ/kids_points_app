import { View } from '@tarojs/components'

import ActionRow from './ActionRow'
import SheetFrame from '../components/SheetFrame'
import { store } from '../data/store'
import type { PointRule } from '../data/types'
import { toast } from '../utils/toast'
import './sheets.scss'

export interface RuleActionsSheetProps {
  visible: boolean
  rule: PointRule | null
  onClose: () => void
}

/** 长按 / 点击规则：加入今天的习惯、删除规则。 */
export default function RuleActionsSheet({
  visible,
  rule,
  onClose
}: RuleActionsSheetProps) {
  if (!rule) return null

  const handleAddToHabits = () => {
    // 修 A1：扣分规则不能生成可打卡习惯（原先 Math.abs 会把扣分变成加分），
    // 被拒绝时必须把原因告诉家长（禁止静默失败）
    const message = store.addHabitFromRule(rule)
    if (message) {
      toast(message)
      return
    }
    onClose()
    toast(`“${rule.title}”已加入首页习惯`)
  }

  const handleRemove = () => {
    store.removeRule(rule)
    onClose()
    toast('规则已删除')
  }

  return (
    <SheetFrame
      visible={visible}
      title={rule.title}
      subtitle={rule.detail}
      onClose={onClose}
    >
      <ActionRow
        icon='listCheck'
        label='加入今天的习惯'
        onClick={handleAddToHabits}
      />
      <View className='kp-sheet-gap-10' />
      <ActionRow
        icon='trash'
        label='删除这条规则'
        danger
        onClick={handleRemove}
      />
    </SheetFrame>
  )
}

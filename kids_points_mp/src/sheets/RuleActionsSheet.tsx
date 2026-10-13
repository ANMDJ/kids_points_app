import { View } from '@tarojs/components'

import ActionRow from './ActionRow'
import SheetFrame from '../components/SheetFrame'
import { store } from '../data/store'
import type { PointRule } from '../data/types'
import { ruleDetail } from '../data/types'
import { toast } from '../utils/toast'
import './sheets.scss'

export interface RuleActionsSheetProps {
  visible: boolean
  rule: PointRule | null
  onClose: () => void
  /** 点“编辑这条规则”：由页面负责收起本菜单并打开编辑态表单（修 C10） */
  onEdit?: () => void
}

/** 长按 / 点击规则：编辑规则、加入今天的习惯、移到回收站。 */
export default function RuleActionsSheet({
  visible,
  rule,
  onClose,
  onEdit
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
    // 修 C9：删除只改状态位（软删），规则留在数据里 90 天可恢复 ——
    // 历史流水的回指（ruleId / ruleVersion）因此不会指向空。
    store.removeRule(rule)
    onClose()
    toast('已移到回收站，90 天内可在「我的 · 回收站」恢复')
  }

  return (
    <SheetFrame
      visible={visible}
      title={rule.title}
      subtitle={ruleDetail(rule)}
      onClose={onClose}
    >
      <ActionRow
        icon='pencil'
        label={`编辑这条规则（当前第 ${rule.currentVersion} 版）`}
        onClick={() => {
          if (onEdit) onEdit()
        }}
      />
      <View className='kp-sheet-gap-10' />
      <ActionRow
        icon='listCheck'
        label='加入今天的习惯'
        onClick={handleAddToHabits}
      />
      <View className='kp-sheet-gap-10' />
      <ActionRow
        icon='trash'
        label='移到回收站'
        danger
        onClick={handleRemove}
      />
    </SheetFrame>
  )
}

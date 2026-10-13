import { View } from '@tarojs/components'
import { useState } from 'react'

import {
  FieldLabel,
  IconPicker,
  SoftTextField,
  ruleIconOptions
} from '../components/FormFields'
import PointsStepper from '../components/PointsStepper'
import SegmentedToggle from '../components/SegmentedToggle'
import SheetFrame from '../components/SheetFrame'
import { store } from '../data/store'
import type { PointRule } from '../data/types'
import { dailyLimitMax, dailyLimitMin, ruleChangeNotice } from '../data/types'
import { toast } from '../utils/toast'
import './sheets.scss'

export interface AddRuleSheetProps {
  visible: boolean
  onClose: () => void
  /**
   * 传了规则即为**编辑态**（同一张表单，修 C10）；不传则是新增。
   * 编辑态下 `id` 不变、`currentVersion` 由 store 递增 —— 页面不做版本运算。
   */
  rule?: PointRule | null
}

/** “新增 / 编辑规则”：约定做到什么、得几分（也可约定扣分）。 */
export default function AddRuleSheet({
  visible,
  onClose,
  rule = null
}: AddRuleSheetProps) {
  const [title, setTitle] = useState(rule ? rule.title : '')
  // 修 E15：表单收集的是**结构字段**（条件 + 每日次数），不再是「细则」自由串
  const [condition, setCondition] = useState(rule ? rule.condition : '')
  const [dailyLimit, setDailyLimit] = useState(rule ? rule.dailyLimit : 1)
  const [isGain, setIsGain] = useState(rule ? rule.points >= 0 : true)
  const [amount, setAmount] = useState(rule ? Math.abs(rule.points) : 2)
  // 修 D9：图标只在**新建**时选择 —— 编辑态不再显示这个「选了也不生效」的选择器。
  // 原因：图标是创建时写入的字段，而 `updateRule` 的版本快照（RuleVersion）里没有图标字段
  // —— 允许「改了但不入版本」会让「第 N 版规则长什么样」缺一块（C10 的语义要求快照完整）。
  // 要让编辑也能改图标，得先把 icon 纳入版本快照（契约扩展），本轮不做，见 docs/design/03 §D9 现状。
  const [iconIndex, setIconIndex] = useState(0)
  const handleSubmit = () => {
    const trimmed = title.trim()
    if (trimmed === '') {
      toast('规则名称不能为空哦')
      return
    }
    const option = ruleIconOptions[iconIndex]
    const points = isGain ? amount : -amount
    if (rule) {
      // 修 C10（§3.3）：改动后若“今天已打卡数 ≥ 新上限”，**必须**告知家长
      // 今天不能再打卡了 —— 否则改完规则孩子打不了卡，却不知原因。
      // 文案由纯函数 ruleChangeNotice 派生（写在 JSX 里的文案测不到）。
      const notice = ruleChangeNotice({
        childName: store.profile.name,
        checkedCountToday: store.checkedCountTodayOfRule(rule),
        newDailyLimit: dailyLimit
      })
      const message = store.updateRule(rule, {
        title: trimmed,
        condition,
        dailyLimit,
        points
      })
      if (message) {
        toast(message)
        return
      }
      onClose()
      toast(notice ?? `已更新规则：${trimmed}（第 ${rule.currentVersion + 1} 版）`)
      return
    }
    const message = store.addRule(
      trimmed,
      condition,
      dailyLimit,
      points,
      option.icon,
      option.color
    )
    if (message) {
      // 修 A2：频次越界被拒绝时必须说明原因（禁止静默失败）
      toast(message)
      return
    }
    onClose()
    toast(
      `已新增规则：${trimmed}（每天 ${dailyLimit} 次 · ${isGain ? '+' : '-'}${amount} 积分）`
    )
  }
  return (
    <SheetFrame
      visible={visible}
      title={rule ? '编辑规则' : '新增规则'}
      subtitle='规则会出现在积分规则页，也可以加入今天的习惯'
      actionLabel='保存规则'
      actionIcon='check'
      onAction={handleSubmit}
      onClose={onClose}
    >
      <FieldLabel text='规则名称' />
      <SoftTextField
        value={title}
        onChange={setTitle}
        hint='例如：每天练琴 30 分钟'
      />
      <View className='kp-sheet-gap-md' />
      <FieldLabel text='达成条件（会显示在名称下方）' />
      <SoftTextField
        value={condition}
        onChange={setCondition}
        hint='例如：认真练习不断开'
      />
      <View className='kp-sheet-gap-md' />
      {/* 修 A2 / E15：频次是可运算的结构字段，不再让家长手打「每天 1 次」这种展示串 */}
      <FieldLabel text='每天最多几次' />
      <PointsStepper
        value={dailyLimit}
        min={dailyLimitMin}
        max={dailyLimitMax}
        suffix='次/天'
        onChanged={setDailyLimit}
      />
      <View className='kp-sheet-gap-lg' />
      <FieldLabel text='积分方向' />
      <SegmentedToggle
        leftLabel='奖励加分'
        rightLabel='扣分提醒'
        leftSelected={isGain}
        onChanged={setIsGain}
      />
      <View className='kp-sheet-gap-md' />
      <PointsStepper value={amount} min={1} max={999} onChanged={setAmount} />
      <View className='kp-sheet-gap-md' />
      {/* 修 D9：图标只在新建时选择（编辑态的选择器「选了也不生效」，已移除） */}
      {rule ? null : (
        <>
          <FieldLabel text='选择图标' />
          <IconPicker selectedIndex={iconIndex} onSelected={setIconIndex} />
        </>
      )}
    </SheetFrame>
  )
}

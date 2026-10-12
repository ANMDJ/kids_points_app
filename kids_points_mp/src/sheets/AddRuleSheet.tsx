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
import { toast } from '../utils/toast'
import './sheets.scss'

export interface AddRuleSheetProps {
  visible: boolean
  onClose: () => void
}

/** “新增规则”：约定做到什么、得几分（也可约定扣分）。 */
export default function AddRuleSheet({ visible, onClose }: AddRuleSheetProps) {
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [isGain, setIsGain] = useState(true)
  const [amount, setAmount] = useState(2)
  const [iconIndex, setIconIndex] = useState(0)

  const handleSubmit = () => {
    const trimmed = title.trim()
    if (trimmed === '') {
      toast('规则名称不能为空哦')
      return
    }
    const option = ruleIconOptions[iconIndex]
    store.addRule(
      trimmed,
      detail,
      isGain ? amount : -amount,
      option.icon,
      option.color
    )
    onClose()
    toast(`已新增规则：${trimmed}（${isGain ? '+' : '-'}${amount} 积分）`)
  }

  return (
    <SheetFrame
      visible={visible}
      title='新增规则'
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
      <FieldLabel text='细则（会显示在名称下方）' />
      <SoftTextField
        value={detail}
        onChange={setDetail}
        hint='例如：认真练习不断开 · 每天 1 次'
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
      <FieldLabel text='选择图标' />
      <IconPicker selectedIndex={iconIndex} onSelected={setIconIndex} />
    </SheetFrame>
  )
}


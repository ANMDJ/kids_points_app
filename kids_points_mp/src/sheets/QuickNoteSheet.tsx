import { View } from '@tarojs/components'
import { useState } from 'react'

import { FieldLabel, SoftTextField } from '../components/FormFields'
import { QuickTag } from '../components/Pills'
import PointsStepper from '../components/PointsStepper'
import SegmentedToggle from '../components/SegmentedToggle'
import SheetFrame from '../components/SheetFrame'
import { store } from '../data/store'
import { toast } from '../utils/toast'
import './sheets.scss'

/** 常见事由，和 Flutter quick_note_sheet.dart 一致。 */
const QUICK_REASONS = [
  '主动帮忙做家务',
  '自主阅读',
  '按时起床',
  '主动整理房间',
  '顶嘴 / 发脾气'
]

/** 快选额度。 */
const QUICK_AMOUNTS = [1, 2, 5, 10]

export interface QuickNoteSheetProps {
  visible: boolean
  onClose: () => void
}

/** “记一笔”：家长手动加/减分。 */
export default function QuickNoteSheet({
  visible,
  onClose
}: QuickNoteSheetProps) {
  const [isGain, setIsGain] = useState(true)
  const [amount, setAmount] = useState(1)
  const [selectedReason, setSelectedReason] = useState('')
  const [typed, setTyped] = useState('')
  /** 提交中：主按钮在这段时间里不再接受第二次点击。 */
  const [saving, setSaving] = useState(false)

  const delta = isGain ? amount : -amount

  const handleSubmit = async () => {
    if (saving) return
    const trimmed = typed.trim()
    // 选中标签优先，手写内容作为补充；两者都空时用默认文案
    const reason =
      selectedReason !== ''
        ? trimmed === ''
          ? selectedReason
          : `${selectedReason}（${trimmed}）`
        : trimmed === ''
          ? '额外调整'
          : trimmed

    setSaving(true)
    // live 模式走 POST /records/adjust（余额与流水以服务端为准）；
    // 预览模式仍是本地写入 —— 两种模式的返回值语义一致。
    const message = await store.submitQuickNote(delta, reason, trimmed)
    setSaving(false)
    if (message) {
      // 修 B6：超额扣分会被服务端拒绝，必须把原因告诉家长（禁止静默失败）
      toast(message)
      return
    }
    onClose()
    toast(
      delta > 0
        ? `已加 ${delta} 积分：${reason}`
        : `已扣 ${Math.abs(delta)} 积分：${reason}`
    )
  }

  return (
    <SheetFrame
      visible={visible}
      title='记一笔'
      subtitle='家长手动加分或扣分，孩子立刻能看到'
      actionLabel={
        saving ? '保存中…' : `保存（${delta > 0 ? '+' : ''}${delta} 积分）`
      }
      actionIcon='check'
      onAction={handleSubmit}
      onClose={onClose}
    >
      <SegmentedToggle
        leftLabel='奖励加分'
        rightLabel='扣分提醒'
        leftSelected={isGain}
        onChanged={setIsGain}
      />
      <View className='kp-sheet-gap-xxl' />
      <PointsStepper
        value={amount}
        min={1}
        max={999}
        onChanged={setAmount}
      />
      <View className='kp-sheet-gap-xs' />
      <View className='kp-sheet-tags kp-sheet-tags--center'>
        {QUICK_AMOUNTS.map((value) => (
          <View className='kp-sheet-tags__item' key={value}>
            <QuickTag
              label={`${value} 分`}
              selected={amount === value}
              onClick={() => setAmount(value)}
            />
          </View>
        ))}
      </View>
      <View className='kp-sheet-gap-lg' />
      <FieldLabel text='常见事由' />
      <View className='kp-sheet-tags'>
        {QUICK_REASONS.map((reason) => (
          <View className='kp-sheet-tags__item' key={reason}>
            <QuickTag
              label={reason}
              selected={selectedReason === reason}
              onClick={() =>
                setSelectedReason(selectedReason === reason ? '' : reason)
              }
            />
          </View>
        ))}
      </View>
      <View className='kp-sheet-gap-lg' />
      <FieldLabel text='补充说明（可选）' />
      <SoftTextField
        value={typed}
        onChange={setTyped}
        hint='例如：今天主动帮妈妈洗碗'
        maxLines={2}
      />
    </SheetFrame>
  )
}

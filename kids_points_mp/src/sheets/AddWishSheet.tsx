import { View, Text } from '@tarojs/components'
import { useState } from 'react'

import { EmojiPicker, FieldLabel, SoftTextField } from '../components/FormFields'
import PointsStepper from '../components/PointsStepper'
import SheetFrame from '../components/SheetFrame'
import { store } from '../data/store'
import { toast } from '../utils/toast'
import './sheets.scss'

export interface AddWishSheetProps {
  visible: boolean
  onClose: () => void
}

/** “新增心愿”：孩子写下想要兑换的奖励以及需要的积分。 */
export default function AddWishSheet({
  visible,
  onClose
}: AddWishSheetProps) {
  const [title, setTitle] = useState('')
  const [cost, setCost] = useState(40)
  const [emoji, setEmoji] = useState('🎁')

  const handleSubmit = () => {
    const trimmed = title.trim()
    if (trimmed === '') {
      toast('先给心愿起个名字吧～')
      return
    }
    store.addWish(trimmed, cost, emoji)
    onClose()
    toast(`已添加心愿：${trimmed}（${cost} 积分）`)
  }

  const points = store.points

  return (
    <SheetFrame
      visible={visible}
      title='新增心愿'
      subtitle={`当前可用积分 ${points}`}
      actionLabel='保存心愿'
      actionIcon='heartFill'
      onAction={handleSubmit}
      onClose={onClose}
    >
      <FieldLabel text='心愿名称' />
      <SoftTextField
        value={title}
        onChange={setTitle}
        hint='例如：去游乐园玩一整天'
        maxLines={2}
      />
      <View className='kp-sheet-gap-lg' />
      <FieldLabel text='需要多少积分' />
      <PointsStepper
        value={cost}
        min={1}
        max={9999}
        onChanged={setCost}
      />
      <View className='kp-sheet-gap-lg' />
      <FieldLabel text='选个图标' />
      <EmojiPicker selected={emoji} onSelected={setEmoji} />
      <View className='kp-sheet-gap-sm' />
      <View className='kp-wish-tip'>
        <Text className='kp-wish-tip__text'>
          {points >= cost
            ? '现在就能兑换，点“兑换”立即生效'
            : `还差 ${cost - points} 积分，加油打卡就能达成`}
        </Text>
      </View>
    </SheetFrame>
  )
}

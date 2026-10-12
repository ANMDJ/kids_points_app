import { View, Text } from '@tarojs/components'

import { SmallPill } from '../Pills'
import type { Wish, WishCoverStyle } from '../../data/types'
import { rpx } from '../../utils/unit'
import './index.scss'

/**
 * 心愿单卡片的 4 套插画底色 —— **按稳定枚举取色**（修 E16：不再用数组下标）。
 * 刻意用 `Record<WishCoverStyle, …>` 而非数组：将来若给枚举加取值，
 * 这里会**在编译期**报缺色，而不是静默取到 `undefined`。
 */
export const WISH_GRADIENTS: Record<WishCoverStyle, [string, string]> = {
  A: ['#fff8e6', '#fbe7b8'],
  B: ['#fff6e9', '#f7dcc0'],
  C: ['#f3faea', '#dceebe'],
  D: ['#fff6f1', '#f8d9ce']
}

export interface WishCardProps {
  wish: Wish
  /** 当前可用积分，用于判断能否兑换 */
  points: number
  onRedeem: () => void
  onLongPress?: () => void
}

/** 心愿卡片：插画 + 名称 + 所需积分 + 兑换 / 还差 N。 */
export default function WishCard({
  wish,
  points,
  onRedeem,
  onLongPress
}: WishCardProps) {
  const affordable = !wish.redeemed && points >= wish.cost
  const gap = wish.cost - points > 0 ? wish.cost - points : 0
  const colors = WISH_GRADIENTS[wish.coverStyle]

  return (
    <View className='kp-wish' onLongPress={onLongPress}>
      <View
        className='kp-wish__illustration'
        style={{
          backgroundImage: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})`
        }}
      >
        <Text className='kp-wish__emoji'>{wish.emoji}</Text>
        <Text className='kp-wish__sparkle'>✨</Text>
        {wish.redeemed ? (
          <View className='kp-wish__redeemed'>
            <Text className='kp-wish__redeemed-label'>已兑换</Text>
          </View>
        ) : null}
      </View>
      <Text className='kp-wish__title'>{wish.title}</Text>
      <View className='kp-wish__bottom'>
        <View className='kp-wish__cost'>
          <Text className='kp-wish__cost-value'>{wish.cost}</Text>
          <Text className='kp-wish__cost-unit'>积分</Text>
        </View>
        {affordable ? (
          <SmallPill label='兑换' filled onClick={onRedeem} />
        ) : wish.redeemed ? (
          <SmallPill label='已兑换' />
        ) : (
          <SmallPill label={`还差 ${gap}`} />
        )}
      </View>
    </View>
  )
}

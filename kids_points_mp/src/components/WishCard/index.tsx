import { View, Text } from '@tarojs/components'

import { SmallPill } from '../Pills'
import type { Wish } from '../../data/types'
import { rpx } from '../../utils/unit'
import './index.scss'

/** 心愿单卡片的 4 套插画底色（对应 Flutter wishGradients）。 */
export const WISH_GRADIENTS: [string, string][] = [
  ['#fff8e6', '#fbe7b8'],
  ['#fff6e9', '#f7dcc0'],
  ['#f3faea', '#dceebe'],
  ['#fff6f1', '#f8d9ce']
]

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
  const colors = WISH_GRADIENTS[wish.backgroundIndex % WISH_GRADIENTS.length]

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

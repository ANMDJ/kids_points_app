import { ScrollView, Text, View } from '@tarojs/components'
import Taro, { useReady } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'

import AppBottomNav from '../../components/AppBottomNav'
import FloatingAddButton from '../../components/FloatingAddButton'
import GradientPage from '../../components/GradientPage'
import Icon from '../../components/Icon'
import WishCard from '../../components/WishCard'
import AddWishSheet from '../../sheets/AddWishSheet'
import { useStore } from '../../data/store'
import type { Wish } from '../../data/types'
import { useViewport } from '../../utils/layout'
import { switchTab } from '../../utils/nav'
import { confirm, toast } from '../../utils/toast'
import { DESIGN_WIDTH, designToPx } from '../../utils/unit'
import { useSheet } from '../../utils/useSheet'
import './index.scss'

/** 悬浮按钮高度，同时也是收起时的宽度（正圆）。 */
const FAB_HEIGHT = 52

/** 悬浮按钮距离屏幕右边 / 下边的距离。 */
const FAB_MARGIN = 20

/** 距离底部多少像素以内就算“已经滚到底”。 */
const BOTTOM_TOLERANCE = 24

/** 底部导航栏高度（AppBottomNav 的 kp-nav__row）。 */
const NAV_HEIGHT = 64

/** 心愿卡宽高比（Flutter GridView childAspectRatio）。 */
const CARD_ASPECT = 0.62

/** 列表左右留白 / 两列间距。 */
const LIST_PADDING = 20
const GRID_GAP = 14

/**
 * 心愿单：甜的心愿单 + 可兑换 / 还差多少 + 右下角可展开的“新增心愿”。
 *
 * 列表还没滚到底时，“新增心愿”收成右下角的圆形悬浮按钮；
 * 滚到底部后自动展开成整行胶囊按钮（与原来贴在底部的样子一致）。
 */
export default function Wishlist() {
  const store = useStore()
  const sheet = useSheet()
  const viewport = useViewport()

  /** 默认收起成圆形悬浮按钮，首帧布局结束后再纠正一次。 */
  const [expanded, setExpanded] = useState(false)
  const viewHeightRef = useRef(0)

  /** 卡片尺寸：宽度按两列算好，高度按设计稿 0.62 的宽高比。 */
  const cell = useMemo(() => {
    const width =
      (designToPx(DESIGN_WIDTH - LIST_PADDING * 2) - designToPx(GRID_GAP)) / 2
    return { width, height: width / CARD_ASPECT }
  }, [])

  /** 量一次列表可视高度：滚到底的判定要用它。 */
  const measure = () => {
    Taro.createSelectorQuery()
      .select('#kp-wish-scroll')
      .boundingClientRect()
      .select('#kp-wish-content')
      .boundingClientRect()
      .exec((res) => {
        const rects = (res || []) as Array<{ height?: number } | null>
        const view = rects[0]
        const content = rects[1]
        if (view && view.height) viewHeightRef.current = view.height
        if (content && content.height && viewHeightRef.current > 0) {
          // 列表比可视区还短时，一进来就已经在底部 → 直接展开
          setExpanded(content.height <= viewHeightRef.current)
        }
      })
  }

  useReady(measure)

  // 心愿增删会改变可滚动高度，重新判断按钮该展开还是收起
  useEffect(() => {
    const timer = setTimeout(measure, 50)
    return () => clearTimeout(timer)
    // measure 只读 DOM 尺寸，不需要进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.wishes.length])

  const syncFromScroll = (scrollTop: number, scrollHeight: number) => {
    const viewHeight = viewHeightRef.current
    if (viewHeight <= 0) return
    setExpanded(
      scrollTop + viewHeight >= scrollHeight - designToPx(BOTTOM_TOLERANCE)
    )
  }

  const handleRedeem = (wish: Wish) => {
    const ok = store.redeem(wish)
    toast(ok ? `兑换成功：${wish.title}` : '积分还不够，继续加油打卡吧！')
  }

  const handleRemove = async (wish: Wish) => {
    const ok = await confirm(
      `确定要删除“${wish.title}”吗？`,
      '删除心愿',
      '删除',
      '取消'
    )
    if (!ok) return
    store.removeWish(wish)
    toast('心愿已删除')
  }

  return (
    <>
      <GradientPage
        safeTop={false}
        footer={
          <AppBottomNav
            currentIndex={1}
            onChanged={(index) => switchTab(index, 1)}
          />
        }
      >
        <View
          className='kp-wishlist'
          style={{
            height: `${viewport.height - viewport.safeTop}px`,
            paddingTop: `${viewport.safeTop}px`,
            // 底部给导航栏 + 安全区留位，列表滚动区止于导航栏上方
            paddingBottom: `${designToPx(NAV_HEIGHT) + viewport.safeBottom}px`
          }}
        >
          <View className='kp-wishlist__header'>
            <Text className='kp-wishlist__title'>甜的心愿单</Text>
            <View className='kp-wishlist__title-icon'>
              <Icon name='pencil' size={18} color='#f6c64a' />
            </View>
            <View className='kp-wishlist__spacer' />
            <Text className='kp-wishlist__caption'>当前可用积分</Text>
            <Text className='kp-wishlist__points'>{store.points}</Text>
          </View>
          <ScrollView
            id='kp-wish-scroll'
            className='kp-wishlist__scroll'
            scrollY
            enhanced
            showScrollbar={false}
            onScroll={(event) =>
              syncFromScroll(event.detail.scrollTop, event.detail.scrollHeight)
            }
          >
            <View id='kp-wish-content' className='kp-wishlist__content'>
              <View className='kp-wishlist__grid'>
                {store.wishes.map((wish) => (
                  <View
                    className='kp-wishlist__cell'
                    key={wish.id}
                    style={{
                      width: `${cell.width}px`,
                      height: `${cell.height}px`
                    }}
                  >
                    <WishCard
                      wish={wish}
                      points={store.points}
                      onRedeem={() => handleRedeem(wish)}
                      onLongPress={() => {
                        void handleRemove(wish)
                      }}
                    />
                  </View>
                ))}
              </View>
              <View className='kp-wishlist__tail' />
            </View>
          </ScrollView>
          <View
            className='kp-wishlist__fab'
            style={{
              bottom: `${
                designToPx(NAV_HEIGHT + FAB_MARGIN) + viewport.safeBottom
              }px`
            }}
          >
            <FloatingAddButton
              label='新增心愿'
              icon='heartFill'
              expanded={expanded}
              expandedWidth={DESIGN_WIDTH - FAB_MARGIN * 2}
              height={FAB_HEIGHT}
              onClick={() => sheet.show()}
            />
          </View>
        </View>
      </GradientPage>
      {sheet.open ? (
        <AddWishSheet visible={sheet.visible} onClose={() => sheet.hide()} />
      ) : null}
    </>
  )
}

import { ScrollView, Text, View } from '@tarojs/components'
import { useState } from 'react'
import type { ReactNode } from 'react'

import GradientPage from '../../components/GradientPage'
import PageHeader from '../../components/PageHeader'
import ReadStatusBanner from '../../components/ReadStatusBanner'
import { SoftChip } from '../../components/Pills'
import RecordTile from '../../components/RecordTile'
import { useStore } from '../../data/store'
import { dayLabel, recordCategoryLabels } from '../../data/types'
import type { RecordCategory } from '../../data/types'
import { useViewport } from '../../utils/layout'
import { goBack } from '../../utils/nav'
import { useAuthGate } from '../../utils/useAuthGate'
import './index.scss'

/** 顶部筛选：全部 + 表扬 / 兑换 / 调整。 */
const FILTERS: Array<RecordCategory | null> = [
  null,
  'praise',
  'exchange',
  'adjust'
]

/** 积分记录：按 全部 / 表扬 / 兑换 / 调整 过滤，并按天分组（今天 / 昨天 …）。 */
export default function Record() {
  // W9-B：登录闸门（详见 `utils/useAuthGate.ts`）。
  useAuthGate()
  const store = useStore()
  const viewport = useViewport()
  // 与 Flutter 积分记录页的 RefreshIndicator 对齐：下拉从第一页重取，
  // 不沿用当前游标（否则会跳着读，且切分类后游标本来就不属于新分类）。
  const [refreshing, setRefreshing] = useState(false)
  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    void store.refreshFromServer().finally(() => setRefreshing(false))
  }

  // live 模式下列表**已经**是服务端按分类过滤后的结果；再本地过滤一遍
  // 只会把后面的页漏掉（见 AppStore.visibleRecords）。
  const list = store.visibleRecords
  const category = store.recordFilter
  const liveLoading = store.isLiveMode && store.readStatus === 'loading'
  const failed = store.isLiveMode && store.readError !== null

  /** 按天分组：同一天只在第一条前面插一个日期标题。 */
  const groups: ReactNode[] = []
  let currentLabel = ''
  list.forEach((record) => {
    const label = dayLabel(record.time)
    if (label !== currentLabel) {
      groups.push(
        <View
          className={`kp-record__day ${
            groups.length === 0 ? 'is-first' : ''
          }`}
          key={`day-${record.id}`}
        >
          <Text className='kp-record__day-label'>{label}</Text>
        </View>
      )
      currentLabel = label
    }
    groups.push(<RecordTile key={record.id} record={record} />)
  })

  return (
    <GradientPage safeTop={false}>
      <View
        className='kp-record'
        style={{
          height: `${viewport.height - viewport.safeTop}px`,
          paddingTop: `${viewport.safeTop}px`,
          paddingBottom: `${viewport.safeBottom}px`
        }}
      >
        <PageHeader title='积分记录' onBack={goBack} />
        <ReadStatusBanner />
        <View className='kp-record__filters'>
          <ScrollView
            className='kp-record__chips'
            scrollX
            enhanced
            showScrollbar={false}
          >
            <View className='kp-record__chips-row'>
              {FILTERS.map((item) => (
                <View className='kp-record__chip' key={item ?? 'all'}>
                  <SoftChip
                    label={item ? recordCategoryLabels[item] : '全部'}
                    selected={category === item}
                    onClick={() => {
                      void store.setRecordFilter(item)
                    }}
                  />
                </View>
              ))}
            </View>
          </ScrollView>
          <Text className='kp-record__count'>
            {store.isLiveMode && store.hasMoreRecords
              ? `已加载 ${list.length} 条`
              : `共 ${list.length} 条`}
          </Text>
        </View>
        <View className='kp-record__gap' />
        {list.length === 0 ? (
          liveLoading ? (
            <View className='kp-record__empty'>
              <View className='kp-record__spinner' />
            </View>
          ) : (
            <View className='kp-record__empty'>
              <Text className='kp-record__empty-emoji'>
                {failed ? '⚠️' : '🍃'}
              </Text>
              <View className='kp-record__empty-gap' />
              <Text className='kp-record__empty-text'>
                {failed
                  ? '没有可展示的记录\n请查看上方提示后重试'
                  : '这里还没有记录'}
              </Text>
            </View>
          )
        ) : (
          <ScrollView
            className='kp-record__list'
            scrollY
            enhanced
            showScrollbar={false}
            refresherEnabled={store.isLiveMode}
            refresherTriggered={refreshing}
            refresherBackground='#FDFFF9'
            onRefresherRefresh={handleRefresh}
          >
            <View className='kp-record__list-content'>
              {groups}
              {store.isLiveMode &&
              (store.readStatus === 'loading' ||
                store.readStatus === 'loadingMore') ? (
                <View className='kp-record__footer'>
                  <View className='kp-record__spinner' />
                </View>
              ) : store.hasMoreRecords ? (
                <View className='kp-record__footer'>
                  <View
                    className='kp-record__more'
                    onClick={() => {
                      void store.loadMoreRecords()
                    }}
                  >
                    <Text className='kp-record__more-text'>
                      {store.readStatus === 'error'
                        ? '重试加载更多'
                        : '加载更多'}
                    </Text>
                  </View>
                </View>
              ) : (
                <View className='kp-record__footer'>
                  <Text className='kp-record__no-more'>没有更多了</Text>
                </View>
              )}
            </View>
          </ScrollView>
        )}
      </View>
    </GradientPage>
  )
}

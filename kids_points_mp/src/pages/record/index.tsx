import { ScrollView, Text, View } from '@tarojs/components'
import { useState } from 'react'
import type { ReactNode } from 'react'

import GradientPage from '../../components/GradientPage'
import PageHeader from '../../components/PageHeader'
import { SoftChip } from '../../components/Pills'
import RecordTile from '../../components/RecordTile'
import { useStore } from '../../data/store'
import { dayLabel, recordCategoryLabels } from '../../data/types'
import type { RecordCategory } from '../../data/types'
import { useViewport } from '../../utils/layout'
import { goBack } from '../../utils/nav'
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
  const store = useStore()
  const viewport = useViewport()
  const [category, setCategory] = useState<RecordCategory | null>(null)

  const list = store.recordsOf(category)

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
                    onClick={() => setCategory(item)}
                  />
                </View>
              ))}
            </View>
          </ScrollView>
          <Text className='kp-record__count'>{`共 ${list.length} 条`}</Text>
        </View>
        <View className='kp-record__gap' />
        {list.length === 0 ? (
          <View className='kp-record__empty'>
            <Text className='kp-record__empty-emoji'>🍃</Text>
            <View className='kp-record__empty-gap' />
            <Text className='kp-record__empty-text'>这里还没有记录</Text>
          </View>
        ) : (
          <ScrollView
            className='kp-record__list'
            scrollY
            enhanced
            showScrollbar={false}
          >
            <View className='kp-record__list-content'>{groups}</View>
          </ScrollView>
        )}
      </View>
    </GradientPage>
  )
}

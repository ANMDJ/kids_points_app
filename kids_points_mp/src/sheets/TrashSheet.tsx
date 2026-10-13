import { Text, View } from '@tarojs/components'

import SheetFrame from '../components/SheetFrame'
import { store } from '../data/store'
import type { TrashItem } from '../data/types'
import {
  trashKindLabelOf,
  trashRetentionDays,
  trashRetentionText
} from '../data/types'
import { confirm, toast } from '../utils/toast'
import './sheets.scss'

export interface TrashSheetProps {
  visible: boolean
  onClose: () => void
}

/**
 * 回收站（修 C9）：规则 / 心愿 / 习惯三类**配置**的软删条目汇总。
 *
 * 两条路径各一条：**恢复**（[AppStore.restoreTrash]）与**彻底删除**（[AppStore.purgeTrash]）。
 * 流水与审计**永不进回收站**（`01` §5：账本不可变）—— 这里只有配置项。
 *
 * 过期（满 90 天）只是**判定**：`是否真清理由家长点“清理已过期”决定`。
 * 判定与文案全部来自纯函数 [isTrashExpired] / [trashRetentionText]，
 * 本组件不做任何日期运算（那正是 E17 的病：展示串在界面里被手算出来）。
 */
export default function TrashSheet({ visible, onClose }: TrashSheetProps) {
  const items: TrashItem[] = store.trashItems()
  const expiredCount = items.filter((item) => item.expired).length

  const handleRestore = (item: TrashItem) => {
    const done = store.restoreTrash(item.kind, item.id)
    if (!done) {
      toast('这条内容已经不在了')
      return
    }
    toast(`已恢复“${item.title}”`)
  }

  const handlePurge = async (item: TrashItem) => {
    const ok = await confirm(
      `彻底删除后无法恢复，确定删除“${item.title}”吗？`,
      '彻底删除',
      '彻底删除',
      '取消'
    )
    if (!ok) return
    const done = store.purgeTrash(item.kind, item.id)
    toast(done ? '已彻底删除' : '这条内容已经不在了')
  }

  /** 清理**已过期**条目 —— 只在家长显式点击时执行（不做任何自动清理）。 */
  const handlePurgeExpired = async () => {
    const ok = await confirm(
      `确定清理 ${expiredCount} 条已过 ${trashRetentionDays} 天保留期的内容吗？`,
      '清理已过期',
      '清理',
      '取消'
    )
    if (!ok) return
    const purged = store.purgeExpiredTrash()
    toast(purged > 0 ? `已清理 ${purged} 条` : '没有可清理的内容')
  }

  return (
    <SheetFrame
      visible={visible}
      title='回收站'
      subtitle={`删除的规则 / 心愿 / 习惯在这里保留 ${trashRetentionDays} 天`}
      actionLabel={expiredCount > 0 ? `清理已过期（${expiredCount}）` : undefined}
      actionIcon='trash'
      onAction={handlePurgeExpired}
      onClose={onClose}
    >
      {items.length === 0 ? (
        <View className='kp-trash__empty'>
          <Text className='kp-trash__empty-text'>回收站是空的</Text>
        </View>
      ) : (
        <View className='kp-trash__list'>
          {items.map((item) => (
            <View className='kp-trash__row' key={`${item.kind}-${item.id}`}>
              <View className='kp-trash__head'>
                <Text className='kp-trash__title kp-ellipsis'>
                  {item.title}
                </Text>
                <Text className='kp-trash__meta'>
                  {`${trashKindLabelOf(item.kind)} · ${trashRetentionText(
                    item.deletedAt
                  )}`}
                </Text>
              </View>
              <View className='kp-trash__actions'>
                <View
                  className='kp-trash__chip'
                  onClick={() => handleRestore(item)}
                >
                  <Text className='kp-trash__chip-text'>恢复</Text>
                </View>
                <View
                  className='kp-trash__chip is-danger'
                  onClick={() => {
                    void handlePurge(item)
                  }}
                >
                  <Text className='kp-trash__chip-text'>彻底删除</Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      )}
    </SheetFrame>
  )
}

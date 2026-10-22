import { Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import SheetFrame from '../components/SheetFrame'
import { useStore } from '../data/store'
import type { TrashItem } from '../data/types'
import {
  trashKindLabelOf,
  trashPurgeOutcomeText,
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
 * 回收站（修 C9 / W5-F）：规则 / 心愿 / 习惯三类**配置**的软删条目汇总。
 *
 * 两条路径各一条：**恢复**（`AppStore.submitRestoreTrash`）与**彻底删除**
 * （`AppStore.submitPurgeTrash`）。流水与审计**永不进回收站**（`01` §5：
 * 账本不可变）—— 这里只有配置项。
 *
 * 过期（满 90 天）只是**判定**：`是否真清理由家长点“清理已过期”决定`，
 * **不做任何自动清理**。判定与文案全部来自纯函数 `isTrashExpired` /
 * `trashRetentionText`，本组件不做任何日期运算（那正是 E17 的病：
 * 展示串在界面里被手算出来）。
 *
 * 数据来源分两种世界：live 模式打开时拉 `GET /trash`（条目来自服务端），
 * 预览模式直接读本地列表 —— 由 store 一条路径统一，页面不判模式。
 */
export default function TrashSheet({ visible, onClose }: TrashSheetProps) {
  const store = useStore()
  /** 有写请求在途：双击不该发出两次恢复 / 两次彻底删除。 */
  const [busy, setBusy] = useState(false)

  const items: TrashItem[] = store.trashItems()
  const expiredCount = items.filter((item) => item.expired).length
  const loadError = store.trashError

  useEffect(() => {
    if (!visible) return
    // 打开弹窗才拉（低频页面不该让每次首页刷新都多付一次往返）。
    // 失败**不弹窗**：错误留在 `store.trashError` 里，由下面照实展示 ——
    // 403 / 断网都不能被画成「回收站是空的」。
    void store.refreshTrash()
  }, [visible, store])

  const handleRestore = async (item: TrashItem) => {
    if (busy) return
    if (store.isTrashWriteReadOnly) {
      toast(store.trashReadOnlyWriteMessage)
      return
    }
    setBusy(true)
    const message = await store.submitRestoreTrash(item)
    setBusy(false)
    toast(message ?? `已恢复“${item.title}”`)
  }

  const handlePurge = async (item: TrashItem) => {
    if (busy) return
    if (store.isTrashWriteReadOnly) {
      toast(store.trashReadOnlyWriteMessage)
      return
    }
    const ok = await confirm(
      `彻底删除后无法恢复，确定删除“${item.title}”吗？`,
      '彻底删除',
      '彻底删除',
      '取消'
    )
    if (!ok) return
    setBusy(true)
    const message = await store.submitPurgeTrash(item)
    setBusy(false)
    toast(message ?? '已彻底删除')
  }

  /** 清理**已过期**条目 —— 只在家长显式点击时执行（不做任何自动清理）。 */
  const handlePurgeExpired = async () => {
    if (busy) return
    if (store.isTrashWriteReadOnly) {
      toast(store.trashReadOnlyWriteMessage)
      return
    }
    const ok = await confirm(
      `确定清理 ${expiredCount} 条已过 ${trashRetentionDays} 天保留期的内容吗？`,
      '清理已过期',
      '清理',
      '取消'
    )
    if (!ok) return
    setBusy(true)
    const outcome = await store.submitPurgeExpiredTrash()
    setBusy(false)
    // 部分成功必须**分段说清**：只说“已清理 N 条”会让剩下几条看起来也删掉了，
    // 只说“失败”又抹掉了真的已经删掉的那几条。
    toast(trashPurgeOutcomeText(outcome))
  }

  const handleReload = () => {
    if (busy) return
    setBusy(true)
    void store.refreshTrash().then(() => setBusy(false))
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
      {/* 顶部状态行：加载中 / 加载失败（失败时**保留**上一次成功的列表） */}
      {busy || (store.trashStatus === 'loading' && items.length === 0) ? (
        <View className='kp-trash__status'>
          <Text className='kp-trash__status-text'>
            {busy ? '正在处理…' : '正在加载回收站…'}
          </Text>
        </View>
      ) : null}
      {loadError !== null ? (
        <View className='kp-trash__status' onClick={handleReload}>
          <Text className='kp-trash__status-text is-error'>
            {`回收站加载失败：${loadError.userMessage}（点此重试）`}
          </Text>
        </View>
      ) : null}

      {items.length === 0 ? (
        <View className='kp-trash__empty'>
          <Text className='kp-trash__empty-text'>
            {loadError !== null ? '回收站没能加载' : '回收站是空的'}
          </Text>
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
                  onClick={() => {
                    void handleRestore(item)
                  }}
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

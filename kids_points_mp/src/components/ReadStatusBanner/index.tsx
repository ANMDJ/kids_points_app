import { Text, View } from '@tarojs/components'

import { useStore } from '../../data/store'
import type { AppStore } from '../../data/store'
import './index.scss'

/**
 * 只读数据状态的**全局**横条（W4-C）。
 *
 * 三条硬约束（与 Flutter `ReadStatusBanner` 同义）：
 *   ① 只在 `store.isLiveMode` 时出现 —— 本地预览不打扰用户；
 *   ② 失败时**明确说出现在看到的是哪份数据**（空态 / 旧的服务端数据），
 *      不能把 501/401 显示成「暂无记录」；
 *   ③ 只读就说只读 —— 写客户端没就绪时不能让用户以为操作已经保存
 *      （W5-B/W5-E 之后「打卡 / 记一笔 / 兑换 / 昵称」都能真写，这句话只说给 false 分支）。
 *
 * 测试可传入 `store`；页面直接用默认单例。
 */
export interface ReadStatusBannerProps {
  store?: AppStore
}

export default function ReadStatusBanner({
  store: override
}: ReadStatusBannerProps) {
  // 无条件订阅单例；传入测试替身时只读取替身（替身由测试自己驱动）。
  const liveStore = useStore()
  return <BannerView store={override ?? liveStore} />
}

function BannerView({ store }: { store: AppStore }) {
  if (!store.isLiveMode) return null

  const error = store.readError
  if (store.readStatus === 'error' && error !== null) {
    const retained = store.usingPreview
      ? '首次读取尚未成功，当前没有可展示的数据（不是「没有记录」）。'
      : store.visibleRecords.length === 0
        ? '当前没有可展示的记录，请重试。'
        : '已加载的内容保留在下方，可以继续查看。'
    return (
      <View className='kp-read-banner kp-read-banner--error'>
        <View className='kp-read-banner__body'>
          <Text className='kp-read-banner__text'>{error.userMessage}</Text>
          <Text className='kp-read-banner__text'>{retained}</Text>
        </View>
        <Text
          className='kp-read-banner__action'
          onClick={() => {
            void store.refreshFromServer()
          }}
        >
          重试
        </Text>
      </View>
    )
  }

  if (store.usingPreview) {
    return (
      <View className='kp-read-banner kp-read-banner--info'>
        <Text className='kp-read-banner__text'>正在读取服务器数据…</Text>
      </View>
    )
  }

  // 2026-11-10（用户第 8 条）：「数据来自服务器 · 打卡 / 记一笔 / 兑换 / 昵称
  // 均会实时保存」这条**常驻**提示删掉。它不是状态，只是「一切正常」的另一种
  // 说法，却每天占着抬头栏一行。只有读取失败 / 首次读取中才需要横条。
  return null
}

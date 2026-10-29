import { ScrollView, Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import AppBottomNav from '../../components/AppBottomNav'
import GradientPage from '../../components/GradientPage'
import { SmallPill, SoftChip } from '../../components/Pills'
import ApprovalCard from '../../components/ApprovalCard'
import ApprovalEmptyHint from '../../components/ApprovalEmptyHint'
import { useStore } from '../../data/store'
import { approvalConfirmText, approvalFilterLabel } from '../../data/approval'
import type { ApprovalInboxItem } from '../../data/approval'
import { useViewport } from '../../utils/layout'
import { switchTab } from '../../utils/nav'
import { confirm, toast } from '../../utils/toast'
import { useAuthGate } from '../../utils/useAuthGate'
import { designToPx } from '../../utils/unit'
import './index.scss'

/** 底部导航栏高度（AppBottomNav 的 kp-nav__row）。 */
const NAV_HEIGHT = 64

/**
 * 家长审批收件箱（W5-D）：待处理 / 已通过 / 已拒绝 / 全部。
 *
 * ── 三条界面纪律（与 Flutter `ApprovalsScreen` 同义）──────────────────────
 *   ① **不编内容**：卡片文案全部来自结构化 `summary`。`summary === null`
 *      （坏数据 / 更新的服务端）显示「内容无法识别」并**禁用批准** —— 看不到
 *      内容就不该点批；但「拒绝」仍然可用，否则那一行会永久卡住。
 *   ② **不假装成功**：批准 / 拒绝的结果以服务端回包为准，409（已处理 / 过期 /
 *      前提变化）原样显示服务端语义，并立刻重拉列表。
 *   ③ **403 要说 403**：孩子角色调用这个端点会被矩阵拦下。页面明说「没有批准
 *      权限」，不能说成「暂无待审批」。
 */
export default function Approvals() {
  const store = useStore()

  // W9-B：登录闸门（详见 `utils/useAuthGate.ts`）。
  useAuthGate()
  const viewport = useViewport()
  const [refreshing, setRefreshing] = useState(false)

  // 只读一次：孩子设备的 403 不该在启动时就发生（这里是家长才会进的页），
  // 失败后的重试是用户的动作（下拉 / 重试按钮）。
  useEffect(() => {
    store.ensureApprovalsLoaded()
  }, [store])

  const items = store.approvals
  const now = Date.now()
  // `idle` 也算首屏加载：挂载后的 useEffect 会立刻把它推到 loading，
  // 但**第一帧**仍是 idle —— 不这样写会先闪一下「还没有任何申请」再转圈。
  const firstLoad =
    store.isLiveMode &&
    (store.approvalStatus === 'loading' || store.approvalStatus === 'idle') &&
    items.length === 0

  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    void store.refreshApprovals().finally(() => setRefreshing(false))
  }

  const handleDecide = async (item: ApprovalInboxItem, approve: boolean) => {
    // 先确认再发请求：「批准后扣多少分」必须让家长在点下去之前看到。
    const ok = await confirm(
      approvalConfirmText(approve, item),
      approve ? '批准这次申请' : '拒绝这次申请',
      approve ? '批准' : '拒绝',
      '取消'
    )
    if (!ok) return
    const message = await store.decideApproval(item, { approve })
    toast(
      message ??
        (approve ? '已批准，这次申请已生效。' : '已拒绝，这次申请不会生效。')
    )
  }

  return (
    <GradientPage
      safeTop={false}
      footer={
        <AppBottomNav
          currentIndex={2}
          onChanged={(index) => switchTab(index, 2)}
        />
      }
    >
      <View
        className='kp-approvals'
        style={{
          height: `${viewport.height - viewport.safeTop}px`,
          paddingTop: `${viewport.safeTop}px`,
          paddingBottom: `${designToPx(NAV_HEIGHT) + viewport.safeBottom}px`
        }}
      >
        <View className='kp-approvals__header'>
          <Text className='kp-approvals__title'>家长审批</Text>
          {store.pendingApprovalCount > 0 &&
          store.approvalFilter === 'pending' ? (
            <View className='kp-approvals__count'>
              <SmallPill
                label={`${store.pendingApprovalCount} 条`}
                filled
                padding={[10, 5]}
              />
            </View>
          ) : null}
          <View className='kp-approvals__spacer' />
          <Text
            className={`kp-approvals__refresh ${
              store.isLiveMode ? '' : 'is-disabled'
            }`}
            onClick={() => {
              if (store.isLiveMode) handleRefresh()
            }}
          >
            刷新
          </Text>
        </View>

        <View className='kp-approvals__filters'>
          {store.approvalFilterOptions.map((filter) => (
            <View className='kp-approvals__chip' key={filter}>
              <SoftChip
                label={approvalFilterLabel(filter)}
                selected={store.approvalFilter === filter}
                onClick={() => {
                  void store.setApprovalFilter(filter)
                }}
              />
            </View>
          ))}
        </View>
        <View className='kp-approvals__gap' />

        {firstLoad ? (
          <View className='kp-approvals__center'>
            <View className='kp-approvals__spinner' />
          </View>
        ) : (
          <ScrollView
            className='kp-approvals__scroll'
            scrollY
            enhanced
            showScrollbar={false}
            refresherEnabled={store.isLiveMode}
            refresherTriggered={refreshing}
            refresherBackground='#FDFFF9'
            onRefresherRefresh={handleRefresh}
          >
            <View className='kp-approvals__content'>
              {items.length > 0 && store.approvalError !== null ? (
                <View className='kp-approvals__error'>
                  <Text className='kp-approvals__error-text'>
                    {store.approvalError.kind === 'forbidden'
                      ? '没有批准申请的权限（403），列表可能是旧的。'
                      : store.approvalError.userMessage}
                  </Text>
                  <Text
                    className='kp-approvals__error-action'
                    onClick={handleRefresh}
                  >
                    重试
                  </Text>
                </View>
              ) : null}
              {items.length === 0 ? (
                <ApprovalEmptyHint
                  isLiveMode={store.isLiveMode}
                  isFiltered={store.approvalFilter !== 'all'}
                  error={store.approvalError}
                  onRetry={handleRefresh}
                />
              ) : (
                <>
                  {items.map((item) => (
                    <ApprovalCard
                      key={item.id}
                      item={item}
                      now={now}
                      busy={store.decidingApprovalId !== null}
                      deciding={store.decidingApprovalId === item.id}
                      canWrite={store.canDecideApprovals}
                      onApprove={() => {
                        void handleDecide(item, true)
                      }}
                      onReject={() => {
                        void handleDecide(item, false)
                      }}
                    />
                  ))}
                  <Footer
                    hasMore={store.hasMoreApprovals}
                    loadingMore={store.approvalStatus === 'loadingMore'}
                    failed={store.approvalStatus === 'error'}
                    onLoadMore={() => {
                      void store.loadMoreApprovals()
                    }}
                  />
                </>
              )}
            </View>
          </ScrollView>
        )}
      </View>
    </GradientPage>
  )
}

/** 列表底部：加载中 / 加载更多（失败时说重试）/ 没有更多了。 */
function Footer({
  hasMore,
  loadingMore,
  failed,
  onLoadMore
}: {
  hasMore: boolean
  loadingMore: boolean
  failed: boolean
  onLoadMore: () => void
}) {
  if (loadingMore) {
    return (
      <View className='kp-approvals__footer'>
        <View className='kp-approvals__more-spinner' />
      </View>
    )
  }
  if (hasMore) {
    return (
      <View className='kp-approvals__footer'>
        <Text className='kp-approvals__more-text' onClick={onLoadMore}>
          {failed ? '重试加载更多' : '加载更多'}
        </Text>
      </View>
    )
  }
  return (
    <View className='kp-approvals__footer'>
      <Text className='kp-approvals__footer-text'>没有更多了</Text>
    </View>
  )
}

import { Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import SheetFrame from '../components/SheetFrame'
import { useStore } from '../data/store'
import {
  approvalAutoReasonLabel,
  approvalDetail,
  approvalHeadline,
  approvalStatusLabel,
  approvalWithdrawConfirmText,
  canWithdrawApproval,
  formatApprovalTime,
  isApprovalExpired,
  isApprovalPending
} from '../data/approval'
import type { ApprovalInboxItem } from '../data/approval'
import { ReadApiException } from '../data/read_api_errors'
import { pushPage } from '../utils/nav'
import { confirm, toast } from '../utils/toast'
import './sheets.scss'

export interface MyApplicationsSheetProps {
  visible: boolean
  onClose: () => void
  /**
   * 从二级页（详情）返回时由页面递增：详情里撤回 / 读到新状态后，本面板要重拉。
   * 面板自己的 `items` 是打开时那一份，不重拉会留一行过时的「撤回」。
   */
  refreshToken?: number
}

/**
 * 「我的申请」（W5-J）：**我提交的**审批，含撤回。
 *
 * ── 为什么不复用家长收件箱 ────────────────────────────────────────────────
 *   两个列表的数据源、权限与动作都不同：
 *     · 收件箱 = `GET /approvals` + 批 / 拒（家长，孩子 403）；
 *     · 这里   = `GET /approvals/mine` + 撤回（申请人自己）。
 *   把「批准」放进这里会诱导家长给自己提的申请盖章 —— 服务端本来就禁止自批，
 *   界面不该先给一个按下去必然失败的动作。
 *
 * ── 分页与错误都留在组件本地 ──────────────────────────────────────────────
 *   store 的 `fetchMyApprovals` 刻意不写全局状态：与家长收件箱共用一份列表会让
 *   两边的游标 / 错误互相污染。这里自己保存 `items` / `cursor` / `error`。
 *
 * ── 撤回能做什么 / 不能做什么 ─────────────────────────────────────────────
 *   只把 `pending → withdrawn`：不写流水、不动积分、不恢复已删的心愿。
 *   因此**没有**「撤销撤回」，需要时重新提交。
 */
export default function MyApplicationsSheet({
  visible,
  onClose,
  refreshToken = 0
}: MyApplicationsSheetProps) {
  const store = useStore()
  const [items, setItems] = useState<ApprovalInboxItem[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 首次加载失败后重试用的标记：false = 还没成功过。 */
  const [loadedOnce, setLoadedOnce] = useState(false)
  /** 正在撤回的那一条（逐行禁用，而不是整块灰掉）。 */
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)

  const readOnly = !store.canWithdrawApprovals

  const load = async (reset: boolean) => {
    if (loading) return
    if (!reset && !hasMore) return

    setLoading(true)
    setLoadError(null)
    if (reset) {
      setItems([])
      setNextCursor(null)
      setHasMore(false)
    }

    try {
      const page = await store.fetchMyApprovals({
        cursor: reset ? null : nextCursor
      })
      setItems((previous) => {
        const base = reset ? [] : previous
        // 按 id 去重：键集翻页本不该重叠，客户端多一道保险。
        const known = new Set(base.map((item) => item.id))
        return [
          ...base,
          ...page.items.filter((item) => {
            if (known.has(item.id)) return false
            known.add(item.id)
            return true
          })
        ]
      })
      setNextCursor(page.nextCursor)
      setHasMore(page.hasMore)
      setLoadedOnce(true)
    } catch (error) {
      // 403 / 断网都不能被画成「没有申请」：错误原样留下 + 顶部重试。
      setLoadError(
        error instanceof ReadApiException
          ? error.userMessage
          : '申请列表没能加载，请稍后重试。'
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!visible) return
    void load(true)
    // 只在面板打开时拉一次；翻页 / 重试是用户的动作。
    // `refreshToken`：从详情页返回时页面会递增它，让这里重拉（否则撤回后的行还在）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, store, refreshToken])

  const handleWithdraw = async (item: ApprovalInboxItem) => {
    if (withdrawingId !== null) return
    const ok = await confirm(
      approvalWithdrawConfirmText(item),
      '撤回申请',
      '撤回',
      '取消'
    )
    if (!ok) return

    setWithdrawingId(item.id)
    const message = await store.withdrawApproval(item)
    setWithdrawingId(null)
    toast(message ?? '已撤回；家长那边不会再看到这条申请。')

    // 成功要重拉（状态以服务端为准）；409（已批 / 已过期）也要重拉，
    // 因为本地那一行已经过时。其余失败（断网 / 403）不重拉，避免把
    // 一次网络故障放大成「列表被清空」。
    if (message !== null && !looksStale(message)) return
    await load(true)
  }

  const handleReload = () => {
    if (loading) return
    void load(true)
  }

  const emptyText = (): string => {
    if (loadError !== null) return '申请列表没能加载'
    if (loading) return '正在加载申请…'
    if (!loadedOnce) return '申请列表还没加载'
    if (!store.isLiveMode) return '预览模式没有申请记录'
    return '还没有提交过申请'
  }

  return (
    <SheetFrame
      visible={visible}
      title='我的申请'
      subtitle={
        readOnly
          ? '只读模式：暂时不能撤回'
          : '你提交的申请都在这里；待处理的可以自己撤回'
      }
      onClose={onClose}
    >
      {loadError !== null ? (
        <View className='kp-myapp__status-row'>
          <Text className='kp-myapp__error-text'>申请加载失败：{loadError}</Text>
          <View
            className={`kp-myapp__chip ${loading ? 'is-disabled' : ''}`}
            onClick={handleReload}
          >
            <Text className='kp-myapp__chip-text'>重试</Text>
          </View>
        </View>
      ) : null}

      {loading && items.length === 0 ? (
        <View className='kp-myapp__empty'>
          <Text className='kp-myapp__empty-text'>正在加载申请…</Text>
        </View>
      ) : null}

      {!loading && items.length === 0 ? (
        <View className='kp-myapp__empty'>
          <Text className='kp-myapp__empty-text'>{emptyText()}</Text>
        </View>
      ) : null}

      <View className='kp-myapp__list'>
        {items.map((item) => (
          <MyApplicationRow
            key={item.id}
            item={item}
            readOnly={readOnly}
            busy={withdrawingId === item.id}
            onWithdraw={() => {
              void handleWithdraw(item)
            }}
            onOpen={() => {
              pushPage(
                `/pages/approval-detail/index?id=${encodeURIComponent(
                  item.id
                )}&mode=withdraw`
              )
            }}
          />
        ))}
      </View>

      {hasMore ? (
        <View className='kp-myapp__more'>
          <View
            className={`kp-myapp__chip ${loading ? 'is-disabled' : ''}`}
            onClick={() => {
              if (loading) return
              void load(false)
            }}
          >
            <Text className='kp-myapp__chip-text'>
              {loading ? '加载中…' : '加载更多'}
            </Text>
          </View>
        </View>
      ) : null}
    </SheetFrame>
  )
}

/**
 * 409 的文案由 `write_api_errors.ts` 统一产出；这里只判断
 * 「本地那一行是不是已经过时」。真正的显示仍然用原文案。
 */
function looksStale(message: string): boolean {
  return (
    message.includes('已经被处理') ||
    message.includes('有效期') ||
    message.includes('前提已经变了')
  )
}

function MyApplicationRow({
  item,
  readOnly,
  busy,
  onWithdraw,
  onOpen
}: {
  item: ApprovalInboxItem
  readOnly: boolean
  busy: boolean
  onWithdraw: () => void
  /** 点整行 → 详情（P1-3）；撤回胶囊自己 `stopPropagation`。 */
  onOpen: () => void
}) {
  const now = Date.now()
  const pending = isApprovalPending(item)
  const expired = isApprovalExpired(item, now)
  const canWithdraw = !readOnly && canWithdrawApproval(item, now)
  const summary = item.summary
  const headline = summary === null ? '内容无法识别' : approvalHeadline(summary)
  const detail =
    summary === null
      ? '这条申请的内容读不懂，仍然可以撤回'
      : approvalDetail(summary)
  const autoReason = approvalAutoReasonLabel(item)

  return (
    <View className='kp-myapp__row' onClick={onOpen}>
      <View className='kp-myapp__head'>
        <Text className='kp-myapp__headline'>{headline}</Text>
        <View
          className={`kp-myapp__pill ${pending ? 'is-filled' : 'is-flat'} ${
            expired ? 'is-expired' : ''
          }`}
        >
          <Text className='kp-myapp__pill-text'>
            {expired ? '已过期' : approvalStatusLabel(item)}
          </Text>
        </View>
      </View>
      <Text className='kp-myapp__detail'>{detail}</Text>
      {autoReason === '' ? null : (
        <Text className='kp-myapp__auto-reason'>{autoReason}</Text>
      )}
      <View className='kp-myapp__foot'>
        <Text className='kp-myapp__time'>
          提交于 {formatApprovalTime(item.createdAt)}
        </Text>
        {canWithdraw ? (
          <View
            className={`kp-myapp__chip ${busy ? 'is-disabled' : ''}`}
            onClick={(event) => {
              // 整行 onClick 是「打开详情」：撤回胶囊必须拦住冒泡。
              event.stopPropagation()
              if (busy) return
              onWithdraw()
            }}
          >
            <Text className='kp-myapp__chip-text'>
              {busy ? '撤回中…' : '撤回'}
            </Text>
          </View>
        ) : pending && !readOnly ? (
          <Text className='kp-myapp__time'>
            {expired ? '已过期' : '不可撤回'}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

import { ScrollView, Text, View } from '@tarojs/components'
import { useRouter } from '@tarojs/taro'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import AppCard from '../../components/AppCard'
import GradientPage from '../../components/GradientPage'
import PageHeader from '../../components/PageHeader'
import { useStore } from '../../data/store'
import {
  approvalAutoReasonLabel,
  approvalConfirmText,
  approvalDetail,
  approvalHeadline,
  approvalRemainingText,
  approvalRequesterLabel,
  approvalStatusLabel,
  approvalWithdrawConfirmText,
  formatApprovalTime,
  isApprovalExpired,
  isApprovalPending,
  isApprovalSelfApproved
} from '../../data/approval'
import type { ApprovalInboxItem } from '../../data/approval'
import { ReadApiException } from '../../data/read_api_errors'
import { useViewport } from '../../utils/layout'
import { goBack } from '../../utils/nav'
import { confirm, toast } from '../../utils/toast'
import './index.scss'

/** 入口决定能做什么：家长收件箱（批 / 拒）/ 我的申请（撤回）/ 通知结果（只看）。 */
type DetailMode = 'decide' | 'withdraw' | 'view'

function readMode(raw: string | undefined): DetailMode {
  if (raw === 'decide' || raw === 'withdraw') return raw
  return 'view'
}

/**
 * 审批详情（P1-3，2026-11-10）—— 与 Flutter `ApprovalDetailScreen` 同构。
 *
 * ── 为什么按 id 现取 ────────────────────────────────────────────────────────
 *   列表卡片只装得下一行 `summary`；通知深链只有一个 `approvalId`，目标那条
 *   可能不在已加载的那一页。`GET /approvals/:id` 直接取这一条。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────────────────
 *   ① 不编内容：`summary === null` 显示「内容无法识别」并禁用批准；
 *   ② 不假装成功：结果以服务端回包为准（store 已做），失败原样提示；
 *   ③ 403 / 404 照实说，不画成「加载中」。
 */
export default function ApprovalDetail() {
  const router = useRouter()
  const store = useStore()
  const viewport = useViewport()
  const id = String(router.params.id ?? '')
  const mode = readMode(router.params.mode)

  const [item, setItem] = useState<ApprovalInboxItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)

  const errorText = (failure: unknown): string => {
    if (failure instanceof ReadApiException) {
      if (failure.code === 'APPROVAL_NOT_FOUND' || failure.statusCode === 404) {
        return '这条申请不存在，或不属于当前孩子（404）。它可能已被删除，'
          + '也可能链接来自另一台设备的通知。'
      }
      if (failure.code === 'NOT_REQUESTER') {
        return '只有申请人本人或有权批准这条申请的家长可以查看详情（403）。'
      }
      return failure.userMessage
    }
    return '这条申请没能加载，请稍后重试。'
  }

  const load = async () => {
    if (id === '') {
      setError('缺少审批 id，无法打开详情。')
      return
    }
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      setItem(await store.fetchApproval(id))
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // 只在 id / store 变化时重取（load 是闭包，不列入依赖避免每次渲染都请求）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, store])

  const decide = async (approve: boolean) => {
    if (item === null || busy) return
    const ok = await confirm(
      approvalConfirmText(approve, item),
      approve ? '批准这次申请' : '拒绝这次申请',
      approve ? '批准' : '拒绝',
      '取消'
    )
    if (!ok) return
    setBusy(true)
    const message = await store.decideApproval(item, { approve })
    setBusy(false)
    if (message !== null) {
      toast(message)
      await load()
      return
    }
    toast(approve ? '已批准，这次申请已生效。' : '已拒绝，这次申请不会生效。')
    await load()
  }

  const withdraw = async () => {
    if (item === null || busy) return
    const ok = await confirm(
      approvalWithdrawConfirmText(item),
      '撤回申请',
      '撤回',
      '取消'
    )
    if (!ok) return
    setBusy(true)
    const message = await store.withdrawApproval(item)
    setBusy(false)
    if (message !== null) {
      toast(message)
      await load()
      return
    }
    toast('已撤回；家长那边不会再看到这条申请。')
    await load()
  }

  const pending = item === null ? false : isApprovalPending(item)
  const expired = item === null ? false : isApprovalExpired(item, Date.now())
  const canDecide =
    mode === 'decide' && pending && !expired && store.canDecideApprovals
  const canWithdraw =
    mode === 'withdraw' && pending && !expired && store.canWithdrawApprovals

  return (
    <GradientPage safeTop={false}>
      <View
        className='kp-adetail'
        style={{
          height: `${viewport.height - viewport.safeTop}px`,
          paddingTop: `${viewport.safeTop}px`,
          paddingBottom: `${viewport.safeBottom}px`
        }}
      >
        <PageHeader title='申请详情' onBack={goBack} />
        {loading ? <View className='kp-adetail__progress' /> : null}
        <ScrollView
          className='kp-adetail__scroll'
          scrollY
          enhanced
          showScrollbar={false}
        >
          <View className='kp-adetail__content'>
            {error !== null ? (
              <AppCard color='#fff6ee' marginBottom={12}>
                <Text className='kp-adetail__error'>{error}</Text>
                <View className='kp-adetail__retry' onClick={() => void load()}>
                  <Text className='kp-adetail__retry-text'>重试</Text>
                </View>
              </AppCard>
            ) : null}

            {item === null ? (
              error === null ? (
                <Text className='kp-adetail__loading'>正在读取这条申请…</Text>
              ) : null
            ) : (
              <>
                <Header item={item} />
                <Content item={item} />
                <Decision item={item} expired={expired} />
                <Execution item={item} />
                <Times item={item} />
                {canDecide || canWithdraw ? (
                  <Actions
                    busy={busy}
                    approveDisabled={item.summary === null}
                    canDecide={canDecide}
                    canWithdraw={canWithdraw}
                    onApprove={() => void decide(true)}
                    onReject={() => void decide(false)}
                    onWithdraw={() => void withdraw()}
                  />
                ) : (
                  <Text className='kp-adetail__hint'>
                    这条申请已经没有可执行的动作（已处理 / 已过期，或当前入口只能查看）。
                  </Text>
                )}
              </>
            )}
          </View>
        </ScrollView>
      </View>
    </GradientPage>
  )
}


/** 抬头：标题 + 状态胶囊 + 内容摘要 + 谁提的 / 什么时候提的。 */
function Header({ item }: { item: ApprovalInboxItem }) {
  const summary = item.summary
  const expired = isApprovalExpired(item, Date.now())
  const tone = expired
    ? 'is-expired'
    : item.status === 'pending'
      ? 'is-pending'
      : item.status === 'rejected'
        ? 'is-rejected'
        : 'is-flat'
  return (
    <AppCard marginBottom={12}>
      <View className='kp-adetail__head'>
        <Text className='kp-adetail__headline'>
          {summary === null ? '内容无法识别' : approvalHeadline(summary)}
        </Text>
        <View className={`kp-adetail__pill ${tone}`}>
          <Text className='kp-adetail__pill-text'>
            {expired ? '已过期' : approvalStatusLabel(item)}
          </Text>
        </View>
      </View>
      <Text className='kp-adetail__detail'>
        {summary === null
          ? '服务端返回的申请内容无法解析（数据异常）。'
          : approvalDetail(summary)}
      </Text>
      <View className='kp-adetail__metaline'>
        <View className='kp-adetail__tag'>
          <Text className='kp-adetail__tag-text'>
            {approvalRequesterLabel(item)}
          </Text>
        </View>
        <Text className='kp-adetail__metatext'>
          提交于 {formatApprovalTime(item.createdAt)}
        </Text>
      </View>
    </AppCard>
  )
}

/** 申请内容：金额 / 规则快照 / 事由，按 summary 的判别式分支给字段。 */
function Content({ item }: { item: ApprovalInboxItem }) {
  const summary = item.summary
  if (summary === null) {
    return (
      <Section title='申请内容'>
        <Text className='kp-adetail__warn'>
          这条申请的 payload 读不懂（库里的坏数据，或客户端比服务端旧）。
          为避免批错，页面不展示猜测出来的内容，并且禁止「批准」；需要时可以
          拒绝后让对方重新提交。
        </Text>
        <Fact label='动作' value={item.action} />
      </Section>
    )
  }

  const rows: ReactNode[] = []
  if (summary.kind === 'redeem') {
    rows.push(<Fact key='wish' label='心愿' value={summary.title} />)
    rows.push(<Fact key='cost' label='本次扣分' value={`${summary.cost} 分`} />)
    rows.push(<Fact key='wid' label='心愿 id' value={summary.wishId} />)
  } else if (summary.kind === 'bonus') {
    rows.push(<Fact key='amount' label='申请加分' value={`+${summary.amount} 分`} />)
    rows.push(
      <Fact
        key='reason'
        label='事由'
        value={summary.reason.trim() === '' ? '（没有写事由）' : summary.reason}
      />
    )
    rows.push(
      <Fact
        key='basis'
        label='依据（快照）'
        value={
          summary.basisTitle !== null && summary.basisTitle.trim() !== ''
            ? summary.basisTitle
            : '没有关联规则 / 习惯'
        }
      />
    )
    if (summary.ruleId !== null) {
      rows.push(<Fact key='rule' label='规则 id' value={summary.ruleId} />)
    }
    if (summary.habitId !== null) {
      rows.push(<Fact key='habit' label='习惯 id' value={summary.habitId} />)
    }
  } else {
    rows.push(
      <Fact
        key='wish'
        label='心愿名'
        value={`${summary.emoji}「${summary.title}」`}
      />
    )
    rows.push(<Fact key='cost' label='兑换成本' value={`${summary.cost} 分`} />)
  }
  rows.push(<Fact key='action' label='动作' value={item.action} />)

  return <Section title='申请内容'>{rows}</Section>
}

/** 处理情况：状态 / 谁处理的 / 系统失效原因。 */
function Decision({
  item,
  expired
}: {
  item: ApprovalInboxItem
  expired: boolean
}) {
  const handled = isApprovalPending(item)
    ? '还没有人处理'
    : isApprovalSelfApproved(item)
      ? '申请人自己处理（自批）'
      : item.decidedByUserId !== null
        ? '另一位家庭成员处理'
        : '系统自动处理（未执行）'
  const autoReason = approvalAutoReasonLabel(item)
  return (
    <Section title='处理情况'>
      <Fact label='当前状态' value={expired ? '已过期' : approvalStatusLabel(item)} />
      <Fact label='处理方式' value={handled} />
      <Fact
        label='处理时间'
        value={
          item.decidedAt === null ? '—' : formatApprovalTime(item.decidedAt)
        }
      />
      {autoReason === '' ? null : <Fact label='系统原因' value={autoReason} />}
    </Section>
  )
}


/** 执行结果 / 幂等事实：审批执行时用 `approval:<id>` 作流水幂等键。 */
function Execution({ item }: { item: ApprovalInboxItem }) {
  return (
    <Section title='执行结果'>
      {item.executedRecordId === null ? (
        <Text className='kp-adetail__muted'>
          这条审批还没有产生积分流水（未批准 / 已拒绝 / 已撤回 / 有效期到期）。
        </Text>
      ) : (
        <>
          <Fact label='积分流水' value={item.executedRecordId} />
          <Text className='kp-adetail__note'>
            同一条审批只会生成一笔流水（幂等键 approval:&lt;审批 id&gt;）：
            重复点「批准」不会重复加 / 扣分。
          </Text>
        </>
      )}
      <Fact label='审批 id' value={item.id} />
    </Section>
  )
}

function Times({ item }: { item: ApprovalInboxItem }) {
  const remaining = approvalRemainingText(item, Date.now())
  return (
    <Section title='时间'>
      <Fact label='提交' value={formatApprovalTime(item.createdAt)} />
      <Fact label='有效期至' value={formatApprovalTime(item.expiresAt)} />
      {remaining === null ? null : <Fact label='剩余' value={remaining} />}
    </Section>
  )
}

function Actions({
  busy,
  approveDisabled,
  canDecide,
  canWithdraw,
  onApprove,
  onReject,
  onWithdraw
}: {
  busy: boolean
  approveDisabled: boolean
  canDecide: boolean
  canWithdraw: boolean
  onApprove: () => void
  onReject: () => void
  onWithdraw: () => void
}) {
  if (!canDecide && !canWithdraw) return null
  return (
    <View className='kp-adetail__actions'>
      {canDecide ? (
        <View className='kp-adetail__row'>
          <View
            className={`kp-adetail__button is-reject ${busy ? 'is-disabled' : ''}`}
            onClick={() => {
              if (busy) return
              onReject()
            }}
          >
            <Text className='kp-adetail__button-text is-reject'>拒绝</Text>
          </View>
          <View
            className={`kp-adetail__button is-approve ${
              busy || approveDisabled ? 'is-disabled' : ''
            }`}
            onClick={() => {
              if (busy || approveDisabled) return
              onApprove()
            }}
          >
            <Text className='kp-adetail__button-text is-approve'>批准</Text>
          </View>
        </View>
      ) : null}
      {canWithdraw ? (
        <View
          className={`kp-adetail__button is-reject kp-adetail__full ${
            busy ? 'is-disabled' : ''
          }`}
          onClick={() => {
            if (busy) return
            onWithdraw()
          }}
        >
          <Text className='kp-adetail__button-text is-reject'>
            {busy ? '处理中…' : '撤回这条申请'}
          </Text>
        </View>
      ) : null}
      <Text className='kp-adetail__hint'>
        批准会立即生效并写入积分流水；拒绝 / 撤回不改变任何积分。
      </Text>
    </View>
  )
}

/** 一行「标签 : 值」。 */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View className='kp-adetail__fact'>
      <Text className='kp-adetail__fact-label'>{label}</Text>
      <Text className='kp-adetail__fact-value'>{value}</Text>
    </View>
  )
}

/** 小节卡片：标题 + 若干行。 */
function Section({
  title,
  children
}: {
  title: string
  children: ReactNode
}) {
  return (
    <AppCard marginBottom={12}>
      <Text className='kp-adetail__section'>{title}</Text>
      {children}
    </AppCard>
  )
}


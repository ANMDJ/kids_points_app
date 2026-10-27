import { Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import AppCard from '../components/AppCard'
import { SmallPill } from '../components/Pills'
import SheetFrame from '../components/SheetFrame'
import { useStore } from '../data/store'
import type { FamilyDeletion, FamilyDeletionSummary } from '../data/types'
import {
  deletionDeadlineText,
  deletionKeptText,
  deletionRemainingText,
  deletionStatusLabel,
  deletionSummaryRows,
  familyDeletionCoolingDays,
  memberRoleLabelOf
} from '../data/types'
import { confirm, toast } from '../utils/toast'
import './sheets.scss'

export interface FamilyDeletionSheetProps {
  visible: boolean
  onClose: () => void
}

/**
 * 家庭数据删除（W7-D）：申请 → 7 天冷却 → 后台执行 → 就地匿名化。
 *
 * ── 必须说清的三件事 ────────────────────────────────────────────────────────
 *   ① **不会立刻删**：申请后进入冷却期，`scheduledFor` 之前随时可以撤销；
 *   ② **删的是「写了什么」**：昵称 / 规则文字的 / 流水备注 / 成员 PIN 被抹掉，
 *      而流水的分数与余额**保留**（账本 append-only，02 §5.7 I5）；
 *   ③ **撤回同意不等于数据被扣住**：删除不受 `ConsentGuard` 管辖（04 §5）。
 *
 * ── 二次确认 ────────────────────────────────────────────────────────────────
 *   第一次点击只是**展开**警告；「确认删除」再弹一次系统确认框，两次都过了
 *   才发请求，且请求体显式带 `confirmed: true`。
 */
export default function FamilyDeletionSheet({
  visible,
  onClose
}: FamilyDeletionSheetProps) {
  const store = useStore()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const canManage = store.canManageFamilyDeletion
  const state = store.familyDeletion
  const readError = store.deletionError
  const memberError = store.memberError

  useEffect(() => {
    if (!visible) return
    setBusy(true)
    const run = async () => {
      if (store.isLiveMode && store.selfMember === null) {
        await store.refreshMembers()
      }
      // 角色不确定时不发注定 403 的请求。
      if (store.canManageFamilyDeletion) {
        await store.loadFamilyDeletion()
      }
    }
    void run().finally(() => setBusy(false))
  }, [visible, store])

  useEffect(() => {
    if (!visible) setConfirming(false)
  }, [visible])

  const handleRetryBootstrap = async () => {
    if (busy) return
    setBusy(true)
    try {
      await store.refreshMembers()
      if (store.canManageFamilyDeletion) await store.loadFamilyDeletion()
    } finally {
      setBusy(false)
    }
  }

  const handleRequest = async () => {
    const agreed = await confirm(
      `提交后进入 ${familyDeletionCoolingDays} 天冷却期，期间可以撤销；` +
        '到期后由后台执行匿名化，无法恢复。',
      '确认删除家庭数据',
      '确认删除',
      '再想想'
    )
    if (!agreed) return
    setBusy(true)
    const error = await store.submitRequestFamilyDeletion()
    setBusy(false)
    if (error === null) setConfirming(false)
    toast(
      error ??
        `已提交删除申请：${familyDeletionCoolingDays} 天内可以撤销，到期后由后台执行。`
    )
  }

  const handleCancel = async () => {
    setBusy(true)
    const error = await store.submitCancelFamilyDeletion()
    setBusy(false)
    toast(error ?? '已撤销删除申请，数据不会被删除。')
  }

  const hint = (text: string) => (
    <Text className='kp-export__paragraph'>{text}</Text>
  )

  const errorCard = (error: typeof readError) => (
    <AppCard radius={16}>
      <Text className='kp-export__card-title'>读取删除状态失败</Text>
      <View className='kp-sheet-gap-xs' />
      <Text className='kp-export__paragraph'>
        {error?.userMessage ?? '删除状态请求失败，原因未知。请重试。'}
      </Text>
      <View className='kp-export__actions'>
        <SmallPill
          label='重试'
          onClick={busy ? undefined : () => void handleRetryBootstrap()}
        />
      </View>
    </AppCard>
  )

  const unknownRoleRows = () => {
    const loading = busy || store.memberStatus === 'loading'
    return (
      <View>
        {loading ? (
          <View className='kp-invite__status'>
            <Text className='kp-invite__status-text'>正在确认你的身份…</Text>
          </View>
        ) : (
          <View className='kp-invite__status-row'>
            <Text className='kp-invite__error-text'>
              {`无法确认你的身份（${
                memberError?.userMessage ?? '成员列表还没拉到'
              }），暂时不能判断能不能删除。`}
            </Text>
            <View
              className='kp-invite__chip'
              onClick={() => void handleRetryBootstrap()}
            >
              <Text className='kp-invite__chip-text'>重试</Text>
            </View>
          </View>
        )}
      </View>
    )
  }

  const warningCard = (item: FamilyDeletion) => (
    <AppCard radius={16}>
      <Text className='kp-export__card-title'>会发生什么</Text>
      <View className='kp-sheet-gap-xs' />
      <Text className='kp-export__line'>
        · 孩子昵称、年龄段、兴趣，以及成员 PIN 会被抹掉；
      </Text>
      <Text className='kp-export__line'>
        · 规则 / 习惯 / 心愿的标题与条件、流水备注、审批文本会被替换为「[已删除]」；
      </Text>
      <Text className='kp-export__line'>
        · 积分的分数与余额**保留**：账本是追加式的，删掉数值会让对账无法解释；
      </Text>
      <Text className='kp-export__line'>
        {`· 申请后 ${item.summary?.coolingDays ?? familyDeletionCoolingDays} 天才会执行，期间可以撤销。`}
      </Text>
      <Text className='kp-export__warn'>
        建议先用「导出家庭数据」留一份副本。
      </Text>
    </AppCard>
  )

  const summaryRows = (summary: FamilyDeletionSummary | null) => {
    if (summary === null) {
      return (
        <Text className='kp-export__warn'>
          执行摘要缺失：无法回答这次删了哪些内容。
        </Text>
      )
    }
    const rows = deletionSummaryRows(summary)
    return (
      <View>
        {rows.length === 0 ? (
          <Text className='kp-export__line'>
            没有可匿名化的内容（这个家庭没有留下描述性数据）。
          </Text>
        ) : (
          rows.map((row) => (
            <Text className='kp-export__line' key={row.key}>
              {`· ${row.label}：${row.count} 行`}
            </Text>
          ))
        )}
        <Text className='kp-export__line'>{deletionKeptText(summary)}</Text>
        <Text className='kp-export__line'>{summary.note}</Text>
      </View>
    )
  }

  const confirmRows = () => (
    <View>
      <AppCard radius={16}>
        <Text className='kp-deletion__danger-title'>确认申请删除？</Text>
        <View className='kp-sheet-gap-xs' />
        <Text className='kp-export__paragraph'>
          再次点击「确认删除」并确认系统弹窗后才会提交给服务器。提交后进入冷却期，
          7 天内可以撤销。
        </Text>
      </AppCard>
      <View className='kp-export__actions'>
        <SmallPill
          label='再想想'
          onClick={busy ? undefined : () => setConfirming(false)}
        />
        <View className='kp-export__action-gap' />
        <SmallPill
          label='确认删除'
          filled
          onClick={busy ? undefined : () => void handleRequest()}
        />
      </View>
    </View>
  )

  const stateBody = (item: FamilyDeletion) => {
    switch (item.status) {
      case 'none':
      case 'cancelled':
        return (
          <View>
            {item.status === 'cancelled'
              ? hint('上一次的删除申请已撤销。')
              : hint('当前没有待执行的删除请求。')}
            {warningCard(item)}
            <View className='kp-sheet-gap-md' />
            {confirming ? (
              confirmRows()
            ) : (
              <View className='kp-export__actions'>
                <SmallPill
                  label='申请删除…'
                  filled
                  padding={[18, 10]}
                  onClick={
                    store.deletionBusy
                      ? undefined
                      : () => setConfirming(true)
                  }
                />
              </View>
            )}
          </View>
        )
      case 'pending':
        return (
          <View>
            <AppCard radius={16}>
              <Text className='kp-export__card-title'>
                {`${deletionStatusLabel(item)} · ${deletionDeadlineText(item)}`}
              </Text>
              <View className='kp-sheet-gap-xs' />
              <Text className='kp-export__line'>
                {deletionRemainingText(item)}
              </Text>
              <Text className='kp-export__paragraph'>
                在到期之前，你随时可以撤销这条申请；撤销不会留下任何删除痕迹。
              </Text>
            </AppCard>
            <View className='kp-export__actions'>
              <SmallPill
                label='撤销删除申请'
                filled
                padding={[18, 10]}
                onClick={store.deletionBusy ? undefined : () => void handleCancel()}
              />
            </View>
          </View>
        )
      case 'executed':
        return (
          <AppCard radius={16}>
            <Text className='kp-export__card-title'>
              {`${deletionStatusLabel(item)} · ${deletionDeadlineText(item)}`}
            </Text>
            <View className='kp-sheet-gap-xs' />
            {summaryRows(item.summary)}
            <Text className='kp-export__warn'>
              这个家庭的数据已不可逆地匿名化，无法恢复。
            </Text>
          </AppCard>
        )
    }
  }

  const body = () => {
    if (!store.isLiveMode) {
      return hint(
        '预览模式没有真实的家庭数据，这里不会执行删除。接入后端后才能申请。'
      )
    }
    if (store.selfMember === null) return unknownRoleRows()
    if (!canManage) {
      return hint(
        `你的身份是${memberRoleLabelOf(store.selfMember.role)}，不能删除家庭数据。\n` +
          '删除与导出一样只属于家长：它会不可逆地抹掉全家的描述性数据。'
      )
    }
    if (state !== null) {
      return (
        <View>
          {store.deletionStatus === 'error' ? (
            <View>
              {errorCard(readError)}
              <View className='kp-sheet-gap-md' />
            </View>
          ) : null}
          {busy ? (
            <View className='kp-invite__status'>
              <Text className='kp-invite__status-text'>正在读取删除状态…</Text>
            </View>
          ) : null}
          {stateBody(state)}
        </View>
      )
    }
    if (store.deletionStatus === 'error') return errorCard(readError)
    return hint(
      store.deletionStatus === 'loading'
        ? '正在读取删除状态…'
        : '还没有拉到删除状态。'
    )
  }

  return (
    <SheetFrame
      visible={visible}
      title='删除家庭数据'
      subtitle={
        canManage
          ? `申请后有 ${familyDeletionCoolingDays} 天可以撤销`
          : '只有家长可以删除家庭数据'
      }
      onClose={onClose}
    >
      {body()}
    </SheetFrame>
  )
}


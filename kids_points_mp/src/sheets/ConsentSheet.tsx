import { Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import AppCard from '../components/AppCard'
import { SmallPill } from '../components/Pills'
import SheetFrame from '../components/SheetFrame'
import { useStore } from '../data/store'
import type { GuardianConsent } from '../data/types'
import {
  consentGrantedText,
  consentVersionLabel,
  consentWithdrawnText,
  guardianConsentStatusLabelOf,
  isDraftConsentVersion,
  memberRoleLabelOf
} from '../data/types'
import { confirm, toast } from '../utils/toast'
import './sheets.scss'

export interface ConsentSheetProps {
  visible: boolean
  onClose: () => void
}

/**
 * 监护人同意（W7-B）：家长查看 / 作出 / 撤回，孩子只能看到「找家长」。
 *
 * ── 为什么先拉成员、再拉同意 ───────────────────────────────────────────
 *   `view_consent` / `manage_consent` 在矩阵里只有 guardian ALLOW，而客户端
 *   判断「我是不是家长」只能靠 `GET /members` 里的 `isSelf` 那一行。
 *   若直接拉同意：孩子必然吃一个 403 —— 用一次注定失败的请求去「探测角色」，
 *   既慢又会把「没有权限」画成「加载失败」。所以先 `refreshMembers()`。
 *
 * ── 为什么「撤回」也要在这里做 ──────────────────────────────────────────
 *   撤回后 `ConsentGuard`（W7-A 第四道屏障）会拦掉写动作，但**读取**与
 *   **重新同意**是豁免的。面板必须把这句话写出来，否则家长会以为
 *   「撤回 = 数据被删了」，或者撤回后再也回不来。
 */
export default function ConsentSheet({ visible, onClose }: ConsentSheetProps) {
  const store = useStore()
  /** 有读请求（成员 / 同意状态）在途；写请求的忙碌由 `store.isConsentWriteBusy` 表达。 */
  const [busy, setBusy] = useState(false)

  const canManage = store.canManageConsent
  const consent = store.consent
  const consentError = store.consentError
  const memberError = store.memberError
  const writeBusy = store.isConsentWriteBusy

  useEffect(() => {
    if (!visible) return
    // 打开弹窗才拉（低频页面不该让每次首页刷新都多付一次往返）。
    // 失败**不弹窗**：错误留在 store 里，由下面照实展示 ——
    // 403 / 断网都不能被画成「未同意」。
    setBusy(true)
    const run = async () => {
      if (store.isLiveMode && store.selfMember === null) {
        await store.refreshMembers()
      }
      // 角色不确定（成员没拉到）时不发注定 403 的请求。
      if (store.canManageConsent) {
        await store.refreshConsent()
      }
    }
    void run().finally(() => setBusy(false))
  }, [visible, store])

  /** 角色没拉到时重来一遍（成员 → 同意）。 */
  const handleRetryBootstrap = async () => {
    if (busy) return
    setBusy(true)
    try {
      await store.refreshMembers()
      if (store.canManageConsent) await store.refreshConsent()
    } finally {
      setBusy(false)
    }
  }

  const handleReloadConsent = async () => {
    if (busy) return
    setBusy(true)
    try {
      await store.refreshConsent()
    } finally {
      setBusy(false)
    }
  }

  const handleGrant = async () => {
    if (store.isConsentWriteReadOnly) {
      toast(store.consentReadOnlyWriteMessage)
      return
    }
    const message = await store.submitGrantConsent()
    toast(message ?? '已记录同意，谢谢你的信任')
  }

  /** 撤回是危险操作：二次确认后才发请求。 */
  const handleWithdraw = async () => {
    if (store.isConsentWriteReadOnly) {
      toast(store.consentReadOnlyWriteMessage)
      return
    }
    const ok = await confirm(
      '确定撤回监护人同意吗？\n' +
        '撤回后打卡、规则、心愿等写入会立即暂停，读取和重新同意不受影响；' +
        '已经发生的数据不会被删除。',
      '撤回同意',
      '撤回',
      '取消'
    )
    if (!ok) return
    const message = await store.submitWithdrawConsent()
    toast(message ?? '已撤回同意，写入已暂停')
  }
  /** 当前状态卡：状态 + 协议版本 + 两个时间点。 */
  const stateCard = (item: GuardianConsent, known: boolean) => {
    const lines: string[] = [`协议版本：${consentVersionLabel(item)}`]
    if (item.status === 'granted') {
      lines.push(consentGrantedText(item) ?? '同意时间未知')
    }
    if (item.status === 'withdrawn') {
      lines.push(consentWithdrawnText(item) ?? '撤回时间未知')
    }
    let pillLabel = guardianConsentStatusLabelOf(item.status)
    if (!known) {
      pillLabel =
        store.consentReadStatus === 'loading' ? '加载中' : '状态未知'
    }
    return (
      <AppCard radius={16}>
        <View className='kp-consent__title-row'>
          <Text className='kp-consent__card-title'>当前状态</Text>
          <SmallPill
            label={pillLabel}
            filled={known && item.status === 'granted'}
          />
        </View>
        <View className='kp-sheet-gap-xs' />
        {lines.map((line) => (
          <Text className='kp-consent__line' key={line}>
            {line}
          </Text>
        ))}
        {known && item.status === 'granted' && isDraftConsentVersion(item) ? (
          <Text className='kp-consent__draft'>
            注意：当前协议文本仍是占位版（版本号以 -draft 结尾），上线前需替换为法务确认的正式文本。
          </Text>
        ) : null}
      </AppCard>
    )
  }

  /**
   * 作出同意：把「同意的是什么」说清楚，再给按钮。
   *
   * 请求体只有 `{accepted: true}` —— 版本由服务端决定，客户端不能自报。
   */
  const grantCard = () => {
    const withdrawn = consent.status === 'withdrawn'
    return (
      <AppCard radius={16}>
        <Text className='kp-consent__card-title'>
          {withdrawn ? '重新同意' : '作出同意'}
        </Text>
        <View className='kp-sheet-gap-xs' />
        <Text className='kp-consent__paragraph'>
          {withdrawn
            ? '重新同意后，写入会恢复。协议版本以服务端当前配置为准。'
            : '同意后，孩子的积分、习惯、心愿等资料才会按协议处理；你可以随时在这里撤回。'}
        </Text>
        <View className='kp-consent__actions'>
          <SmallPill
            label={
              writeBusy ? '提交中…' : withdrawn ? '重新同意' : '我已阅读并同意'
            }
            filled
            onClick={writeBusy ? undefined : () => void handleGrant()}
          />
        </View>
      </AppCard>
    )
  }

  /** 撤回同意：危险操作，二次确认后才发请求。 */
  const withdrawCard = () => (
    <AppCard radius={16}>
      <Text className='kp-consent__card-title'>撤回同意</Text>
      <View className='kp-sheet-gap-xs' />
      <Text className='kp-consent__paragraph'>
        撤回后写入会立即暂停，已经发生的数据保留；重新同意即可恢复。
      </Text>
      <View className='kp-consent__actions'>
        <View
          className={`kp-consent__danger ${writeBusy ? 'is-disabled' : ''}`}
          onClick={() => {
            if (writeBusy) return
            void handleWithdraw()
          }}
        >
          <Text className='kp-consent__danger-text'>
            {writeBusy ? '撤回中…' : '撤回同意'}
          </Text>
        </View>
      </View>
    </AppCard>
  )
  const hint = (text: string) => (
    <View className='kp-consent__hint'>
      <Text className='kp-consent__hint-text'>{text}</Text>
    </View>
  )

  /** 状态加载失败行（失败时保留已有快照，不清成「未同意」）。 */
  const consentStatusRows = () =>
    consentError === null ? null : (
      <View className='kp-invite__status-row'>
        <Text className='kp-invite__error-text'>
          {`同意状态加载失败：${consentError.userMessage}`}
        </Text>
        <View
          className={`kp-invite__chip ${busy ? 'is-disabled' : ''}`}
          onClick={() => {
            if (busy) return
            void handleReloadConsent()
          }}
        >
          <Text className='kp-invite__chip-text'>重试</Text>
        </View>
      </View>
    )

  /** 成员没拉到时的状态行（含重试）—— 角色未知就不能画按钮。 */
  const memberStatusRows = () =>
    memberError === null ? (
      <View className='kp-invite__status'>
        <Text className='kp-invite__status-text'>
          正在确认你的家庭成员身份…
        </Text>
      </View>
    ) : (
      <View className='kp-invite__status-row'>
        <Text className='kp-invite__error-text'>
          {`无法确认你的家庭成员身份：${memberError.userMessage}`}
        </Text>
        <View
          className={`kp-invite__chip ${busy ? 'is-disabled' : ''}`}
          onClick={() => {
            if (busy) return
            void handleRetryBootstrap()
          }}
        >
          <Text className='kp-invite__chip-text'>重试</Text>
        </View>
      </View>
    )

  const body = () => {
    if (!store.isLiveMode) {
      // 预览模式没有真实同意记录 —— 编一个「已同意」会让人以为合规动作已经做过。
      return hint('预览模式没有真实的同意记录。接入后端后才能作出或撤回同意。')
    }
    if (store.selfMember === null) {
      // 角色未知（成员列表没拉到 / 403 / 断网）：既不能给按钮也不能说
      // 「你不是家长」—— 两种猜法都会把真实原因藏起来。
      return (
        <View>
          {busy ? (
            <View className='kp-invite__status'>
              <Text className='kp-invite__status-text'>正在同步同意状态…</Text>
            </View>
          ) : null}
          {memberStatusRows()}
        </View>
      )
    }
    if (!canManage) {
      return hint(
        `你的身份是${memberRoleLabelOf(store.selfMember.role)}，不能查看或修改同意状态。\n` +
          '需要作出/撤回同意时，请让家里的家长在「我的 → 监护人同意」里操作。'
      )
    }

    // 「未同意」只有在服务端真的这样说过时才能显示：只读快照还是本地初值
    // （未拉到 / 403 / 断网）时，把它画成「未同意」会诱导家长去点一个
    // 可能重复同意、也可能必然失败的按钮。
    const known =
      consent.childId !== '' || store.consentReadStatus === 'ready'
    return (
      <View>
        {busy ? (
          <View className='kp-invite__status'>
            <Text className='kp-invite__status-text'>正在同步同意状态…</Text>
          </View>
        ) : null}
        {stateCard(consent, known)}
        <View className='kp-sheet-gap-md' />
        {consentStatusRows()}
        {!known
          ? hint(
              store.consentReadStatus === 'loading'
                ? '正在读取同意状态…'
                : '同意状态未知，暂时不能操作。请重试或稍后再打开。'
            )
          : consent.status === 'granted'
            ? withdrawCard()
            : grantCard()}
        <View className='kp-sheet-gap-xs' />
        {hint(
          '撤回同意后，打卡、规则、心愿等写入会暂停（服务端返回 403 CONSENT_REQUIRED），' +
            '读取和「重新同意」不受影响。撤回不会删除已经发生的数据。'
        )}
      </View>
    )
  }

  return (
    <SheetFrame
      visible={visible}
      title='监护人同意'
      subtitle={
        canManage
          ? '孩子资料的收集与使用，需要监护人明确同意'
          : '只有家长可以查看和修改同意状态'
      }
      onClose={onClose}
    >
      {body()}
    </SheetFrame>
  )
}


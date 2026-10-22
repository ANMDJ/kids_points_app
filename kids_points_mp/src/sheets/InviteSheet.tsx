import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'

import AppCard from '../components/AppCard'
import { SmallPill, SoftChip } from '../components/Pills'
import SheetFrame from '../components/SheetFrame'
import { useStore } from '../data/store'
import type { InviteCode, InviteCodeStatus, InviteRole } from '../data/types'
import {
  inviteDisplayCode,
  inviteExpiresText,
  inviteRoleLabelOf,
  inviteStatusLabelOf,
  inviteStatusOf,
  inviteUsageText,
  memberRoleLabelOf
} from '../data/types'
import { confirm, toast } from '../utils/toast'
import './sheets.scss'

export interface InviteSheetProps {
  visible: boolean
  onClose: () => void
}

/** 生成表单的封闭选项 —— 自由输入只会换来后端 400（`@Min/@Max`）。 */
const USE_OPTIONS: number[] = [1, 3, 5]
const TTL_OPTIONS: number[] = [1, 7, 30]

/**
 * 邀请码（W5-I）：家长生成 / 复制 / 吊销，孩子只能看到「找家长要」。
 *
 * ── 为什么先拉成员、再拉邀请码 ───────────────────────────────────────────
 *   `invite_member` 在矩阵里只有 guardian ALLOW，而客户端判断「我是不是家长」
 *   只能靠 `GET /members` 里的 `isSelf` 那一行。若直接拉邀请码：
 *     · 家长：能成功，但没有 `selfMember` 时界面仍不知道该不该给按钮；
 *     · 孩子：必然吃一个 403 —— 用一次注定失败的请求去「探测」角色，
 *       既慢又会把「没有权限」画成「加载失败」。
 *   所以先 `refreshMembers()`，拿到角色后再决定要不要拉列表。
 *
 * ── 为什么列表不缓存「状态结论」 ──────────────────────────────────────────
 *   「可用 / 已用完 / 已过期 / 已吊销」由 `inviteStatusOf` 在渲染时现算：
 *   弹窗开着跨过有效期时，缓存下来的 `expired` 会说谎。
 */
export default function InviteSheet({ visible, onClose }: InviteSheetProps) {
  const store = useStore()
  /** 有读请求（成员 / 邀请码）在途；写请求的忙碌状态由 `store.isInviteWriteBusy`
   *  表达（表单与行按钮统一禁用）。 */
  const [busy, setBusy] = useState(false)

  /** 生成表单的三个选择（默认：孩子 · 1 人 · 7 天 —— 最常见的「给另一个孩子开号」）。 */
  const [role, setRole] = useState<InviteRole>('child')
  const [maxUses, setMaxUses] = useState(1)
  const [expiresInDays, setExpiresInDays] = useState(7)

  const canManage = store.canManageInvites
  const invites = store.invites
  const inviteError = store.invitesError
  const memberError = store.memberError
  const writeBusy = store.isInviteWriteBusy

  useEffect(() => {
    if (!visible) return
    // 打开弹窗才拉（低频页面不该让每次首页刷新都多付一次往返）。
    // 失败**不弹窗**：错误留在 store 里，由下面照实展示 ——
    // 403 / 断网都不能被画成「没有邀请码」。
    setBusy(true)
    const run = async () => {
      if (store.isLiveMode && store.selfMember === null) {
        await store.refreshMembers()
      }
      // 角色不确定（成员没拉到）时不发注定 403 的请求。
      if (store.canManageInvites) {
        await store.refreshInvites()
      }
    }
    void run().finally(() => setBusy(false))
  }, [visible, store])

  /** 角色没拉到时重来一遍（成员 → 邀请码）。 */
  const handleRetryBootstrap = async () => {
    if (busy) return
    setBusy(true)
    try {
      await store.refreshMembers()
      if (store.canManageInvites) await store.refreshInvites()
    } finally {
      setBusy(false)
    }
  }

  const handleReloadInvites = async () => {
    if (busy) return
    setBusy(true)
    try {
      await store.refreshInvites()
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async () => {
    if (store.isInviteWriteReadOnly) {
      toast(store.inviteReadOnlyWriteMessage)
      return
    }
    const message = await store.submitCreateInvite({
      role,
      maxUses,
      expiresInDays
    })
    toast(message ?? '邀请码已生成，复制后发给家人')
  }

  const handleCopy = (invite: InviteCode) => {
    // 复制**原始码**（不带连字符）：即使对方用的客户端不会 normalize，
    // 也能直接粘进输入框；带连字符的展示形式只是给人读的。
    // 失败必须说话：静默失败会让家长以为「已复制」，粘贴出来是上一条剪贴板内容。
    void Taro.setClipboardData({ data: invite.code })
      .then(() => toast(`已复制邀请码 ${inviteDisplayCode(invite.code)}`))
      .catch(() => toast('复制失败，请长按邀请码手动复制'))
  }

  const handleRevoke = async (invite: InviteCode) => {
    if (store.isInviteWriteReadOnly) {
      toast(store.inviteReadOnlyWriteMessage)
      return
    }
    const ok = await confirm(
      `确定吊销 ${inviteDisplayCode(invite.code)} 吗？` +
        '吊销后这个码不能再用来加入家庭，已经加入的成员不受影响。',
      '吊销邀请码',
      '吊销',
      '取消'
    )
    if (!ok) return
    const message = await store.submitRevokeInvite(invite)
    toast(message ?? `已吊销 ${inviteDisplayCode(invite.code)}`)
  }

  /** 空态必须区分**没拉到**与**真的没有** —— 403 / 断网时显示
   *  「还没有邀请码」会让家长以为自己的码被删了。 */
  const emptyText = (): string => {
    if (inviteError !== null) return '邀请码列表没能加载'
    if (store.invitesReadStatus === 'loading') return '正在加载邀请码…'
    return '还没有生成过邀请码'
  }

  const statusChip = (status: InviteCodeStatus) => (
    <View
      className={`kp-invite__pill ${status === 'usable' ? 'is-usable' : ''}`}
    >
      <Text
        className={`kp-invite__pill-text ${
          status === 'usable' ? 'is-usable' : ''
        }`}
      >
        {inviteStatusLabelOf(status)}
      </Text>
    </View>
  )


  /** 生成表单：角色 / 名额 / 有效期，三个都是**封闭选项**。 */
  const createCard = () => (
    <AppCard radius={16}>
      <Text className='kp-invite__card-title'>生成新邀请码</Text>
      <View className='kp-invite__gap-sm' />
      <Text className='kp-invite__label'>邀请谁</Text>
      <View className='kp-invite__chips'>
        <SoftChip
          label='孩子'
          selected={role === 'child'}
          onClick={() => {
            if (writeBusy) return
            setRole('child')
          }}
        />
        <SoftChip
          label='家长'
          selected={role === 'guardian'}
          onClick={() => {
            if (writeBusy) return
            setRole('guardian')
          }}
        />
      </View>
      <View className='kp-invite__gap-sm' />
      <Text className='kp-invite__label'>可以被几个人使用</Text>
      <View className='kp-invite__chips'>
        {USE_OPTIONS.map((value) => (
          <SoftChip
            key={value}
            label={`${value} 人`}
            selected={maxUses === value}
            onClick={() => {
              if (writeBusy) return
              setMaxUses(value)
            }}
          />
        ))}
      </View>
      <View className='kp-invite__gap-sm' />
      <Text className='kp-invite__label'>有效期</Text>
      <View className='kp-invite__chips'>
        {TTL_OPTIONS.map((days) => (
          <SoftChip
            key={days}
            label={`${days} 天`}
            selected={expiresInDays === days}
            onClick={() => {
              if (writeBusy) return
              setExpiresInDays(days)
            }}
          />
        ))}
      </View>
      <View className='kp-invite__submit'>
        <SmallPill
          label={writeBusy ? '生成中…' : '生成邀请码'}
          filled
          onClick={writeBusy ? undefined : () => void handleCreate()}
        />
      </View>
    </AppCard>
  )

  /** 一行邀请码：码 + 状态 + 角色 / 名额 / 有效期 + 复制 / 吊销。 */
  const inviteRow = (invite: InviteCode) => {
    const status = inviteStatusOf(invite, Date.now())
    const rowBusy = store.busyInviteId === invite.id
    // 已吊销的行不再给「吊销」按钮：服务端虽幂等，但按钮已经没有意义。
    const canRevoke = status !== 'revoked'
    return (
      <View className='kp-invite__row' key={invite.id}>
        <View className='kp-invite__head'>
          <Text className='kp-invite__code kp-ellipsis'>
            {inviteDisplayCode(invite.code)}
          </Text>
          {statusChip(status)}
        </View>
        <Text className='kp-invite__meta'>
          {`${inviteRoleLabelOf(invite.role)}邀请码 · ${inviteUsageText(invite)}`}
        </Text>
        <Text className='kp-invite__expires'>
          {inviteExpiresText(invite.expiresAt)}
        </Text>
        <View className='kp-invite__actions'>
          <SmallPill label='复制' onClick={() => handleCopy(invite)} />
          {canRevoke ? (
            <View
              className={`kp-invite__chip is-danger ${
                rowBusy || writeBusy ? 'is-disabled' : ''
              }`}
              onClick={() => {
                if (rowBusy || writeBusy) return
                void handleRevoke(invite)
              }}
            >
              <Text className='kp-invite__chip-text is-danger'>
                {rowBusy ? '吊销中…' : '吊销'}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    )
  }

  const hint = (text: string) => (
    <View className='kp-invite__hint'>
      <Text className='kp-invite__hint-text'>{text}</Text>
    </View>
  )

  const body = () => {
    if (!store.isLiveMode) {
      // 预览模式没有真实家庭，也没有邀请码可发 —— 编一个假码会让人真的去试。
      return hint('预览模式没有真实的邀请码。接入后端后才能生成和吊销邀请码。')
    }
    if (store.selfMember === null) {
      // 角色未知（成员列表没拉到 / 403 / 断网）：此时既不能给表单也不能说
      // 「你不是家长」—— 两种猜法都会把真实原因藏起来。
      return (
        <View>
          {memberError === null ? (
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
          )}
        </View>
      )
    }
    if (!canManage) {
      return hint(
        `你的身份是${memberRoleLabelOf(store.selfMember.role)}，不能生成或查看邀请码。\n` +
          '需要加入新成员时，请让家里的家长在「我的 → 邀请码」里生成一个码给你。'
      )
    }
    return (
      <View>
        {/* 与 Flutter 的 LinearProgressIndicator 同义：读请求在途时给一条明确提示，
            避免「点了进来什么都没有」被当成「没有邀请码」。 */}
        {busy && inviteError === null ? (
          <View className='kp-invite__status'>
            <Text className='kp-invite__status-text'>正在同步邀请码…</Text>
          </View>
        ) : null}
        {createCard()}
        <View className='kp-invite__gap-md' />
        {inviteError !== null ? (
          <View className='kp-invite__status-row'>
            <Text className='kp-invite__error-text'>
              {`邀请码加载失败：${inviteError.userMessage}`}
            </Text>
            <View
              className={`kp-invite__chip ${busy ? 'is-disabled' : ''}`}
              onClick={() => {
                if (busy) return
                void handleReloadInvites()
              }}
            >
              <Text className='kp-invite__chip-text'>重试</Text>
            </View>
          </View>
        ) : null}
        {invites.length === 0 ? (
          <View className='kp-invite__empty'>
            <Text className='kp-invite__empty-text'>{emptyText()}</Text>
          </View>
        ) : (
          <View className='kp-invite__list'>
            {invites.map((invite) => inviteRow(invite))}
          </View>
        )}
        {hint(
          '邀请码就是钥匙：拿到码的人可以加入这个家庭，只发给信任的人。' +
            '吊销后立即失效，已加入的成员不受影响。'
        )}
      </View>
    )
  }

  return (
    <SheetFrame
      visible={visible}
      title='邀请码'
      subtitle={
        canManage
          ? '生成邀请码发给家人，让对方加入这个家庭'
          : '只有家长可以生成和查看邀请码'
      }
      onClose={onClose}
    >
      {body()}
    </SheetFrame>
  )
}

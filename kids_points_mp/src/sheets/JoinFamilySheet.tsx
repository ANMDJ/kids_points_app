import { Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import { FieldLabel, SoftTextField } from '../components/FormFields'
import SheetFrame from '../components/SheetFrame'
import { useStore } from '../data/store'
import { toast } from '../utils/toast'
import './sheets.scss'

export interface JoinFamilySheetProps {
  visible: boolean
  onClose: () => void
}

/**
 * 「加入家庭」（P0-3，2026-11-03）—— 已有账号的人用家长发的邀请码进另一个家庭。
 *
 * ── 它与「邀请码」面板是**相反方向**的两件事 ────────────────────────────────
 *   · 「邀请码」：我发码，别人来加入**我**的家庭（`POST /invites`，仅家长）；
 *   · 「加入家庭」：我输码，去加入**别人**的家庭（`POST /invites/accept`，
 *     任何已登录的人都行 —— 被邀请人按定义还不是那个孩子的成员）。
 *   两个入口都在「我的」页，名称必须一眼能分开。
 *
 * ── 本地校验只做形状 ────────────────────────────────────────────────────────
 *   空 / 少抄一位 / 抄进了 0 O 1 I L：本地就能说清楚，不必先等一次往返再被
 *   400 拒。而「这码过期了 / 用完了 / 被吊销了 / 你已经是成员了」只有服务端
 *   知道（后端故意让前三种同形，避免变成「哪些码存在」的探针）。
 *
 * ── 成功后为什么 `onClose()` 就够了 ────────────────────────────────────────
 *   `store.submitAcceptInvite()` 已经把 `childId` 切到新家庭、清空了上一个
 *   家庭的缓存并拉了一次新首页；`useStore()` 的订阅会让四个 tab 重绘。
 *   页面不需要自己跳转（那会让用户以为"加入"是一次页面切换）。
 */
export default function JoinFamilySheet({ visible, onClose }: JoinFamilySheetProps) {
  const store = useStore()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const busy = store.isAcceptInviteBusy

  useEffect(() => {
    if (!visible) return
    // 每次打开都从空开始：上一次输到一半的码不该被带到下一次。
    setCode('')
    setError(null)
  }, [visible])

  const handleSubmit = async () => {
    if (busy) return
    setError(null)
    // 形状规则**只有一份**（`store.submitAcceptInvite` → `utils/invite_code.ts`）；
    // 面板不抄第二份，否则面板与 store 的边界迟早不一致。
    const message = await store.submitAcceptInvite(code)
    if (message === null) {
      toast('已加入家庭，正在切换到这个家庭的数据…')
      onClose()
      return
    }
    setError(message)
  }

  return (
    <SheetFrame
      visible={visible}
      title='加入家庭'
      subtitle='输入家长发给你的邀请码，就能看到这个家庭的积分和心愿'
      onClose={onClose}
      actionLabel={busy ? '正在加入…' : '加入'}
      actionIcon='check'
      onAction={handleSubmit}
    >
      <FieldLabel text='邀请码' />
      <SoftTextField
        value={code}
        onChange={(value) => {
          setCode(value)
          if (error !== null) setError(null)
        }}
        hint='例如 ABCD-EFGH'
        // 与后端 `AcceptInviteDto` 的 `@MaxLength(32)` 同口径。
        maxLength={32}
      />
      <Text className='kp-join-family__hint'>
        8 位字母数字，不含容易认错的 0 / O / 1 / I / L；连字符可省略。加入后会切换到这个家庭 —— 你自己的家庭不会消失，下次登录仍在。
      </Text>
      {error !== null ? (
        <View className='kp-join-family__error'>
          <Text className='kp-join-family__error-text'>{error}</Text>
        </View>
      ) : null}
    </SheetFrame>
  )
}

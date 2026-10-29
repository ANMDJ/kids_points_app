import { Text, View } from '@tarojs/components'
import { redirectTo } from '@tarojs/taro'
import { useEffect, useState } from 'react'

import AppCard from '../../components/AppCard'
import GradientPage from '../../components/GradientPage'
import Icon from '../../components/Icon'
import SoftButton from '../../components/SoftButton'
import type { AuthLoginReason } from '../../data/auth_session'
import { useStore } from '../../data/store'
import type { AuthGateKind } from '../../data/store'
import { TAB_PAGES } from '../../utils/nav'
import './index.scss'

/**
 * 登录页 / 启动闸门（W9-B）。
 *
 * ── 它承担四件事，各自的说服成本不同 ──────────────────────────────────────
 *   ① `needs_login`   未登录 / token 被拒 / 账号停用 ⇒ 一键登录（或说明为什么不能登）；
 *   ② `needs_bootstrap` 已登录但没有孩子档案 ⇒ 同意 + `POST /children`；
 *   ③ `needs_child_selection` 多个孩子 ⇒ 选一个（首版限 1 个，正常走不到）；
 *   ④ `unreachable`   断网 / 5xx ⇒ **只**给重试，绝不跳"重新登录"。
 *   四个分支的文案都从 store 来（`authMessage` 是服务端 / 网络层的原话），
 *   页面只负责把「为什么」说具体 —— 不在 UI 里另编一套错误话术。
 *
 * ── 为什么不做"先看首页再弹登录" ──────────────────────────────────────────
 *   那会让用户在登录前就看到上一位用户的数字（指标 / 昵称）。闸门必须在
 *   任何业务渲染之前生效，所以它是 `redirectTo` 覆盖当前页，而不是弹窗。
 *
 * ── 为什么这里不挂 `useAuthGate` ──────────────────────────────────────────
 *   自己跳自己会触发小程序的 "redirectTo:fail page is not allowed"，
 *   而且登录页正是闸门的**终点**，再判断一次没有意义。
 */
const REASON_TITLES: Record<AuthLoginReason, string> = {
  no_token: '欢迎使用积分小管家',
  token_rejected: '登录已过期',
  relogin_failed: '需要重新登录',
  login_failed: '登录没有完成',
  account_inactive: '账号已停用'
}

/** 停用账号不该出现"再登一次"的按钮：重登一定还是同一个结果。 */
const LOGIN_DISABLED_REASONS: readonly AuthLoginReason[] = ['account_inactive']

/** 每个闸门状态一句话（标题下面的那行）。 */
const SUBTITLES: Record<AuthGateKind, string> = {
  idle: '正在启动…',
  restoring: '正在确认登录状态…',
  preview: '没有配置后端：正在使用本地预览数据。',
  needs_login: '每天的小事，攒成看得见的进步。',
  needs_bootstrap: '还差一步：为这个账号建立孩子的档案。',
  needs_child_selection: '这个账号有多个孩子，请选择这台设备要用哪一个。',
  ready: '正在进入…',
  unreachable: '网络没有连上，数据都还在。'
}

export default function LoginPage() {
  const store = useStore()
  const [error, setError] = useState<string | null>(null)
  const [consentChecked, setConsentChecked] = useState(false)

  const state = store.authState
  const busy = store.isAuthBusy
  const reason = store.authReason
  const title = reason !== null ? REASON_TITLES[reason] : '登录积分小管家'

  // `ready` / `preview` 都可以进主页：前者会话就绪，后者是没配后端的本地预览
  // （`40` §10.1 规矩三 —— 开发者不该因为没配后端就被锁在登录页）。
  useEffect(() => {
    if (state !== 'ready' && state !== 'preview') return
    void redirectTo({ url: TAB_PAGES[0] })
  }, [state])

  /**
   * `wx.login()` → `POST /auth/login`。
   *
   * 成功时 store 会变成 `ready`，上面那个 effect 负责跳页；这里只处理失败 ——
   * 失败**不跳**，把原因留在这一屏（用户点了按钮，总得看到结果）。
   */
  const handleLogin = async () => {
    if (busy) return
    setError(null)
    const message = await store.login()
    if (message !== null) setError(message)
  }

  /** 同意并建立第一个孩子（`needs_bootstrap`）。 */
  const handleBootstrap = async () => {
    if (busy) return
    if (!consentChecked) {
      setError('请先勾选「我是该儿童的监护人，并同意为其创建积分账本」。')
      return
    }
    setError(null)
    const message = await store.bootstrapChild()
    if (message !== null) setError(message)
  }

  /** 多孩子选择（首版限 1 个孩子，正常走不到）。 */
  const handleSelectChild = async (childId: string) => {
    if (busy) return
    setError(null)
    const message = await store.selectChild(childId)
    if (message !== null) setError(message)
  }

  /** 断网重试：**不清 token**，只是重新问一次 `GET /auth/session`。 */
  const handleRetry = () => {
    if (busy) return
    setError(null)
    store.retryAuth()
  }

  const canLogin = reason === null || !LOGIN_DISABLED_REASONS.includes(reason)

  return (
    <GradientPage className='kp-login' safeBottom>
      <View className='kp-login__body'>
        <View className='kp-login__brand'>
          <Text className='kp-login__emoji'>🌱</Text>
          <Text className='kp-login__title'>{title}</Text>
          <Text className='kp-login__subtitle'>{SUBTITLES[state]}</Text>
        </View>

        {state === 'needs_login' ? (
          <AppCard className='kp-login__card'>
            <Text className='kp-login__hint'>{store.authMessage}</Text>
            {reason === 'account_inactive' ? (
              <Text className='kp-login__warn'>
                这个账号已被停用，重新登录也不会恢复。请让家庭里的家长在「我的 →
                家庭成员」里确认你的成员位；如果是误判，请联系我们。
              </Text>
            ) : null}
            {reason === 'token_rejected' ? (
              <Text className='kp-login__fineprint'>
                换一台设备、清理过缓存或会话到期都会走到这里。重新登录不会丢数据 ——
                积分和记录都在服务端。
              </Text>
            ) : null}
          </AppCard>
        ) : null}

        {state === 'needs_bootstrap' ? (
          <AppCard className='kp-login__card'>
            <Text className='kp-login__hint'>
              {`${store.accountLabel} 已登录，但还没有孩子的档案。建立后就能开始记积分。`}
            </Text>
            <View
              className='kp-login__checkbox-row'
              onClick={() => {
                if (busy) return
                setConsentChecked((value) => !value)
                setError(null)
              }}
            >
              <View
                className={`kp-login__checkbox ${consentChecked ? 'is-checked' : ''}`}
              >
                {consentChecked ? (
                  <Icon name='check' size={13} color='#ffffff' />
                ) : null}
              </View>
              <Text className='kp-login__checkbox-label'>
                我是该儿童的监护人，并同意为其创建积分账本
              </Text>
            </View>
            <Text className='kp-login__fineprint'>
              继续即表示您已阅读并同意《用户协议》与《儿童个人信息保护规则》。协议文本仍是占位版本，正式上线前会替换并重新征求同意。
            </Text>
          </AppCard>
        ) : null}

        {state === 'needs_child_selection' ? (
          <AppCard className='kp-login__card'>
            {store.loginCandidates.map((child) => (
              <View
                key={child.childId}
                className='kp-login__child-row'
                onClick={() => {
                  void handleSelectChild(child.childId)
                }}
              >
                <Text className='kp-login__child-name'>
                  {child.name.trim() !== '' ? child.name : '未命名孩子'}
                </Text>
                <Icon name='chevronRight' size={16} color='#b6bdb0' />
              </View>
            ))}
            <Text className='kp-login__fineprint'>
              首版一个账号只放一个孩子；这里出现多项说明服务端数据比这个版本新，选一个继续即可。
            </Text>
          </AppCard>
        ) : null}

        {state === 'unreachable' ? (
          <AppCard className='kp-login__card'>
            <Text className='kp-login__hint'>{store.authMessage}</Text>
            <Text className='kp-login__fineprint'>
              这次没有连上服务器，但并没有退出登录：网络恢复后点重试即可，不需要重新授权。
            </Text>
          </AppCard>
        ) : null}

        {state === 'restoring' || state === 'idle' ? (
          <AppCard className='kp-login__card'>
            <Text className='kp-login__hint'>正在确认登录状态…</Text>
          </AppCard>
        ) : null}

        {error !== null ? (
          <View className='kp-login__error'>
            <Text className='kp-login__error-text'>{error}</Text>
          </View>
        ) : null}

        <View className='kp-login__actions'>
          {state === 'needs_login' && canLogin ? (
            <SoftButton
              label={busy ? '正在登录…' : '微信一键登录'}
              enabled={!busy}
              onClick={handleLogin}
            />
          ) : null}
          {state === 'needs_bootstrap' ? (
            <SoftButton
              label={busy ? '正在建立…' : '同意并建立档案'}
              enabled={!busy && consentChecked}
              onClick={handleBootstrap}
            />
          ) : null}
          {state === 'unreachable' || (state === 'needs_login' && !canLogin) ? (
            <View className='kp-login__secondary' onClick={handleRetry}>
              <Text className='kp-login__secondary-label'>
                {busy ? '正在重试…' : '重试'}
              </Text>
            </View>
          ) : null}
        </View>

        <Text className='kp-login__footer'>
          登录只用于识别「你是这个家庭里的谁」：不读取微信昵称与头像，也不会读取通讯录。
        </Text>
      </View>
    </GradientPage>
  )
}

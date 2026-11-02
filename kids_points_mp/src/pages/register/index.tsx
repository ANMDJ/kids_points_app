import { Text, View } from '@tarojs/components'
import { redirectTo } from '@tarojs/taro'
import { useState } from 'react'

import AppCard from '../../components/AppCard'
import { FieldLabel, SoftTextField } from '../../components/FormFields'
import GradientPage from '../../components/GradientPage'
import SoftButton from '../../components/SoftButton'
import { useStore } from '../../data/store'
import { LOGIN_PAGE, TAB_PAGES } from '../../utils/nav'
import './index.scss'

/**
 * 用邀请码注册（W12，2026-11-02）。
 *
 * ── 它补的是哪一个洞 ────────────────────────────────────────────────────────
 *   小程序原先只有「微信一键登录」：从网站拿到邀请码的人在这里没有任何入口，
 *   而产品明确要求「小程序与 App 都能用同一张码注册，且互不依赖」。
 *
 * ── 为什么字段顺序是「邀请码 → 手机号/邮箱 → 密码」──────────────────────────
 *   邀请码是这条路由**唯一的授权凭据**（`45` §0）：没有码就不能建号。
 *   放第一行，用户第一眼就知道「我需要先拿到一个码」；放到最后，
 *   他会填完手机号和密码才被打回来。
 *
 * ── 成功之后去哪，由 store 的闸门决定 ──────────────────────────────────────
 *   · 网站码 ⇒ 账号零个孩子 ⇒ `needs_bootstrap` ⇒ 回登录页勾选同意建档案；
 *   · 家庭码 ⇒ 直接 `ready` ⇒ 登录页 effect 跳主页。
 *   本页**不**自己判断 membership，也不自己调 `POST /children` —— 那会把
 *   「注册」和「建档案」两件事混成一个不可重试的动作。
 *
 * ── 本地只拦「空」──────────────────────────────────────────────────────────
 *   码形状 / 标识形状 / 密码强度都只有服务端一份规则；客户端再抄一遍，
 *   两边迟早不一致，用户会看到「本地说可以、服务端说不行」。
 */
export default function RegisterPage() {
  const store = useStore()
  const [inviteCode, setInviteCode] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const busy = store.isAuthBusy

  /**
   * 回到登录页。
   *
   * ★ 用 `redirectTo`（不是 `navigateBack`）：注册页是从登录页 `redirectTo`
   *   过来的，页面栈本来就只有一层；这里再替换一次，任何入口（含深链）
   *   都不会把用户困在一个没有登录入口的页面上。
   */
  const back = () => {
    void redirectTo({ url: LOGIN_PAGE })
  }

  const submit = async () => {
    if (busy) return
    setError(null)

    if (inviteCode.trim() === '') {
      setError('请填写邀请码（从网站「邀请码获取」页领取，或向家里已在用的家长要一张）。')
      return
    }
    if (identifier.trim() === '') {
      setError('请填写手机号或邮箱。')
      return
    }
    if (password === '') {
      setError('请填写密码。')
      return
    }

    const message = await store.registerWithInvite({
      inviteCode,
      identifier,
      password,
      displayName: displayName.trim() === '' ? undefined : displayName
    })
    if (message !== null) {
      setError(message)
      return
    }

    // 注册成功：由 store 的闸门决定去哪（**不**在这里判断 membership）。
    //   · ready（家庭码直接进了家庭）⇒ 主页；
    //   · needs_bootstrap（网站码，零个孩子）⇒ 登录页显示「同意并建立档案」。
    if (store.authState === 'ready') {
      void redirectTo({ url: TAB_PAGES[0] })
      return
    }
    back()
  }

  return (
    <GradientPage className='kp-register' safeBottom>
      <View className='kp-register__body'>
        <View
          className='kp-register__back'
          onClick={() => {
            if (!busy) back()
          }}
        >
          <Text className='kp-register__back-label'>‹ 返回登录</Text>
        </View>

        <View className='kp-register__brand'>
          <Text className='kp-register__emoji'>🎟️</Text>
          <Text className='kp-register__title'>用邀请码注册</Text>
          <Text className='kp-register__subtitle'>
            积分小管家目前是邀请制：先拿到邀请码，再在这里建号。
          </Text>
        </View>

        <AppCard className='kp-register__card'>
          <Text className='kp-register__hint'>
            邀请码有两个来源：网站「邀请码获取」页（每天限量），
            或家里已经在用的家长在小程序「我的 → 邀请码」生成。
          </Text>
        </AppCard>

        <AppCard className='kp-register__card'>
          <FieldLabel text='邀请码' />
          <SoftTextField
            value={inviteCode}
            onChange={(value) => {
              setInviteCode(value)
              setError(null)
            }}
            hint='例如 ABCD-2345'
          />

          <View className='kp-register__gap' />
          <FieldLabel text='手机号或邮箱' />
          <SoftTextField
            value={identifier}
            onChange={(value) => {
              setIdentifier(value)
              setError(null)
            }}
            hint='13800138000 或 dad@example.com'
          />
          <Text className='kp-register__fineprint'>
            网站码只认申请时填写的手机号或邮箱；这里填其中一个即可。
          </Text>

          <View className='kp-register__gap' />
          <FieldLabel text='设置密码' />
          <SoftTextField
            value={password}
            onChange={(value) => {
              setPassword(value)
              setError(null)
            }}
            hint='至少 8 位，别用纯数字'
            password
            maxLength={64}
          />

          <View className='kp-register__gap' />
          <FieldLabel text='你的称呼（选填）' />
          <SoftTextField
            value={displayName}
            onChange={setDisplayName}
            hint='例如：妈妈 / 爸爸'
            maxLength={40}
          />
        </AppCard>

        {error !== null ? (
          <View className='kp-register__error'>
            <Text className='kp-register__error-text'>{error}</Text>
          </View>
        ) : null}

        <View className='kp-register__actions'>
          <SoftButton
            label={busy ? '正在注册…' : '注册并登录'}
            enabled={!busy}
            onClick={() => {
              void submit()
            }}
          />
        </View>

        <Text className='kp-register__footer'>
          注册即表示你已阅读并同意《用户协议》与《儿童个人信息保护规则》。
          网站邀请码只能使用一次；注册成功后按引导为孩子建立档案。
        </Text>
      </View>
    </GradientPage>
  )
}

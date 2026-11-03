import { Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import AppCard from '../components/AppCard'
import { FieldLabel, SoftTextField } from '../components/FormFields'
import SheetFrame from '../components/SheetFrame'
import {
  ACCOUNT_PASSWORD_MAX,
  accountIdentifierLabel,
  accountLoginReady,
  accountStatusText,
  checkAccountEmail,
  checkAccountPassword,
  checkAccountPhone
} from '../data/account'
import { createAccountBinderFromEnvironment, type AccountBinder } from '../data/auth_api'
import { AuthApiException } from '../data/auth_api_errors'
import { sharedAuthTokens } from '../data/auth_token_holder'
import type { AccountSnapshot } from '../data/auth_dto'
import { PASSWORD_REQUIREMENT_HINT } from '../utils/password_rules'
import { toast } from '../utils/toast'
import './sheets.scss'

export interface AppAccountSheetProps {
  visible: boolean
  onClose: () => void
}

/**
 * 「App 登录账号」（W9-D，2026-10-30 / `42` §4.3）—— 小程序是**唯一**的账号创建入口。
 *
 * ── 这一屏存在的理由 ────────────────────────────────────────────────────────
 *   App 首版**不开放注册**（`42` §5.1）：手机号打错一位就静默生成一个「看不到
 *   自己孩子」的新账号，然后三条客服工单。所以「哪些号能登 App」只能在小程序里
 *   被绑定 —— 而绑定的那一刻，微信身份已经把"这是我"证明了。
 *
 * ── 为什么叫「App 登录账号」而不是「安全设置」────────────────────────────────
 *   它**不是**可选设置。没绑过的人打开 App 只会看到登录页，而登录页没有任何
 *   注册入口 —— 文案若含糊，用户会以为"App 坏了"，而不是"我还没开通"。
 *
 * ── 先读状态，再让用户填（`GET /auth/account`）─────────────────────────────
 *   不读就只能是空白表单，用户会读成"我根本没绑过"然后又绑一次（换号 ⇒
 *   上一台手机的 App 登录再也进不来）。而且 `hasPassword` 决定密码框写
 *   「设置密码」还是「修改密码」—— 后者必须带当前密码，猜错就是一次必然 400。
 *
 * ── 明文密码的边界（与 `ParentModeSheet` 同一纪律）──────────────────────────
 *   明文只活在 `password` / `currentPassword` 两个 state 里：不进 store、
 *   不进日志、不进异常 detail；保存成功**立刻清空**，关掉面板即随组件卸载。
 */
export default function AppAccountSheet({ visible, onClose }: AppAccountSheetProps) {
  /** 惰性构造一次：面板开着时不必反复 new 客户端（它只是 transport 的壳）。 */
  const [binder] = useState<AccountBinder | null>(() => createAccountBinderFromEnvironment())

  /** `null` = 还没读到（**不是**"什么都没绑"）。两者在界面上是完全相反的结论。 */
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 输入框一律**不预填**已绑的号：状态行已经用掩码说明"现在绑的是什么"，
  // 再在输入框里回显完整号码只会多一份被截屏的机会。
  // 空 ⇒ 不改（见 handleSave 的"只提交改动过的字段"）。
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')

  const load = async (api: AccountBinder) => {
    const token = sharedAuthTokens.current()
    if (token === null) {
      setLoading(false)
      setSnapshot(null)
      setLoadError('这台设备当前没有登录凭据，请退出后重新进入小程序再试')
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      setSnapshot(await api.fetchAccount(token))
    } catch (err) {
      // 读失败**不能**画成"还没绑"：那样用户会去绑一个已经绑过的号，
      // 得到一句"这个手机号已经被另一个账号绑定了"（其实就是他自己）。
      setSnapshot(null)
      setLoadError(errorMessage(err, '读取 App 登录账号失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!visible) return
    // 每次打开都清空凭据输入框：上一次输到一半的密码不该被带到下一次。
    setPhone('')
    setEmail('')
    setPassword('')
    setCurrentPassword('')
    setError(null)
    setSnapshot(null)
    setLoadError(null)
    if (binder === null) {
      setLoading(false)
      return
    }
    void load(binder)
    // `binder` 在组件生命周期内不变；`load` 只读组件外部状态，无需进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, binder])

  /**
   * 保存。**只提交改动过的字段**（与快照比较）。
   *
   * ── 为什么不是"把三个框都发一遍"──────────────────────────────────────────
   *   用户只想改密码时手机号框是空的 —— 若把空串也发出去，后端会把它当成
   *   "要改成空手机号"（400，或更糟：清掉绑定）。"空 = 不改"必须由客户端
   *   保证，因为 JSON 里的 `null` / 缺省 / 空串是三种意思，而服务端只认
   *   "字段在不在"。
   */
  const handleSave = async () => {
    if (busy || loading) return
    const api = binder
    if (api === null) return
    const token = sharedAuthTokens.current()
    if (token === null) {
      setError('这台设备当前没有登录凭据，请退出后重新进入小程序再试。')
      return
    }

    const input: {
      phone?: string
      email?: string
      password?: string
      currentPassword?: string
    } = {}

    const nextPhone = phone.trim()
    const nextEmail = email.trim()
    if (nextPhone !== '' && nextPhone !== (snapshot?.phone ?? '')) input.phone = nextPhone
    if (nextEmail !== '' && nextEmail !== (snapshot?.email ?? '')) input.email = nextEmail

    if (password !== '') {
      // ★ 传上这次要绑的标识（有就传）：`same_as_identifier` 这一条要在本地
      //   也判得出来，否则「密码 = 手机号」仍要撞一次 400。
      const weak = checkAccountPassword(
        password,
        input.phone ?? input.email ?? snapshot?.phone ?? snapshot?.email
      )
      if (weak !== null) {
        setError(weak)
        return
      }
      if (snapshot?.hasPassword === true) {
        // 服务端在"已有密码"时**强制**要求当前密码（`CURRENT_PASSWORD_REQUIRED`）。
        // 本地先拦一次：那是一次注定 400 的往返，而且错误框出现在保存按钮下方，
        // 用户会以为是自己新密码写错了。
        if (currentPassword === '') {
          setError('修改密码前请先填写当前密码。')
          return
        }
        input.currentPassword = currentPassword
      }
      input.password = password
    }

    if (Object.keys(input).length === 0) {
      setError('没有要保存的改动。填手机号、邮箱或密码后再点保存。')
      return
    }

    if (input.phone !== undefined) {
      const bad = checkAccountPhone(input.phone)
      if (bad !== null) {
        setError(bad)
        return
      }
    }
    if (input.email !== undefined) {
      const bad = checkAccountEmail(input.email)
      if (bad !== null) {
        setError(bad)
        return
      }
    }

    // 后端允许"只设密码、不绑标识"，但那种账号在 App 那边没有东西可填 ——
    // 半成品状态会让用户以为已经开通了。这里直接拦下并说清原因。
    const willHaveIdentifier =
      input.phone !== undefined ||
      input.email !== undefined ||
      snapshot?.phone != null ||
      snapshot?.email != null
    if (!willHaveIdentifier) {
      setError('请同时填写手机号或邮箱 —— 只有密码的话，App 的登录页没有东西可以填。')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const next = await api.updateAccount(token, input)
      setSnapshot(next)
      // 明文立刻消失；输入框清空，状态行会显示"已绑定 138****8000"。
      setPassword('')
      setCurrentPassword('')
      setPhone('')
      setEmail('')
      toast(
        accountLoginReady(next)
          ? '已保存：可以在 App 里用手机号或邮箱 + 密码登录了'
          : '已保存，但还差密码 —— 现在还不能在 App 里登录'
      )
    } catch (err) {
      // 409 IDENTIFIER_TAKEN / 400 WEAK_PASSWORD / 403 CURRENT_PASSWORD_INVALID
      // 都在服务端 `message` 里写了"下一步怎么办"，原样显示即可。
      setError(errorMessage(err, '保存请求已发出，但结果无法确认'))
      // 失败后重读一次：手机号可能刚好被别人抢注（409），而界面上写的
      // "当前绑定"还是打开面板那一刻的旧事实。
      void load(api)
    } finally {
      setBusy(false)
    }
  }

  const hint = (text: string, danger = false) => (
    <View className='kp-app-account__hint'>
      <Text className={`kp-app-account__hint-text ${danger ? 'is-danger' : ''}`}>{text}</Text>
    </View>
  )

  /** 把**服务端事实**摊开说：绑了什么、还差什么、现在能不能登。 */
  const statusCard = () => {
    if (snapshot === null) return null
    const ready = accountLoginReady(snapshot)
    const bound = accountIdentifierLabel(snapshot) !== null
    return (
      <AppCard radius={20} padding={[16, 18]}>
        <Text className='kp-app-account__status-text'>{accountStatusText(snapshot)}</Text>
        <View className={`kp-app-account__badge ${ready ? 'is-ready' : 'is-pending'}`}>
          <Text className='kp-app-account__badge-text'>
            {ready ? '可以用 App 登录' : bound ? '还差密码' : '还没有绑定'}
          </Text>
        </View>
      </AppCard>
    )
  }

  const form = () => {
    if (snapshot === null) return null
    return (
      <View>
        <FieldLabel text='手机号' />
        <SoftTextField
          value={phone}
          onChange={setPhone}
          hint={
            snapshot.phone === null
              ? '11 位手机号，例如 13800138000'
              : '换号请直接填写新的 11 位手机号'
          }
          digit
          maxLength={11}
        />
        <View className='kp-sheet-gap-xs' />
        <FieldLabel text='邮箱' />
        <SoftTextField
          value={email}
          onChange={setEmail}
          hint={snapshot.email === null ? '没有手机号也可以只绑邮箱' : '换邮箱请直接填写新的地址'}
          maxLength={254}
        />
        <View className='kp-sheet-gap-xs' />
        <FieldLabel text={snapshot.hasPassword ? '新密码' : '设置密码'} />
        <SoftTextField
          value={password}
          onChange={setPassword}
          hint='8–64 位，至少含一个字母'
          password
          maxLength={ACCOUNT_PASSWORD_MAX}
        />
        {/* ★ 要求**常驻**（不是 placeholder）：placeholder 在用户开始输入的那一刻
            就消失了，而密码要求恰恰是"输入到一半"最需要看到的东西。 */}
        {hint(PASSWORD_REQUIREMENT_HINT)}
        {snapshot.hasPassword && password !== '' ? (
          <View>
            <View className='kp-sheet-gap-xs' />
            <FieldLabel text='当前密码' />
            <SoftTextField
              value={currentPassword}
              onChange={setCurrentPassword}
              hint='修改密码必须先验证旧密码'
              password
              maxLength={ACCOUNT_PASSWORD_MAX}
            />
          </View>
        ) : null}
        <View className='kp-sheet-gap-sm' />
        {hint(
          '手机号和邮箱至少要有一个，并设置一个密码 —— 两样齐了才能在 App 里登录。' +
            '密码只用于 App 登录，不会改变小程序的微信登录状态。' +
            '忘记密码时回到这里重设即可（不需要短信验证码）。'
        )}
        <View className='kp-sheet-gap-10' />
        {hint('目前不支持在 App 里解绑；想换号，直接在上面填新号并保存。')}
      </View>
    )
  }

  const body = () => {
    // ★ 判据只能是 `binder`，**不能**用 `store.isLiveMode`：
    //   `isLiveMode` 要求 baseUrl + deviceId + childId 三项齐全，而绑定账号
    //   只需要 baseUrl（Bearer 已足够）。用 `isLiveMode` 会把「三项里少两项」
    //   误判成「没有后端」，用户看到「预览模式」而请求其实已经发出 —— 界面
    //   把真实结果挡住了，人会以为功能没接。
    if (binder === null) {
      return hint(
        '没有配置后端地址（TARO_APP_KP_API_BASE_URL），这一屏读不到也存不了账号。' +
          '在 kids_points_mp/.env.local 填好地址后重新 build:weapp。'
      )
    }
    if (loading) return hint('正在读取当前绑定情况…')
    if (loadError !== null) {
      return (
        <View>
          {hint(loadError, true)}
          <View className='kp-sheet-gap-sm' />
          <View
            className='kp-app-account__retry'
            onClick={() => {
              if (loading) return
              void load(binder)
            }}
          >
            <Text className='kp-app-account__retry-text'>重新读取</Text>
          </View>
        </View>
      )
    }
    return (
      <View>
        {statusCard()}
        <View className='kp-sheet-gap-md' />
        {busy ? hint('正在保存，请稍候…') : null}
        {form()}
        {error !== null ? (
          <View>
            <View className='kp-sheet-gap-10' />
            {hint(error, true)}
          </View>
        ) : null}
      </View>
    )
  }

  return (
    <SheetFrame
      visible={visible}
      title='App 登录账号'
      subtitle={
        snapshot === null
          ? '绑定后就能在 App 里用手机号或邮箱登录'
          : accountLoginReady(snapshot)
            ? '这个账号已经可以在 App 里登录'
            : '绑定手机号或邮箱并设置密码，App 才能登录'
      }
      onClose={onClose}
      actionLabel={busy ? '保存中…' : '保存'}
      actionIcon='check'
      onAction={
        busy || loading || binder === null || loadError !== null
          ? undefined
          : () => {
              void handleSave()
            }
      }
    >
      {body()}
    </SheetFrame>
  )
}

/** 服务端 `message` 优先（每一支都写了"下一步怎么改"），否则给一句兜底。 */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AuthApiException) return error.userMessage
  return `${fallback}。请稍后重试。`
}

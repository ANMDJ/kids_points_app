import { Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import AppCard from '../components/AppCard'
import { FieldLabel, SoftTextField } from '../components/FormFields'
import Icon from '../components/Icon'
import SheetFrame from '../components/SheetFrame'
import SoftButton from '../components/SoftButton'
import { useStore } from '../data/store'
import { humanizeSeconds, mmss } from '../data/parent_mode'
import { toast } from '../utils/toast'
import './sheets.scss'

export interface ParentModeSheetProps {
  visible: boolean
  onClose: () => void
}

/**
 * 家长模式（W8-C）：用 PIN 换 5 分钟家长权限，或立刻退出。
 *
 * ── 这个面板要回答的三个问题 ────────────────────────────────────────────────
 *   ① **我现在是不是家长模式**：服务端事实（`activeRole`），不是本地开关；
 *   ② **还剩多久**：从 `expiresAt` 现算 —— 面板里每秒重绘的是「剩余秒数」，
 *      不是"减了 1 的计数器"，所以切到后台再回来也对得上；
 *   ③ **输错了会怎样**：还剩几次 / 锁定到什么时候，必须写在输入框旁边 ——
 *      家长连错 5 次会被锁 15 分钟，而"锁 15 分钟"这件事如果不提前说，
 *      就会被读成"应用坏了"。
 *
 * ── 为什么退出不需要 PIN ────────────────────────────────────────────────────
 *   `02` §7：降级永远允许。孩子正拿着手机时，家长必须能立刻收回权限；
 *   给"退出"加一道 PIN 等于把权限锁在家长模式里。
 */
export default function ParentModeSheet({ visible, onClose }: ParentModeSheetProps) {
  const store = useStore()
  const [pin, setPin] = useState('')
  const [currentPin, setCurrentPin] = useState('')
  const [newPin, setNewPin] = useState('')
  /** 「设置 / 修改 PIN」折叠区：默认收起（90% 的用法是「进去 5 分钟」）。 */
  const [editorOpen, setEditorOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!visible) return
    // 打开才拉一次：应用冷启动不该为「可能根本不会用」的面板付一次往返。
    // 明文 PIN 每次打开都清空 —— 上一次输到一半的凭据不该被带到下一次。
    setError(null)
    setEditorOpen(false)
    setPin('')
    setCurrentPin('')
    setNewPin('')
    void store.refreshParentMode()
  }, [visible, store])

  /**
   * 每秒重绘一次。只重绘，**不递减任何状态**：倒计时始终由
   * `store.parentModeRemainingSeconds(now)` 从服务端的 `expiresAt` 现算，
   * 小程序被切到后台时定时器会停，靠本地自减就会"少走几分钟"。
   */
  useEffect(() => {
    if (!visible) return undefined
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [visible])

  const now = Date.now()
  const parentMode = store.isParentMode
  // ★ 「家长模式」有两种来源，说法必须分开（W8-C 验收抓到的缺陷）：
  //   · PIN 换的 5 分钟 ⇒ 倒计时有意义；
  //   · 邀请码加入的家长设备 ⇒ 登录会话（30 天）自带，倒计时会变成 `43200:00`。
  const sessionBacked = store.isParentModeSessionBacked
  const locked = store.isParentPinLockedAt(now)
  const busy = store.isParentModeBusy || store.isParentPinBusy
  /** `null` = 还没拉到（**不是**「不在家长模式」）。 */
  const known = store.parentMode !== null

  const handleEnter = async () => {
    if (busy || locked) return
    const failure = await store.enterParentMode(pin)
    setError(failure)
    if (failure !== null) return
    // 成功后清空输入框：明文 PIN 不该继续留在页面状态里。
    setPin('')
    toast('已进入家长模式（5 分钟后自动收回）')
  }

  const handleExit = async () => {
    if (busy) return
    const failure = await store.exitParentMode()
    setError(failure)
    if (failure === null) toast('已退出家长模式')
  }

  const handleSavePin = async () => {
    if (busy) return
    // 已有 PIN 时必须带当前 PIN（服务端 `manage_parent_pin` 只对家长 ALLOW）；
    // 缺了它，任何拿到解锁手机的孩子都能把 PIN 改掉。
    const configured = store.isParentPinConfigured
    const failure = await store.setParentPin(
      configured ? { pin: newPin, currentPin } : { pin: newPin }
    )
    setError(failure)
    if (failure !== null) return
    const changed = store.lastParentPinResult?.changed ?? false
    setEditorOpen(false)
    setCurrentPin('')
    setNewPin('')
    toast(changed ? '家长 PIN 已修改' : '家长 PIN 已设置')
  }

  /** 顶部状态行：加载中 / 读失败 / 已锁定 / 还剩几次 / 还没设 PIN。 */
  const statusRows = () => (
    <View>
      {store.parentModeReadStatus === 'loading' && !known
        ? hint('正在读取家长模式状态…')
        : null}
      {store.parentModeError !== null
        ? hint(`状态没读成功：${store.parentModeError}`, true)
        : null}
      {locked
        ? hint(
            `家长 PIN 已锁定，请 ${humanizeSeconds(
              store.parentPinLockSecondsAt(now)
            )}后再试。锁定期间服务端不校验 PIN，也不会因为继续尝试而延长。`,
            true
          )
        : null}
      {known && !locked && !parentMode && store.isParentPinConfigured
        ? hint(
            `还剩 ${store.parentPinRemainingAttempts} 次尝试机会；连错 5 次会锁 15 分钟。`
          )
        : null}
      {known && parentMode && !store.isParentPinConfigured
        ? hint(
            '这台设备已经有家长权限，但这个账号还没有家长 PIN。' +
              '设置之后，同一账号在「孩子拿着手机」时也能凭 PIN 临时切回家长模式。'
          )
        : null}
      {known && !parentMode && !store.isParentPinConfigured
        ? hint(
            // ★ 旧文案是「请先用家长账号进入一次家长模式，再在下面设置」——
            //   对引导期跳过 PIN 的账号**不可执行**：5 分钟窗口一过就回落 child，
            //   而进家长模式本身就要 PIN（`43` §8 D7）。这里写唯一能走的那条路：
            //   「我的」页有「退出登录」，用手机号/密码重登后是 30 天家长会话。
            '这个账号还没有家长 PIN，而现在不是家长模式 —— 设置 PIN 需要家长权限。' +
              '引导期的 5 分钟家长权限已经到期，只能这样补：回到「我的」页点「退出登录」，' +
              '用申请时的手机号/密码重新登录，再回到这里设置。',
            true
          )
        : null}
    </View>
  )

  /**
   * 已经是家长模式时：倒计时（PIN 换的）或「已以家长身份登录」（会话自带）。
   *
   * ★ 两种来源的界面**必须不同**：`session` 的 TTL 是 30 天登录会话，
   * 画成倒计时会得到 `43200:00` 这种「看起来像坏了」的数字。
   */
  const parentRows = () => {
    const seconds = store.parentModeRemainingSeconds(now)
    return (
      <View>
        <AppCard radius={16} padding={[16, 14]}>
          <View className='kp-parent-mode__timer-row'>
            <Icon name='check' size={18} color='#4d7c3a' />
            <Text className='kp-parent-mode__timer-text'>
              {sessionBacked
                ? '已以家长身份登录'
                : seconds > 0
                  ? `还剩 ${mmss(seconds)} 家长权限`
                  : '家长权限已到期'}
            </Text>
          </View>
        </AppCard>
        <View className='kp-sheet-gap-xs' />
        {hint(
          sessionBacked
            ? '这台设备是家长设备：登录期间一直是家长权限，不会 5 分钟收回。' +
                '和孩子共用同一台手机时，用完请点「退出家长模式」。'
            : '到期会自动收回；「退出家长模式」随时可用，不需要 PIN。'
        )}
      </View>
    )
  }

  /** 不在家长模式时：PIN 输入框。 */
  const childRows = () => (
    <View>
      <FieldLabel text='家长 PIN' />
      <SoftTextField
        value={pin}
        // 只留数字且最多 6 位：输入法允许的 `.` / `-` 到服务端只会换回一个 400。
        onChange={(value) => setPin(value.replace(/\D/g, '').slice(0, 6))}
        hint='4–6 位数字'
        digit
        password
        maxLength={6}
      />
    </View>
  )

  /**
   * 「设置 / 修改家长 PIN」折叠区（默认收起）。
   *
   * ★ 已有 PIN 时**必须**填当前 PIN：否则任何拿到解锁手机的孩子都能改掉它，
   *   PIN 就只是装饰。这条限制在服务端（`manage_parent_pin` 仅家长 ALLOW），
   *   这里的输入框只是让家长少走一次 403。
   */
  const pinEditorRows = () => {
    const configured = store.isParentPinConfigured
    return (
      <View>
        <View
          className={`kp-parent-mode__toggle ${busy ? 'is-disabled' : ''}`}
          onClick={() => {
            if (busy) return
            setEditorOpen(!editorOpen)
          }}
        >
          <Text className='kp-parent-mode__toggle-text'>
            {configured ? '修改家长 PIN' : '设置家长 PIN'}
          </Text>
          <Icon
            name='chevronRight'
            size={16}
            color='#6e7568'
            className={`kp-parent-mode__chevron ${editorOpen ? 'is-open' : ''}`}
          />
        </View>
        {editorOpen ? (
          <View>
            {configured ? (
              <View>
                <FieldLabel text='当前 PIN' />
                <SoftTextField
                  value={currentPin}
                  onChange={(value) =>
                    setCurrentPin(value.replace(/\D/g, '').slice(0, 6))
                  }
                  hint='当前使用的 4–6 位数字'
                  digit
                  password
                  maxLength={6}
                />
                <View className='kp-sheet-gap-xs' />
              </View>
            ) : null}
            <FieldLabel text={configured ? '新的 PIN' : '家长 PIN'} />
            <SoftTextField
              value={newPin}
              onChange={(value) =>
                setNewPin(value.replace(/\D/g, '').slice(0, 6))
              }
              hint='4–6 位数字'
              digit
              password
              maxLength={6}
            />
            <View className='kp-sheet-gap-xs' />
            {hint(
              configured
                ? '改掉之后，其它设备上的旧 PIN 立刻失效；当前 5 分钟家长模式不受影响。'
                : '设置后进入家长模式就需要它。忘记 PIN 目前只能由另一位家长重新设置。'
            )}
            <View className='kp-sheet-gap-sm' />
            <SoftButton
              label={configured ? '保存新 PIN' : '设置 PIN'}
              icon='check'
              height={46}
              enabled={!busy}
              onClick={handleSavePin}
              className='kp-parent-mode__save'
            />
          </View>
        ) : null}
      </View>
    )
  }

  const body = () => {
    // 预览模式没有真实会话：编一个「家长模式已开启」会让人以为权限真的拿到了。
    if (!store.isLiveMode) {
      return hint(
        '预览模式没有真实的家长模式。接入后端后才能用 PIN 切换家长模式。'
      )
    }
    return (
      <View>
        {busy ? hint('正在提交，请稍候…') : null}
        {statusRows()}
        <View className='kp-sheet-gap-sm' />
        {parentMode ? parentRows() : childRows()}
        {pinEditorRows()}
        {error !== null ? (
          <View>
            <View className='kp-sheet-gap-10' />
            {hint(error, true)}
          </View>
        ) : null}
      </View>
    )
  }

  // 锁定 / 在途时不给动作：连点两次会消耗两次 PIN 校验，锁定期间发请求也只是
  // 换回同一个 429（服务端明确不校验、也不延长）。
  const actionLabel = parentMode
    ? '退出家长模式'
    : locked
      ? '已锁定，请稍后再试'
      : '进入家长模式'

  return (
    <SheetFrame
      visible={visible}
      title='家长模式'
      subtitle={
        !parentMode
          ? '输入家长 PIN 可以在这台设备上临时获得 5 分钟家长权限'
          : sessionBacked
            ? '这台设备已以家长身份登录，登录期间一直是家长权限'
            : `这台设备现在是家长权限（${mmss(store.parentModeRemainingSeconds(now))} 后自动收回）`
      }
      onClose={onClose}
      actionLabel={actionLabel}
      actionIcon={parentMode ? 'chevronLeft' : 'check'}
      onAction={
        busy || (!parentMode && locked)
          ? undefined
          : () => {
              void (parentMode ? handleExit() : handleEnter())
            }
      }
    >
      {body()}
    </SheetFrame>
  )
}

/** 面板内的小字提示（`danger` 用于锁定 / 错误这类必须看见的结论）。 */
function hint(text: string, danger = false) {
  return (
    <View className='kp-parent-mode__hint'>
      <Text
        className={`kp-parent-mode__hint-text ${danger ? 'is-danger' : ''}`}
      >
        {text}
      </Text>
    </View>
  )
}

import { ScrollView, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useMemo, useState } from 'react'

import AppCard from '../../components/AppCard'
import GradientPage from '../../components/GradientPage'
import Icon from '../../components/Icon'
import { isKnownIconName } from '../../components/Icon/icons'
import { FieldLabel, SoftTextField } from '../../components/FormFields'
import { SoftChip } from '../../components/Pills'
import SoftButton from '../../components/SoftButton'
import {
  AGE_BAND_OPTIONS,
  FOCUS_AREA_OPTIONS,
  ageBandLabel,
  type AgeBandName,
  type RuleTemplate
} from '../../data/onboarding'
import { useStore } from '../../data/store'
import { TAB_PAGES } from '../../utils/nav'
import './index.scss'

/** 七步的标题 / 副标题（与 `04` §2 与 Flutter 侧逐条对应）。 */
const TITLES = [
  '把约定变成看得见的成长',
  '先给孩子起个名字',
  '选择孩子的学段',
  '最想先改善什么',
  '挑选第一批约定',
  '设置家长 PIN',
  '一切就绪'
]

const SUBTITLES = [
  '每天的小事，攒成看得见的进步。开始前需要监护人同意。',
  '这本积分账本是给谁的？之后可以在「我的」里改。',
  '学段只影响约定卡片的排序，不会隐藏任何内容。',
  '可以多选；也可以跳过，约定卡片会按通用顺序排。',
  '至少选 1 条才能继续 —— 有约定，孩子才有可以做的事。',
  '用于「切到家长模式」；现在不设也可以，之后在设置里补。',
  '第一本账本已建好，点开卡片就能加分。'
]

/**
 * 首启引导（W8-B，2026-10-27 / `04` §2、§5、§6）—— 小程序侧。
 *
 * 与 Flutter `OnboardingScreen` 同一套流程与判据：
 *   ① 同意（`POST /consent`）→ ② 昵称（`PATCH /child`）→ ③ 学段 / ④ 关注点
 *   （`PATCH /onboarding/profile`）→ ⑤ 选约定 → ⑥ PIN → ⑦ 完成
 *   （⑤⑥ 一起走 `POST /onboarding/complete`，它**非幂等**）。
 *
 * 三条界面纪律：
 *   ① 失败**留在原地**并显示原因，绝不把「没保存」画成「已保存」；
 *   ② 第⑤步一条都不选**不发请求**（`04` §6 4.2）；
 *   ③ 第⑦步只说服务端确认过的事实（采纳了几条 / 加了几条习惯 / 哪些要手动）。
 */
export default function Onboarding() {
  const store = useStore()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [consentChecked, setConsentChecked] = useState(false)
  const [name, setName] = useState('')
  const [ageBand, setAgeBand] = useState<AgeBandName | null>(null)
  const [focus, setFocus] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [pin, setPin] = useState('')
  const [ready, setReady] = useState(false)

  // 首帧之后：拉一次完整状态（可能是从「我的」进来的，闸门没拉过）+ 同意状态。
  // 只跑一次：`useStore` 会让组件随 store 变化重渲染，不能在这里无脑重复发请求。
  useEffect(() => {
    let alive = true
    const bootstrap = async () => {
      if (store.onboarding === null) await store.refreshOnboarding()
      if (!alive) return
      if (store.isLiveMode && store.consentReadStatus === 'idle') {
        await store.refreshConsent()
      }
      if (!alive) return
      const snapshot = store.onboarding
      // 中途退出再进入要接着走（04 §6 4.12）：学段 / 关注点从服务端草稿恢复。
      if (snapshot !== null) {
        setAgeBand(snapshot.ageBand)
        setFocus(snapshot.focusAreas)
      }
      setName(store.profile.name)
      setReady(true)
    }
    void bootstrap()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const templates: RuleTemplate[] = store.onboarding?.templates ?? []
  const granted = store.consent.status === 'granted'
  const withdrawn = store.consent.status === 'withdrawn'

  const footerLabel = useMemo(() => {
    if (step === 0) return granted ? '开始设置' : '同意并开始'
    if (step === 4) return `就是这几条（${selected.length}）`
    // PIN 必填（2026-11-03，`43` §8 D7）：没有「跳过并完成」这个状态。
    if (step === 5) return '完成引导'
    if (step === 6) return '开始打卡'
    return '下一步'
  }, [step, granted, selected.length])

  /** 承载「在途 → 成功 / 失败」三段：失败留在原地。 */
  const run = async (
    action: () => Promise<string | null>,
    onSuccess: () => void
  ) => {
    if (busy) return
    setBusy(true)
    setError(null)
    let message: string | null
    try {
      message = await action()
    } catch (unexpected) {
      message = '操作没有完成。请重试；若持续出现请反馈。'
    }
    setBusy(false)
    setError(message)
    if (message === null) onSuccess()
  }

  const next = async () => {
    if (step === 0) {
      if (granted) {
        setError(null)
        setStep(1)
        return
      }
      if (store.consentReadStatus === 'error') {
        if (store.consentError?.kind === 'forbidden') {
          setError('只有家长可以完成首次引导。请让家长在自己的设备上操作。')
          return
        }
        setBusy(true)
        await store.refreshConsent()
        setBusy(false)
        if (store.consent.status === 'granted') {
          setError(null)
          setStep(1)
        } else {
          setError(
            store.consentError?.userMessage ??
              '还没确认监护人同意状态，请勾选后重试。'
          )
        }
        return
      }
      if (!consentChecked) {
        setError('请先勾选「我是该儿童的监护人，并同意为其创建积分账本」。')
        return
      }
      await run(() => store.submitGrantConsent(), () => setStep(1))
      return
    }

    if (step === 1) {
      const trimmed = name.trim()
      if (trimmed === '') {
        setError('请先填一个昵称（孩子看到的就是这个名字）。')
        return
      }
      if (trimmed.length > 20) {
        setError(`昵称最多 20 个字（现在 ${trimmed.length} 个字）。`)
        return
      }
      if (trimmed === store.profile.name) {
        setError(null)
        setStep(2)
        return
      }
      await run(() => store.submitRenameChild(trimmed), () => setStep(2))
      return
    }

    if (step === 2) {
      if (ageBand === (store.onboarding?.ageBand ?? null)) {
        setError(null)
        setStep(3)
        return
      }
      await run(
        () => store.saveOnboardingDraft({ ageBand }),
        () => setStep(3)
      )
      return
    }

    if (step === 3) {
      const ordered = FOCUS_AREA_OPTIONS.filter((area) => focus.includes(area))
      await run(
        () => store.saveOnboardingDraft({ focusAreas: [...ordered] }),
        () => setStep(4)
      )
      return
    }

    if (step === 4) {
      if (selected.length === 0) {
        setError('至少选一条约定才能继续（之后可以在规则页里增删）。')
        return
      }
      setError(null)
      setStep(5)
      return
    }

    if (step === 5) {
      const trimmedPin = pin.trim()
      // ★ PIN 必填（2026-11-03，`43` §8 D7）：网站码注册拿到的家长权限只有
      //   5 分钟，跳过 PIN 的人窗口一过就回落 `child` —— 那时既进不了家长模式，
      //   也没权限补设（`manage_parent_pin` 对孩子 DENY）。所以这里不再放行空串。
      if (trimmedPin === '') {
        setError(
          '请设置家长 PIN（4–6 位数字）。引导期的家长权限只有 5 分钟，没有 PIN 之后就进不了家长模式。'
        )
        return
      }
      if (!/^\d{4,6}$/.test(trimmedPin)) {
        setError('家长 PIN 必须是 4–6 位数字。')
        return
      }
      const ordered = FOCUS_AREA_OPTIONS.filter((area) => focus.includes(area))
      await run(
        () =>
          store.completeOnboarding({
            templateSlugs: selected,
            ageBand,
            focusAreas: [...ordered],
            parentPin: trimmedPin
          }),
        () => {
          setStep(6)
        }
      )
      return
    }

    // ⑦ 完成：回首页。用 redirectTo，栈里只留一层（与 switchTab 同策略）。
    Taro.redirectTo({ url: TAB_PAGES[0] })
  }

  const toggleSelected = (slug: string) => {
    if (busy) return
    setError(null)
    setSelected((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
        : [...current, slug]
    )
  }

  if (!ready && store.onboarding === null) {
    return (
      <GradientPage>
        <View className='kp-onboarding__loading'>
          <Text className='kp-onboarding__loading-text'>正在读取引导状态…</Text>
        </View>
      </GradientPage>
    )
  }

  return (
    <GradientPage className='kp-onboarding'>
      <ScrollView scrollY className='kp-onboarding__scroll'>
        <View className='kp-onboarding__body'>
          <View className='kp-onboarding__progress'>
            <Text className='kp-onboarding__step-text'>
              {`第 ${step + 1} / 7 步`}
            </Text>
            <View className='kp-onboarding__dots'>
              {[0, 1, 2, 3, 4, 5, 6].map((index) => (
                <View
                  key={index}
                  className={`kp-onboarding__dot ${
                    index <= step ? 'is-active' : ''
                  } ${index === step ? 'is-current' : ''}`}
                />
              ))}
            </View>
          </View>
          <Text className='kp-onboarding__title'>{TITLES[step]}</Text>
          <Text className='kp-onboarding__subtitle'>{SUBTITLES[step]}</Text>

          {error !== null ? (
            <View className='kp-onboarding__error'>
              <Text className='kp-onboarding__error-text'>{error}</Text>
            </View>
          ) : null}

          {step === 0 ? (
            <>
              <AppCard
                color='#fff8e6'
                border={false}
                className='kp-onboarding__welcome'
              >
                <Text className='kp-onboarding__emoji'>🌱</Text>
                <Text className='kp-onboarding__welcome-title'>
                  每天一点小进步
                </Text>
                <Text className='kp-onboarding__welcome-text'>
                  选好约定后，孩子点一下卡片就能加分；攒够积分可以兑换心愿。整个过程大约 1 分钟，之后随时可以改。
                </Text>
              </AppCard>

              {store.consentReadStatus === 'loading' ? (
                <AppCard className='kp-onboarding__gap'>
                  <Text className='kp-onboarding__hint'>
                    正在确认监护人同意状态…
                  </Text>
                </AppCard>
              ) : granted ? (
                <AppCard className='kp-onboarding__gap'>
                  <Text className='kp-onboarding__consent-title'>
                    监护人同意已记录
                  </Text>
                  <Text className='kp-onboarding__hint'>
                    {`协议版本 ${store.consent.consentVersion ?? '—'}`}
                  </Text>
                </AppCard>
              ) : (
                <AppCard className='kp-onboarding__gap'>
                  {withdrawn ? (
                    <Text className='kp-onboarding__warn'>
                      之前撤回过同意。继续前需要重新同意 —— 撤回不会删除已有数据。
                    </Text>
                  ) : null}
                  <View
                    className='kp-onboarding__checkbox-row'
                    onClick={() => {
                      if (busy) return
                      setConsentChecked((value) => !value)
                      setError(null)
                    }}
                  >
                    <View
                      className={`kp-onboarding__checkbox ${
                        consentChecked ? 'is-checked' : ''
                      }`}
                    >
                      {consentChecked ? (
                        <Icon name='check' size={13} color='#ffffff' />
                      ) : null}
                    </View>
                    <Text className='kp-onboarding__checkbox-label'>
                      我是该儿童的监护人，并同意为其创建积分账本
                    </Text>
                  </View>
                </AppCard>
              )}

              <Text className='kp-onboarding__fineprint'>
                继续即表示您已阅读并同意《用户协议》与《儿童个人信息保护规则》。协议文本仍是占位版本，正式上线前会替换并重新征求同意。
              </Text>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <FieldLabel text='孩子昵称' />
              <SoftTextField
                value={name}
                onChange={(value) => {
                  setName(value)
                  if (error !== null) setError(null)
                }}
                hint='例如：小满'
              />
              <Text className='kp-onboarding__hint-block'>
                这个名字会出现在孩子的首页、打卡提示与通知里。之后可以在「我的」里修改。
              </Text>
            </>
          ) : null}


          {step === 2 ? (
            <>
              {AGE_BAND_OPTIONS.map((option) => (
                <AppCard
                  key={option.value}
                  className='kp-onboarding__gap'
                  color={ageBand === option.value ? '#e8f6da' : '#ffffff'}
                  onClick={() => {
                    if (busy) return
                    // 再点一次 = 取消选择（对应 `PATCH profile` 的 `null`）。
                    setAgeBand(ageBand === option.value ? null : option.value)
                    setError(null)
                  }}
                >
                  <View className='kp-onboarding__option'>
                    <View>
                      <Text className='kp-onboarding__option-title'>
                        {option.label}
                      </Text>
                      <Text className='kp-onboarding__hint'>{option.hint}</Text>
                    </View>
                    {ageBand === option.value ? (
                      <Icon name='check' size={18} color='#7fbf55' />
                    ) : null}
                  </View>
                </AppCard>
              ))}
              <Text className='kp-onboarding__hint-block'>
                {ageBand === null
                  ? '可以不选：不选时约定卡片按平台通用顺序排。'
                  : `已选「${ageBandLabel(
                      ageBand
                    )}」——只影响排序，不会隐藏任何约定。`}
              </Text>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <View className='kp-onboarding__chips'>
                {FOCUS_AREA_OPTIONS.map((area) => (
                  <View key={area} className='kp-onboarding__chip'>
                    <SoftChip
                      label={area}
                      selected={focus.includes(area)}
                      onClick={() => {
                        if (busy) return
                        setError(null)
                        setFocus((current) =>
                          current.includes(area)
                            ? current.filter((item) => item !== area)
                            : [...current, area]
                        )
                      }}
                    />
                  </View>
                ))}
              </View>
              <Text className='kp-onboarding__hint-block'>
                {focus.length === 0
                  ? '一个都不选也可以：约定卡片会按学段与平台权重排序。'
                  : `已选 ${focus.length} 项 —— 命中的约定会排在前面（不会隐藏其它的）。`}
              </Text>
            </>
          ) : null}


          {step === 4 ? (
            <>
              {templates.length === 0 ? (
                <AppCard>
                  <Text className='kp-onboarding__hint'>
                    模板库暂时是空的，引导无法继续。请联系管理员补充模板后重试。
                  </Text>
                </AppCard>
              ) : (
                templates.map((template) => {
                  const isSelected = selected.includes(template.slug)
                  return (
                    <AppCard
                      key={template.slug}
                      className='kp-onboarding__gap'
                      color={isSelected ? '#e8f6da' : '#ffffff'}
                      onClick={() => toggleSelected(template.slug)}
                    >
                      <View className='kp-onboarding__template'>
                        <View
                          className='kp-onboarding__template-icon'
                          style={{ backgroundColor: `${template.color}22` }}
                        >
                          <Icon
                            name={
                              isKnownIconName(template.icon)
                                ? template.icon
                                : 'unknown'
                            }
                            size={20}
                            color={template.color}
                          />
                        </View>
                        <View className='kp-onboarding__template-main'>
                          <View className='kp-onboarding__template-head'>
                            <Text className='kp-onboarding__template-title'>
                              {template.title}
                            </Text>
                            <Text
                              className={`kp-onboarding__template-points ${
                                template.isPenalty ? 'is-penalty' : ''
                              }`}
                            >
                              {`${template.isPenalty ? '−' : '+'}${
                                template.points
                              }`}
                            </Text>
                          </View>
                          <Text className='kp-onboarding__hint'>
                            {`${template.condition} · 每天最多 ${template.dailyLimit} 次`}
                          </Text>
                          <Text className='kp-onboarding__hint-faint'>
                            {`${ageBandLabel(template.ageBand)} · ${
                              template.focusAreas.length === 0
                                ? '通用'
                                : template.focusAreas.join(' · ')
                            }`}
                          </Text>
                        </View>
                        <View
                          className={`kp-onboarding__radio ${
                            isSelected ? 'is-selected' : ''
                          }`}
                        />
                      </View>
                    </AppCard>
                  )
                })
              )}
              <Text className='kp-onboarding__hint-block'>
                扣分约定也会被采纳，但不会加入「今天的习惯」—— 它用于家长记录，不是孩子主动打卡的项目。
              </Text>
            </>
          ) : null}

          {step === 5 ? (
            <>
              <FieldLabel text='家长 PIN（4–6 位数字）' />
              <SoftTextField
                value={pin}
                onChange={(value) => {
                  setPin(value.replace(/\D/g, '').slice(0, 6))
                  if (error !== null) setError(null)
                }}
                hint='4–6 位数字'
                digit
              />
              <Text className='kp-onboarding__hint-block'>
                这一步必须设置。切到「家长模式」要用它确认身份；而引导期的家长权限只有 5
                分钟，现在不设，之后再想补就得先退出登录、用手机号/密码重新登录。
              </Text>
            </>
          ) : null}


          {step === 6 ? (
            <>
              <AppCard color='#fff8e6' border={false}>
                <Text className='kp-onboarding__emoji'>🎉</Text>
                <Text className='kp-onboarding__welcome-title'>
                  {store.lastOnboardingResult === null
                    ? '引导已完成'
                    : `已采纳 ${store.lastOnboardingResult.rules.length} 条约定`}
                </Text>
                <Text className='kp-onboarding__welcome-text'>
                  {store.lastOnboardingHabitCount > 0
                    ? `其中 ${store.lastOnboardingHabitCount} 条已加入「今天的习惯」，回到首页点一下就能加分。`
                    : '回到首页即可开始记录；约定已保存到「积分规则」。'}
                </Text>
              </AppCard>

              {store.lastOnboardingResult !== null ? (
                <AppCard className='kp-onboarding__gap'>
                  {store.lastOnboardingResult.rules.map((rule) => (
                    <View key={rule.ruleId} className='kp-onboarding__rule-row'>
                      <Text className='kp-onboarding__rule-title'>
                        {rule.title}
                      </Text>
                      <Text
                        className={`kp-onboarding__template-points ${
                          rule.isPenalty ? 'is-penalty' : ''
                        }`}
                      >
                        {`${rule.isPenalty ? '−' : '+'}${rule.points}`}
                      </Text>
                    </View>
                  ))}
                </AppCard>
              ) : null}

              {store.lastOnboardingManualTitles.length > 0 ? (
                <Text className='kp-onboarding__hint-block'>
                  {`这些约定没有加入「今天的习惯」：${store.lastOnboardingManualTitles.join(
                    '、'
                  )}。扣分约定本来就不该作为孩子的打卡项；其余可在「积分规则」页手动加入。`}
                </Text>
              ) : null}
            </>
          ) : null}
        </View>
      </ScrollView>

      <View className='kp-onboarding__footer'>
        {step > 0 && step < 6 ? (
          <View
            className='kp-onboarding__back'
            onClick={() => {
              if (busy) return
              setError(null)
              setStep((current) => current - 1)
            }}
          >
            <Text className='kp-onboarding__back-text'>上一步</Text>
          </View>
        ) : null}
        <View className='kp-onboarding__primary'>
          <SoftButton
            label={busy ? '正在保存…' : footerLabel}
            enabled={!busy}
            onClick={() => {
              void next()
            }}
          />
        </View>
      </View>
    </GradientPage>
  )
}


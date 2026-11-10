import { Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { useState } from 'react'

import AppBottomNav from '../../components/AppBottomNav'
import AppCard from '../../components/AppCard'
import GradientPage from '../../components/GradientPage'
import Icon from '../../components/Icon'
import type { IconName } from '../../components/Icon/icons'
import ReadStatusBanner from '../../components/ReadStatusBanner'
import AppAccountSheet from '../../sheets/AppAccountSheet'
import ConsentSheet from '../../sheets/ConsentSheet'
import ExportSheet from '../../sheets/ExportSheet'
import FamilyDeletionSheet from '../../sheets/FamilyDeletionSheet'
import InviteSheet from '../../sheets/InviteSheet'
import JoinFamilySheet from '../../sheets/JoinFamilySheet'
import MemberSheet from '../../sheets/MemberSheet'
import MyApplicationsSheet from '../../sheets/MyApplicationsSheet'
import NotificationsSheet from '../../sheets/NotificationsSheet'
import ParentModeSheet from '../../sheets/ParentModeSheet'
import TrashSheet from '../../sheets/TrashSheet'
import { ALLOW_DEMO_RESET, useStore } from '../../data/store'
import { notificationBadgeText } from '../../data/notification'
import { withAlpha } from '../../utils/color'
import { pushPage, switchTab } from '../../utils/nav'
import { prompt, toast, confirm } from '../../utils/toast'
import { useAuthGate } from '../../utils/useAuthGate'
import { useSheet } from '../../utils/useSheet'
import './index.scss'

interface MenuItem {
  icon: IconName
  color: string
  label: string
  url: string
}

/** 两个二级页入口，与 Flutter 的 _MenuRow 一致。 */
const MENU: MenuItem[] = [
  {
    icon: 'book',
    color: '#7fbf55',
    label: '积分记录',
    url: '/pages/record/index'
  },
  {
    icon: 'trophy',
    color: '#f6c64a',
    label: '积分规则',
    url: '/pages/rule/index'
  }
]

/** 战绩卡里的一列：数字 + 说明。 */
function StatColumn({ value, label }: { value: number; label: string }) {
  return (
    <View className='kp-profile__stat'>
      <Text className='kp-profile__stat-value'>{value}</Text>
      <Text className='kp-profile__stat-label'>{label}</Text>
    </View>
  )
}

/** 我的：孩子档案 + 好习惯 / 奖励次数战绩 + 积分记录 / 积分规则入口。 */
export default function Profile() {
  const store = useStore()

  // W9-B：登录闸门（详见 `utils/useAuthGate.ts`）。
  useAuthGate()
  // 修 C9：回收站入口固定在“我的”页（两端同一处）—— 打开的是底部弹窗，
  // 不新增路由，恢复 / 彻底删除各一条路径。
  const trashSheet = useSheet()
  const trashCount = store.trashItems().length
  // W5-H：成员列表 / 改角色 / 移出都由服务端判定；孩子也能看列表
  // （矩阵 `view_members`），写入口按自己那一行的角色隐藏。
  const memberSheet = useSheet()
  // W5-I：邀请码面板自己先确认角色（`invite_member` 仅家长 ALLOW），
  // 所以入口对所有角色可见 —— 孩子点进去看到的是说明，不是 403。
  const inviteSheet = useSheet()
  // P0-3：「加入家庭」与上面那一行方向相反（我输码加入别人家）。
  // 只有真有一个本机会话时才给入口（预览模式点了必然失败，不发那个请求）。
  const joinFamilySheet = useSheet()
  // W8-C：家长模式。矩阵里 `switch_role_mode` 对孩子**也是** ALLOW —— PIN 才是
  // 那道门，所以这一行在孩子设备上同样显示：家长可以把手机接过去自己输 PIN，
  // 不必让孩子「先登出再登录」。
  const parentModeSheet = useSheet()
  // W9-D：App 登录账号（小程序是**唯一**的账号创建入口，App 不开放注册）。
  const appAccountSheet = useSheet()
  // W7-B：监护人同意。入口对所有角色可见 —— 孩子点进去看到的是说明，不是 403。
  const consentSheet = useSheet()
  // W7-C：导出家庭数据。入口同样对所有角色可见（面板自己先确认角色），
  // 孩子点进去看到的是「请让家长操作」，不是 403。
  const exportSheet = useSheet()
  // W7-D：删除家庭数据。入口对所有角色可见（面板自己先确认角色），
  // 孩子点进去看到的是「只有家长可以…」，不是 403。
  const deletionSheet = useSheet()
  // W5-J：我的申请。与家长收件箱分开 —— 这里只看「我提交的」，动作是撤回。
  const myApplicationsSheet = useSheet()
  // W5-L：站内通知中心。未读数由服务端下发的整份 `unreadCount` 决定；
  // 只有进入「我的」页时才单独查一次（`limit=1`），不拖慢首页刷新。
  const notificationSheet = useSheet()
  const unreadNotifications = store.unreadNotificationCount
  const badgeText = notificationBadgeText(unreadNotifications)

  /**
   * 从二级页（审批详情）返回时递增：`MyApplicationsSheet` 的 items 是打开时
   * 那一份，详情里撤回过就必须重拉，否则会留一行已经不能撤回的「撤回」。
   */
  const [returnTick, setReturnTick] = useState(0)

  useDidShow(() => {
    // 与 Flutter `home_shell` 切到「我的」tab 时同义：只换红点，不动列表。
    // 预览模式 / 未配置后端时 store 内部直接返回（不发一次注定 401 的请求）。
    void store.refreshUnreadNotificationCount()
    setReturnTick((tick) => tick + 1)
  })

  const handleRename = async () => {
    // 只读拦截交给 store（`submitRenameChild` 三种世界各自给结论），
    // 页面不再自己判 `isReadOnly` —— 昵称在 live 模式下已经能真写。
    const name = await prompt('修改昵称', store.profile.name, '输入新的昵称')
    if (name === null) return
    // 刻意**不**在本地截断、也不判长度：16 个字符按 code point 算，判定只留
    // 一份在服务端；`slice(0, 16)` 还会静默改写用户输入（看着存上了，其实不是他写的）。
    // 超长时服务端回 400 `CHILD_NAME_TOO_LONG`，store 翻成中文提示。
    const message = await store.submitRenameChild(name)
    toast(message ?? '昵称已更新')
  }

  const handleCopyId = () => {
    // 复制孩子 ID 后用轻提示回执（和 Flutter 的 SnackBar 一致）
    void Taro.setClipboardData({ data: store.profile.childId }).then(() =>
      toast('已复制孩子 ID')
    )
  }

  /**
   * 打开首启引导（W8-B）。
   *
   * `needsOnboarding` ⇒ 进引导页；否则只重拉一次状态并把结论说出来
   * （「不知道」不等于「未引导」，不能贸然把人推进一个 409 的流程）。
   */
  const handleOnboarding = async () => {
    if (!store.needsOnboarding) {
      await store.refreshOnboarding()
      toast(
        store.onboardingError ??
          (store.needsOnboarding
            ? '引导还没完成，可以点「继续首次引导」。'
            : '引导状态已更新。')
      )
      return
    }
    void Taro.navigateTo({ url: '/pages/onboarding/index' })
  }


  /**
   * 退出登录（W9-B）。
   *
   * 顺序是「先问服务端再清本地」：`logout()` 会 `POST /auth/logout` 撤销 token，
   * 即使这一步失败，本地也照样清空（`store.logout()` 内部保证），返回的文案
   * 只是「服务端没确认撤销」的提醒 —— 不能因为网络问题就让人登不出去。
   */
  const handleLogout = async () => {
    const ok = await confirm(
      '退出后需要重新微信登录才能看到积分数据。',
      '退出登录',
      '退出'
    )
    if (!ok) return
    const message = await store.logout()
    toast(message ?? '已退出登录')
  }

  const handleReset = () => {
    if (store.isReadOnly) {
      toast(store.readOnlyWriteMessage)
      return
    }
    // 修 E18：生产环境禁止恢复演示数据（否则用户可一键清空真实数据）
    if (!store.resetToSeed()) {
      toast('正式环境不支持恢复演示数据')
      return
    }
    toast('已恢复演示数据')
  }

  return (
    <GradientPage
      safeBottom
      footer={
        <AppBottomNav
          currentIndex={3}
          onChanged={(index) => switchTab(index, 2)}
        />
      }
    >
      <View className='kp-profile'>
        <ReadStatusBanner />
        <View className='kp-profile__head'>
          <View
            className='kp-profile__avatar'
            onClick={() => {
              void handleRename()
            }}
          >
            <Text className='kp-profile__avatar-emoji'>🧒</Text>
          </View>
          <View className='kp-profile__info'>
            <Text className='kp-profile__name'>{store.profile.name}</Text>
            <View className='kp-profile__id' onClick={handleCopyId}>
              <Text className='kp-profile__id-text'>
                {`ID:${store.profile.childId}`}
              </Text>
              <View className='kp-profile__id-icon'>
                <Icon name='copy' size={13} color='#b6bdb0' />
              </View>
            </View>
          </View>
        </View>

        <View className='kp-profile__stats'>
          <AppCard radius={20} padding={[0, 18]}>
            <View className='kp-profile__stat-row'>
              <StatColumn value={store.profile.goodHabitCount} label='好习惯' />
              <View className='kp-profile__stat-divider' />
              <StatColumn value={store.profile.rewardCount} label='奖励次数' />
            </View>
          </AppCard>
        </View>

        <View className='kp-profile__menu-card'>
          <AppCard radius={20} paddingLtrb={[0, 0, 0, 0]}>
            {MENU.map((item, index) => (
              <View key={item.label}>
                {index > 0 ? <View className='kp-profile__menu-divider' /> : null}
                <View
                  className='kp-profile__menu'
                  onClick={() => pushPage(item.url)}
                >
                  <View
                    className='kp-profile__menu-icon'
                    style={{ backgroundColor: withAlpha(item.color, 34 / 255) }}
                  >
                    <Icon name={item.icon} size={19} color={item.color} />
                  </View>
                  <Text className='kp-profile__menu-label'>{item.label}</Text>
                  <Icon name='chevronRight' size={22} color='#b6bdb0' />
                </View>
              </View>
            ))}
            <View className='kp-profile__menu-divider' />
            <View
              className='kp-profile__menu'
              onClick={() => myApplicationsSheet.show()}
            >
              <View
                className='kp-profile__menu-icon'
                style={{ backgroundColor: withAlpha('#7f9bd8', 34 / 255) }}
              >
                <Icon name='clipboard' size={19} color='#7f9bd8' />
              </View>
              <Text className='kp-profile__menu-label'>我的申请</Text>
              <Icon name='chevronRight' size={22} color='#b6bdb0' />
            </View>
            <View className='kp-profile__menu-divider' />
            <View
              className='kp-profile__menu'
              onClick={() => notificationSheet.show()}
            >
              <View
                className='kp-profile__menu-icon'
                style={{ backgroundColor: withAlpha('#f6c64a', 34 / 255) }}
              >
                {/* 图标名集合是跨端契约（三份逐字相等），没有 bell；
                    `stories` 是最贴近「消息 / 动态」的既有图案。 */}
                <Icon name='stories' size={19} color='#f6c64a' />
              </View>
              <Text className='kp-profile__menu-label'>消息</Text>
              {badgeText === '' ? null : (
                <View className='kp-profile__badge'>
                  <Text className='kp-profile__badge-text'>{badgeText}</Text>
                </View>
              )}
              <Icon name='chevronRight' size={22} color='#b6bdb0' />
            </View>
            <View className='kp-profile__menu-divider' />
            <View
              className='kp-profile__menu'
              onClick={() => memberSheet.show()}
            >
              <View
                className='kp-profile__menu-icon'
                style={{ backgroundColor: withAlpha('#7fbf55', 34 / 255) }}
              >
                <Icon name='smile' size={19} color='#7fbf55' />
              </View>
              <Text className='kp-profile__menu-label'>家庭成员</Text>
              <Icon name='chevronRight' size={22} color='#b6bdb0' />
            </View>
            <View className='kp-profile__menu-divider' />
            <View
              className='kp-profile__menu'
              onClick={() => inviteSheet.show()}
            >
              <View
                className='kp-profile__menu-icon'
                style={{ backgroundColor: withAlpha('#f6c64a', 34 / 255) }}
              >
                <Icon name='gift' size={19} color='#f6c64a' />
              </View>
              <Text className='kp-profile__menu-label'>邀请码</Text>
              <Icon name='chevronRight' size={22} color='#b6bdb0' />
            </View>
            <View className='kp-profile__menu-divider' />
            {/* P0-3：加入家庭（`POST /invites/accept`）。与「邀请码」相反：
                那一行发码，这一行收码。只在真的登录且有本机会话时渲染 ——
                预览模式 / 未登录时点开只会得到一句「还没登录」。 */}
            {store.isAuthenticated ? (
              <>
                <View
                  className='kp-profile__menu'
                  onClick={() => joinFamilySheet.show()}
                >
                  <View
                    className='kp-profile__menu-icon'
                    style={{ backgroundColor: withAlpha('#62c1b8', 34 / 255) }}
                  >
                    <Icon name='plus' size={19} color='#62c1b8' />
                  </View>
                  <Text className='kp-profile__menu-label'>加入家庭</Text>
                  <Icon name='chevronRight' size={22} color='#b6bdb0' />
                </View>
                <View className='kp-profile__menu-divider' />
              </>
            ) : null}
            {/* W8-C：家长模式（PIN 换 5 分钟家长权限）。矩阵里 `switch_role_mode`
                对孩子**也是** ALLOW —— PIN 才是那道门，所以孩子设备上同样显示。
                `hasParentMode` 为假（预览模式 / 未配后端）时整行不渲染：点开只会
                看到一句「没接后端」，不如不给入口。 */}
            {store.hasParentMode ? (
              <>
                <View
                  className='kp-profile__menu'
                  onClick={() => parentModeSheet.show()}
                >
                  <View
                    className='kp-profile__menu-icon'
                    style={{ backgroundColor: withAlpha('#6aa84f', 34 / 255) }}
                  >
                    <Icon name='check' size={19} color='#6aa84f' />
                  </View>
                  <Text className='kp-profile__menu-label'>
                    {store.isParentMode ? '家长模式 · 已开启' : '家长模式'}
                  </Text>
                  <Icon name='chevronRight' size={22} color='#b6bdb0' />
                </View>
                <View className='kp-profile__menu-divider' />
              </>
            ) : null}
            {/* W8-B：引导入口。闸门在「状态未知」时放行进首页（断网 / 403），
                这里必须留一个可重试的入口；`onboarded=false` 时是「继续首次引导」。 */}
            {store.hasOnboarding &&
            (store.needsOnboarding || store.onboardingError !== null) ? (
              <>
                <View
                  className='kp-profile__menu'
                  onClick={() => handleOnboarding()}
                >
                  <View
                    className='kp-profile__menu-icon'
                    style={{ backgroundColor: withAlpha('#7fbf55', 34 / 255) }}
                  >
                    <Icon name='star' size={19} color='#7fbf55' />
                  </View>
                  <Text className='kp-profile__menu-label'>
                    {store.needsOnboarding ? '继续首次引导' : '重试读取引导状态'}
                  </Text>
                  <Icon name='chevronRight' size={22} color='#b6bdb0' />
                </View>
                <View className='kp-profile__menu-divider' />
              </>
            ) : null}
            {/* W9-D：App 登录账号。App 首版**不开放注册**，所以这一行是
                "手机能登 App"的唯一入口 —— 它不像「家长模式」那样按后端配置
                隐藏：藏起来会让"App 登不上"变成一条没有任何线索的死路。
                没接后端时点进来会看到一句「预览模式没有真实的账号体系」。 */}
            <View
              className='kp-profile__menu'
              onClick={() => appAccountSheet.show()}
            >
              <View
                className='kp-profile__menu-icon'
                style={{ backgroundColor: withAlpha('#7f9bd8', 34 / 255) }}
              >
                {/* 图标名集合是跨端契约（三份逐字相等），没有 lock / key；
                    `listCheck` 是最贴近「逐条确认过的凭据」的既有图案。 */}
                <Icon name='listCheck' size={19} color='#7f9bd8' />
              </View>
              <Text className='kp-profile__menu-label'>App 登录账号</Text>
              <Icon name='chevronRight' size={22} color='#b6bdb0' />
            </View>
            <View className='kp-profile__menu-divider' />
            {/* W7-B：监护人同意（先确认角色，再拉 `GET /consent`） */}
            <View
              className='kp-profile__menu'
              onClick={() => consentSheet.show()}
            >
              <View
                className='kp-profile__menu-icon'
                style={{ backgroundColor: withAlpha('#6aa84f', 34 / 255) }}
              >
                <Icon name='check' size={19} color='#6aa84f' />
              </View>
              <Text className='kp-profile__menu-label'>监护人同意</Text>
              <Icon name='chevronRight' size={22} color='#b6bdb0' />
            </View>
            <View className='kp-profile__menu-divider' />
            {/* W7-C：家庭数据导出（可携带权，04 §5）。矩阵里
                `export_family_data` 仅家长 ALLOW —— 面板内部先确认角色，
                孩子点进来只看到「找家长」说明。它与「监护人同意」是两件事：
                导出不受同意状态限制，撤回同意后仍然可用。 */}
            <View
              className='kp-profile__menu'
              onClick={() => exportSheet.show()}
            >
              <View
                className='kp-profile__menu-icon'
                style={{ backgroundColor: withAlpha('#7fbf55', 34 / 255) }}
              >
                <Icon name='copy' size={19} color='#7fbf55' />
              </View>
              <Text className='kp-profile__menu-label'>导出家庭数据</Text>
              <Icon name='chevronRight' size={22} color='#b6bdb0' />
            </View>
            <View className='kp-profile__menu-divider' />
            {/* W7-D：家庭数据删除（可删除权，02 §9.20）。 */}
            <View
              className='kp-profile__menu'
              onClick={() => deletionSheet.show()}
            >
              <View
                className='kp-profile__menu-icon'
                style={{ backgroundColor: withAlpha('#d9534f', 34 / 255) }}
              >
                <Icon name='trash' size={19} color='#d9534f' />
              </View>
              <Text className='kp-profile__menu-label'>删除家庭数据</Text>
              <Icon name='chevronRight' size={22} color='#b6bdb0' />
            </View>
            <View className='kp-profile__menu-divider' />
            <View
              className='kp-profile__menu'
              onClick={() => {
                if (store.isReadOnly) {
                  toast(store.readOnlyWriteMessage)
                  return
                }
                trashSheet.show()
              }}
            >
              <View
                className='kp-profile__menu-icon'
                style={{ backgroundColor: withAlpha('#e9834b', 34 / 255) }}
              >
                <Icon name='trash' size={19} color='#e9834b' />
              </View>
              <Text className='kp-profile__menu-label'>
                {trashCount > 0 ? `回收站（${trashCount}）` : '回收站'}
              </Text>
              <Icon name='chevronRight' size={22} color='#b6bdb0' />
            </View>
            {/* W9-B：退出登录。只在真的有会话时出现 —— 预览模式没有 token，
                「退出」无从谈起；`.kp-profile__menu-divider` 必须留在卡片内。 */}
            {store.isAuthenticated ? (
              <>
                <View className='kp-profile__menu-divider' />
                <View className='kp-profile__menu' onClick={handleLogout}>
                  <View
                    className='kp-profile__menu-icon'
                    style={{ backgroundColor: withAlpha('#d9534f', 34 / 255) }}
                  >
                    <Icon name='close' size={19} color='#d9534f' />
                  </View>
                  <Text className='kp-profile__menu-label'>退出登录</Text>
                  <Text className='kp-profile__menu-account'>
                    {store.accountLabel}
                  </Text>
                  <Icon name='chevronRight' size={22} color='#b6bdb0' />
                </View>
              </>
            ) : null}
          </AppCard>
        </View>

        {/* 修 E18：生产构建下整个入口不渲染，避免暴露“清空真实数据”的能力 */}
        {ALLOW_DEMO_RESET ? (
          <View className='kp-profile__reset' onClick={handleReset}>
            <Text className='kp-profile__reset-text'>恢复演示数据</Text>
          </View>
        ) : null}

        <View className='kp-profile__gap' />
        <View className='kp-nav-space' />

        {/* 修 C9：回收站弹窗（SheetFrame 本身就是覆盖层，挂在页面根节点内即可） */}
        {trashSheet.open ? (
          <TrashSheet visible={trashSheet.visible} onClose={trashSheet.hide} />
        ) : null}
        {/* W5-L：站内通知弹窗（打开时才拉 `GET /notifications`）。
            ★ 顺序有意义：两个弹窗都是 `z-index: 900` 的 fixed 层，DOM 靠后的在上。
              通知面板排在「我的申请」**之前**，从消息里「查看申请」打开申请面板时
              才能盖住它；关掉申请面板就回到消息列表。 */}
        {notificationSheet.open ? (
          <NotificationsSheet
            visible={notificationSheet.visible}
            onClose={notificationSheet.hide}
          />
        ) : null}
        {/* W5-J：我的申请弹窗（打开时才拉 `GET /approvals/mine`） */}
        {myApplicationsSheet.open ? (
          <MyApplicationsSheet
            visible={myApplicationsSheet.visible}
            onClose={myApplicationsSheet.hide}
            refreshToken={returnTick}
          />
        ) : null}
        {/* W5-H：成员弹窗（打开时才拉 `GET /members`） */}
        {memberSheet.open ? (
          <MemberSheet
            visible={memberSheet.visible}
            onClose={memberSheet.hide}
          />
        ) : null}
        {/* W5-I：邀请码弹窗（先确认角色，再拉 `GET /invites`） */}
        {inviteSheet.open ? (
          <InviteSheet
            visible={inviteSheet.visible}
            onClose={inviteSheet.hide}
          />
        ) : null}
        {/* P0-3：加入家庭弹窗（本地先判形状，服务端原文显示在面板内） */}
        {joinFamilySheet.open ? (
          <JoinFamilySheet
            visible={joinFamilySheet.visible}
            onClose={joinFamilySheet.hide}
          />
        ) : null}
        {/* W8-C：家长模式弹窗。打开时才拉 `GET /auth/parent-mode`；
            明文 PIN 只活在这个组件的 state 里，关闭即卸载。 */}
        {parentModeSheet.open ? (
          <ParentModeSheet
            visible={parentModeSheet.visible}
            onClose={parentModeSheet.hide}
          />
        ) : null}
        {/* W9-D：App 登录账号弹窗（打开时才拉 `GET /auth/account`）。
            ★ 明文密码只活在这个组件里：`open` 为假即卸载 ⇒ 输入框内容随之消失。 */}
        {appAccountSheet.open ? (
          <AppAccountSheet
            visible={appAccountSheet.visible}
            onClose={appAccountSheet.hide}
          />
        ) : null}
        {/* W7-B：监护人同意弹窗（先确认角色，再拉 `GET /consent`） */}
        {consentSheet.open ? (
          <ConsentSheet
            visible={consentSheet.visible}
            onClose={consentSheet.hide}
          />
        ) : null}
        {/* W7-C：导出家庭数据弹窗（先确认角色，再拉 `GET /export`） */}
        {exportSheet.open ? (
          <ExportSheet
            visible={exportSheet.visible}
            onClose={exportSheet.hide}
          />
        ) : null}
        {/* W7-D：删除家庭数据弹窗（先确认角色，再拉 `GET /family-deletion`） */}
        {deletionSheet.open ? (
          <FamilyDeletionSheet
            visible={deletionSheet.visible}
            onClose={deletionSheet.hide}
          />
        ) : null}
      </View>
    </GradientPage>
  )
}

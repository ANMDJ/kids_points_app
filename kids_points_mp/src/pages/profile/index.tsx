import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'

import AppBottomNav from '../../components/AppBottomNav'
import AppCard from '../../components/AppCard'
import GradientPage from '../../components/GradientPage'
import Icon from '../../components/Icon'
import type { IconName } from '../../components/Icon/icons'
import ReadStatusBanner from '../../components/ReadStatusBanner'
import TrashSheet from '../../sheets/TrashSheet'
import { ALLOW_DEMO_RESET, useStore } from '../../data/store'
import { withAlpha } from '../../utils/color'
import { pushPage, switchTab } from '../../utils/nav'
import { prompt, toast } from '../../utils/toast'
import { useSheet } from '../../utils/useSheet'
import './index.scss'

/** 昵称最长 16 个字符（对应 Flutter TextField 的 maxLength）。 */
const NAME_MAX_LENGTH = 16

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
  // 修 C9：回收站入口固定在“我的”页（两端同一处）—— 打开的是底部弹窗，
  // 不新增路由，恢复 / 彻底删除各一条路径。
  const trashSheet = useSheet()
  const trashCount = store.trashItems().length

  const handleRename = async () => {
    if (store.isReadOnly) {
      toast(store.readOnlyWriteMessage)
      return
    }
    const name = await prompt('修改昵称', store.profile.name, '输入新的昵称')
    if (name === null) return
    const trimmed = name.trim()
    if (!trimmed) return
    store.renameChild(trimmed.slice(0, NAME_MAX_LENGTH))
  }

  const handleCopyId = () => {
    // 复制孩子 ID 后用轻提示回执（和 Flutter 的 SnackBar 一致）
    void Taro.setClipboardData({ data: store.profile.childId }).then(() =>
      toast('已复制孩子 ID')
    )
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
          currentIndex={2}
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
      </View>
    </GradientPage>
  )
}

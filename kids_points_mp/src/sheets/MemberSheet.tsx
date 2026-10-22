import { Text, View } from '@tarojs/components'
import { useEffect, useState } from 'react'

import SheetFrame from '../components/SheetFrame'
import { useStore } from '../data/store'
import type { FamilyMember } from '../data/types'
import {
  memberJoinedText,
  memberNameOf,
  memberRoleLabelOf,
  switchableMemberRoleLabel
} from '../data/types'
import { confirm, toast } from '../utils/toast'
import './sheets.scss'

export interface MemberSheetProps {
  visible: boolean
  onClose: () => void
}

/**
 * 家庭成员（W5-H）：谁在这个家庭里、各自是什么角色。
 *
 * 服务端只下发**事实**（`role` / `status` / `isSelf`），本组件据
 * `store.canManageMembers`（= 自己那一行是不是家长）决定给不给按钮；
 * 真正的拒绝（403 / 409）由 store 原样上报，这里只负责展示原因。
 *
 * 自己的那一行**永远没有**写按钮：后端两条路由都禁止作用于自己 ——
 * 自我降级会把自己锁在门外，而「移出自己」等于退出家庭。
 */
export default function MemberSheet({ visible, onClose }: MemberSheetProps) {
  const store = useStore()
  /** 有读请求（首次拉取 / 重试）在途；写请求的忙碌状态由 `store.busyMemberId`
   *  表达（逐行禁用，而不是整块灰掉）。 */
  const [busy, setBusy] = useState(false)

  const members = store.members
  const canManage = store.canManageMembers
  const loadError = store.memberError

  useEffect(() => {
    if (!visible) return
    // 打开弹窗才拉（低频页面不该让每次首页刷新都多付一次往返）。
    // 失败**不弹窗**：错误留在 `store.memberError` 里，由下面照实展示 ——
    // 403 / 断网都不能被画成「没有成员」。
    setBusy(true)
    void store.refreshMembers().then(() => setBusy(false))
  }, [visible, store])

  /** 切换角色前先确认：两个方向都会改变**权限**（家长 ⇄ 孩子），
   *  点错一下不该悄悄生效。真正的判定仍由服务端做出。 */
  const handleChangeRole = async (member: FamilyMember) => {
    if (store.isMemberWriteReadOnly) {
      toast(store.memberReadOnlyWriteMessage)
      return
    }
    const label = switchableMemberRoleLabel(member.role)
    if (label === null) return
    const ok = await confirm(
      `确定把“${memberNameOf(member.displayName)}”${label}吗？` +
        '角色决定谁可以修改规则、批准申请和管理成员。',
      '确认调整角色',
      label,
      '取消'
    )
    if (!ok) return
    const message = await store.submitChangeMemberRole(member)
    toast(message ?? '角色已更新')
  }

  const handleRemove = async (member: FamilyMember) => {
    if (store.isMemberWriteReadOnly) {
      toast(store.memberReadOnlyWriteMessage)
      return
    }
    const ok = await confirm(
      `确定把“${memberNameOf(member.displayName)}”移出家庭吗？` +
        '移出后 TA 将无法再访问这个家庭的数据。',
      '移出成员',
      '移出',
      '取消'
    )
    if (!ok) return
    const message = await store.submitRemoveMember(member)
    toast(message ?? `已移出“${memberNameOf(member.displayName)}”`)
  }

  const handleReload = () => {
    if (busy) return
    setBusy(true)
    void store.refreshMembers().then(() => setBusy(false))
  }

  const emptyText = (): string => {
    if (loadError !== null) return '成员列表没能加载'
    if (store.memberStatus === 'loading') return '正在加载成员…'
    if (!store.isLiveMode) return '预览模式没有家庭成员信息'
    return '成员列表是空的'
  }

  return (
    <SheetFrame
      visible={visible}
      title='家庭成员'
      subtitle={
        canManage
          ? '你是家长，可以调整成员角色或把成员移出家庭'
          : '你是成员，只有家长可以调整角色或移出成员'
      }
      onClose={onClose}
    >
      {/* 顶部状态行：加载中 / 加载失败（失败时**保留**上一次成功的列表） */}
      {store.memberStatus === 'loading' && members.length === 0 ? (
        <View className='kp-member__status'>
          <Text className='kp-member__status-text'>正在加载成员…</Text>
        </View>
      ) : null}
      {loadError !== null ? (
        <View className='kp-member__status-row'>
          <Text className='kp-member__error-text'>
            {`成员加载失败：${loadError.userMessage}`}
          </Text>
          <View className='kp-member__chip' onClick={handleReload}>
            <Text className='kp-member__chip-text'>重试</Text>
          </View>
        </View>
      ) : null}

      {members.length === 0 ? (
        <View className='kp-member__empty'>
          <Text className='kp-member__empty-text'>{emptyText()}</Text>
        </View>
      ) : (
        <View className='kp-member__list'>
          {members.map((member) => {
            const rowBusy = store.busyMemberId === member.memberId
            const switchLabel = switchableMemberRoleLabel(member.role)
            const canManageThis = canManage && !member.isSelf
            return (
              <View className='kp-member__row' key={member.memberId}>
                <View className='kp-member__head'>
                  <Text className='kp-member__name kp-ellipsis'>
                    {memberNameOf(member.displayName)}
                  </Text>
                  {member.isSelf ? (
                    <View className='kp-member__pill is-self'>
                      <Text className='kp-member__pill-text is-self'>你</Text>
                    </View>
                  ) : null}
                  <View className='kp-member__pill'>
                    <Text className='kp-member__pill-text'>
                      {memberRoleLabelOf(member.role)}
                    </Text>
                  </View>
                </View>
                <Text className='kp-member__meta'>
                  {memberJoinedText(member.joinedAt)}
                </Text>
                {canManageThis && switchLabel !== null ? (
                  <View className='kp-member__actions'>
                    <View
                      className={`kp-member__chip ${
                        rowBusy ? 'is-disabled' : ''
                      }`}
                      onClick={() => {
                        if (rowBusy) return
                        void handleChangeRole(member)
                      }}
                    >
                      <Text className='kp-member__chip-text'>{switchLabel}</Text>
                    </View>
                    <View
                      className={`kp-member__chip is-danger ${
                        rowBusy ? 'is-disabled' : ''
                      }`}
                      onClick={() => {
                        if (rowBusy) return
                        void handleRemove(member)
                      }}
                    >
                      <Text className='kp-member__chip-text is-danger'>
                        {rowBusy ? '处理中…' : '移出'}
                      </Text>
                    </View>
                  </View>
                ) : null}
              </View>
            )
          })}
        </View>
      )}
    </SheetFrame>
  )
}

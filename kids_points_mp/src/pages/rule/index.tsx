import { ScrollView, Text, View } from '@tarojs/components'

import GradientPage from '../../components/GradientPage'
import PageHeader from '../../components/PageHeader'
import RuleTile from '../../components/RuleTile'
import SoftButton from '../../components/SoftButton'
import AddRuleSheet from '../../sheets/AddRuleSheet'
import RuleActionsSheet from '../../sheets/RuleActionsSheet'
import { useStore } from '../../data/store'
import type { PointRule } from '../../data/types'
import { useViewport } from '../../utils/layout'
import { goBack } from '../../utils/nav'
import { toast } from '../../utils/toast'
import { usePayloadSheet, useSheet } from '../../utils/useSheet'
import './index.scss'

/** 积分规则：家庭约定清单 + 新增规则；点 / 长按某条规则可加入习惯或删除。 */
export default function Rule() {
  const store = useStore()
  const viewport = useViewport()
  const addSheet = useSheet()
  const actions = usePayloadSheet<PointRule>()
  // 修 C10：编辑规则复用同一张表单（编辑态）—— 与新增共用一个组件，
  // 页面不做版本运算（currentVersion 由 store 递增）。
  const editSheet = usePayloadSheet<PointRule>()

  // live 模式没有规则写端点：编辑 / 新建都会骗用户「改了」，所以入口先拦。
  const guardReadOnly = (): boolean => {
    if (!store.isReadOnly) return false
    toast(store.readOnlyWriteMessage)
    return true
  }

  const openRuleActions = (rule: PointRule) => {
    if (guardReadOnly()) return
    actions.show(rule)
  }

  return (
    <>
      <GradientPage safeTop={false}>
        <View
          className='kp-rule'
          style={{
            height: `${viewport.height - viewport.safeTop}px`,
            paddingTop: `${viewport.safeTop}px`,
            paddingBottom: `${viewport.safeBottom}px`
          }}
        >
          <PageHeader title='积分规则' onBack={goBack} />
          <View className='kp-rule__hint'>
            <Text className='kp-rule__hint-text'>
              长按规则可编辑、加入今天的习惯，也可以移到回收站
            </Text>
          </View>
          {store.rules.length === 0 ? (
            <View className='kp-rule__empty'>
              <Text className='kp-rule__empty-text'>
                还没有规则，点下方按钮新增吧
              </Text>
            </View>
          ) : (
            <ScrollView
              className='kp-rule__list'
              scrollY
              enhanced
              showScrollbar={false}
            >
              <View className='kp-rule__list-content'>
                {store.rules.map((rule) => (
                  <RuleTile
                    key={rule.id}
                    rule={rule}
                    onClick={() => openRuleActions(rule)}
                    onLongPress={() => openRuleActions(rule)}
                  />
                ))}
              </View>
            </ScrollView>
          )}
          <View className='kp-rule__footer'>
            <SoftButton
              label='新增规则'
              icon='book'
              onClick={() => {
                if (guardReadOnly()) return
                addSheet.show()
              }}
            />
          </View>
        </View>
      </GradientPage>
      {addSheet.open ? (
        <AddRuleSheet visible={addSheet.visible} onClose={addSheet.hide} />
      ) : null}
      {actions.open ? (
        <RuleActionsSheet
          visible={actions.visible}
          rule={actions.data}
          onEdit={() => {
            // 先收起操作菜单，再打开编辑态表单（两个弹窗不叠在一起）
            const target = actions.data
            actions.hide()
            if (target) editSheet.show(target)
          }}
          onClose={actions.hide}
        />
      ) : null}
      {editSheet.open && editSheet.data ? (
        <AddRuleSheet
          visible={editSheet.visible}
          rule={editSheet.data}
          onClose={editSheet.hide}
        />
      ) : null}
    </>
  )
}

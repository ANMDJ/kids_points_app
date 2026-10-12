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
import { usePayloadSheet, useSheet } from '../../utils/useSheet'
import './index.scss'

/** 积分规则：家庭约定清单 + 新增规则；点 / 长按某条规则可加入习惯或删除。 */
export default function Rule() {
  const store = useStore()
  const viewport = useViewport()
  const addSheet = useSheet()
  const actions = usePayloadSheet<PointRule>()

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
              长按规则可加入今天的习惯，也可以删除
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
                    onClick={() => actions.show(rule)}
                    onLongPress={() => actions.show(rule)}
                  />
                ))}
              </View>
            </ScrollView>
          )}
          <View className='kp-rule__footer'>
            <SoftButton
              label='新增规则'
              icon='book'
              onClick={() => addSheet.show()}
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
          onClose={actions.hide}
        />
      ) : null}
    </>
  )
}

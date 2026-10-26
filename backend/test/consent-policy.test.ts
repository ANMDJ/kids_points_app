/**
 * consent-policy.test.ts —— 「撤回同意后写入停止」的**分类完整性**（W7-A，2026-10-26）
 *
 * ── 这个文件在防什么 ────────────────────────────────────────────────────────
 *   `ConsentGuard` 只做一件事：拿动作去问 `isConsentGatedAction()`。
 *   于是整条合规链的**唯一弱点**变成了「分类表漏了一个动作」——
 *   漏掉的那一个写端点会**完全正常地工作**（HTTP 200、数据照写），
 *   没有任何状态码、日志或类型错误会提示它绕过了闸门。
 *   这类缺口在代码评审里也看不见：新增动作的人不会去读 `consent-policy.ts`。
 *
 *   因此这里钉的是**划分的完整性**，不是某几个动作的具体取值：
 *     · 每个矩阵动作必须**恰好**落在「写」或「豁免」一侧（`unclassified` 为空）；
 *     · 不许两侧都落（`double` 为空 —— 否则 Set 会让\"写\"静默胜出）；
 *     · 分类里不许出现矩阵没有的动作（拼错等于把某条真动作漏在分类外）。
 *   矩阵扩容却忘了分类 ⇒ **本文件先红**，而不是等合规审计发现。
 *
 * ── 与 permission-matrix.test.ts 的分工 ─────────────────────────────────────
 *   那边的唯一事实源是「谁准不准做」（屏障二）；这里的是「现在能不能做」（屏障四）。
 *   两者都从 `ALL_ACTIONS` 推导，不存在第二份动作清单。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CONSENT_EXEMPT_ACTIONS,
  CONSENT_GATED_ACTIONS,
  doubleClassifiedActions,
  isConsentGatedAction,
  unclassifiedActions,
  unknownClassifiedActions
} from '../src/contracts/consent-policy'
import { ALL_ACTIONS, PERMISSION_MATRIX, type ActionType } from '../src/contracts/permission-matrix'

test('划分完整性：每个矩阵动作**恰好**落在写侧或豁免侧（这是本文件存在的理由）', () => {
  // 新增一个矩阵动作却没分类 ⇒ 这里点名。
  assert.deepEqual(
    unclassifiedActions(),
    [],
    '有动作没有被分类 —— 请到 contracts/consent-policy.ts 明确它属于写（撤回后停）还是豁免'
  )
  assert.deepEqual(
    doubleClassifiedActions(),
    [],
    '同一个动作同时出现在写侧与豁免侧 —— 两个 Set 会让"写"静默胜出，等于豁免没写'
  )
  assert.deepEqual(unknownClassifiedActions(), [], '分类表里出现了矩阵没有的动作（拼错 / 动作被删）')
})

test('规模：37 个动作 = 24 写 + 13 豁免（数字变了必须同时改 PRD 与用例）', () => {
  assert.equal(ALL_ACTIONS.length, 37)
  assert.equal(CONSENT_GATED_ACTIONS.length, 24)
  assert.equal(CONSENT_EXEMPT_ACTIONS.length, 13)
  assert.equal(
    CONSENT_GATED_ACTIONS.length + CONSENT_EXEMPT_ACTIONS.length,
    ALL_ACTIONS.length,
    '两侧加起来不等于矩阵规模 —— 有动作重复或被漏掉'
  )
})

test('「写侧」是穷举而不是推理：每个动作的判定与清单逐项一致', () => {
  // 反向自证：`isConsentGatedAction` 不允许有「清单之外的判断」。
  for (const action of ALL_ACTIONS) {
    const inList = (CONSENT_GATED_ACTIONS as readonly ActionType[]).includes(action)
    assert.equal(
      isConsentGatedAction(action),
      inList,
      `${action}：清单说 ${inList ? '写' : '豁免'}，函数却回了 ${!inList ? '写' : '豁免'}`
    )
  }
})

test('fail-closed：未知动作按「写」处理，不按「读」放行', () => {
  // 与 `resolveVerdict()` 对未知动作返回 DENY 同一个方向。
  // 若这里改成 false，未来某个新动作在本表漏登记时会**静默绕过闸门**。
  assert.equal(isConsentGatedAction('not_in_matrix' as ActionType), true)
  assert.equal(isConsentGatedAction(undefined as unknown as ActionType), true)
})

test('★ 撤回后必须还能恢复：`view_consent` / `manage_consent` 豁免（否则是死状态）', () => {
  // 合规要求的「可撤回」必须同时意味着「可再次授予」。
  // 把这两个动作归到写侧 = 撤回之后连"重新同意"都写不进去 —— 用户被永久锁死。
  assert.equal(isConsentGatedAction('view_consent'), false)
  assert.equal(isConsentGatedAction('manage_consent'), false)
  // 但**只有家长**能行使（屏障二仍然是 DENY，见 permission-matrix.test.ts）
  assert.equal(PERMISSION_MATRIX.manage_consent.child, 'DENY')
})

test('行使权利不算新的处理：撤回自己已提交的申请、切家长模式都豁免', () => {
  // `withdraw_request`：申请人收回自己已经提交的申请 —— 拦住它会让用户无法收拾自己的东西。
  assert.equal(isConsentGatedAction('withdraw_request'), false)
  // `switch_role_mode`：切模式不写儿童数据；而它是家长**进入恢复同意界面**的路径。
  assert.equal(isConsentGatedAction('switch_role_mode'), false)
})

test('只改 UI 状态也算豁免，但**写业务事实**一律要同意', () => {
  // `read_notifications` 只改 `Notification.readAt` 一列，不采集儿童数据。
  assert.equal(isConsentGatedAction('read_notifications'), false)
  // 其余通知/成员读取同理
  assert.equal(isConsentGatedAction('view_notifications'), false)
  assert.equal(isConsentGatedAction('view_members'), false)
  assert.equal(isConsentGatedAction('view_trash'), false)

  // 写侧：这几条是最容易被"顺手放行"的，逐条钉住。
  for (const action of [
    'check_in_habit',
    'undo_check_in',
    'adjust_points',
    'add_wish',
    'redeem',
    'review_approvals',
    'change_member_role',
    'remove_member',
    'invite_member',
    'edit_child_profile',
    'apply_onboarding',
    'manage_device_tokens'
  ] as const) {
    assert.equal(isConsentGatedAction(action), true, `${action} 必须要求有效同意`)
  }
})

test('`view_*` 全部豁免，但豁免不是靠前缀推导出来的', () => {
  // 这条用例**不是**在验收"前缀规则"——它是在说：当前矩阵里恰好所有 view_ 都是读。
  // 真正的判定只看两张清单；下面同时给出反例（不以 view_ 开头却是写）。
  const views = ALL_ACTIONS.filter((action) => action.startsWith('view_'))
  assert.ok(views.length >= 9, `view_ 动作只有 ${views.length} 个，矩阵改过了？`)
  for (const action of views) {
    assert.equal(isConsentGatedAction(action), false, `${action} 是读路径，不该被同意闸门拦住`)
  }
  // 反例：不以 `view_` 开头却是读 / 以 `read_` 开头却是写侧之外 —— 前缀规则两头都不准。
  assert.equal(isConsentGatedAction('read_notifications'), false)
  assert.equal(isConsentGatedAction('request_points_bonus'), true)
  assert.equal(isConsentGatedAction('switch_role_mode'), false)
})

test('双 DENY 的运维动作仍归写侧：分类穷尽优先，不因"谁都做不了"而免检', () => {
  // `reset_demo_data` 双侧 DENY（E18）。把它放进豁免侧会让"穷尽划分"出现一个
  // 靠语义解释的口子；而它一旦被放开为可执行，就必须先有过同意。
  assert.equal(PERMISSION_MATRIX.reset_demo_data.guardian, 'DENY')
  assert.equal(PERMISSION_MATRIX.reset_demo_data.child, 'DENY')
  assert.equal(isConsentGatedAction('reset_demo_data'), true)
})

test('已知副作用：读端点复用写动作时，撤回后**连读也停**（改法是新增读动作，不是按 GET 放行）', () => {
  // `GET /invites` → `invite_member`；`GET /approvals`（收件箱）→ `review_approvals`。
  // 这条把"它们确实在写侧"钉住；配套的 `consent-guard.test.ts` 还钉住
  // 「Guard 不看 HTTP 方法」—— 两处合起来才挡住"给 GET 开后门"的改法。
  assert.equal(isConsentGatedAction('invite_member'), true)
  assert.equal(isConsentGatedAction('review_approvals'), true)
})

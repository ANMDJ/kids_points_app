import { ALL_ACTIONS, type ActionType } from './permission-matrix'

/**
 * 同意闸门（W7-A，`docs/PRD.md` FR-12 / `docs/design/04` §5）——
 * **「撤回同意后写入停止」到底拦哪些动作**的唯一事实源。
 *
 * ── 为什么不按「动作名以 view_ 开头」自动推导 ───────────────────────────────
 *   名字看起来能分类，但它会把判断藏进一个正则里：`read_notifications` 不是读、
 *   `withdraw_request` 不以 view_ 开头却必须放行、`reset_demo_data` 是写但双侧 DENY。
 *   正则的每一次例外都得在调用处打补丁 —— 那就等于没有单点。因此这里**显式穷举**。
 *
 * ── 两个集合必须**恰好划分**全部动作（`consent-policy.test.ts` 钉着）─────────
 *   新增一个矩阵动作却忘了分类 ⇒ 用例立刻红（"未分类：xxx"）。
 *   这是本文件存在的第二个理由：矩阵扩容时，闸门不会静默退化成
 *   「新端点天然不受同意约束」——那种缺口在代码里看不出来，只有用例能钉。
 *
 * ── 为什么撤回后仍放行这些 ─────────────────────────────────────────────────
 *   ① **读取**（`view_*`）：撤回的是「处理」，不是「看一眼自己的数据」；
 *   ② `read_notifications`：只改 `Notification.readAt` 一列，不采集儿童数据；
 *   ③ `withdraw_request`：申请人撤回自己**已经提交**的申请 —— 这是行使权利，
 *      不是新的处理；拦住它会让用户无法收拾自己留下的东西；
 *   ④ `manage_consent` / `view_consent`：**必须能重新同意**。撤回后若连授予口都封了，
 *      就是「可撤回但不可恢复」的死状态（合规上不成立）；
 *   ⑤ `switch_role_mode`：切家长模式本身不写儿童数据；而它是家长**进入恢复同意界面**
 *      的路径 —— 拦住它同样会制造死锁。
 */
export const CONSENT_GATED_ACTIONS = [
  /* ── 打卡 / 记一笔 ── */
  'check_in_habit',
  'undo_check_in',
  'adjust_points',
  'request_points_bonus',
  /* ── 规则 / 习惯 ── */
  'add_rule',
  'update_rule',
  'delete_rule',
  'add_habit_from_rule',
  'delete_habit',
  /* ── 回收站（恢复 / 彻底删除都是写）── */
  'restore_trash_item',
  'purge_trash_item',
  /* ── 心愿 / 审批 ── */
  'add_wish',
  'request_redeem',
  'delete_wish',
  'redeem',
  'request_approval',
  'review_approvals',
  /* ── 成员 / 档案 / 引导 ── */
  'invite_member',
  'change_member_role',
  'remove_member',
  'edit_child_profile',
  'apply_onboarding',
  /* ── 设备（登记推送 token = 采集设备信息）── */
  'manage_device_tokens',
  /* ── 运维（双侧 DENY，仍归写侧：穷举完整性优先）── */
  'reset_demo_data'
] as const satisfies readonly ActionType[]

export const CONSENT_EXEMPT_ACTIONS = [
  /* ── 读取 ── */
  'view_child_points',
  'view_records',
  'view_rules',
  'view_wishes',
  'view_trash',
  'view_own_approvals',
  'view_notifications',
  'view_members',
  'view_consent',
  /* ── 数据导出（W7-C）──
     ★ 它不是写：导出不改变任何一行，而且**撤回同意后仍必须可用** ——
       撤回的含义是「停止处理」，不是「连已经存在的数据都拿不走」。
       把它归进写侧会让 04 §5 的可携带承诺在撤回后失效。 */
  'export_family_data',
  /* ── 只改 UI 状态 ── */
  'read_notifications',
  /* ── 行使权利 / 恢复同意（见文件头 ③④⑤）── */
  'withdraw_request',
  'manage_consent',
  'switch_role_mode'
] as const satisfies readonly ActionType[]

const GATED = new Set<string>(CONSENT_GATED_ACTIONS)
const EXEMPT = new Set<string>(CONSENT_EXEMPT_ACTIONS)

/**
 * ── 一个必须知道的副作用：闸门按「动作」拦，**不按 HTTP 方法拦** ──────────────
 *   `GET /invites`（邀请码列表）与 `GET /approvals`（家长收件箱）复用的是
 *   `invite_member` / `review_approvals` —— 矩阵里没有 `view_invites` /
 *   `view_approval_inbox` 这两个动作。因此撤回同意后，这两条**读**也会 403。
 *
 *   这不是疏漏，而是「分类以动作而非动词为准」的直接后果。要放行它们，正确做法是
 *   **新增读动作**（矩阵 + 迁移 + PRD §7），而不是在这里按 `GET` 网开一面 ——
 *   后者会让「哪些读被放行」变成藏在正则里的第二份清单，与本文件存在的理由相反。
 */

/**
 * 这个动作是否需要「有效同意」才允许执行。
 *
 * ★ 未知动作返回 `true`（**fail-closed**）：调用方拿到一个不在矩阵里的动作时，
 *   它能做的最安全的事是**当成写动作**去要同意，而不是当成读放行。
 *   与 `resolveVerdict()` 对未知动作返回 DENY 同一个方向。
 */
export function isConsentGatedAction(action: ActionType): boolean {
  if (GATED.has(action)) return true
  if (EXEMPT.has(action)) return false
  // 两个集合都没收录（矩阵新增了动作却忘了分类）⇒ **按写处理**（fail-closed）。
  return true
}

/** 既不在写集合、也不在豁免集合里的动作（应为空；用例钉着）。 */
export function unclassifiedActions(): ActionType[] {
  return ALL_ACTIONS.filter((action) => !GATED.has(action) && !EXEMPT.has(action))
}

/** 同时出现在两个集合里的动作（应为空；两个 Set 会静默让"写"胜出，故必须钉）。 */
export function doubleClassifiedActions(): ActionType[] {
  return ALL_ACTIONS.filter((action) => GATED.has(action) && EXEMPT.has(action))
}

/** 分类里出现了矩阵中不存在的动作（拼错 / 动作被删）——应为空；用例钉着。 */
export function unknownClassifiedActions(): string[] {
  const known = new Set<string>(ALL_ACTIONS)
  return [...GATED, ...EXEMPT].filter((action) => !known.has(action)).sort()
}

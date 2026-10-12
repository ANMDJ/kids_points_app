/**
 * PERMISSION_MATRIX —— **单一权威事实源**（docs/design/02 §2、§3 屏障二）。
 *
 * 架构约束：权限只能在一处定义。HTTP Guard 与 Agent `action-dispatcher`
 * **必须消费同一张表**，否则两条入口必然漂移 —— Agent 会成为提权通道。
 *
 * ── 跨语言消费方式 ──────────────────────────────────────────────
 * 本文件是唯一事实源（TypeScript）。Python Agent 无法 import TS，
 * 因此由 `npm run contracts:emit` 生成 `contracts/permission-matrix.json`，
 * Agent 侧只读该 JSON。**绝不允许手改 JSON**，也绝不允许在 Python 侧另抄一份。
 *
 * ── 三道屏障中的位置 ────────────────────────────────────────────
 * 屏障一（成员资格门）→ 屏障二（本矩阵）→ 屏障三（成员级收紧）
 * 最终判定 = min(矩阵判定, 成员级限制)，按严苛度 DENY > REQUIRE_APPROVAL > ALLOW。
 * 屏障三**只能更严**，永远不能把 DENY 放宽（02 §3）。
 */

export type Role = 'guardian' | 'child'
export type Verdict = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL'

/** 严苛度排序：用于 min() 与屏障三的方向性约束。 */
export const VERDICT_SEVERITY: Record<Verdict, number> = {
  ALLOW: 0,
  REQUIRE_APPROVAL: 1,
  DENY: 2
}

/** 取更严的那个判定 —— 屏障三只能收紧，不能放宽（02 §3）。 */
export function stricter(a: Verdict, b: Verdict): Verdict {
  return VERDICT_SEVERITY[a] >= VERDICT_SEVERITY[b] ? a : b
}

export const PERMISSION_MATRIX = {
  /* ── 查询类 ───────────────────────────────────────────── */
  view_child_points: { guardian: 'ALLOW', child: 'ALLOW' },
  view_records: { guardian: 'ALLOW', child: 'ALLOW' },
  view_rules: { guardian: 'ALLOW', child: 'ALLOW' },
  view_wishes: { guardian: 'ALLOW', child: 'ALLOW' },

  /* ── 打卡 ─────────────────────────────────────────────── */
  check_in_habit: { guardian: 'ALLOW', child: 'ALLOW' },
  undo_check_in: { guardian: 'ALLOW', child: 'DENY' },

  /* ── 规则 ─────────────────────────────────────────────── */
  add_rule: { guardian: 'ALLOW', child: 'DENY' },
  update_rule: { guardian: 'ALLOW', child: 'DENY' },
  delete_rule: { guardian: 'ALLOW', child: 'DENY' },
  add_habit_from_rule: { guardian: 'ALLOW', child: 'DENY' },

  /* ── 心愿 ─────────────────────────────────────────────── */
  add_wish: { guardian: 'ALLOW', child: 'REQUIRE_APPROVAL' },
  request_redeem: { guardian: 'ALLOW', child: 'REQUIRE_APPROVAL' },
  delete_wish: { guardian: 'ALLOW', child: 'DENY' },

  /* ── 积分 ─────────────────────────────────────────────── */
  // 矩阵里孩子 adjust_points = DENY，但**不能简单返回 403**：
  // 孩子确实有「我想要更多分」的正当诉求。归一化在 dispatcher 层完成（02 §6），
  // 而非把「按 delta 符号分流」塞进矩阵 —— 那会让矩阵变形为代码。
  adjust_points: { guardian: 'ALLOW', child: 'DENY' },
  request_points_bonus: { guardian: 'ALLOW', child: 'ALLOW' },
  redeem: { guardian: 'REQUIRE_APPROVAL', child: 'REQUIRE_APPROVAL' },

  /* ── 审批 ─────────────────────────────────────────────── */
  request_approval: { guardian: 'ALLOW', child: 'ALLOW' },
  review_approvals: { guardian: 'ALLOW', child: 'DENY' },
  withdraw_request: { guardian: 'ALLOW', child: 'ALLOW' },

  /* ── 成员与设置 ───────────────────────────────────────── */
  invite_member: { guardian: 'ALLOW', child: 'DENY' },
  remove_member: { guardian: 'ALLOW', child: 'DENY' },
  switch_role_mode: { guardian: 'ALLOW', child: 'ALLOW' }, // 受 PIN 保护（02 §7）
  edit_child_profile: { guardian: 'ALLOW', child: 'DENY' },
  apply_onboarding: { guardian: 'ALLOW', child: 'DENY' },
  // ← E18：生产环境永久关闭。reset_demo_data 双侧均为 DENY，
  //    且**必须**保持双侧 DENY —— 客户端"生产可重置数据"是已修的严重缺陷。
  reset_demo_data: { guardian: 'DENY', child: 'DENY' }
} as const satisfies Record<string, Record<Role, Verdict>>

export type ActionType = keyof typeof PERMISSION_MATRIX

/** 25 个 ActionType —— 与 Prisma `enum ActionType` 必须逐一对应。 */
export const ALL_ACTIONS = Object.keys(PERMISSION_MATRIX) as ActionType[]

/**
 * 解析判定（屏障二）。
 *
 * ★ 失败即拒绝（fail-closed）：`viewer` 角色在 02 §1 中作为「只读分享」的
 * **未来扩展**被提及，但 §2 的矩阵**只有 guardian / child 两列**。
 * 因此 viewer 一律返回 DENY，而不是崩溃、更不是放行。
 * 若将来要支持 viewer，必须显式扩展矩阵列，不允许在调用处打补丁。
 * 见 docs/design/06-w0-report.md §3「待确认决策 D6」。
 */
export function resolveVerdict(action: ActionType, role: Role | 'viewer'): Verdict {
  if (role === 'viewer') return 'DENY'
  const row: Record<Role, Verdict> | undefined = PERMISSION_MATRIX[action]
  if (row === undefined) return 'DENY' // 未知动作 → 拒绝，绝不默认放行
  return row[role]
}

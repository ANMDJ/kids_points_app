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

  /* ── 规则 / 习惯 ───────────────────────────────────────── */
  add_rule: { guardian: 'ALLOW', child: 'DENY' },
  update_rule: { guardian: 'ALLOW', child: 'DENY' },
  delete_rule: { guardian: 'ALLOW', child: 'DENY' },
  add_habit_from_rule: { guardian: 'ALLOW', child: 'DENY' },
  // 习惯的“新建”只有一条路：从规则采纳（`add_habit_from_rule`）。
  // 删除是**软删**（进回收站 90 天，修 C9）；孩子不能把今天该做的事删掉。
  delete_habit: { guardian: 'ALLOW', child: 'DENY' },

  /* ── 回收站（W5-F）───────────────────────────────────── */
  // 看：孩子也能看到被移走的内容（删之前本来就看得见，隐藏没有意义）。
  // 恢复 / 彻底删除：只给家长 —— 那是“改变约定”与“不可逆”的决定。
  view_trash: { guardian: 'ALLOW', child: 'ALLOW' },
  restore_trash_item: { guardian: 'ALLOW', child: 'DENY' },
  purge_trash_item: { guardian: 'ALLOW', child: 'DENY' },

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
  // 看「**我提交的**申请」（W5-J）：两个角色都能看，因为每个人本来就该知道
  // 自己提过什么、哪条还能撤回。★ 它不是 `review_approvals` —— 后者是
  // 「待我批准」的家长视图（child DENY）。两个视图的收口条件完全不同：
  // 这个按 `requesterUserId = 本人`，那个按 `childId` 全量。
  view_own_approvals: { guardian: 'ALLOW', child: 'ALLOW' },

  /* ── 通知（W5-L）───────────────────────────────────────── */
  // 站内通知：**只有收件人自己那条**（按会话 `userId` 收口），两个孩子都放行 ——
  // 藏起来只会让「审批被拒了」永远没人知道。注意它**不是** `review_approvals`：
  // 这里看不到别人家 / 别人的通知，也不是审批收件箱。
  view_notifications: { guardian: 'ALLOW', child: 'ALLOW' },
  // 标记已读：只改 `readAt` 一列，不改账本 / 审批状态 ⇒ 两个角色都可。
  // 服务端不接受「替别人读」：`recipientUserId` 来自会话，不是请求体。
  read_notifications: { guardian: 'ALLOW', child: 'ALLOW' },

  /* ── 设备推送（W6-A）────────────────────────────────────── */
  // 上报 / 注销**自己的**设备推送 token：两个角色都 ALLOW —— 孩子的设备也要能收到
  // 「审批通过了」，藏起来只会让推送永远送不到孩子手里。收口条件写死在**会话 actor**
  // 上（请求体里没有 `userId`，也没有 `token` 的归属者），所以「改别人的 token」
  // 这条路不存在：别人的 token 一律回答 404 `DEVICE_TOKEN_NOT_FOUND`。
  // 与 `read_notifications` 刻意分开：那个只改 `Notification.readAt` 一列，
  // 这个往 `DeviceToken` 里写一行（另一张表、另一类事实），合并会让「允许标已读」
  // 顺带等于「允许把你的设备绑到我的账号上」。
  manage_device_tokens: { guardian: 'ALLOW', child: 'ALLOW' },

  /* ── 成员与设置 ───────────────────────────────────────── */
  // 成员管理（W5-H）：**看得到成员**对孩子开放（"家里有谁"不是敏感数据，
  // 藏起来只会让界面出现一个匿名家长）；**改角色 / 移出**只给家长 ——
  // 那是改变"谁能管这个家"的决定。
  view_members: { guardian: 'ALLOW', child: 'ALLOW' },
  change_member_role: { guardian: 'ALLOW', child: 'DENY' },
  invite_member: { guardian: 'ALLOW', child: 'DENY' },
  remove_member: { guardian: 'ALLOW', child: 'DENY' },
  switch_role_mode: { guardian: 'ALLOW', child: 'ALLOW' }, // 受 PIN 保护（02 §7）
  edit_child_profile: { guardian: 'ALLOW', child: 'DENY' },
  apply_onboarding: { guardian: 'ALLOW', child: 'DENY' },

  /* ── 合规与监护人同意（W7-A）────────────────────────────── */
  // 看同意状态：只给家长。它不是给孩子的界面，而且矩阵不给孩子任何合规控制面
  // （同意只能由监护人作出 —— 04 §5）。
  view_consent: { guardian: 'ALLOW', child: 'DENY' },
  // 授予 / 撤回同意：只给家长。
  // ★ 这两个动作是「撤回后写入停止」的**豁免口**（见 contracts/consent-policy.ts）：
  //   若连它也被拦，用户会被锁在「撤回了却无法重新同意」的死状态里 ——
  //   合规要求的「可撤回」必须同时意味着「可再次授予」。
  manage_consent: { guardian: 'ALLOW', child: 'DENY' },

  /* ── 数据导出（W7-C）────────────────────────────────────── */
  // 导出整个家庭的可携带数据（档案 / 成员 / 规则与版本 / 习惯 / 心愿 / 流水 /
  // 审批 / 同意记录 / 审计），供家长行使查阅与可携带权（02 §9.20 / 04 §5）。
  // ★ 只给家长：孩子不该能成批导出全家数据（一次请求就能拿走所有流水与成员信息）。
  // ★ 它不是写动作：导出**不改变任何一行**，且撤回同意后仍必须可用 ——
  //   否则「撤回」就等于「连自己的数据也拿不走」，与 04 §5 的可携带承诺相反。
  //   因此 `contracts/consent-policy.ts` 把它归入豁免集合，并由用例钉住。
  export_family_data: { guardian: 'ALLOW', child: 'DENY' },
  // ← E18：生产环境永久关闭。reset_demo_data 双侧均为 DENY，
  //    且**必须**保持双侧 DENY —— 客户端"生产可重置数据"是已修的严重缺陷。
  reset_demo_data: { guardian: 'DENY', child: 'DENY' }
} as const satisfies Record<string, Record<Role, Verdict>>

export type ActionType = keyof typeof PERMISSION_MATRIX

/** 38 个 ActionType —— 与 Prisma `enum ActionType` 必须逐一对应。 */
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

/**
 * 自批策略（approval policy）—— **「谁可以批准」的唯一权威判定**
 * （docs/design/02 §4.5；PRD FR-08 ／ §14.1 决策 P4）
 *
 * ── 这一步在修什么 ───────────────────────────────────────────────
 * `redeem` 对**两端**都是 `REQUIRE_APPROVAL`（`permission-matrix.ts` L61），
 * 而 PRD FR-08 与 `02` §4.1–§4.4 只定义了「**什么**动作需要审批」与「状态怎么走」，
 * **从未定义「谁可以批准」**：全仓既没有批准资格的文字，也没有判据
 * （`grep` 无 `approver` / 无「批准人 ≠ 申请人」这类约束）。
 *
 * 后果不是安全漏洞，而是**功能死锁**：**单家长家庭**（只有一位 `guardian`）
 * 提交兑换后没有任何人能批准 → 永远 `pending` → 到期被 `expired` 扫掉。
 * 孩子「按规矩办事」反而换不出心愿 —— 这是必须修的体验缺陷，不是可选项。
 *
 * ── 裁定（2026-10-14，用户点头；PRD §14.1 **P4**）─────────────────
 * **允许申请人自批，但自批必须是一次「显式动作」** —— 绝不静默自动批准：
 *   ① **两步式（二次确认）**：先建 `pending`，再由**申请人自己**调批准端点
 *      （落库后 `decidedByUserId === requesterUserId`）；
 *   ② **一步式（申请时勾选「自动审批」）**：建请求带 `autoApprove: true`，
 *      同一事务直接落 `approved` + 写流水。
 * 界面上的「弹窗二次确认」与「请求时勾选」只是这两种形态的皮，
 * **契约只看那个显式信号**（`autoApprove === true`，或"多出来的那次批准调用"）。
 *
 * 为什么**不给「只有一位家长」开自动批准的特例**：
 *   ① 同一个 API 调用会随"家庭里有几位家长"改变安全语义，而这件事客户端可伪造、服务端还要额外查询；
 *   ② 审计里会凭空出现**没有人点过同意**的批准记录 —— 事后无法回答"这笔是谁同意的"。
 *     显式信号下，`isSelfApproved()` 永远能给出答案。
 *
 * ── 两条硬约束（**全部由矩阵导出，不新增第三处名单**）──────────────
 *   ① 自批资格 = `PERMISSION_MATRIX[action][role] === 'REQUIRE_APPROVAL'`
 *      **且** `PERMISSION_MATRIX['review_approvals'][role] === 'ALLOW'`；
 *   ② 传了 `autoApprove` 却**不满足资格** → **拒绝**（`SELF_APPROVAL_NOT_ALLOWED`），
 *      **不是静默忽略** —— 与 `member-restrictions.ts` 的多余键拒绝同一口径：
 *      静默忽略会让客户端以为"已经批了"，而库里那条 `pending` 谁也没看见。
 *
 * 于是**孩子永远无法自批**（`review_approvals` 对孩子是 `DENY`），家长对 `redeem` 可以 ——
 * 恰好补上单家长家庭的死锁，且**不扩大任何人的权限**：家长本来就能
 * `adjust_points` / `add_wish`（矩阵 `ALLOW`），自批只是把"自己提的兑换"从
 * "等别人"变成"自己确认"；孩子照旧受 `02` §9.16 / §9.17 的每日配额与 ±50 上限约束。
 *
 * ── 落地状态（2026-10-14 阶段 B4 更新，**上一版标注已被证伪**）────────────
 * ✅ **HTTP 路径已建成并真实消费本文件**：`approvals.controller.ts` → `approvals.service.ts`
 *    （`POST /approvals`、`POST /approvals/:id/decide`），用例 `test/approvals-http.test.ts`
 *    （26 条**真 HTTP**用例，含一条「改矩阵 ⇒ HTTP 行为必须跟着变」——判定若被抄一份就会红）。
 * ⚠️ 但**落库 / 账本流水 / 审计写入仍未落地**：`ApprovalsPort` 的默认实现是**显式 501**
 *    （W1/W2），不是静默成功。**别把「判定已上线」读成「审批已验收」。**
 */

import { resolveVerdict, type ActionType, type Role } from './permission-matrix'

/** 没资格自批却显式要求自批时返回给客户端的错误码（`02` §4.5）。 */
export const SELF_APPROVAL_NOT_ALLOWED = 'SELF_APPROVAL_NOT_ALLOWED'

/**
 * 自批的审计动作名（`AuditLog.action` 是**自由字符串**，见 `schema.prisma` 注释
 * 「动作标识，如 `point_rule.update`」）—— 故**不需要新增枚举、不需要迁移**。
 */
export const AUDIT_ACTION_SELF_APPROVED = 'approval.self_approved'

/**
 * 该角色**是否具备批准资格**（能不能去点「同意」，与具体动作无关）。
 * 判据直接读矩阵的 `review_approvals` 行 —— 权限只在矩阵里定义一次（`02` §2）。
 * fail-closed：`viewer` / 未知角色 → `resolveVerdict` 已返回 `DENY` → 这里是 `false`。
 */
export function canReview(role: Role | 'viewer'): boolean {
  return resolveVerdict('review_approvals', role) === 'ALLOW'
}

/**
 * 申请人能否**对自己的这条请求**自批（`02` §4.5 硬约束 ①②）。
 * 两个条件缺一不可：动作确实需要审批 ＋ 申请人自己有批准资格。
 * fail-closed：`viewer` / 未知动作 / 不需要审批的动作（`ALLOW`）/ 本来就是 `DENY` 的动作 → 一律 `false`。
 */
export function canSelfApprove(action: ActionType, requesterRole: Role | 'viewer'): boolean {
  return resolveVerdict(action, requesterRole) === 'REQUIRE_APPROVAL' && canReview(requesterRole)
}

/**
 * 建审批请求时的输入 —— 只取判定需要的字段（**不假装已经有 DTO**）。
 *
 * `autoApprove` 故意声明为 `unknown`：调用方必须**显式**收敛到 `true` 才算勾选，
 * 免得 `'true'` / `1` / `{}` 这类真值被 `Boolean()` 顺带放行（fail-closed）。
 */
export interface RequestIntent {
  action: ActionType
  requesterRole: Role | 'viewer'
  /** 请求体里的显式信号；**缺席 / `false` / 非布尔**一律视为「没勾选」。 */
  autoApprove?: unknown
}

/**
 * 一条请求建出来之后应当是什么结果。
 *
 * 返回**判别式联合而不是布尔**：`false` 会被消费方当成"随便怎么办都行"，
 * 而"没资格"与"没勾选"必须走**不同**的分支（前者 400，后者 `pending`）。
 */
export type RequestOutcome =
  | { kind: 'PENDING' } // 不勾选：走正常审批流（等家庭里另一位 guardian）
  | { kind: 'SELF_APPROVED' } // 显式自批 → 与"他人批准"同一执行路径
  | { kind: 'REJECTED'; code: typeof SELF_APPROVAL_NOT_ALLOWED } // 显式要求自批但没资格

/**
 * 判定「这条请求建出来应当是什么结果」（`02` §4.5）。
 *
 * ★ 只有**严格等于 `true`** 才算显式勾选 —— 缺字段 / `false` / `'true'` / `1` 一律 `PENDING`。
 *   这是本策略里最要紧的一条：**不勾选就不批**。
 */
export function decideRequestOutcome(intent: RequestIntent): RequestOutcome {
  if (intent.autoApprove !== true) return { kind: 'PENDING' }
  if (!canSelfApprove(intent.action, intent.requesterRole)) {
    return { kind: 'REJECTED', code: SELF_APPROVAL_NOT_ALLOWED }
  }
  return { kind: 'SELF_APPROVED' }
}

/**
 * 批准端点（两步式自批也走这里）的放行判据：**有批准资格** 且 **这条请求还没被决过**。
 *
 * 自批在这里**不额外开绿灯**：申请人能不能批，与别人能不能批是同一个 `canReview()`；
 * 差别只在落库后 `decidedByUserId` 会等于 `requesterUserId`（审计可辨，见 `isSelfApproved()`）。
 *
 * 只认字面量 `'pending'`（`ApprovalStatus` 的唯一非终态），其余状态一律 `false`
 * —— 与 `02` §4.4 的乐观锁 `UPDATE … WHERE id=? AND status='pending'` 同一口径。
 */
export function canDecide(request: { status: string }, deciderRole: Role | 'viewer'): boolean {
  return request.status === 'pending' && canReview(deciderRole)
}

/**
 * 这条**已决**请求是不是「自批」（批准人与申请人同一人）。
 *
 * 供审计与 UI 使用（"你自己确认的"），**不需要新增字段**：真相就在
 * `decidedByUserId` 与 `requesterUserId` 的比较里 —— 同 `02` §5 的 D4 口径
 * （冗余的两份真相必然漂移）。
 * fail-closed：未决（`decidedByUserId === null`）**不算**自批。
 */
export function isSelfApproved(decision: {
  requesterUserId: string
  decidedByUserId: string | null
}): boolean {
  return decision.decidedByUserId !== null && decision.decidedByUserId === decision.requesterUserId
}

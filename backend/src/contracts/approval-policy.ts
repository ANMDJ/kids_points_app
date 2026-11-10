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
 * ── 落地状态（2026-10-18，W3-A / W3-B）─────────────────────────────────────
 * ✅ **HTTP 路径已建成并真实消费本文件**：`approvals.controller.ts` → `approvals.service.ts`
 *    （`POST /approvals`、`POST /approvals/:id/decide`、`POST /approvals/:id/withdraw`）。
 * ✅ **落库 / 账本流水 / 余额 / 审计已落地（W3-A）**：有库时由
 *    `PrismaApprovalsRepository` 在**同一事务**里写四张表；无库才显式 501。
 * ✅ **撤回（W3-B）**：`withdrawDenial()` 是本文件新增的**唯一撤回判定**
 *    （角色 → 是否本人 → 是否仍 pending），service 与 Prisma 适配器都消费它，
 *    绝不在两处各写一份「谁能撤回」。
 * 用例：`test/approvals-http.test.ts`（含「改矩阵 ⇒ HTTP 行为必须跟着变」）、
 *       `test-db/approvals-execution-db.dbtest.ts`（真库同事务证据）。
 * ⚠️ W3-C（2026-10-18）已收尾：执行器覆盖 `redeem` / `request_redeem` /
 *    `request_points_bonus` / `add_wish`；`autoReason` 五种均可复现；`expired` 有后台扫描；
 *    `Idempotency-Key` 已接到 create / decide / withdraw。
 *    **别把「审批动作已覆盖这四项」读成「所有业务动作都已实现」**（规则/邀请等模块仍待建）。
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

/**
 * 撤回的审计动作名（`02` §4.1 的 `withdrawn` 终态）。
 * 与 `approval.approved` / `approval.rejected` 分开记：撤回是**申请人**的动作，
 * 不是批准人的决定 —— 统计「谁批的」时不能把撤回算进去。
 */
export const AUDIT_ACTION_WITHDRAWN = 'approval.withdrawn'

/**
 * 撤回被拒的三种原因。返回**判别式**而不是布尔：
 * 三种原因对应三种不同的 HTTP 处置（角色不够 403 / 不是本人 403 / 已终态 409），
 * 用一个 `false` 表示会把它们压成同一句话，客户端无法正确提示。
 */
export type WithdrawDenial =
  | 'WITHDRAW_FORBIDDEN_ROLE' // 矩阵的 withdraw_request 不是 ALLOW（viewer / 未知角色）
  | 'NOT_REQUESTER' // 不是申请人本人 —— 连「这条还在不在等」都不该知道
  | 'ALREADY_DECIDED' // 已终态（approved / rejected / withdrawn / invalidated / expired）

/**
 * 撤回判定（`02` §4.1 / §9.7）：**只有申请人本人**、**只有 `pending`** 能撤回。
 *
 * 顺序是语义的一部分：
 *   ① 先看角色（矩阵 `withdraw_request`，两道角色都是 ALLOW）—— 权限只在矩阵里定义一次；
 *   ② 再看是不是本人 —— 非本人一律 `NOT_REQUESTER`，**不**顺便告诉他这条已批/已拒
 *      （跨孩子/跨用户的存在性本身就是信息）；
 *   ③ 最后看状态 —— 这里只认字面量 `'pending'`，与 §4.4 的乐观锁
 *      `UPDATE … WHERE status='pending'` 同一口径。
 *
 * `expired` 的惰性判定**不在这里**：它需要「现在几点」，属于端口在事务里做的事
 * （见 `PrismaApprovalsRepository.withdraw`）—— 纯策略不读时钟，才能被稳定地单测。
 */
export function withdrawDenial(
  request: { status: string; requesterUserId: string },
  actor: { userId: string; role: Role | 'viewer' }
): WithdrawDenial | null {
  if (resolveVerdict('withdraw_request', actor.role) !== 'ALLOW') return 'WITHDRAW_FORBIDDEN_ROLE'
  if (request.requesterUserId !== actor.userId) return 'NOT_REQUESTER'
  if (request.status !== 'pending') return 'ALREADY_DECIDED'
  return null
}

/** 布尔形态（便于断言「能撤回」）；原因请用 `withdrawDenial()`。 */
export function canWithdraw(
  request: { status: string; requesterUserId: string },
  actor: { userId: string; role: Role | 'viewer' }
): boolean {
  return withdrawDenial(request, actor) === null
}

/**
 * 读**单条**审批（`GET /approvals/:id`，P1-3）被拒的两种原因。
 *
 * 为什么需要一条独立的判定（而不是在 controller 里写 if）：
 *   详情页同时服务两种人 —— **有权批的家长**（收件箱 / 通知深链）与
 *   **申请人自己**（「我的申请」/ 审批结果通知）。两个条件都不能写进
 *   `approvals.service.ts`（该文件的硬约束是「不出现任何角色判断」），
 *   所以和 `withdrawDenial()` 一样，判定只放在这里。
 */
export type DetailDenial =
  | 'DETAIL_FORBIDDEN_ROLE' // 矩阵 view_own_approvals 不是 ALLOW（viewer / 未知角色）
  | 'NOT_REQUESTER' // 没有批准资格，且不是申请人本人

/**
 * 详情页的放行判据（P1-3）：
 *   ① 有批准资格（矩阵 `review_approvals` ALLOW）⇒ 本孩子范围内的任何一条都能看，
 *      与收件箱完全一致（家长看得到「待我批的那条」，才谈得上点进去）；
 *   ② 否则必须自己是申请人（矩阵 `view_own_approvals` ALLOW 且 id 相同）。
 *
 * ★ 跨孩子的隔离**不在这里**：`findById(id, childId)` 已把 `childId` 当查询条件，
 *   另一家的 id 与「不存在」都返回 `null`（W3-B），上层统一 404。
 * ★ fail-closed：`viewer` / 未知角色在 ① 为 false、② 的矩阵判定为 DENY ⇒ 403。
 */
export function detailDenial(
  request: { requesterUserId: string },
  actor: { userId: string; role: Role | 'viewer' }
): DetailDenial | null {
  if (canReview(actor.role)) return null
  if (resolveVerdict('view_own_approvals', actor.role) !== 'ALLOW') {
    return 'DETAIL_FORBIDDEN_ROLE'
  }
  if (request.requesterUserId !== actor.userId) return 'NOT_REQUESTER'
  return null
}

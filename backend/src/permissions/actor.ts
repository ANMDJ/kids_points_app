import type { Role, Verdict } from '../contracts/permission-matrix'
import type { Membership } from '../membership/membership.gate'

/**
 * 「操作人」—— 身份解析的结果，也是三道屏障的**共同输入**。
 *
 * ── 为什么它单独成一个文件（W1-A，2026-10-14）────────────────────────────────
 *   此前它定义在 `device-session/temporary-role.guard.ts`（B4 的临时物）里。
 *   但 actor 并不是「临时头」的私有物：屏障一（成员资格）／屏障二（矩阵）／
 *   每个 service 都要用它。把它留在临时物里，会让 W1 删除临时 Guard 时
 *   连带牵动整个审批模块 —— 类型搬家与行为变更混进同一个 diff，正是本仓库
 *   反复强调要避免的那类"看不懂的改动"。
 *   现在它有自己的位置：`src/permissions/`（＝权限判定的输入）。
 *
 * ⚠️ `role` 含 `'viewer'`：它在矩阵里**没有列**，`resolveVerdict()` 一律 `DENY`
 *   （fail-closed，见 02 §2 与 D6 裁定）。把 `viewer` 放进类型，是为了让
 *   「看到了 viewer 却不知道该怎么办」在**编译期**就浮出来，
 *   而不是等运行时把它当成 `Role` 蒙混过关。
 */
export interface Actor {
  userId: string
  role: Role | 'viewer'
}

/**
 * Guard 与 controller / service 之间的传递载体（挂在请求对象上）。
 *
 * 字段是**可选**的，但「可选」**不等于**「缺了就当放行」：
 *
 * · `kpActor` 缺失 = 身份 Guard 没跑（漏挂 / 顺序颠倒）→ 下游**响亮失败**
 *   （见 `ApprovalsController.actorOf`），绝不落到默认角色。
 *   默认 `guardian` 是提权，默认 `child` 是另一种撒谎 —— 见 device-session.guard.ts。
 *
 * · `kpChildId` 是**会话的孩子上下文**（**由身份 Guard 写入**，见 `device-session.guard.ts`）：
 *   取值来自请求头的选择器 `x-kp-child-id`，但它**必须**等于会话行上的 `childId`
 *   （不等 ⇒ **500 `SESSION_CHILD_MISMATCH`**，`device-session/session.gate.ts`）——
 *   所以"在哪个孩子的档案上"这半个身份**也不是客户端说了算**。
 *   屏障一（资格）与屏障三（成员级收紧）都必须先知道"对哪个孩子"——
 *   缺失时**绝不跳过检查**（见 MembershipGuard ②）。
 *
 * · `kpMember` 是**屏障一的输出**（已通过形状校验的成员位，含 `restrictions`）。
 *   ★ 它缺失 = 屏障一没跑。`PermissionsGuard` 对此**响亮失败**（500），
 *   绝不把它读成"没有额外限制"—— 那会让屏障三静默失效，且看不出来。
 *
 * · `kpVerdict` 是**屏障二 × 屏障三 之后的最终判定**：由 `PermissionsGuard` 写入。
 *   ★ 它的存在**不代表已授权**：`DENY` 与 `REQUIRE_APPROVAL` 在 Guard 里就已被拒
 *   （根本走不到业务层）。保留这个字段，是为了让将来「确实需要审批的端点」
 *   能读到 `REQUIRE_APPROVAL` 并据此建 `ApprovalRequest`（02 §3 屏障二）。
 */
export interface RequestWithActor {
  headers: Record<string, string | string[] | undefined>
  kpActor?: Actor
  kpChildId?: string
  kpMember?: Membership
  kpVerdict?: Verdict
}

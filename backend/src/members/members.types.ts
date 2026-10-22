/**
 * 成员管理的**线格式**与**端口行**（W5-H，2026-10-22；02 §1 / §2 / §3）
 *
 * ── 服务端只下发事实，不下发结论 ────────────────────────────────────────────
 *   `GET /members` 给 `role` / `status` / `isSelf`，**不**给
 *   `canChangeRole` / `canRemove` / `actions: ['remove']`。
 *   谁能对谁做什么由矩阵（屏障二）决定，而屏障二在**服务端**运行；把结论抄进
 *   线格式就等于让界面拿着一个可能过期的判断去渲染按钮。界面该做的是：
 *   「我是家长 ⇒ 显示这些入口」，被拒绝时按 403 的 `code` 解释原因。
 *
 * ── 为什么保留 `status` ────────────────────────────────────────────────────
 *   它不是结论，是**库里的事实**（与 `InviteCode.revoked` 同口径）。
 *   列表只回 `active`，但把真实状态放在线格式里，界面就不必假设"列出来的都活着"
 *   —— 将来若加 `includeRemoved`，线格式不需要变。
 *
 * ── `isSelf`：唯一一个"服务端算、客户端不该算"的字段 ────────────────────────
 *   客户端**不知道自己的 userId**（身份在服务端会话里，客户端只持有设备 id 与会话
 *   上下文，见 02 §7）。所以"这一行是不是我"只能由服务端回答。
 *   它不是权限结论（那是 403 的事），只是「这行要不要标（我）」。
 */
import type { MemberRole } from '@prisma/client'

/**
 * `PATCH /members/:id` 允许指定的**目标角色**。
 *
 * `viewer` 只能作为**现状**出现（历史数据 / 只读分享的预留），不能作为目标：
 * 把家长降成 viewer 等于"留一个看得见、做不了任何事的人"，而矩阵对 viewer 一律
 * DENY（06 §3 D6）—— 那不是降权，是制造一个死账号。
 * 把 viewer **提升**成 child / guardian 是正常操作，故本类型不限制来源角色。
 */
export type MutableMemberRole = Extract<MemberRole, 'child' | 'guardian'>

/** 端口行（仓储读出来的形状）。`Date` 只在这一层与端口之间流动。 */
export interface MemberRow {
  /** `ChildMember.id`（**不是** userId）：成员位可以被移出再恢复，userId 不会变。 */
  memberId: string
  userId: string
  /** `User.displayName` 可能为空（L2 主体认证前允许 null，01 §2）。 */
  displayName: string | null
  role: MemberRole
  status: 'active' | 'removed'
  joinedAt: Date
  removedAt: Date | null
}

/** `GET /members` 的条目 / `PATCH /members/:id` 的回包（时间一律 ISO 串）。 */
export interface MemberDto {
  memberId: string
  userId: string
  displayName: string | null
  role: MemberRole
  status: 'active' | 'removed'
  joinedAt: string
  removedAt: string | null
  /**
   * 这一行是不是**发起请求的人自己**。
   * 服务端算，因为客户端不知道自己的 userId（见文件头）。
   */
  isSelf: boolean
}

/** `GET /members` 的回包。 */
export interface MemberListResponse {
  items: MemberDto[]
}

/**
 * `DELETE /members/:id` 的回包 —— 与请求**验明正身**（同 `{id, revoked}` 的手法）。
 *
 * 回 `status: 'removed'` 而不是 `{ok:true}`：后者无法区分"移出了"与
 * "这个接口只是没报错"。`removedAt` 用 ISO 串，与所有其它时间字段同口径。
 */
export interface MemberRemoveResponse {
  memberId: string
  status: 'removed'
  removedAt: string
}

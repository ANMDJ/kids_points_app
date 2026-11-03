/**
 * 身份解析 · **判定内核**（docs/design/02 §7）
 *
 * 回答一句话：**这台设备、在这个孩子的档案上，现在是谁？**
 *
 *     (deviceId, childId) 的会话行  →  本内核  →  ALLOW（带 userId ＋ **有效角色**）| DENY（SESSION_NOT_FOUND）
 *
 * ── 为什么必须有这一层（W1-C 要修的病）──────────────────────────────────
 *   W1-A / W1-B 之后，三道屏障**都是真的**，但它们的输入 `actor` 来自**客户端自己发的**头
 *   （`x-kp-role` / `x-kp-user-id` / `x-kp-child-id`）—— 即：
 *     · 客户端**自选角色**：发 `x-kp-role: guardian` 就是家长（`02` §7 明写"不存客户端"的理由：
 *       小程序 storage 可被直接改）；
 *     · 客户端**自选身份**：发谁的 userId 就是谁。
 *   于是"屏障拦得对不对"这件事本身**没有人验证过** —— 拦一个**自称**是 guardian 的人，
 *   与拦一个**真的**是 guardian 的人，是两件事。
 *
 *   本内核把这两件事分开：**角色与 userId 一律由服务端的会话行给出**，
 *   客户端只被允许回答「我是哪台设备、在哪个孩子的档案上」。
 *
 * ── 口径逐字对齐 02 §7 / §9.19 ────────────────────────────────────────────
 *     · 默认角色 `child`（最小权限默认）—— 手机在孩子手里时不能是家长模式；
 *     · **TTL 到期 ⇒ 角色回落 `child`**（§9.19）。注意：这是**降级，不是拒绝** ——
 *       设备与身份仍然有效，只是不再具备家长权限。`guardian` 会话过期若判 401，
 *       孩子连"看自己的积分"都做不了（那会把 TTL 变成一种故障）。
 *     · 会话行**查不到 ⇒ `SESSION_NOT_FOUND`**（401）：没有身份，就没有后续三道屏障可言。
 *
 * ── ★ 本文件是纯函数：不碰 HTTP、不碰数据库、不构造 `Actor` ─────────────────
 *   查询归端口（`device-session.repository.ts`），翻成 HTTP 归守卫
 *   （`device-session.guard.ts`）—— 于是"判定"可以离线穷举（`test/session-gate.test.ts`），
 *   "装配"由 HTTP 用例钉住（`test/device-session-http.test.ts`）。两者分开，
 *   才不会互相冒充证据（与 `membership.gate.ts` 同一条纪律）。
 *
 * ── ★ 形状与判定是**两件事**，刻意分开（同 D3b 的教训）────────────────────
 *   · 会话行**不存在**                → 判定 → **401**（身份问题）
 *   · 会话行的字段**形状不对**（角色不在枚举内 / `expiresAt` 解析不出 /
 *     会话的 childId 与本次请求的 childId 不一致）→ **500**（数据/实现问题）
 *   混在一起的后果很具体：形状坏掉的行会表现为"你没有权限"，
 *   于是一个**数据**问题被当成**权限**问题排查很久 —— 而真正的病在数据。
 *   ★ 其中 `SESSION_CHILD_MISMATCH` 专门盯住适配器：若实现把 childId 查询参数**写死/忽略**，
 *     返回的行就会与请求的 childId 对不上（这正是 W1-B 证伪里"把 childId 写死"那条的同族病）。
 */

import type { Role } from '../contracts/permission-matrix'

/**
 * 端口返回的**原始**行 —— 字段故意是宽松的 `string` / 可解析时间：
 * 它来自数据库（`activeRole` 是枚举、`expiresAt` 是 timestamp），**未经验证**，
 * 不许直接当类型用。
 */
export interface SessionLookupRow {
  deviceId: string
  /** 会话所属的孩子档案 —— 必须与本次请求的 childId **一致**（见 `SESSION_CHILD_MISMATCH`）。 */
  childId: string
  /** 服务端权威的"我是谁"（`DeviceSession.userId`）。 */
  userId: string
  /** 原始 `MemberRole` 字符串（guardian | child | viewer）—— 形状校验在 `toSessionActor()`。 */
  activeRole: string
  /** `DeviceSession.expiresAt`：Prisma 给 `Date`，JSON 线上传输可能是 ISO 字符串。 */
  expiresAt: Date | string
  /**
   * `DeviceSession.kidModeUntil`（W14，2026-11-03）—— 孩子模式的到期绝对时刻。
   *
   * ★ 可选：它是在 W14 才加的列，而本接口被**大量**既有用例 / 替身构造。
   *   缺省（`undefined`）与 `null` 同义 = 「没开孩子模式」；这不是"猜默认值"，
   *   而是"这一列在旧行上不存在"的诚实表达（迁移给存量行的正是 NULL）。
   * ★ **有值就降级**：不论还在窗口内（`active`）还是已经到点（`locked`），
   *   角色都必须留在 `child` —— 到点自动回家长模式是明令禁止的安全洞
   *   （`kid-mode.policy.ts` 的口径 ②）。
   */
  kidModeUntil?: Date | string | null
}

/** 会话行**形状**问题（**不是**权限判定）的专用错误 —— 守卫把它翻成 500。 */
export class SessionRowShapeError extends Error {
  constructor(
    readonly code:
      | 'INVALID_SESSION_ROLE'
      | 'INVALID_SESSION_EXPIRY'
      | 'INVALID_KID_MODE_EXPIRY'
      | 'SESSION_CHILD_MISMATCH',
    message: string
  ) {
    super(message)
    this.name = 'SessionRowShapeError'
  }
}

export type SessionDenial = 'SESSION_NOT_FOUND'

export type SessionVerdict =
  | { kind: 'ALLOW'; row: SessionLookupRow }
  | { kind: 'DENY'; code: SessionDenial }

/** 解析成毫秒时间戳；解析不出 ⇒ 形状错误（`NaN > n` 恒为 `false`，静默的失败最难查）。 */
function toEpoch(expiresAt: Date | string): number {
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt)
  if (!Number.isFinite(ms)) {
    throw new SessionRowShapeError(
      'INVALID_SESSION_EXPIRY',
      `会话的 expiresAt 无法解析：${JSON.stringify(expiresAt)}（过期判定依赖它，` +
        '解析不出时**绝不能**当成"没过期"继续 —— 那会让 TTL 静默失效）。'
    )
  }
  return ms
}

const KNOWN_SESSION_ROLES: readonly string[] = ['guardian', 'child', 'viewer']

/**
 * 解析 `kidModeUntil`；缺省 / `null` ⇒ `null`（没开孩子模式），解析不出 ⇒ 形状错误。
 *
 * ★ 为什么**不能**把解析失败当成 `null`：那会让一个坏时间戳静默变成
 *   "这台设备没开孩子模式" ⇒ 孩子白拿家长权限。与 `toEpoch()` 同一条理由：
 *   静默的失败最难查，而且方向正好朝危险的一侧。
 */
function kidModeEpochOf(kidModeUntil: Date | string | null | undefined): number | null {
  if (kidModeUntil === null || kidModeUntil === undefined) return null
  const ms = kidModeUntil instanceof Date ? kidModeUntil.getTime() : Date.parse(kidModeUntil)
  if (!Number.isFinite(ms)) {
    throw new SessionRowShapeError(
      'INVALID_KID_MODE_EXPIRY',
      `会话的 kidModeUntil 无法解析：${JSON.stringify(kidModeUntil)}（孩子模式的降级判定依赖它，` +
        '解析不出时**绝不能**当成"没开孩子模式"继续 —— 那等于把家长权限还给正在用手机的孩子）。'
    )
  }
  return ms
}

function isKnownSessionRole(value: string): value is Role | 'viewer' {
  return KNOWN_SESSION_ROLES.includes(value)
}

/**
 * 会话**是否仍在有效期内**（`02` §7 的 TTL）。
 * 边界口径：`expiresAt === now` 即视为**已过期**（到期时刻不再有效）——
 * 写成 `>=` 还是 `>` 这种事必须在**一处**定死并有用例钉着，否则两端各理解一种。
 */
export function isSessionActive(row: SessionLookupRow, now: Date): boolean {
  return toEpoch(row.expiresAt) > now.getTime()
}

/**
 * 会话的**有效角色** —— 身份解析的真正产物（`02` §7 / §9.19）。
 *
 * 三条规则，顺序不能换：
 *   ① 角色取值必须在 `MemberRole` 白名单内（否则 **500**：库里存了枚举外的值）；
 *   ② `guardian` 且**已过期** ⇒ **回落 `child`**（§9.19）—— 降级，不是拒绝；
 *   ③ 其余情况原样返回（`child` 会话过期仍是 `child`：它本来就没有更高权限可收）。
 *
 * ★ 这里**没有**、也**不许有**"过期就放行"的分支：回落方向只有一个 —— 最小权限。
 */
export function effectiveRole(row: SessionLookupRow, now: Date): Role | 'viewer' {
  if (!isKnownSessionRole(row.activeRole)) {
    throw new SessionRowShapeError(
      'INVALID_SESSION_ROLE',
      `会话上的 activeRole 非法：${JSON.stringify(row.activeRole)}` +
        `（MemberRole 只有 guardian / child / viewer）。deviceId=${row.deviceId} userId=${row.userId}` +
        ' —— 这是**数据/实现**的问题，不是权限问题，故 500 而不是 401/403。'
    )
  }

  // ★ W14（2026-11-03）：孩子模式 **优先于** activeRole / expiresAt。
  //
  //   `kidModeUntil` 有值就降级为 child，**不区分**还在窗口内还是已经到点：
  //     · 窗口内        —— 家长主动交出了手机；
  //     · 已经到点      —— 仍然降级，直到家长输入 PIN 收回（`locked`）。
  //   后者是 A 方案的**全部意义**：如果到点就 `expiresAt` 生效、guardian 自动回来，
  //   孩子只要等 30 分钟就自己拿回了家长权限，能批自己的心愿 —— 比不做管控更糟。
  //
  //   ★ 只降级 `guardian`：`viewer` 比 `child` **更小**，把它改成 child 是提权
  //     （只读成员会突然能打卡）。这正是"降级方向只有一个"的具体体现。
  if (row.activeRole === 'guardian' && kidModeEpochOf(row.kidModeUntil) !== null) {
    return 'child'
  }

  if (row.activeRole === 'guardian' && !isSessionActive(row, now)) {
    return 'child'
  }
  return row.activeRole
}

/**
 * 身份判定（纯函数，可穷举）。
 *
 * 一处 fail-closed：**查不到会话 ⇒ `SESSION_NOT_FOUND`**。
 * 「查不到」不是异常，但**绝不是"那就当作匿名、按 child 放行吧"** ——
 * 那会让身份层变成可选（与 `resolveMembership()` 的 ① 同一教训）。
 *
 * ★ `requestedChildId` 参与判定：会话行必须属于**本次请求的这个孩子**。
 *   对不上 ⇒ `SessionRowShapeError`（500），因为 (deviceId, childId) 是查询键，
 *   对不上只可能是**适配器没有按 childId 查**（实现问题），不是用户输入问题。
 */
export function resolveSession(
  row: SessionLookupRow | null,
  requestedChildId: string,
  now: Date
): SessionVerdict {
  if (row === null) return { kind: 'DENY', code: 'SESSION_NOT_FOUND' }

  if (row.childId !== requestedChildId) {
    throw new SessionRowShapeError(
      'SESSION_CHILD_MISMATCH',
      `会话返回的 childId=${JSON.stringify(row.childId)} 与本次请求的 ` +
        `${JSON.stringify(requestedChildId)} 不一致（deviceId=${row.deviceId}）：` +
        '(deviceId, childId) 是查询键，对不上意味着适配器**没有按 childId 查**（例如写死/忽略该参数）。' +
        '★ 绝不能放行 —— 那样"在哪个孩子的档案上"这一半身份就是客户端说了算。'
    )
  }

  // 提前触发角色/时间的形状校验：坏数据必须在**判定阶段**就响亮，
  // 而不是等业务层拿到一个可疑的 actor（见文件头「形状与判定是两件事」）。
  effectiveRole(row, now)
  toEpoch(row.expiresAt)
  // W14：`kidModeUntil` 与 `expiresAt` 同样是"判定依赖的时间戳"，坏值必须 500。
  kidModeEpochOf(row.kidModeUntil)

  return { kind: 'ALLOW', row }
}

/**
 * 把原始行变成可用的「身份」：`userId` ＋ **有效角色** ＋ 被作用的孩子。
 *
 * ★ 返回值里**没有**客户端提供的任何东西 —— 这是本阶段的核心目标：
 *   「我是谁 / 我是什么角色」在请求路径上只剩这一个来源（`DeviceSession` 行）。
 *   （`childId` 虽是客户端选择器，但它已被 `resolveSession()` 的同源校验钉死：
 *    只有"这台设备在这个孩子档案上有会话"的取值才走得下去。）
 */
export function toSessionActor(
  row: SessionLookupRow,
  requestedChildId: string,
  now: Date
): { actor: { userId: string; role: Role | 'viewer' }; childId: string } {
  const verdict = resolveSession(row, requestedChildId, now)
  if (verdict.kind === 'DENY') {
    throw new Error('toSessionActor 只接受已通过判定（ALLOW）的会话行：内部调用顺序错了')
  }
  return {
    actor: { userId: row.userId, role: effectiveRole(row, now) },
    childId: requestedChildId
  }
}

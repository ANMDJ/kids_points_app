import { request } from '@tarojs/taro'

import {
  kAuthorizationHeader,
  sharedAuthTokens
} from './auth_token_holder'
import {
  ReadApiConfig,
  kChildIdHeader,
  kDeviceIdHeader,
  type ReadEnvironment
} from './read_api'
import { ReadApiException } from './read_api_errors'
import { readCompiledEnvironment } from './compiled_env'
import {
  ConsentStateDto,
  FamilyDeletionStateDto,
  HabitDto,
  InviteDto,
  MemberDto,
  RuleDto,
  WishDto
} from './read_dto'
import { WriteApiException } from './write_api_errors'
import {
  ApprovalDto,
  ChildProfileDto,
  InviteAcceptDto,
  InviteRevokeDto,
  MemberRemoveDto,
  NotificationReadDto,
  TrashTargetDto,
  WrittenRecordDto
} from './write_dto'
import type { MemberRole, MutableMemberRole } from './types'
import { INVITE_MAX_TTL_DAYS, INVITE_MAX_USES } from './types'
import { normalizeInviteCodeInput } from '../utils/invite_code'

/** 写端点用到的 HTTP 方法（与后端 REST 语义一致，幂等哈希按真实方法算）。 */
export type WriteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** 写传输层的一行响应 —— 测试替身只需要造这个。 */
export interface WriteHttpResponse {
  statusCode: number
  body: unknown
}

/**
 * 写传输层接口。
 *
 * 刻意与只读的 `ReadTransport` 分开：写请求必须带 body / Content-Type，
 * 且**不允许**自动重试（重试要靠幂等键）。
 *
 * `body` 允许为 null：DELETE 没有请求体，目标已经在路径里。
 */
export interface WriteTransport {
  send(
    uri: string,
    headers: Record<string, string>,
    body: Record<string, unknown> | null,
    timeoutMs: number,
    method?: WriteMethod
  ): Promise<WriteHttpResponse>
  close?(): void
}

/** 基于 `Taro.request` 的最小实现。 */
export class TaroWriteTransport implements WriteTransport {
  async send(
    uri: string,
    headers: Record<string, string>,
    body: Record<string, unknown> | null,
    timeoutMs: number,
    method: WriteMethod = 'POST'
  ): Promise<WriteHttpResponse> {
    try {
      const response = await request({
        url: uri,
        // Taro 的方法联合类型没有导出，这里按同一份字符串转一次，
        // 避免为了 PATCH 去 `as any` 把整条请求的类型安全一起丢掉。
        method: method as Parameters<typeof request>[0]['method'],
        header: headers,
        data: body ?? undefined,
        dataType: 'json',
        timeout: timeoutMs
      })
      return { statusCode: response.statusCode, body: response.data }
    } catch (error) {
      if (error instanceof WriteApiException) throw error
      throw WriteApiException.network(error)
    }
  }
}

/** AppStore 依赖的写能力（测试可注入自己的实现，不必起 HTTP 服务）。 */
export interface WriteApi {
  /** 打卡。返回服务端真正写入的流水。 */
  checkIn(
    habitId: string,
    idempotencyKey?: string
  ): Promise<WrittenRecordDto>

  /** 撤销一条打卡。返回**冲正记录**（不是原记录）。 */
  reverse(
    recordId: string,
    input?: { idempotencyKey?: string; note?: string }
  ): Promise<WrittenRecordDto>

  /**
   * 「记一笔」（`adjust_points`）：家长手动加 / 扣分。
   *
   * `points` **带符号**（负 = 扣分），与回包同构 —— 调用方不需要再取反；
   * 服务端按锁内余额算 `balanceAfter` 并落一条 `category='adjust'` 的流水。
   */
  adjust(input: {
    title: string
    points: number
    note?: string
    idempotencyKey?: string
  }): Promise<WrittenRecordDto>

  /**
   * 新建规则。`points` 带符号（负 = 扣分），服务端落库时拆成
   * 「正数分值 + direction」，回包仍是带符号的分值。
   */
  createRule(input: {
    title: string
    condition: string
    dailyLimit: number
    points: number
    icon: string
    color: string
    idempotencyKey?: string
  }): Promise<RuleDto>

  /**
   * 更新规则。`expectedVersion` 是**客户端看到的版本号**：与服务端不一致
   * ⇒ 409 `RULE_VERSION_CONFLICT`，绝不静默覆盖别人刚改的内容。
   */
  updateRule(
    ruleId: string,
    input: {
      title: string
      condition: string
      dailyLimit: number
      points: number
      expectedVersion: number
      idempotencyKey?: string
    }
  ): Promise<RuleDto>

  /** 软删规则（进回收站）。返回服务端确认删除的 `ruleId`。 */
  deleteRule(ruleId: string, idempotencyKey?: string): Promise<string>

  /** 按规则生成首页习惯。返回与 `GET /home` 的 `habits[]` 同构的行。 */
  addHabitFromRule(ruleId: string, idempotencyKey?: string): Promise<HabitDto>

  /**
   * 新增心愿（`add_wish`）。
   *
   * 家长 ⇒ 直接落库；孩子的权限矩阵若是 `REQUIRE_APPROVAL`，服务端回
   * 403 `APPROVAL_REQUIRED` —— 这里**不吞**该业务码，由 store 翻成
   * 「需要家长确认」，界面据此提示，而不是假装保存成功。
   */
  createWish(input: {
    title: string
    cost: number
    emoji: string
    idempotencyKey?: string
  }): Promise<WishDto>

  /**
   * 软删心愿（`delete_wish`，进回收站）。返回服务端确认删除的 `wishId`。
   *
   * 删除**不碰流水**：已发生的兑换记录继续带 `wishId` 回指这条心愿（修 C9）。
   */
  deleteWish(wishId: string, idempotencyKey?: string): Promise<string>

  /**
   * 软删首页习惯（`DELETE /habits/:id`，`delete_habit`，W5-F）—— 修 C9。
   *
   * 服务端只改 `status='deleted'` + `deletedAt`，**不碰流水**，因此卡片上的
   * 历史打卡仍能回指这条习惯。返回服务端确认删除的 `habitId`。
   */
  deleteHabit(habitId: string, idempotencyKey?: string): Promise<string>

  /**
   * 从回收站恢复一条（`POST /trash/:kind/:id/restore`，W5-F）。
   *
   * `kind` 只接受 `point_rule` / `wish` / `habit` —— 拼错的类型在**发请求之前**
   * 就抛错（服务端会回 400 `TRASH_KIND_INVALID`，用户不该看到本可避免的错误）。
   */
  restoreTrashItem(kind: string, id: string): Promise<TrashTargetDto>

  /**
   * 彻底删除回收站里的一条（`DELETE /trash/:kind/:id`）—— **不可逆**，W5-F。
   *
   * 服务端只允许删「已经在回收站里」的条目；拒绝（还有流水引用 / 根本没软删）
   * 时原样抛 4xx，由 store 把 `userMessage` 展示给用户。
   */
  purgeTrashItem(kind: string, id: string): Promise<TrashTargetDto>

  /**
   * 申请兑换心愿（`POST /approvals`，`action='redeem'`）。
   *
   * 后端**没有**独立的「兑换」路由：`redeem` 在权限矩阵里对两个角色都是
   * `REQUIRE_APPROVAL`，所以唯一的正确路径就是建一条审批请求。
   * `costSnapshot` **不由客户端提交** —— 服务端按心愿当前价格快照，
   * 客户端说了不算（否则改一个数字就能少扣分）。
   *
   * 回包 `status === 'pending'` 时**还没有扣分**：界面必须说
   * 「已提交，等家长确认」，不能说「兑换成功」。
   */
  requestRedeem(wishId: string, idempotencyKey?: string): Promise<ApprovalDto>

  /**
   * 申请新增心愿（`POST /approvals`，`action='add_wish'`，2026-11-03）。
   *
   * `add_wish` 对孩子是 `REQUIRE_APPROVAL`：`POST /wishes` 只会回 403
   * **且不落任何审批行**。只提示一句「需要家长确认」的话，家长收件箱里
   * 永远看不到这条申请 —— 所以 store 在 403 `APPROVAL_REQUIRED` 之后
   * 必须调用本方法，把这次操作真的落成审批单。
   *
   * 只发 `action + title + cost + emoji`（payload 由服务端快照）；
   * 不发 `autoApprove`（孩子没有批准资格）。
   */
  requestAddWish(input: {
    title: string
    cost: number
    emoji: string
    idempotencyKey?: string
  }): Promise<ApprovalDto>

  /**
   * 家长批准 / 拒绝一条申请（`POST /approvals/:id/decide`，W5-D）。
   *
   * `decision` 只接受 `approved` / `rejected` —— 其他终态（`expired` /
   * `invalidated`）由服务端自己落，客户端不能"替服务端宣布失效"。
   *
   * 回包是审批单本身：`approved` 时 `executedRecordId` 指向真正落下的流水
   * （调用方随后刷新快照就能看到余额变化），`rejected` 时为 null。
   *
   * 只有家长角色调得通：孩子设备会拿到 403；重复处理 / 已过期 / 前提变化
   * 都是 409（`ALREADY_DECIDED` / `APPROVAL_EXPIRED` / `APPROVAL_INVALIDATED`）——
   * 页面据此刷新列表，而不是把失败当成"网络问题"让用户反复重试。
   */
  decideApproval(
    approvalId: string,
    input: { approve: boolean; idempotencyKey?: string }
  ): Promise<ApprovalDto>

  /**
   * 撤回自己提交的申请（`POST /approvals/:id/withdraw`，W5-J）。
   *
   * **没有请求体**：撤回只需要审批单 id（申请人由会话推出）。
   * 只有申请人能撤回 —— 别人（包括家长）会拿到 403 `NOT_REQUESTER`；
   * 已批 / 已拒 / 已过期是 409，页面据此刷新而不是让用户反复点。
   *
   * 回包 `status` 必须是 `withdrawn`：不一致说明契约漂移，调用方不能当成功。
   */
  withdrawApproval(
    approvalId: string,
    idempotencyKey?: string
  ): Promise<ApprovalDto>

  /**
   * 改孩子昵称（`PATCH /child`，`edit_child_profile`，W5-E）。
   *
   * 幂等：改成同一个名字时服务端**不写库也不写审计**，直接回 200，
   * 所以这里不带幂等键。
   *
   * 回包 `childId` 必须等于本设备会话的孩子；不一致说明这次改名落到了
   * 别人头上 ⇒ 抛 `malformed`，绝不写进本地档案。
   */
  renameChild(name: string): Promise<ChildProfileDto>

  /**
   * 改成员角色（`PATCH /members/:id`，`change_member_role`，W5-H）。
   *
   * `role` 只接受 `guardian` / `child`：`viewer` 不是合法目标角色
   * （邀请码也建不出它），传进来在**发请求之前**就拒绝。
   *
   * 常见业务拒绝（都必须原样展示，不能让界面假装成功）：
   *   · 403 `CANNOT_MODIFY_SELF` —— 两条写路由都禁止作用于自己
   *     （自我降级 = 把自己锁在门外，而没有家长能救你）
   *   · 403 `FORBIDDEN` —— 当前角色不是家长
   *   · 409 `LAST_GUARDIAN_PROTECTED` —— 会把这个孩子降成 0 位家长
   *   · 409 `MEMBER_NOT_ACTIVE` —— 目标成员位已被移出
   *   · 404 `MEMBER_NOT_FOUND` —— 不存在 / 属于别的孩子（同一句话）
   *
   * 同角色重复提交在服务端是**构造幂等**（200、不写第二条审计），
   * 因此不需要幂等键。回包 `role` 必须等于请求的角色 —— 不一致说明契约漂移，
   * 宁可显式失败。
   */
  changeMemberRole(
    memberId: string,
    role: MutableMemberRole
  ): Promise<MemberDto>

  /**
   * 移出成员（`DELETE /members/:id`，`remove_member`，W5-H）。
   *
   * 服务端只做**软删**（`status='removed'`）并**保留会话**：删会话会把
   * 「你被移出」伪装成「你没登录」（401）。重复调用是构造幂等
   * （200、`removedAt` 保持第一次的值）。
   *
   * 403 `CANNOT_MODIFY_SELF`（不能移出自己 ⇒ 没有自助「退出家庭」）、
   * 403 `FORBIDDEN`、409 `LAST_GUARDIAN_PROTECTED` 都按原样展示。
   * 回包 `memberId` 必须等于请求的 id。
   */
  removeMember(memberId: string): Promise<MemberRemoveDto>

  /**
   * 生成邀请码（`POST /invites`，`invite_member`，W5-I）。
   *
   * 参数范围在**发请求之前**就按后端 DTO 判掉（`@IsIn(['child','guardian'])`、
   * `@Max(10)` / `@Max(30)`）：越界一定会 400，白跑一趟还要等网络。
   *
   * 回包是**新码全量行**（`{ id, code, role, maxUses, usedCount, expiresAt,
   * revoked, createdAt }`）—— 直接插到列表头，不重拉整页：重拉会让刚生成的码
   * 排到服务端顺序里的某个位置，用户复制错了就是别人的码。
   *
   * 常见业务拒绝：403 `FORBIDDEN`（不是家长）、409
   * `INVITE_CODE_GENERATION_FAILED`（连续撞码，服务端放弃）。
   */
  createInvite(input: {
    role: MutableMemberRole
    maxUses: number
    expiresInDays: number
  }): Promise<InviteDto>

  /**
   * 吊销邀请码（`POST /invites/:id/revoke`，`invite_member`，W5-I）。
   *
   * 构造幂等：已经吊销过的码再吊销仍是 200（且不写第二条审计）。404
   * `INVITE_NOT_FOUND` = 不存在或不属于这个孩子（同一句话，不泄露别家 id）。
   *
   * 回包只有 `{ id, revoked }` —— 服务端不回整行，客户端不要把「200」
   * 理解成「这次真的改了一行」，也不要拿它去覆盖别的字段。
   */
  revokeInvite(inviteId: string): Promise<InviteRevokeDto>

  /**
   * 用邀请码**加入一个已有家庭**（`POST /invites/accept`，P0-3，2026-11-03）。
   *
   * ── 为什么它属于写层 ────────────────────────────────────────────────────────
   *   `AuthApi` 的 `send()` 只带 token + deviceId，而这条路由要求
   *   `x-kp-child-id`（`DeviceSessionGuard` 按 `(deviceId, childId)` 查会话行）。
   *   写层的 `config.effectiveChildId` 正好就是"我现在在哪个孩子上"，
   *   加入成功后立刻改成新孩子（`sharedDeviceContext.applyChild`）。
   *
   * ★ 请求体**只有** `code`：角色只能来自邀请码行；传 `role` / `childId`
   *   会被后端 `forbidNonWhitelisted` 400，而且等于让客户端自报权限。
   *
   * 失败码（`write_api_errors.ts` 已逐条翻成中文）：
   *   400 `INVITE_CODE_MALFORMED`、409 `INVITE_CODE_UNAVAILABLE`、
   *   409 `ALREADY_MEMBER`（不消耗名额）、401（会话失效）。
   */
  acceptInvite(code: string): Promise<InviteAcceptDto>

  /**
   * 作出监护人同意（`POST /consent`，W7-B）。
   *
   * 请求体只有 `{accepted: true}`：协议版本由**服务端**决定
   * （`CONSENT_VERSION`），客户端不能自报 —— 否则家长同意的可能是
   * 一版服务端根本没生效的文本。
   *
   * 构造幂等：已同意再调仍是 200，`grantedAt` 保持第一次的时间。
   * 常见业务拒绝：403 `FORBIDDEN`（不是家长）、400 `CONSENT_NOT_ACCEPTED`、
   * 500 `CONSENT_VERSION_MISSING`（服务端漏配协议版本）。
   */
  grantConsent(): Promise<ConsentStateDto>

  /**
   * 撤回监护人同意（`POST /consent/withdraw`，W7-B）。
   *
   * 没有请求体：目标孩子由会话决定，不需要幂等键。
   *
   * 撤回后写动作会被 `ConsentGuard` 拦成 403 `CONSENT_REQUIRED`；读取与
   * 重新同意仍可用。回包状态是 `withdrawn`（曾同意过）或 `none`
   * （从没同意过）—— 两种都算撤回成功，界面按状态文案区分。
   */
  withdrawConsent(): Promise<ConsentStateDto>

  /**
   * 申请删除家庭数据（`POST /family-deletion`，W7-D）。
   *
   * 请求体**只有** `{confirmed: true}`：删除对象来自会话，冷却期（7 天）由
   * 服务端政策决定。确认必须是布尔真值 —— 后端不把「没带字段」读成同意，
   * 客户端也不提供「默认确认」的调用方式。
   *
   * 构造幂等：已在冷却期再调仍是 200、返回**同一条**请求（`requestedAt` 不变）。
   * 常见业务拒绝：403 `FORBIDDEN`（不是家长）、400 `FAMILY_DELETION_NOT_CONFIRMED`、
   * 409 `FAMILY_DELETION_ALREADY_EXECUTED`、404 `CHILD_NOT_FOUND`。
   */
  requestFamilyDeletion(): Promise<FamilyDeletionStateDto>

  /**
   * 撤销待执行的删除（`POST /family-deletion/cancel`，W7-D）。
   *
   * 没有请求体；撤销的只有「当前这条 pending 请求」。
   * 没有 pending 时回 409 `FAMILY_DELETION_NOT_PENDING` —— 那不是「本来就没申请」，
   * 而是「这个动作此刻没有对象」；调用方据此刷新状态。
   */
  cancelFamilyDeletion(): Promise<FamilyDeletionStateDto>

  /**
   * 标记一条站内通知已读（`PATCH /notifications/:id/read`，W5-L）。
   *
   * 幂等：已读的再标记仍是 200，`readAt` 保持**第一次**的时间。
   * 404 `NOTIFICATION_NOT_FOUND` = 不存在**或**不是发给我的（同一句话，
   * 不泄露别人那条的 id）—— 调用方据此刷新列表，而不是无限重试。
   *
   * 没有请求体：id 全在路径里，目标明确，不需要幂等键。
   */
  markNotificationRead(notificationId: string): Promise<NotificationReadDto>
}

/** `POST /records/check-in` 与 `POST /records/:id/reverse` 的客户端。 */
export class WriteApiClient implements WriteApi {
  readonly config: ReadApiConfig
  readonly timeoutMs: number
  private readonly transport: WriteTransport

  constructor(input: {
    config: ReadApiConfig
    transport?: WriteTransport
    timeoutMs?: number
  }) {
    this.config = input.config
    this.timeoutMs = input.timeoutMs ?? 10000
    this.transport = input.transport ?? new TaroWriteTransport()
  }

  async checkIn(
    habitId: string,
    idempotencyKey?: string
  ): Promise<WrittenRecordDto> {
    const id = habitId.trim()
    if (id === '') {
      throw new Error('habitId 不能为空')
    }
    return this.send(
      'POST',
      '/records/check-in',
      { habitId: id },
      parseWrittenRecord,
      idempotencyKey
    )
  }

  async reverse(
    recordId: string,
    input: { idempotencyKey?: string; note?: string } = {}
  ): Promise<WrittenRecordDto> {
    const id = recordId.trim()
    if (id === '') {
      throw new Error('recordId 不能为空')
    }
    const note = input.note?.trim() ?? ''
    return this.send(
      'POST',
      `/records/${encodeURIComponent(id)}/reverse`,
      note === '' ? {} : { note },
      parseWrittenRecord,
      input.idempotencyKey
    )
  }

  async adjust(input: {
    title: string
    points: number
    note?: string
    idempotencyKey?: string
  }): Promise<WrittenRecordDto> {
    const title = input.title.trim()
    if (title === '') {
      throw new Error('title 不能为空')
    }
    if (input.points === 0) {
      throw new Error('points 不能为 0')
    }
    const note = input.note?.trim() ?? ''
    return this.send(
      'POST',
      '/records/adjust',
      note === ''
        ? { title, points: input.points }
        : { title, points: input.points, note },
      parseWrittenRecord,
      input.idempotencyKey
    )
  }

  async createRule(input: {
    title: string
    condition: string
    dailyLimit: number
    points: number
    icon: string
    color: string
    idempotencyKey?: string
  }): Promise<RuleDto> {
    const title = input.title.trim()
    if (title === '') {
      throw new Error('title 不能为空')
    }
    return this.send(
      'POST',
      '/point-rules',
      {
        title,
        condition: input.condition.trim(),
        dailyLimit: input.dailyLimit,
        // 带符号原样发出：扣分由服务端转成「正数 + direction」，
        // 客户端再取反一次就会把扣分变加分。
        points: input.points,
        icon: input.icon,
        color: input.color
      },
      (raw) => this.parseRule(raw),
      input.idempotencyKey
    )
  }

  async updateRule(
    ruleId: string,
    input: {
      title: string
      condition: string
      dailyLimit: number
      points: number
      expectedVersion: number
      idempotencyKey?: string
    }
  ): Promise<RuleDto> {
    const id = this.requireId(ruleId, 'ruleId')
    const title = input.title.trim()
    if (title === '') {
      throw new Error('title 不能为空')
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error('expectedVersion 必须 ≥ 1')
    }
    return this.send(
      'PATCH',
      `/point-rules/${encodeURIComponent(id)}`,
      {
        title,
        condition: input.condition.trim(),
        dailyLimit: input.dailyLimit,
        points: input.points,
        // 乐观锁：客户端只声明「我改的是第几版」，版本递增由服务端做。
        expectedVersion: input.expectedVersion
      },
      (raw) => this.parseRule(raw),
      input.idempotencyKey
    )
  }

  async deleteRule(ruleId: string, idempotencyKey?: string): Promise<string> {
    const id = this.requireId(ruleId, 'ruleId')
    const decoded = await this.send<unknown>(
      'DELETE',
      `/point-rules/${encodeURIComponent(id)}`,
      // DELETE 没有请求体：目标已经在路径里，幂等哈希也按 null body 计算。
      null,
      (raw) => raw,
      idempotencyKey
    )
    const returned =
      typeof decoded === 'object' && decoded !== null
        ? (decoded as Record<string, unknown>).ruleId
        : undefined
    if (returned !== id) {
      // 回包确认的不是「我删的那条」⇒ 宁可报错，也不能让界面假装删对了。
      throw WriteApiException.malformed(
        '$.ruleId',
        `删除回包的 ruleId 与请求不一致：${String(returned)} != ${id}`
      )
    }
    return id
  }

  async addHabitFromRule(
    ruleId: string,
    idempotencyKey?: string
  ): Promise<HabitDto> {
    const id = this.requireId(ruleId, 'ruleId')
    return this.send(
      'POST',
      `/point-rules/${encodeURIComponent(id)}/habits`,
      null,
      (raw) => this.parseHabit(raw),
      idempotencyKey
    )
  }

  async createWish(input: {
    title: string
    cost: number
    emoji: string
    idempotencyKey?: string
  }): Promise<WishDto> {
    const title = input.title.trim()
    if (title === '') throw new Error('title 不能为空')
    if (!Number.isInteger(input.cost) || input.cost < 1) {
      throw new Error('cost 必须是 ≥ 1 的整数')
    }
    const emoji = input.emoji.trim()
    if (emoji === '') throw new Error('emoji 不能为空')
    return this.send(
      'POST',
      '/wishes',
      {
        title,
        cost: input.cost,
        emoji
        // 配色**不传**：由服务端按「空档优先，否则 id 哈希」决定，
        // 避免客户端和服务端各算一次而给出两个颜色。
      },
      (raw) => this.parseWish(raw),
      input.idempotencyKey
    )
  }

  async deleteWish(wishId: string, idempotencyKey?: string): Promise<string> {
    const id = this.requireId(wishId, 'wishId')
    const decoded = await this.send<unknown>(
      'DELETE',
      `/wishes/${encodeURIComponent(id)}`,
      // DELETE 没有请求体：目标已经在路径里，幂等哈希也按 null body 计算。
      null,
      (raw) => raw,
      idempotencyKey
    )
    const returned =
      typeof decoded === 'object' && decoded !== null
        ? (decoded as Record<string, unknown>).wishId
        : undefined
    if (returned !== id) {
      // 回包确认的不是「我删的那条」⇒ 宁可报错，也不能让界面假装删对了。
      throw WriteApiException.malformed(
        '$.wishId',
        `删除回包的 wishId 与请求不一致：${String(returned)} != ${id}`
      )
    }
    return id
  }

  async deleteHabit(habitId: string, idempotencyKey?: string): Promise<string> {
    const id = this.requireId(habitId, 'habitId')
    const decoded = await this.send<unknown>(
      'DELETE',
      `/habits/${encodeURIComponent(id)}`,
      // DELETE 没有请求体：目标已经在路径里，幂等哈希也按 null body 计算。
      null,
      (raw) => raw,
      idempotencyKey
    )
    const returned =
      typeof decoded === 'object' && decoded !== null
        ? (decoded as Record<string, unknown>).habitId
        : undefined
    if (returned !== id) {
      // 回包确认的不是「我删的那条」⇒ 宁可报错，也不能让界面假装删对了。
      throw WriteApiException.malformed(
        '$.habitId',
        `删除回包的 habitId 与请求不一致：${String(returned)} != ${id}`
      )
    }
    return id
  }

  async restoreTrashItem(kind: string, id: string): Promise<TrashTargetDto> {
    const safeKind = this.trashKind(kind)
    const safeId = this.requireId(id, 'id')
    return this.send<TrashTargetDto>(
      'POST',
      `/trash/${safeKind}/${encodeURIComponent(safeId)}/restore`,
      null,
      (raw) => TrashTargetDto.fromJson(raw, '$', safeKind, safeId)
    )
  }

  async purgeTrashItem(kind: string, id: string): Promise<TrashTargetDto> {
    const safeKind = this.trashKind(kind)
    const safeId = this.requireId(id, 'id')
    return this.send<TrashTargetDto>(
      'DELETE',
      `/trash/${safeKind}/${encodeURIComponent(safeId)}`,
      null,
      (raw) => TrashTargetDto.fromJson(raw, '$', safeKind, safeId)
    )
  }

  /**
   * 回收站只认三个线值；拼错的类型**在发请求之前**就报错 ——
   * 否则服务端会回 400 `TRASH_KIND_INVALID`，用户看到一条本可避免的错误。
   */
  private static readonly trashKinds = ['point_rule', 'wish', 'habit'] as const

  private trashKind(kind: string): string {
    const value = kind.trim()
    if (!(WriteApiClient.trashKinds as readonly string[]).includes(value)) {
      throw new Error(`未知回收站类型：${value}（应为 point_rule / wish / habit）`)
    }
    return value
  }

  async requestRedeem(
    wishId: string,
    idempotencyKey?: string
  ): Promise<ApprovalDto> {
    const id = this.requireId(wishId, 'wishId')
    return this.send<ApprovalDto>(
      'POST',
      '/approvals',
      {
        action: 'redeem',
        targetId: id
        // `autoApprove` **不发**：那是「申请人要求自批」的显式勾选，
        // 孩子没有批准资格 ⇒ 只会换来 400；家长也不该被这个界面代勾。
      },
      (raw) => this.parseApproval(raw),
      idempotencyKey
    )
  }

  async requestAddWish(input: {
    title: string
    cost: number
    emoji: string
    idempotencyKey?: string
  }): Promise<ApprovalDto> {
    const title = input.title.trim()
    if (title === '') throw new Error('title 不能为空')
    if (!Number.isInteger(input.cost) || input.cost < 1 || input.cost > 100000) {
      throw new Error('cost 必须是 1..100000 的整数')
    }
    const emoji = input.emoji.trim()
    if (emoji === '') throw new Error('emoji 不能为空')
    return this.send<ApprovalDto>(
      'POST',
      '/approvals',
      {
        action: 'add_wish',
        title,
        cost: input.cost,
        emoji
        // 不发 `autoApprove`：孩子没有批准资格，带上只会换来 400。
      },
      (raw) => this.parseApproval(raw),
      input.idempotencyKey
    )
  }

  async decideApproval(
    approvalId: string,
    input: { approve: boolean; idempotencyKey?: string }
  ): Promise<ApprovalDto> {
    const id = this.requireId(approvalId, 'approvalId')
    return this.send<ApprovalDto>(
      'POST',
      // 审批单 id 放进路径，客户端不用（也不该）自己拼查询串。
      `/approvals/${encodeURIComponent(id)}/decide`,
      { decision: input.approve ? 'approved' : 'rejected' },
      (raw) => this.parseApproval(raw),
      input.idempotencyKey
    )
  }

  async withdrawApproval(
    approvalId: string,
    idempotencyKey?: string
  ): Promise<ApprovalDto> {
    const id = this.requireId(approvalId, 'approvalId')
    return this.send<ApprovalDto>(
      'POST',
      `/approvals/${encodeURIComponent(id)}/withdraw`,
      // 撤回没有业务参数：申请人由设备会话决定，客户端说了不算。
      null,
      (raw) => this.parseApproval(raw),
      idempotencyKey
    )
  }

  async renameChild(name: string): Promise<ChildProfileDto> {
    const trimmed = name.trim()
    if (trimmed === '') {
      // 空名字在本地就拒：服务端一定会 400，白跑一趟还要等网络。
      // 长度**不在客户端**判：16 个字符是按 code point 算的，
      // 判定只留一份在服务端（emoji / 组合字符在 JS 里数出来不一样）。
      throw new Error('name 不能为空')
    }
    return this.send(
      'PATCH',
      '/child',
      { name: trimmed },
      (raw) => {
        const dto = this.parseChildProfile(raw)
        const sessionChildId = this.config.effectiveChildId
        if (dto.childId !== sessionChildId) {
          throw WriteApiException.malformed(
            '$.childId',
            `回包 childId=${dto.childId} 与当前会话 childId=${sessionChildId} 不一致`
          )
        }
        return dto
      }
    )
  }

  async changeMemberRole(
    memberId: string,
    role: MutableMemberRole
  ): Promise<MemberDto> {
    const id = this.requireId(memberId, 'memberId')
    if (role !== 'guardian' && role !== 'child') {
      // `viewer` 不是合法目标角色（后端 DTO 用 @IsIn(['child','guardian'])）。
      // 在本地就拒绝，不浪费一次必然 400 的往返。
      throw new Error('role 只能是 guardian / child')
    }
    return this.send(
      'PATCH',
      `/members/${encodeURIComponent(id)}`,
      { role },
      (raw) => {
        const dto = this.parseMember(raw)
        if (dto.memberId !== id) {
          // 回包指向别的成员 ⇒ 会话串号 / 后端 bug。
          // 把别人的角色改掉是权限事故，宁可显式失败。
          throw WriteApiException.malformed(
            '$.memberId',
            `回包 memberId=${dto.memberId} 与请求 ${id} 不一致`
          )
        }
        if (dto.role !== role) {
          // 请求降级、回包仍是家长 ⇒ 界面会以为降级成功。
          throw WriteApiException.malformed(
            '$.role',
            `回包 role=${dto.role} 与请求 ${role} 不一致`
          )
        }
        return dto
      }
    )
  }

  async removeMember(memberId: string): Promise<MemberRemoveDto> {
    const id = this.requireId(memberId, 'memberId')
    return this.send(
      'DELETE',
      `/members/${encodeURIComponent(id)}`,
      null,
      (raw) => this.parseMemberRemove(raw, id)
    )
  }

  async createInvite(input: {
    role: MutableMemberRole
    maxUses: number
    expiresInDays: number
  }): Promise<InviteDto> {
    const { role, maxUses, expiresInDays } = input
    if (role !== 'guardian' && role !== 'child') {
      // `viewer` 不是可邀请的角色（后端 DTO：@IsIn(['child','guardian'])）。
      throw new Error('role 只能是 guardian / child')
    }
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > INVITE_MAX_USES) {
      throw new Error(`maxUses 必须是 1–${INVITE_MAX_USES} 的整数`)
    }
    if (
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > INVITE_MAX_TTL_DAYS
    ) {
      throw new Error(`expiresInDays 必须是 1–${INVITE_MAX_TTL_DAYS} 的整数`)
    }
    // 不带幂等键：每次生成**都该是新码**（同一个键重放会拿回同一张票，
    // 家长会以为「生成失败」而反复点）。参数范围已在上面拦过。
    return this.send(
      'POST',
      '/invites',
      { role, maxUses, expiresInDays },
      (raw) => {
        const dto = this.parseInvite(raw)
        if (dto.role !== role) {
          // 要的是孩子码、回包却是家长码 ⇒ 发出去就是一次权限事故。
          throw WriteApiException.malformed(
            '$.role',
            `回包 role=${dto.role} 与请求 ${role} 不一致`
          )
        }
        if (dto.maxUses !== maxUses) {
          // 名额被悄悄改写会让「发给 3 个人」变成「只发给 1 个人」。
          throw WriteApiException.malformed(
            '$.maxUses',
            `回包 maxUses=${dto.maxUses} 与请求 ${maxUses} 不一致`
          )
        }
        return dto
      }
    )
  }

  async revokeInvite(inviteId: string): Promise<InviteRevokeDto> {
    const id = this.requireId(inviteId, 'inviteId')
    return this.send(
      'POST',
      `/invites/${encodeURIComponent(id)}/revoke`,
      null,
      (raw) => this.parseInviteRevoke(raw, id)
    )
  }

  async acceptInvite(code: string): Promise<InviteAcceptDto> {
    const normalized = normalizeInviteCodeInput(code)
    if (normalized === '') {
      // 空输入是**编程/界面**问题：这里响亮失败，不发一个必然
      // 400 `INVITE_CODE_MALFORMED` 的请求（界面已经先拦过空值）。
      throw new Error('邀请码不能为空。')
    }
    // 粗上限与后端 `AcceptInviteDto` 的 `@MaxLength(32)` 同口径。
    if (normalized.length > 32) {
      throw new Error('邀请码不能超过 32 个字符。')
    }
    return this.send(
      'POST',
      '/invites/accept',
      { code: normalized },
      (raw) => InviteAcceptDto.fromJson(raw)
    )
  }

  async grantConsent(): Promise<ConsentStateDto> {
    // 显式 `accepted: true`：后端 `@IsDefined()` 拒绝空 body，
    // 这里仍写全 —— 让「同意」这件事在客户端代码里也是显式的。
    return this.send('POST', '/consent', { accepted: true }, (raw) => {
      const dto = this.parseConsent(raw)
      // 服务端说没同意 ⇒ 界面不能显示「已同意」（比如它悄悄走了另一个分支）。
      if (dto.status !== 'granted') {
        throw WriteApiException.malformed(
          '$.status',
          `同意回包 status=${dto.status}，期望 granted`
        )
      }
      return dto
    })
  }

  async withdrawConsent(): Promise<ConsentStateDto> {
    return this.send('POST', '/consent/withdraw', null, (raw) => {
      const dto = this.parseConsent(raw)
      // 撤回回包必须是 withdrawn / none（从未同意）：`granted` 说明没生效。
      if (dto.status === 'granted') {
        throw WriteApiException.malformed(
          '$.status',
          '撤回回包 status=granted —— 撤回没有生效'
        )
      }
      return dto
    })
  }

  async requestFamilyDeletion(): Promise<FamilyDeletionStateDto> {
    // ★ 请求体只有这一个布尔真值：冷却期 / 孩子 / 操作人全部由服务端决定。
    return this.send(
      'POST',
      '/family-deletion',
      { confirmed: true },
      (raw) => {
        const dto = FamilyDeletionStateDto.fromJson(raw, '$')
        // 申请成功的回包必须是 pending：`none` 说明什么都没发生，
        // `executed` 说明它已经在删了 —— 两种都不该被界面显示成「已申请」。
        if (dto.status !== 'pending') {
          throw WriteApiException.malformed(
            '$.status',
            `申请删除的回包 status=${dto.status}，期望 pending`
          )
        }
        return dto
      }
    )
  }

  async cancelFamilyDeletion(): Promise<FamilyDeletionStateDto> {
    return this.send('POST', '/family-deletion/cancel', null, (raw) => {
      const dto = FamilyDeletionStateDto.fromJson(raw, '$')
      if (dto.status !== 'cancelled') {
        throw WriteApiException.malformed(
          '$.status',
          `撤销删除的回包 status=${dto.status}，期望 cancelled`
        )
      }
      return dto
    })
  }

  async markNotificationRead(
    notificationId: string
  ): Promise<NotificationReadDto> {
    const id = this.requireId(notificationId, 'notificationId')
    return this.send(
      'PATCH',
      `/notifications/${encodeURIComponent(id)}/read`,
      null,
      (raw) => this.parseNotificationRead(raw, id)
    )
  }

  private requireId(value: string, name: string): string {
    const id = value.trim()
    if (id === '') throw new Error(`${name} 不能为空`)
    return id
  }

  /**
   * 严格解析失败（`ReadApiException`）也必须归一到写异常：
   * 页面只处理一种错误类型，不必知道「这次是读 DTO 报的错」。
   */
  private parseRule(raw: unknown): RuleDto {
    try {
      return RuleDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseHabit(raw: unknown): HabitDto {
    try {
      return HabitDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseWish(raw: unknown): WishDto {
    try {
      return WishDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseApproval(raw: unknown): ApprovalDto {
    try {
      return ApprovalDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseChildProfile(raw: unknown): ChildProfileDto {
    try {
      return ChildProfileDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseMember(raw: unknown): MemberDto {
    try {
      return MemberDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseMemberRemove(raw: unknown, expectedMemberId: string): MemberRemoveDto {
    try {
      return MemberRemoveDto.fromJson(raw, '$', expectedMemberId)
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseInvite(raw: unknown): InviteDto {
    try {
      return InviteDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseInviteRevoke(
    raw: unknown,
    expectedInviteId: string
  ): InviteRevokeDto {
    try {
      return InviteRevokeDto.fromJson(raw, '$', expectedInviteId)
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseConsent(raw: unknown): ConsentStateDto {
    try {
      return ConsentStateDto.fromJson(raw, '$')
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private parseNotificationRead(
    raw: unknown,
    expectedNotificationId: string
  ): NotificationReadDto {
    try {
      return NotificationReadDto.fromJson(raw, '$', expectedNotificationId)
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('$', error.detail ?? undefined)
      }
      throw error
    }
  }

  private async send<T>(
    method: WriteMethod,
    path: string,
    body: Record<string, unknown> | null,
    parse: (raw: unknown) => T,
    idempotencyKey?: string
  ): Promise<T> {
    const configError = this.config.validationError
    if (configError !== null) {
      throw new WriteApiException('badRequest', configError, {
        code: 'CLIENT_NOT_CONFIGURED'
      })
    }

    const key = idempotencyKey?.trim() ?? ''
    if (key.length > 200) {
      throw new Error('idempotencyKey 不能超过 200 字符（后端同口径）')
    }

    const uri = this.config.uri(path)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [kDeviceIdHeader]: this.config.effectiveDeviceId,
      [kChildIdHeader]: this.config.effectiveChildId
    }
    // W9-A：登录之后每个写请求也要带 Bearer（`40` §10.1）。
    // 持有者为空时一个头都不加 ⇒ 预览模式的既有行为逐字不变。
    const authorization = sharedAuthTokens.authorizationHeader()
    if (authorization !== null) headers[kAuthorizationHeader] = authorization
    // 没有请求体就不声明 Content-Type：DELETE 带空 JSON 会被严格后端拒掉。
    if (body !== null) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
    }
    if (key !== '') headers['idempotency-key'] = key

    let response: WriteHttpResponse
    try {
      response = await withTimeout(
        this.transport.send(uri, headers, body, this.timeoutMs, method),
        this.timeoutMs
      )
    } catch (error) {
      if (error instanceof WriteApiException) throw error
      throw WriteApiException.network(error)
    }

    const decoded = decodeBody(response.body)
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw WriteApiException.fromHttp({
        statusCode: response.statusCode,
        body: decoded
      })
    }
    if (decoded === null) {
      throw WriteApiException.malformed(
        '$',
        `HTTP ${response.statusCode} 但响应体为空`
      )
    }
    return parse(decoded)
  }
}

/** 写回包 → 流水 DTO 的解析（把读层异常归一成写异常）。 */
function parseWrittenRecord(raw: unknown): WrittenRecordDto {
  return WrittenRecordDto.fromJson(raw)
}

/**
 * 配置齐全时才构造写客户端；否则返回 null，store 继续使用本地预览数据。
 * 不抛错、不偷偷发请求：缺配置是**正常**的本地开发状态。
 */
export function createWriteApiFromEnvironment(
  env: ReadEnvironment = defaultEnvironment()
): WriteApi | null {
  const config = ReadApiConfig.fromEnvironment(env)
  return config.isConfigured ? new WriteApiClient({ config }) : null
}

function defaultEnvironment(): ReadEnvironment {
  // ★ 同上：`process.env` 整体在小程序里是空 polyfill，必须逐键静态读。
  return readCompiledEnvironment()
}

/** 超时是**客户端**的承诺：部分平台不遵守 Taro.request 的 timeout。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(WriteApiException.timeout(timeoutMs))
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** 文本 / 已解析对象都接受；空体或坏 JSON 交给 DTO 报 malformed。 */
function decodeBody(body: unknown): unknown {
  if (typeof body !== 'string') return body
  const text = body.trim()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch (error) {
    return null
  }
}

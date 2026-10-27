import { useEffect, useState } from 'react'
import { useDidShow } from '@tarojs/taro'

import { buildSeedData } from './seed'
import { isKnownIconName } from '../components/Icon/icons'
import {
  createReadApiFromEnvironment,
  ReadApiClient
} from './read_api'
import { ReadApiException } from './read_api_errors'
import {
  mapApprovalsPage,
  mapConsent,
  mapFamilyDeletion,
  mapFamilyExport,
  mapHabit,
  mapHome,
  mapInvite,
  mapInvites,
  mapMember,
  mapMembers,
  mapNotificationsPage,
  mapRecord,
  mapRecordsPage,
  mapRule,
  mapTrash,
  mapWish
} from './read_mapper'
import type { RecordsPage } from './read_mapper'
import type {
  ConsentStateDto,
  FamilyDeletionStateDto,
  FamilyExportDto,
  HabitDto,
  MemberDto,
  RecordDto,
  RuleDto,
  WishDto
} from './read_dto'
import type { ApprovalFilter, ApprovalInboxItem, ApprovalsPage } from './approval'
import type { NotificationItem } from './notification'
import { isNotificationUnread } from './notification'
import {
  approvalBlockedReason,
  approvalFilterQuery,
  approvalFilters,
  canWithdrawApproval,
  isApprovalExpired,
  isApprovalPending
} from './approval'
import { createWriteApiFromEnvironment, WriteApi } from './write_api'
import { WriteApiException } from './write_api_errors'
import type { ApprovalDto, MemberRemoveDto, WrittenRecordDto } from './write_dto'
import type {
  ActorContext,
  AuditAction,
  AuditEntry,
  AuditSnapshot,
  AuditTargetType,
  ChildProfile,
  FamilyExport,
  FamilyDeletion,
  FamilyMember,
  GuardianConsent,
  Habit,
  HabitView,
  IconOption,
  MutableMemberRole,
  PointRecord,
  PointRule,
  RecordCategory,
  RecordSource,
  RuleVersion,
  SoftDeletable,
  TrashItem,
  TrashKind,
  TrashPurgeOutcome,
  Wish
} from './types'
import {
  activeOnly,
  auditSnapshotOf,
  checkedCountToday,
  checkedCountTodayByRule,
  dailyLimitMax,
  dailyLimitMin,
  habitView,
  isDailyLimitValid,
  isSameDay,
  isTrashExpired,
  pickCoverStyle,
  recordSubtitle,
  revokedInviteCopy,
  trashOnly,
  unknownGuardianConsent
} from './types'
import type { InviteCode, InviteRole } from './types'

/**
 * 演示数据的**准入判据**（修 E18）。
 *
 * 刻意写成纯函数：`process.env.NODE_ENV` 只在打包时被 DefinePlugin 替换，
 * 若判据只存在于常量里，测试就只能靠“碰巧跑在开发环境”才验证得到它。
 * 现在可以确定性地断言 `demoResetAllowed('production') === false`；
 * 另一层证明是**以 NODE_ENV=production 重新加载模块**
 * （见 `kids_points_mp/.tmp_test/run.js` 的 E18 用例）。
 */
export function demoResetAllowed(env: string = process.env.NODE_ENV ?? ''): boolean {
  return env !== 'production'
}

/**
 * 是否允许“恢复演示数据”（修 E18）。
 *
 * 该方法原先是**生产可达**的公开 API，“我的”页按钮直接调用 ——
 * 用户可一键清空真实数据并恢复假演示数据（124 分 / 324 好习惯 / 4 次奖励）。
 * 保持**编译期常量**：生产构建下为 false，能力整段可被 DCE。
 */
export const ALLOW_DEMO_RESET = demoResetAllowed()

/**
 * 只读数据的状态机 —— 与 Flutter `ReadStatus` 同值同义。
 *
 * - `idle`：还没发过请求（预览数据 / 尚未进入页面）
 * - `loading`：第一页或整页刷新在途（首屏显示 spinner）
 * - `loadingMore`：游标翻页在途（页尾显示 spinner，列表保持可读）
 * - `ready`：最近一次读取成功
 * - `error`：最近一次读取失败；**失败不抹掉已有数据**
 */
export type ReadStatus = 'idle' | 'loading' | 'loadingMore' | 'ready' | 'error'

/**
 * 应用状态中心：积分余额、习惯、心愿、流水、规则。
 *
 * 与 Flutter 版 lib/data/app_store.dart 一一对应，模块级单例，
 * 页面之间用 redirectTo / navigateTo 跳转时数据依然保留。
 * 要落地持久化时只需在 [persist] 里接入 Taro.setStorageSync 即可，UI 层无需改动。
 */
export class AppStore {
  points = 0
  profile: ChildProfile = {
    name: '',
    childId: '',
    goodHabitCount: 0,
    rewardCount: 0
  }
  /** 流水：**只增不删**（撤销也走冲正记录）—— 与审计、版本表同等待遇。 */
  records: PointRecord[] = []

  /** 规则版本表 —— **只增不删、永不 UPDATE**（02 §5.3 / §5.6），修 C10。 */
  ruleVersions: RuleVersion[] = []

  /** 审计流水 —— **追加式**（只增不删、永不 UPDATE），修 C11。 */
  auditLog: AuditEntry[] = []

  // 三个配置列表的**唯一**存储：含回收站条目（status 为 'deleted' 的项）。
  // 页面**不得**直接读它们 —— 一律走下面的 getter（自动过滤回收站，§3.6）。
  private habitList: Habit[] = []
  private wishList: Wish[] = []
  private ruleList: PointRule[] = []

  /**
   * 列表的**唯一**读法（docs/design/08 §3.6）：`activeOnly` 只在这里收口。
   * 页面拿到的是"活着的"；回收站拿的是 `status === 'deleted'` 的 ——
   * 排除 `deleted` 的判断**全仓库只有 types.ts 一处**，
   * 两端各写一遍 `status === 'active'` 迟早漂移（那正是 E15 / E17 教过的）。
   */
  get habits(): Habit[] {
    return activeOnly(this.habitList)
  }

  get wishes(): Wish[] {
    return activeOnly(this.wishList)
  }

  get rules(): PointRule[] {
    return activeOnly(this.ruleList)
  }

  private seq = 0
  private listeners = new Set<() => void>()

  // ------------------------------------------------------- 只读 API（W4-C）
  // 与 Flutter `AppStore` 同构：读端点真数据 + 本地写仍留在内存。

  /** 一页流水条数 —— 与后端 DTO 上限（200）同口径，50 是「首屏够用」的折中。 */
  private static readonly recordsPageSize = 50

  private readonly readApi: ReadApiClient | null
  private readonly writeApi: WriteApi | null
  private readStatusValue: ReadStatus = 'idle'
  private readErrorValue: ReadApiException | null = null
  private usingPreviewValue = true
  private moreAvailable = false
  private nextCursorValue: string | null = null
  private recordFilterValue: RecordCategory | null = null

  // ------------------------------------------------- 审批收件箱（W5-D）
  // 与 Flutter `AppStore` 同构；**独立**的一套状态（不复用流水的
  // readStatus / readEpoch）：孩子角色访问这个端点必然 403，混进首页刷新
  // 会把「没有审批权限」污染成「首页读取失败」。

  /** 一页审批条数（与后端 DTO 上限同口径，20 是家长一屏能扫完的量）。 */
  private static readonly approvalsPageSize = 20

  private approvalItems: ApprovalInboxItem[] = []
  private approvalFilterValue: ApprovalFilter = 'pending'
  private approvalStatusValue: ReadStatus = 'idle'
  private approvalErrorValue: ReadApiException | null = null
  private hasMoreApprovalsValue = false
  private nextApprovalCursorValue: string | null = null
  /** 收件箱在途的旧响应据此丢弃（切筛选 / 刷新时递增）。 */
  private approvalEpoch = 0
  /** 正在判定的申请 id：双击不会变成两次判定（幂等键只是第二道）。 */
  private decidingApprovalIdValue: string | null = null

  // ------------------------------------------- 回收站（W5-F，服务端）
  //
  // 与审批收件箱同策略：**进回收站弹窗才拉**（`refreshTrash`）。首页 / 流水
  // 刷新不额外带这次请求 —— 回收站是低频页面，不该让每个孩子每次刷新都多付
  // 一次往返。代价是「我的」页上的条数在打开回收站之前是 0（不显示），
  // 这比“猜一个数”诚实。
  //
  // 只存**事实**（服务端下发的 `deletedAt`）；`expired` 每次读时用
  // `isTrashExpired` 现算 —— 缓存一个“是否过期”的布尔值，页面开着跨过第 90
  // 天就会说谎。

  private trashRows: TrashItem[] = []
  private trashStatusValue: ReadStatus = 'idle'
  private trashErrorValue: ReadApiException | null = null

  /** 回收站自己的 epoch：重复进入 / 手动刷新时作废在途响应（与 `readEpoch` 同理）。 */
  private trashEpoch = 0

  // ------------------------------------------- 家庭成员（W5-H，服务端）
  //
  // 与回收站同策略：**进成员弹窗才拉**（`refreshMembers`），首页刷新不带
  // 这次请求 —— 成员列表是低频数据，不该让每个孩子每次刷新都多付一次往返。
  //
  // 只存服务端下发的**事实**（角色 / 状态 / `isSelf`）；「我能不能改」由
  // `canManageMembers` 从 `isSelf` 那一行现算，缓存成布尔值会在角色变化后说谎。

  private memberRows: FamilyMember[] = []
  private memberStatusValue: ReadStatus = 'idle'
  private memberErrorValue: ReadApiException | null = null

  /** 成员列表自己的 epoch：重复打开弹窗 / 手动刷新时作废在途响应。 */
  private memberEpoch = 0

  /** 正在提交改角色 / 移出的成员 id；非 null 时该行按钮禁用（防双击）。 */
  private busyMemberIdValue: string | null = null

  // ------------------------------------------- 邀请码（W5-I，服务端）
  //
  // 与成员列表同策略：**打开邀请码面板时才拉**（`refreshInvites`）。
  // 邀请码是低频数据，且只有家长能看（矩阵 `invite_member` 对 child 是 DENY）。
  //
  // 只存服务端下发的**事实**（`usedCount` / `maxUses` / `expiresAt` /
  // `revoked`）；「还能不能用」由 `inviteStatusOf` 现算 —— 缓存一个
  // `expired` 布尔值，面板开着跨过有效期就会说谎。

  private inviteRows: InviteCode[] = []
  private inviteStatusValue: ReadStatus = 'idle'
  private inviteErrorValue: ReadApiException | null = null

  /** 邀请码列表自己的 epoch：重复打开面板 / 手动刷新时作废在途响应。 */
  private inviteEpoch = 0

  /** 正在吊销的邀请码 id；非 null 时该行按钮禁用（防双击）。 */
  private busyInviteIdValue: string | null = null

  /** 是否正在生成邀请码（表单按钮据此禁用并显示「生成中…」）。 */
  private creatingInviteValue = false

  // ------------------------------------------- 监护人同意（W7-B，服务端）
  //
  // 与成员 / 邀请码同策略：**打开同意面板时才拉**（`refreshConsent`）。
  // `GET /consent` 是 guardian 专属（`view_consent` 对 child 是 DENY），
  // 因此**不能**塞进首页 / 全局刷新 —— 孩子每次刷新都会吃一个必然的 403。
  //
  // 快照只存服务端下发的事实（状态 / 同意时的版本 / 两个时间点）；
  // 「能不能写」由服务端矩阵判定，客户端只按 `canManageConsent` 决定是否
  // 画出按钮，403 照样原样上报。

  /** 同意快照；未拉到时是 [unknownGuardianConsent]（**不是**服务端事实）。 */
  private consentValue: GuardianConsent = unknownGuardianConsent
  private consentStatusValue: ReadStatus = 'idle'
  private consentErrorValue: ReadApiException | null = null

  /** 同意状态自己的 epoch：重复打开面板 / 手动刷新时作废在途响应。 */
  private consentEpoch = 0

  /** 是否正在提交同意 / 撤回 —— 面板据此禁用两个按钮。 */
  private consentWriteBusyValue = false

  // ------------------------------------------- 家庭数据导出（W7-C，服务端）
  //
  // 与同意面板同策略：**打开导出面板时才拉**（`loadExport`）。`GET /export`
  // 是 guardian 专属（`export_family_data` 对 child 是 DENY），塞进首页刷新
  // 会让每个孩子每次下拉都吃一个必然的 403。
  //
  // 与同意**不同**的一点：导出**不受** `ConsentGuard` 管辖 —— 撤回同意后
  // 仍然必须可用（04 §5 的可携带权）。所以这里没有任何「同意生效中」前置
  // 判断，缓存也不随同意状态失效。
  //
  // 存的是一份完整文件（含 `rawJson`）：家长点「复制」时复制的必须是服务端
  // 下发的原始文本，而不是按本地模型重新拼出来的近似物。

  /** 最近一次成功拉到的导出文件；还没拉到过时是 null（**不是**「没有数据」）。 */
  private exportValue: FamilyExport | null = null
  private exportStatusValue: ReadStatus = 'idle'
  private exportErrorValue: ReadApiException | null = null

  /**
   * 是否正在下载导出文件。
   *
   * 导出**单飞**（不像同意那样用 epoch）：同一时刻不允许两个在途请求，
   * 因此不存在「旧响应覆盖新响应」，连点也只会拿到一份文件。
   */
  private exportBusyValue = false

  // ------------------------------------------- 家庭数据删除（W7-D，服务端）
  //
  // 与导出同一策略：**打开删除面板时才拉**（`loadFamilyDeletion`）。
  // 两个删除动作都是 guardian 专属（矩阵对 child DENY），塞进首页刷新
  // 会让每个孩子每次下拉都吃一个必然的 403。
  //
  // 与导出的另一共同点：删除**不受** `ConsentGuard` 管辖 —— 撤回同意后
  // 仍必须能删（否则「撤回」等于「数据被扣住」）。这里同样不读 consentValue。

  /** 最近一次拉到的删除状态；还没拉到过时是 null（**不是**「从未申请」）。 */
  private familyDeletionValue: FamilyDeletion | null = null
  private deletionStatusValue: ReadStatus = 'idle'
  private deletionErrorValue: ReadApiException | null = null

  /** 是否正在提交申请 / 撤销（两个按钮互斥，防双击）。 */
  private deletionBusyValue = false

  /** 读状态请求的代际（旧响应不得覆盖新响应）。 */
  private deletionEpoch = 0

  // ------------------------------------------- 站内通知（W5-L，服务端）
  //
  // 与审批收件箱同策略：**打开「消息」面板才拉整页**；「我的」页只多一条
  // `limit=1` 的红点查询（`refreshUnreadNotificationCount`），不把整页列表
  // 塞进每次首页刷新 —— 消息是低频页面。
  //
  // 未读只有一种事实源：行上的 `readAt === null`；数量用服务端下发的整份
  // `unreadCount`，**不**对 `items` 求和（本页之外的未读会被漏掉，
  // 红点就会在翻页时莫名变少）。

  /** 一页消息条数（后端上限 100，20 是首屏够用的折中）。 */
  private static readonly notificationsPageSize = 20

  private notificationItems: NotificationItem[] = []
  private notificationStatusValue: ReadStatus = 'idle'
  private notificationErrorValue: ReadApiException | null = null
  private hasMoreNotificationsValue = false
  private nextNotificationCursorValue: string | null = null

  /** 整份未读数（服务端下发）。红点用；0 不画。 */
  private unreadNotificationCountValue = 0

  /** 正在标记已读的通知 id；非 null 时该行禁用（防双击）。 */
  private busyNotificationIdValue: string | null = null

  /** 列表会话的 epoch：整页刷新作废在途响应（翻页**不**自增）。 */
  private notificationEpoch = 0

  /**
   * 红点单查的 epoch：列表刷新 / 新一次红点查询都会 +1，
   * 避免一个更早的红点响应把刚拉到的未读数盖回旧值。
   */
  private notificationBadgeEpoch = 0

  /**
   * 每次「整页刷新 / 切分类」都 +1；在途的旧响应据此丢弃（防串页）。
   * 翻页（loadMore）**不**递增：它读取的是刷新当时那一版游标。
   */
  private readEpoch = 0

  /** 写请求串行化：防双击重复提交，也防“撤销”与“打卡”交叉。 */
  private writeInFlight = false

  /** 是否接入了后端（与「当前是否已加载成功」是两件事）。 */
  get isLiveMode(): boolean {
    return this.readApi !== null
  }

  /** live 模式下是否已接上写端点（W4-E：只覆盖打卡 / 撤销）。 */
  get usesServerWrites(): boolean {
    return this.readApi !== null && this.writeApi !== null
  }

  /**
   * 打卡是否被只读拦截。
   *
   * 本地预览可以照常写（那本来就是演示）；live 但没注入写客户端时**必须拦**，
   * 否则会改内存却不落库，用户以为已经保存。
   */
  get isCheckInReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /** 首页打卡 / 长按撤销是否可用。 */
  get canWriteCheckIns(): boolean {
    return !this.isCheckInReadOnly
  }

  /**
   * 仍未接后端的本地写入口（回收站恢复 / 恢复演示数据）是否被只读拦截。
   *
   * 具体写入口不要再用它判断，各自有专属的 `is*ReadOnly`
   * （打卡 / 记一笔 / 规则 / 心愿 / 档案在 live 模式下都已接后端）。
   */
  get isReadOnly(): boolean {
    return this.isLiveMode
  }

  /**
   * 规则写入口是否被只读拦截（W5-A：新建 / 编辑 / 删除 / 加入习惯）。
   *
   * 与 [isReadOnly] 分开：live 模式下这四条已经接了后端，不该再被全局
   * 「写入口未接」拦掉；只有**没注入写客户端**时才拦。
   */
  get isRuleWriteReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /** 只读模式下规则写操作的文案 —— 页面直接展示，不另编理由。 */
  get ruleReadOnlyWriteMessage(): string {
    return '只读模式：规则写入还没有接上后端，这次操作没有保存到服务器。'
  }

  /**
   * 心愿写入口是否被只读拦截（W5-C：新增 / 删除）。
   *
   * 与 [isReadOnly] 分开：live 模式下这两条已经接了后端，不该再被全局
   * 「写入口未接」拦掉；只有**没注入写客户端**时才拦。
   */
  get isWishWriteReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /** 只读模式下心愿写操作的文案 —— 页面直接展示，不另编理由。 */
  get wishReadOnlyWriteMessage(): string {
    return '只读模式：心愿写入还没有接上后端，这次操作没有保存到服务器。'
  }

  /**
   * 档案写入口（昵称）是否被只读拦截（W5-E）。
   *
   * 与 [isReadOnly] 分开：live 模式下昵称已经接了后端（`PATCH /child`），
   * 不该再被全局「写入口未接」拦掉；只有**没注入写客户端**时才拦。
   */
  get isProfileWriteReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /**
   * 只读模式下档案写操作的文案 —— 页面直接展示，不另编理由。
   *
   * 注意「还没接后端」已经过时：`PATCH /child` W5-E 就位了，走到这里只可能是
   * 写客户端没构造出来（配置缺失 / 构造失败），文案别再说「没接」。
   */
  get profileReadOnlyWriteMessage(): string {
    return '只读模式：昵称修改暂时写不进去（写客户端未就绪），这次没有保存到服务器。'
  }

  // ------------------------------------------------------- 回收站（W5-F）

  /** 回收站加载状态（与首页 `readStatus` 分开：回收站失败不该把首页画成错误页）。 */
  get trashStatus(): ReadStatus {
    return this.trashStatusValue
  }

  /** 回收站的加载错误（403 = 没有查看资格；**不能**显示成“回收站是空的”）。 */
  get trashError(): ReadApiException | null {
    return this.trashErrorValue
  }

  /**
   * 回收站写入口（恢复 / 彻底删除）是否被只读拦截。
   *
   * 与 `isReadOnly` 分开：live 模式下这两条已经接了后端，只有**没注入写客户端**
   * 时才拦；预览模式反而可以随便点（那是演示数据）。
   */
  get isTrashWriteReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /** 只读模式下回收站写操作的文案 —— 页面直接展示，不另编理由。 */
  get trashReadOnlyWriteMessage(): string {
    return '只读模式：回收站操作暂时写不进去（写客户端未就绪），这次没有保存到服务器。'
  }

  /**
   * 习惯写入口（删除首页习惯）是否被只读拦截（W5-F）。
   *
   * 与 `isReadOnly` 分开：live 模式下 `DELETE /habits/:id` 已经接了后端，
   * 只有**没注入写客户端**时才拦。
   */
  get isHabitWriteReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /** 只读模式下习惯写操作的文案 —— 页面直接展示，不另编理由。 */
  get habitReadOnlyWriteMessage(): string {
    return '只读模式：删除习惯暂时写不进去（写客户端未就绪），这次没有保存到服务器。'
  }

  // ------------------------------------------------------- 家庭成员（W5-H）

  /** 成员列表的只读快照（服务端顺序：家长在前、按加入时间）。 */
  get members(): FamilyMember[] {
    return this.memberRows
  }

  /** 成员列表加载状态（与首页 `readStatus` 分开：403 不该把首页画成错误页）。 */
  get memberStatus(): ReadStatus {
    return this.memberStatusValue
  }

  /** 成员列表的加载错误（403 = 没有查看资格，**不能**显示成「没有成员」）。 */
  get memberError(): ReadApiException | null {
    return this.memberErrorValue
  }

  /** 正在提交改角色 / 移出的成员 id；非 null 时该行按钮应禁用。 */
  get busyMemberId(): string | null {
    return this.busyMemberIdValue
  }

  /**
   * 成员写入口（改角色 / 移出）是否被只读拦截。
   *
   * 与 `isReadOnly` 分开：live 模式下这两条已经接了后端，只有**没注入
   * 写客户端**时才拦；预览模式没有真实成员，弹窗另有空态文案。
   */
  get isMemberWriteReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /** 只读模式下成员写操作的文案 —— 页面直接展示，不另编理由。 */
  get memberReadOnlyWriteMessage(): string {
    return '只读模式：成员管理暂时写不进去（写客户端未就绪），这次没有保存到服务器。'
  }

  /** 「我」那一行；服务端没下发（或列表还没拉到）时为 null。 */
  get selfMember(): FamilyMember | null {
    return this.memberRows.find((member) => member.isSelf) ?? null
  }

  /**
   * 当前用户能否管理成员 —— **只看自己那一行的角色**。
   *
   * 服务端仍然是最终裁决者：这里为 true 只表示「界面可以给出按钮」，
   * 真正的拒绝（403 `CANNOT_MODIFY_SELF` 之类）照样原样上报。
   */
  get canManageMembers(): boolean {
    return this.selfMember?.role === 'guardian'
  }

  // ------------------------------------------------------------ 邀请码（W5-I）

  /** 邀请码列表的只读快照（服务端顺序：新的在前）。 */
  get invites(): InviteCode[] {
    return this.inviteRows
  }

  /** 邀请码列表加载状态（与首页 `readStatus` 分开：403 不该把首页画成错误页）。 */
  get invitesReadStatus(): ReadStatus {
    return this.inviteStatusValue
  }

  /** 邀请码列表的加载错误（403 = 当前身份没有 `invite_member`）。 */
  get invitesError(): ReadApiException | null {
    return this.inviteErrorValue
  }

  /** 正在吊销的邀请码 id；非 null 时该行按钮应禁用。 */
  get busyInviteId(): string | null {
    return this.busyInviteIdValue
  }

  /** 生成 / 吊销任一在途 —— 表单与行按钮统一禁用。 */
  get isInviteWriteBusy(): boolean {
    return this.creatingInviteValue || this.busyInviteIdValue !== null
  }

  /**
   * 邀请码写入口是否被只读拦截。
   *
   * 与成员同理：live 模式下这两条已经接了后端，只有**没注入写客户端**时才拦。
   */
  get isInviteWriteReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /** 只读模式下邀请码写操作的文案 —— 页面直接展示，不另编理由。 */
  get inviteReadOnlyWriteMessage(): string {
    return '只读模式：邀请码暂时写不进去（写客户端未就绪），这次没有保存到服务器。'
  }

  /**
   * 能否管理邀请码 —— 与 `canManageMembers` 同一条判据（`invite_member`
   * 也只看当前角色是不是家长）。
   *
   * 服务端仍是最终裁决者：这里为 true 只表示「界面可以给出表单」，
   * 403 照样原样上报。
   */
  get canManageInvites(): boolean {
    return this.canManageMembers
  }

  // ------------------------------------------------------------ 监护人同意（W7-B）

  /** 当前同意快照；未拉到时是 [unknownGuardianConsent]（**不是**服务端事实）。 */
  get consent(): GuardianConsent {
    return this.consentValue
  }

  /** 同意状态的加载状态（与成员 / 邀请码分开）。 */
  get consentReadStatus(): ReadStatus {
    return this.consentStatusValue
  }

  /**
   * 同意状态的加载错误（403 = 当前身份没有 `view_consent`）。
   *
   * **不能**画成「未同意」—— 那会诱导孩子或访客去点一个必然失败的按钮。
   */
  get consentError(): ReadApiException | null {
    return this.consentErrorValue
  }

  /** 是否正在提交同意 / 撤回 —— 面板据此禁用两个按钮。 */
  get isConsentWriteBusy(): boolean {
    return this.consentWriteBusyValue
  }

  /** 同意写入口（作出 / 撤回）是否被只读拦截。 */
  get isConsentWriteReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /** 只读模式下同意写操作的文案 —— 页面直接展示，不另编理由。 */
  get consentReadOnlyWriteMessage(): string {
    return '只读模式：同意状态暂时写不进去（写客户端未就绪），这次没有保存到服务器。'
  }

  /**
   * 能否管理同意 —— `view_consent` / `manage_consent` 在矩阵里都是
   * guardian ALLOW / child DENY，与成员管理同一条判据。
   *
   * 服务端仍是最终裁决者：这里为 true 只表示「界面可以给出按钮」，403
   * 照样原样上报。依赖成员列表已拉到（`selfMember`），所以同意面板打开时
   * 同样要先 `refreshMembers()`。
   */
  get canManageConsent(): boolean {
    return this.canManageMembers
  }

  // ------------------------------------------------------------ 家庭数据导出（W7-C）

  /** 最近一次成功拉到的导出文件；还没拉到过时为 null（**不是**「没有数据」）。 */
  get familyExport(): FamilyExport | null {
    return this.exportValue
  }

  /** 导出的加载状态（与成员 / 同意分开）。 */
  get exportReadStatus(): ReadStatus {
    return this.exportStatusValue
  }

  /**
   * 导出的加载错误（403 = 当前身份没有 `export_family_data`）。
   *
   * **不能**画成「没有可导出的数据」—— 那会把权限问题说成数据问题。
   */
  get exportError(): ReadApiException | null {
    return this.exportErrorValue
  }

  /** 是否正在下载导出文件 —— 按钮据此禁用，防连点下载出两份文件。 */
  get isExportBusy(): boolean {
    return this.exportBusyValue
  }

  /**
   * 能否导出家庭数据 —— `export_family_data` 在矩阵里只有 guardian ALLOW，
   * 与成员管理同一条判据（`selfMember.role`）。
   *
   * 服务端仍是最终裁决者：这里为 true 只表示「界面可以给出入口」，403
   * 照样原样上报。依赖成员列表已拉到（`selfMember`），所以导出面板打开时
   * 同样要先 `refreshMembers()`。
   */
  get canExportFamilyData(): boolean {
    return this.canManageMembers
  }

  // ------------------------------------------- 家庭数据删除（W7-D，服务端）

  /** 最近一次拉到的删除状态；还没拉到过时是 null。 */
  get familyDeletion(): FamilyDeletion | null {
    return this.familyDeletionValue
  }

  /** 删除状态的加载状态（与导出 / 同意分开）。 */
  get deletionStatus(): ReadStatus {
    return this.deletionStatusValue
  }

  /** 删除状态的加载错误（403 = 没有 `view_family_deletion`，不是「没有请求」）。 */
  get deletionError(): ReadApiException | null {
    return this.deletionErrorValue
  }

  /** 是否正在提交申请 / 撤销。 */
  get deletionBusy(): boolean {
    return this.deletionBusyValue
  }

  /**
   * 能否查看 / 申请 / 撤销删除 —— 两个动作在矩阵里都是 guardian ALLOW /
   * child DENY，与成员管理同一条判据。
   *
   * 服务端仍是最终裁决者：这里为 true 只表示「界面可以给出按钮」，
   * 403 照样原样上报。依赖成员列表已拉到（`selfMember`）。
   */
  get canManageFamilyDeletion(): boolean {
    return this.canManageMembers
  }

  get readStatus(): ReadStatus {
    return this.readStatusValue
  }

  get readError(): ReadApiException | null {
    return this.readErrorValue
  }

  /** 当前展示的是本地预览数据（未配置后端，或首次加载尚未成功）。 */
  get usingPreview(): boolean {
    return this.usingPreviewValue
  }

  /** 服务端还有下一页（仅 live 有效）。 */
  get hasMoreRecords(): boolean {
    return this.moreAvailable
  }

  get recordFilter(): RecordCategory | null {
    return this.recordFilterValue
  }

  // ------------------------------------------------- 审批收件箱（W5-D）

  /** 收件箱当前筛选（默认只看待处理）。 */
  get approvalFilter(): ApprovalFilter {
    return this.approvalFilterValue
  }

  /** 收件箱的筛选词表（页面直接遍历渲染 chips）。 */
  get approvalFilterOptions(): readonly ApprovalFilter[] {
    return approvalFilters
  }

  get approvalStatus(): ReadStatus {
    return this.approvalStatusValue
  }

  get approvalError(): ReadApiException | null {
    return this.approvalErrorValue
  }

  get hasMoreApprovals(): boolean {
    return this.hasMoreApprovalsValue
  }

  /** 已加载的申请（服务端已按筛选返回，本地不再二次过滤）。 */
  get approvals(): ApprovalInboxItem[] {
    return this.approvalItems.slice()
  }

  /** 已加载的待处理条数（角标用；不是"全库"计数）。 */
  get pendingApprovalCount(): number {
    return this.approvalItems.filter((item) => isApprovalPending(item)).length
  }

  /** 正在判定的申请 id；没有在途判定时为 null。 */
  get decidingApprovalId(): string | null {
    return this.decidingApprovalIdValue
  }

  /** live 且接上写端点才允许批 / 拒。 */
  get canDecideApprovals(): boolean {
    return this.isLiveMode && this.writeApi !== null
  }

  /**
   * live 且接上写端点才允许撤回（W5-J）。
   *
   * 与 [canDecideApprovals] 同一条件但语义不同：撤回是申请人动作，
   * 孩子设备也可能有这个能力 —— 不能复用「家长可判定」那个开关。
   */
  get canWithdrawApprovals(): boolean {
    return this.isLiveMode && this.writeApi !== null
  }

  /**
   * 只读模式下写操作统一文案（W5-B 起多个能力共用）。
   *
   * 走到这里有两个原因，文案同时覆盖：写客户端没能构造出来（配置缺失 / 构造失败），
   * 或这个能力压根还没有端点（回收站恢复、恢复演示数据）。不再点名具体功能 ——
   * 兑换 / 记一笔 / 昵称都已经能真写，旧文案「还没接后端」会变成假话。
   */
  get readOnlyWriteMessage(): string {
    return '只读模式：这个操作暂时写不进去（写客户端未就绪或尚未接后端），没有保存。'
  }

  // ------------------------------------------------- 站内通知（W5-L）

  /** 已加载的通知（服务端顺序：新通知在前）。 */
  get notifications(): NotificationItem[] {
    return this.notificationItems.slice()
  }

  /** 通知列表的加载状态（与首页 / 审批 / 回收站的状态分开）。 */
  get notificationsStatus(): ReadStatus {
    return this.notificationStatusValue
  }

  /**
   * 通知列表的加载错误。403 ⇒ 当前身份没有 `view_notifications` ——
   * 面板据此说「消息没能加载」，**不能**画成「还没有消息」。
   */
  get notificationsError(): ReadApiException | null {
    return this.notificationErrorValue
  }

  /** 未读通知总数 —— 红点用它。0 时页面不画红点。 */
  get unreadNotificationCount(): number {
    return this.unreadNotificationCountValue
  }

  /** 是否还有下一页（「加载更多」据此显示）。 */
  get notificationsHasMore(): boolean {
    return this.hasMoreNotificationsValue
  }

  /** 正在标记已读的通知 id；非 null 时该行禁用。 */
  get busyNotificationId(): string | null {
    return this.busyNotificationIdValue
  }

  /**
   * 标记已读是否被只读拦截。
   *
   * 与 [isReadOnly] 分开：live 模式下这条已经接了后端，只有**没注入
   * 写客户端**时才拦。
   */
  get isNotificationWriteReadOnly(): boolean {
    return this.isLiveMode && this.writeApi === null
  }

  /** 只读模式下通知写操作的文案 —— 页面直接展示，不另编理由。 */
  get notificationReadOnlyWriteMessage(): string {
    return '只读模式：标记已读暂时写不进去（写客户端未就绪），这次没有保存到服务器。'
  }

  /**
   * 记录页要展示的流水：
   *   · 预览模式：对本地流水按分类过滤（原逻辑）；
   *   · live 模式：服务端已按 `category` 过滤，这里不再二次过滤，
   *     否则「全部」只加载 50 条时会漏掉后面的同类记录。
   */
  get visibleRecords(): PointRecord[] {
    return this.usingPreviewValue
      ? this.recordsOf(this.recordFilterValue)
      : this.records.slice()
  }

  /**
   * 首启是**空态**（修 E18 第二半）。
   *
   * 原先构造即 `this.reset()` → 应用一打开就是假数据（124 分 / 324 好习惯 /
   * “萌新铲屎官的小可爱”）：新用户看到“我完成了 324 个好习惯”是荒谬的，
   * 而且屏幕上没有任何一个数字能被当真。
   * seed 自此只作**测试夹具**，由 [resetToSeed] 显式载入。
   *
   * [readApi] 默认按 `TARO_APP_*` 环境变量构造；三项缺一项就是 null，
   * 应用继续使用本地预览数据（这是正常的本地开发状态，不是错误）。
   */
  constructor(
    readApi: ReadApiClient | null = createReadApiFromEnvironment(),
    writeApi: WriteApi | null = readApi === null
      ? null
      : createWriteApiFromEnvironment()
  ) {
    this.readApi = readApi
    this.writeApi = writeApi
    this.resetToEmpty()
  }

  // ------------------------------------------------------------- 订阅 / 通知

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private persist(): void {
    this.listeners.forEach((listener) => listener())
  }

  /** 空态：每个真实用户的第一步都从这里开始（修 E18）。 */
  private resetToEmpty(): void {
    this.points = 0
    this.profile = { name: '', childId: '', goodHabitCount: 0, rewardCount: 0 }
    this.habitList = []
    this.wishList = []
    this.ruleList = []
    this.records = []
    this.ruleVersions = []
    this.auditLog = []
    this.resetApprovals()
    this.resetTrash()
    this.resetMembers()
    this.resetInvites()
    this.resetConsent()
    this.resetExport()
    this.resetFamilyDeletion()
    this.resetNotifications()
  }

  /** 载入演示数据 —— 只由 [resetToSeed] 调用（开发环境 / 测试夹具）。 */
  private applySeed(): void {
    const seed = buildSeedData()
    this.points = seed.points
    this.profile = seed.profile
    this.habitList = seed.habits
    this.wishList = seed.wishes
    this.ruleList = seed.rules
    this.records = seed.records
    this.ruleVersions = seed.ruleVersions
    // 夹具的审计**从空开始**：审计记录的是"这台设备上发生过的变更"，
    // 预置数据不是变更（否则回收站/审计页会显示一堆没人做过的操作）。
    this.auditLog = []
    // 演示数据里没有审批单：收件箱必须是真空态，不能留着上一个账号的申请。
    this.resetApprovals()
    this.resetTrash()
    this.resetMembers()
    this.resetInvites()
    this.resetConsent()
    this.resetExport()
    this.resetFamilyDeletion()
    this.resetNotifications()
  }

  /**
   * 清空回收站的**服务端**状态（切账号 / 恢复正常数据 / 演示重置时调用）。
   *
   * 不清的话：换到另一个孩子后，打开回收站之前会先看到上一个孩子的条目，
   * 而「恢复」按钮会把这些 id 发到新会话上（服务端会拒，但那是本可避免的错）。
   */
  private resetTrash(): void {
    this.trashEpoch++
    this.trashRows = []
    this.trashStatusValue = 'idle'
    this.trashErrorValue = null
  }

  /**
   * 清空成员列表的本地状态（切账号 / 恢复正常数据 / 演示重置时调用）。
   *
   * 与回收站同理：不清的话，换到另一个家庭后打开成员弹窗会先看到上一个
   * 家庭的成员 id，改角色 / 移出按钮会把这些 id 发到新会话上。
   */
  private resetMembers(): void {
    this.memberEpoch++
    this.memberRows = []
    this.memberStatusValue = 'idle'
    this.memberErrorValue = null
    this.busyMemberIdValue = null
  }

  /**
   * 清空邀请码的本地状态（切账号 / 恢复正常数据 / 演示重置时调用）。
   *
   * 与成员同理：不清的话，换到另一个家庭后打开邀请码面板会先看到上一个
   * 家庭的**凭据**（码本身），复制出去就发给了错误的人。
   */
  private resetInvites(): void {
    this.inviteEpoch++
    this.inviteRows = []
    this.inviteStatusValue = 'idle'
    this.inviteErrorValue = null
    this.busyInviteIdValue = null
    this.creatingInviteValue = false
  }

  /**
   * 清空同意快照（切账号 / 恢复正常数据 / 演示重置时调用）。
   *
   * 不清的话：换到另一个孩子后打开同意面板，会先看到上一个家庭的状态
   * （甚至是「已同意」），家长据此以为新孩子也已经同意了 —— 这是一条
   * 会直接影响合规判断的旧数据。
   */
  private resetConsent(): void {
    this.consentEpoch++
    this.consentValue = unknownGuardianConsent
    this.consentStatusValue = 'idle'
    this.consentErrorValue = null
    this.consentWriteBusyValue = false
  }

  /**
   * 清空导出文件的本地状态（切账号 / 恢复正常数据 / 演示重置时调用）。
   *
   * 不清的话：换到另一个孩子后打开导出面板，会先看到**上一个家庭**的整份
   * 数据（含昵称、积分、流水），复制出去就是把别人家的数据交给了当前家长。
   * 这是本文件里最不该留缓存的一处。
   */
  private resetExport(): void {
    this.exportValue = null
    this.exportStatusValue = 'idle'
    this.exportErrorValue = null
    this.exportBusyValue = false
  }

  /**
   * 清空删除状态的本地状态（切账号 / 恢复正常数据 / 演示重置时调用）。
   *
   * 不清的话：换到另一个家庭后打开删除面板，会先看到上一个家庭
   * 「将于 X 日删除」—— 家长可能据此以为新家庭也在删除队列里。
   */
  private resetFamilyDeletion(): void {
    this.deletionEpoch++
    this.familyDeletionValue = null
    this.deletionStatusValue = 'idle'
    this.deletionErrorValue = null
    this.deletionBusyValue = false
  }

  /** 清空收件箱的本地状态（切账号 / 恢复正常数据 / 演示重置时调用）。 */
  private resetApprovals(): void {
    this.approvalEpoch++
    this.approvalItems = []
    this.approvalFilterValue = 'pending'
    this.approvalStatusValue = 'idle'
    this.approvalErrorValue = null
    this.hasMoreApprovalsValue = false
    this.nextApprovalCursorValue = null
    this.decidingApprovalIdValue = null
  }

  /**
   * 恢复演示数据（“我的”页的“恢复演示数据”按钮）。
   * 返回是否真的执行了恢复。
   *
   * **修 E18**：原先是**生产可达**的公开方法 —— 用户可一键清空真实数据并恢复假演示数据。
   * 现由 [ALLOW_DEMO_RESET]（编译期常量）守卫，仅开发环境可用；生产构建下整个
   * 入口也不渲染（见 pages/profile）。
   *
   * 注意它现在是演示数据的**唯一**入口：首启不再自动载入 seed（那是 E18 的另一半）。
   */
  resetToSeed(): boolean {
    if (!ALLOW_DEMO_RESET) return false
    this.applySeed()
    this.persist()
    return true
  }

  // ------------------------------------------------------------------- 查询

  /** 按分类过滤流水，[category] 为 null 表示“全部”。 */
  recordsOf(category: RecordCategory | null): PointRecord[] {
    if (category === null) return this.records.slice()
    return this.records.filter((record) => record.category === category)
  }

  /**
   * 首页用的**派生视图**列表 —— 修 A2 / A3 / E17。
   *
   * 页面不再读任何“状态字段”：`checked` / `limitText` / `doneText` 都在这里
   * 由 `dailyLimit` ＋ 当天流水现算。视图是**快照对象**，不回写 store，
   * 因此也不存在“谁改了 checked 导致状态与流水不一致”的可能。
   */
  habitViews(): HabitView[] {
    return this.habits.map((habit) => habitView(habit, this.records))
  }

  /**
   * 从后端拉取首页快照 + 第一页流水；失败时**保留已有数据**并记录错误。
   *
   * 两个请求并发：首页和流水各自独立，任何一个失败都会走 catch，
   * 不会出现「首页更新了、流水还是旧的」这种半新半旧的静默状态。
   */
  async refreshFromServer(): Promise<void> {
    const api = this.readApi
    if (api === null) return

    const epoch = ++this.readEpoch
    this.readStatusValue = 'loading'
    this.readErrorValue = null
    this.persist()

    try {
      const [homeDto, pageDto] = await Promise.all([
        api.fetchHome(),
        api.fetchRecords({
          category: this.recordFilterValue,
          limit: AppStore.recordsPageSize
        })
      ])
      if (epoch !== this.readEpoch) return

      this.applyHomeSnapshot(mapHome(homeDto))
      this.applyRecordsPage(mapRecordsPage(pageDto), false)
      this.usingPreviewValue = false
      this.readStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.readEpoch) return
      this.readErrorValue = toReadApiException(error)
      this.readStatusValue = 'error'
    }
    this.persist()
  }

  /**
   * 追加下一页。**必须**用服务端给的 `nextCursor` 原样请求；
   * 没有更多 / 正在加载 / 预览模式时直接返回（不会重复请求同一页）。
   */
  async loadMoreRecords(): Promise<void> {
    const api = this.readApi
    const cursor = this.nextCursorValue
    if (
      api === null ||
      this.usingPreviewValue ||
      !this.moreAvailable ||
      cursor === null ||
      this.readStatusValue === 'loading' ||
      this.readStatusValue === 'loadingMore'
    ) {
      return
    }

    // 翻页跟随当前 epoch：期间若切分类 / 刷新，旧页响应作废。
    const epoch = this.readEpoch
    this.readStatusValue = 'loadingMore'
    this.readErrorValue = null
    this.persist()

    try {
      const dto = await api.fetchRecords({
        category: this.recordFilterValue,
        limit: AppStore.recordsPageSize,
        cursor
      })
      if (epoch !== this.readEpoch) return

      this.applyRecordsPage(mapRecordsPage(dto), true)
      this.readStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.readEpoch) return
      this.readErrorValue = toReadApiException(error)
      this.readStatusValue = 'error'
    }
    this.persist()
  }

  // ------------------------------------------------- 审批收件箱（W5-D）

  /**
   * 首帧后触发一次读取（页面 `useDidShow` 调用）。
   *
   * **只读一次**：已成功或已失败都不自动重试 —— 重试是用户的动作（下拉 / 按钮）。
   * 孩子角色的设备会拿到 403，页面据此说明「没有批准申请的权限」。
   */
  ensureApprovalsLoaded(): void {
    if (!this.isLiveMode) return
    if (this.approvalStatusValue !== 'idle') return
    void this.refreshApprovals()
  }

  /** 拉取收件箱第一页。 */
  async refreshApprovals(): Promise<void> {
    await this.loadApprovalsPage(false)
  }

  /** 追加下一页；没有更多 / 正在加载时直接返回。 */
  async loadMoreApprovals(): Promise<void> {
    if (!this.hasMoreApprovalsValue) return
    if (this.nextApprovalCursorValue === null) return
    if (
      this.approvalStatusValue === 'loading' ||
      this.approvalStatusValue === 'loadingMore'
    ) {
      return
    }
    await this.loadApprovalsPage(true)
  }

  /**
   * 切换收件箱筛选。
   *
   * 与流水分类同一纪律：live 模式**重新向服务端要第一页**（带 `status`），
   * 因为本地只过滤已加载的 20 条会漏掉后面的同类申请。未知筛选词直接忽略。
   */
  async setApprovalFilter(filter: ApprovalFilter): Promise<void> {
    if (filter === this.approvalFilterValue) return
    if (!approvalFilters.includes(filter)) return
    this.approvalFilterValue = filter
    this.approvalItems = []
    this.hasMoreApprovalsValue = false
    this.nextApprovalCursorValue = null
    this.approvalErrorValue = null
    await this.loadApprovalsPage(false)
  }

  private async loadApprovalsPage(append: boolean): Promise<void> {
    const api = this.readApi
    if (api === null) {
      // 预览：没有后端可问。明确置空 + ready，让页面说「预览模式没有待审批」，
      // 而不是停在 loading 转圈，或显示一个编出来的假申请。
      this.approvalEpoch++
      this.approvalItems = []
      this.hasMoreApprovalsValue = false
      this.nextApprovalCursorValue = null
      this.approvalErrorValue = null
      this.approvalStatusValue = 'ready'
      this.persist()
      return
    }

    const epoch = ++this.approvalEpoch
    this.approvalStatusValue = append ? 'loadingMore' : 'loading'
    this.approvalErrorValue = null
    if (!append) {
      this.approvalItems = []
      this.hasMoreApprovalsValue = false
      this.nextApprovalCursorValue = null
    }
    this.persist()

    try {
      const dto = await api.fetchApprovals({
        status: approvalFilterQuery(this.approvalFilterValue),
        limit: AppStore.approvalsPageSize,
        cursor: append ? this.nextApprovalCursorValue : null
      })
      if (epoch !== this.approvalEpoch) return

      const page: ApprovalsPage = mapApprovalsPage(dto)
      // 按 id 去重：键集翻页本不该重叠，但客户端多一道保险。
      const known = new Set(this.approvalItems.map((item) => item.id))
      page.items.forEach((item) => {
        if (known.has(item.id)) return
        known.add(item.id)
        this.approvalItems.push(item)
      })
      this.nextApprovalCursorValue = page.nextCursor
      this.hasMoreApprovalsValue = page.hasMore
      this.approvalStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.approvalEpoch) return
      // 失败时保留已加载的行（与流水一致）：网络抖一下不该让家长丢掉列表，
      // 页面会在顶部显示错误横幅 + 重试入口。
      this.approvalErrorValue = toReadApiException(error)
      this.approvalStatusValue = 'error'
    }
    this.persist()
  }

  /**
   * 批准 / 拒绝一条申请。成功返回 null（界面自己提示），失败返回可展示文案。
   *
   * 三层校验，缺一层都会让界面说谎：
   *   ① **本地能判死的先拒**：已终态 / 已过期 / 内容读不懂 —— 这类请求发出去
   *      只会换来 409，而且白白让列表里的状态晚一拍才更新；
   *   ② 发送前占用 [decidingApprovalId]，双击不会变成两次判定（幂等键只是第二道）；
   *   ③ 409 一律**重新拉列表**：服务端说「已经处理过」时，本地那条早已过期，
   *      不刷新就会一直显示着一条点不动的申请。
   */
  async decideApproval(
    item: ApprovalInboxItem,
    input: { approve: boolean; now?: number }
  ): Promise<string | null> {
    const now = input.now ?? Date.now()
    const approve = input.approve

    if (!this.isLiveMode) return '预览模式没有需要处理的申请。'
    const api = this.writeApi
    if (api === null) {
      return '只读模式：审批写入还没有接上后端，这次操作没有保存到服务器。'
    }
    if (item.id.trim() === '') return '申请 id 不能为空'
    if (!isApprovalPending(item)) return '这条申请已经处理过了，请刷新列表。'
    if (isApprovalExpired(item, now)) {
      return '这条申请已超过 72 小时有效期，不能再批 / 拒，请让孩子重新提交。'
    }
    if (approve && item.summary === null) {
      return approvalBlockedReason(item, now) ?? '内容无法识别，不能批准。'
    }
    if (this.decidingApprovalIdValue !== null) {
      return '上一条申请正在处理中，请稍候…'
    }

    this.decidingApprovalIdValue = item.id
    this.persist()
    try {
      const result: ApprovalDto = await api.decideApproval(item.id, {
        approve,
        idempotencyKey: this.newIdempotencyKey('approval-decide')
      })

      // 服务端回包的状态必须与这次点击一致；不一致说明契约漂移，不能当成功。
      const expected = approve ? 'approved' : 'rejected'
      if (result.status !== expected) {
        await this.refreshApprovals()
        return `服务端返回的状态是「${result.status}」，与这次操作不一致，请刷新确认。`
      }

      // 批准会写账本 / 改余额 / 可能新建心愿 ⇒ 首页数据必须重拉，
      // 否则家长回到首页看到的还是旧积分。
      if (approve) await this.refreshFromServer()
      await this.refreshApprovals()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        // 409：本地看到的那条已经过时了。刷新后界面才与服务端一致。
        if (error.kind === 'conflict') await this.refreshApprovals()
        return error.userMessage
      }
      return '这次审批结果无法确认，请刷新后查看，避免重复提交。'
    } finally {
      this.decidingApprovalIdValue = null
      this.persist()
    }
  }

  /**
   * 我提交的申请（`GET /approvals/mine`，W5-J）。
   *
   * 刻意**不进全局状态**：收件箱（家长视角）与我的申请（申请人视角）各自
   * 分页、各自错误 —— 共用一份 `approvalItems` 会让「我在我的申请里翻了 3 页」
   * 把家长收件箱的游标顶掉，或者一次 403 同时弄脏两个页面。
   *
   * 预览模式返回空页（不编假申请），由面板显示「预览模式没有…」。
   */
  async fetchMyApprovals(
    input: { limit?: number; cursor?: string | null } = {}
  ): Promise<ApprovalsPage> {
    const api = this.readApi
    if (api === null) {
      return { items: [], hasMore: false, nextCursor: null }
    }
    const dto = await api.fetchMyApprovals({
      // 不过滤：已处理 / 已撤回的也要能看见（撤回按钮由行状态禁用）。
      status: null,
      limit: input.limit ?? AppStore.approvalsPageSize,
      cursor: input.cursor ?? null
    })
    return mapApprovalsPage(dto)
  }

  // ------------------------------------------------ 站内通知（W5-L）

  /**
   * 拉取通知第一页（`GET /notifications`）—— **打开「消息」面板时**调用。
   *
   * 预览模式没有真实的站内通知（行由服务端在审批出结果时写入）——
   * 直接进入 `ready` 空态：面板据此说「预览模式没有站内消息」，而不是发
   * 一个只会 401 的请求，再把 401 说成「网络错误」。
   *
   * 失败**不清空**上一次成功的结果：把列表清空会变成「消息都没了」，
   * 而实际可能只是断网；错误经 [notificationsError] 上报。
   */
  async refreshNotifications(): Promise<void> {
    const api = this.readApi
    if (api === null) {
      this.notificationEpoch++
      this.notificationBadgeEpoch++
      this.notificationItems = []
      this.notificationStatusValue = 'ready'
      this.notificationErrorValue = null
      this.nextNotificationCursorValue = null
      this.hasMoreNotificationsValue = false
      this.unreadNotificationCountValue = 0
      this.persist()
      return
    }

    const epoch = ++this.notificationEpoch
    this.notificationStatusValue = 'loading'
    this.notificationErrorValue = null
    this.persist()

    try {
      const page = mapNotificationsPage(
        await api.fetchNotifications({ limit: AppStore.notificationsPageSize })
      )
      if (epoch !== this.notificationEpoch) return

      // 列表刷新拿到的是整页 + 整份未读数：同时让在途的红点单查失效，
      // 否则一个更早的红点响应可能把刚拉到的未读数盖回旧值。
      this.notificationBadgeEpoch++
      this.notificationItems = page.items
      this.nextNotificationCursorValue = page.nextCursor
      this.hasMoreNotificationsValue = page.hasMore
      this.unreadNotificationCountValue = page.unreadCount
      this.notificationStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.notificationEpoch) return
      this.notificationErrorValue = toReadApiException(error)
      this.notificationStatusValue = 'error'
    }
    this.persist()
  }

  /**
   * 拉下一页（面板点「加载更多」时调用）。
   *
   * 没有下一页 / 上一页还在途时**直接返回**，不发一个游标为空的请求
   * （那会被服务端判成第一页，把列表打乱）。
   */
  async loadMoreNotifications(): Promise<void> {
    const api = this.readApi
    if (api === null) return
    const cursor = this.nextNotificationCursorValue
    if (!this.hasMoreNotificationsValue || cursor === null || cursor === '') return
    if (this.notificationStatusValue === 'loading') return

    // 不自增 epoch：这是同一个「列表会话」的下一页，不该作废第一页。
    const epoch = this.notificationEpoch
    this.notificationStatusValue = 'loadingMore'
    this.notificationErrorValue = null
    this.persist()

    try {
      const page = mapNotificationsPage(
        await api.fetchNotifications({
          limit: AppStore.notificationsPageSize,
          cursor
        })
      )
      if (epoch !== this.notificationEpoch) return

      // 去重：两次请求之间若有新通知写入，键集分页可能让同一行出现在两页。
      const known = new Set(this.notificationItems.map((item) => item.id))
      page.items.forEach((item) => {
        if (known.has(item.id)) return
        known.add(item.id)
        this.notificationItems.push(item)
      })
      this.nextNotificationCursorValue = page.nextCursor
      this.hasMoreNotificationsValue = page.hasMore
      this.unreadNotificationCountValue = page.unreadCount
      this.notificationStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.notificationEpoch) return
      this.notificationErrorValue = toReadApiException(error)
      this.notificationStatusValue = 'error'
    }
    this.persist()
  }

  /**
   * 只刷新未读红点（`GET /notifications?limit=1`）—— 进「我的」页时调用。
   *
   * ★ 为什么单独一条：红点要出现在「消息」入口上，而整页列表只在面板打开时
   *   才需要。这里只用 `limit=1` 换 `unreadCount`，**不覆盖**列表现有内容。
   *
   * ★ 失败**保持上一次的值**，绝不把「取不到」画成「没有未读」——
   *   红点消失比红点迟到更糟（用户会以为已经看完了）。
   */
  async refreshUnreadNotificationCount(): Promise<void> {
    const api = this.readApi
    if (api === null) return
    const epoch = ++this.notificationBadgeEpoch
    try {
      const page = mapNotificationsPage(await api.fetchNotifications({ limit: 1 }))
      if (epoch !== this.notificationBadgeEpoch) return
      this.unreadNotificationCountValue = page.unreadCount
      this.persist()
    } catch {
      // 红点是提示性信息：静默失败即可（面板打开时还有一次完整列表可重试）。
    }
  }

  /**
   * 标记一条通知已读（`PATCH /notifications/:id/read`）。成功返回 null。
   *
   * 只把**这一行**改成本地已读，并把未读数减一 —— 不重拉整页：
   * 重拉会让「刚点开的那条」在列表里跳位置，用户会以为点错了行。
   * `readAt` 用**服务端**回包（已读再调时是第一次的时间）。
   *
   * 404 = 这条通知已经不在（服务端清过 / 不是发给我的）：刷新列表，
   * 让界面与服务端一致，而不是留一条点不动的行。
   */
  async markNotificationRead(notification: NotificationItem): Promise<string | null> {
    if (!this.isLiveMode) return '预览模式没有真实的站内通知，这次没有提交。'
    const api = this.writeApi
    if (api === null) return this.notificationReadOnlyWriteMessage
    if (!isNotificationUnread(notification)) return null
    if (this.busyNotificationIdValue !== null) {
      return '上一条通知正在标记，请稍候…'
    }

    this.busyNotificationIdValue = notification.id
    this.persist()
    try {
      const written = await api.markNotificationRead(notification.id)
      if (written.id !== notification.id) {
        // API 层已验过；这里再守一次，避免「标记了别人那条」被当成功。
        await this.refreshNotifications()
        return '服务端返回的通知与这次操作不一致，请刷新消息列表确认。'
      }
      this.applyNotificationRead(written.id, written.readAt)
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        // 404：这一行已经不在了 —— 重拉让界面与服务端一致。
        if (error.kind === 'notFound') await this.refreshNotifications()
        return error.userMessage
      }
      return '标记已读的请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.busyNotificationIdValue = null
      this.persist()
    }
  }

  /**
   * 把服务端的已读结果写到本地那一行，并同步未读数。
   *
   * 这一行不在本地列表里（例如只刷新过红点）⇒ 不凭空造行、未读数也不猜：
   * 交给下一次 `refreshNotifications()`（它带整份 `unreadCount`）。
   */
  private applyNotificationRead(id: string, readAt: number): void {
    for (let index = 0; index < this.notificationItems.length; index++) {
      const item = this.notificationItems[index]
      if (item === undefined || item.id !== id) continue
      const wasUnread = item.readAt === null
      this.notificationItems[index] = { ...item, readAt }
      if (wasUnread && this.unreadNotificationCountValue > 0) {
        this.unreadNotificationCountValue--
      }
      return
    }
  }

  /**
   * 清空站内通知的本地状态（切账号 / 恢复正常数据 / 演示重置时调用）。
   *
   * 通知是**私密内容**（含审批结果）：不清的话，切到另一个孩子后打开消息
   * 面板会先看到上一个账号的消息。两个 epoch 一起推走 —— 在途的列表 / 红点
   * 响应回来时不能再往新会话里写旧值。
   */
  private resetNotifications(): void {
    this.notificationEpoch++
    this.notificationBadgeEpoch++
    this.notificationItems = []
    this.notificationStatusValue = 'idle'
    this.notificationErrorValue = null
    this.hasMoreNotificationsValue = false
    this.nextNotificationCursorValue = null
    this.unreadNotificationCountValue = 0
    this.busyNotificationIdValue = null
  }

  /**
   * 撤回自己提交的申请（W5-J）。成功返回 null，失败返回可展示文案。
   *
   * 与 [decideApproval] 的区别：
   *   · 撤回**不需要**读 payload（坏数据也必须能撤回，否则永久卡住）；
   *   · 撤回**不碰**余额 / 流水 ⇒ 不刷新首页；只在收件箱已加载时顺带刷新
   *     （孩子的设备请求 `/approvals` 会 403，不能因为撤回而凭空多一次失败）。
   */
  async withdrawApproval(
    item: ApprovalInboxItem,
    now: number = Date.now()
  ): Promise<string | null> {
    if (!this.isLiveMode) return '预览模式没有可撤回的申请。'
    const api = this.writeApi
    if (api === null) return this.readOnlyWriteMessage
    if (item.id.trim() === '') return '申请 id 不能为空'
    if (!isApprovalPending(item)) return '这条申请已经处理过了，请刷新列表。'
    if (!canWithdrawApproval(item, now)) {
      return '这条申请已超过 72 小时有效期，不能再撤回。'
    }

    try {
      const result = await api.withdrawApproval(
        item.id,
        this.newIdempotencyKey('approval-withdraw')
      )
      // 契约漂移不能当成功：用户以为撤回了，家长那边却还能批。
      if (result.status !== 'withdrawn') {
        return `服务端返回的状态是「${result.status}」，与这次撤回不一致，请刷新确认。`
      }
      if (this.approvalStatusValue !== 'idle') await this.refreshApprovals()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        // 409（已被批 / 已过期）：本地那条已经过时；收件箱若没加载就不去打扰。
        if (error.kind === 'conflict' && this.approvalStatusValue !== 'idle') {
          await this.refreshApprovals()
        }
        return error.userMessage
      }
      return '这次撤回结果无法确认，请刷新后查看，避免重复提交。'
    }
  }

  /**
   * 切换记录页分类。live 模式下**重新向服务端要第一页**（带 `category`），
   * 因为本地只过滤已加载的 50 条会漏掉后面的同类记录（那是假「共 N 条」）。
   */
  async setRecordFilter(category: RecordCategory | null): Promise<void> {
    if (this.recordFilterValue === category) return
    this.recordFilterValue = category

    if (this.readApi === null) {
      this.persist()
      return
    }
    // 首次加载还没成功时，切分类不能只改本地筛选：服务端那页仍按旧分类在途，
    // 回来后会和 chip 对不上。整页刷新会递增 epoch，把旧响应作废。
    if (this.usingPreviewValue) {
      await this.refreshFromServer()
      return
    }
    const api = this.readApi

    const epoch = ++this.readEpoch
    this.readStatusValue = 'loading'
    this.readErrorValue = null
    this.nextCursorValue = null
    this.moreAvailable = false
    this.records = []
    this.persist()

    try {
      const dto = await api.fetchRecords({
        category,
        limit: AppStore.recordsPageSize
      })
      if (epoch !== this.readEpoch) return

      this.applyRecordsPage(mapRecordsPage(dto), false)
      this.readStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.readEpoch) return
      this.readErrorValue = toReadApiException(error)
      this.readStatusValue = 'error'
    }
    this.persist()
  }

  /**
   * 页面首帧后触发一次读取。已读过（成功或失败）就不再自动重试 ——
   * 失败后的重试是**用户的动作**（顶部提示条 / 下拉刷新）。
   */
  ensureInitialRead(): void {
    if (!this.isLiveMode || this.readStatusValue !== 'idle') return
    void this.refreshFromServer()
  }

  /** 服务端快照覆盖本地列表（软删状态一律来自服务端：active）。 */
  private applyHomeSnapshot(snapshot: {
    childName: string
    childId: string
    pointsBalance: number
    goodHabitCount: number
    rewardCount: number
    habits: Habit[]
    rules: PointRule[]
    wishes: Wish[]
  }): void {
    this.points = snapshot.pointsBalance
    this.profile = {
      name: snapshot.childName,
      childId: snapshot.childId,
      goodHabitCount: snapshot.goodHabitCount,
      rewardCount: snapshot.rewardCount
    }
    this.habitList = snapshot.habits.slice()
    this.ruleList = snapshot.rules.slice()
    this.wishList = snapshot.wishes.slice()
  }

  private applyRecordsPage(page: RecordsPage, append: boolean): void {
    if (!append) this.records = []
    // 按 id 去重：键集翻页本不该重叠，但客户端多一道保险 ——
    // 宁可少显示一条重复，也不能让「加载更多」把同一笔流水堆两遍。
    const known = new Set(this.records.map((record) => record.id))
    page.records.forEach((record) => {
      if (known.has(record.id)) return
      known.add(record.id)
      this.records.push(record)
    })
    this.nextCursorValue = page.nextCursor
    this.moreAvailable = page.hasMore
  }


  /** 单个习惯的派生视图（用于“刚打完卡”的单点查询）。 */
  habitViewOf(habit: Habit): HabitView {
    return habitView(habit, this.records)
  }

  canRedeem(wish: Wish): boolean {
    return !wish.redeemed && this.points >= wish.cost
  }

  gapOf(wish: Wish): number {
    const gap = wish.cost - this.points
    return gap > 0 ? gap : 0
  }

  // ------------------------------------------------------------------- 打卡

  /**
   * 首页习惯打卡。成功返回 null，失败返回提示文案。
   *
   * [actor] 记录**真实操作人** —— 修 A4：原先无论谁打卡都写死“家长记录”，
   * 孩子自己完成也显示“家长记录”，流水在撒谎且责任链断裂。
   */
  checkIn(
    habit: Habit,
    actor: ActorContext = { role: 'guardian' }
  ): string | null {
    // 修 A3：上限判定必须来自**当天流水**，不能是布尔量 `checked` ——
    // 否则“每天最多 2 次”的规则打完 1 次就再也打不了第 2 次（承诺的次数永远不可达）。
    // 习惯以 store 里的**当前**定义为准（视图是快照，不能信任调用方传进来的副本）。
    const live = this.habits.find((item) => item.id === habit.id)
    if (!live) {
      return `“${habit.title}”已经不在今天的习惯里了`
    }
    const done = checkedCountToday(this.records, live.id)
    if (done >= live.dailyLimit) {
      return `“${live.title}”今天已经完成 ${done} 次啦，明天继续加油～`
    }
    const source: RecordSource = actor.role === 'child' ? 'child_self' : 'guardian'
    this.points += live.points
    this.profile.goodHabitCount += 1
    const time = Date.now()
    const record: PointRecord = {
      id: this.newId('rec'),
      title: live.title,
      subtitle: recordSubtitle({ time, source }),
      points: live.points,
      time,
      category: 'praise',
      icon: live.icon,
      color: live.color,
      source,
      operatorRole: actor.role,
      note: '',
      habitId: live.id,
      // 修 C10：习惯由哪条规则派生，就把那条规则**当时的版本**钉在这一笔上 ——
      // 没有它，规则改成 +5 之后这笔 +3 就成了无法解释的数字。
      ruleId: live.ruleId,
      ruleVersion: this.currentRuleVersion(live.ruleId),
      wishId: null,
      reversesRecordId: null,
      balanceAfter: this.points
    }
    this.records.unshift(record)
    // 修 C11：写流水与记审计在**同一次操作**里、只 persist 一次
    this.audit(
      'point_record.check_in',
      'point_record',
      record.id,
      null,
      auditSnapshotOf(record),
      actor
    )
    this.persist()
    return null
  }

  /**
   * 撤销今天的打卡（长按习惯卡片）。成功返回 null，失败返回提示文案。
   *
   * **修 B7**：原先直接 `filter` 掉今天的流水 —— 历史被物理抹掉（违背账本不可变原则），
   * 且按 `title` 匹配会**误删同名习惯**的记录（改过名的习惯与新习惯同名时必然出错）。
   *
   * 现改为两件事：
   * 1. 按 `habitId`（唯一）定位原记录，跳过已被冲正的记录与冲正记录本身；
   * 2. 写入一条**冲正记录**（`source='correction'`、`reversesRecordId` 指向原记录），
   *    **原记录保留不动** —— 见 docs/design/02 §5。
   *
   * 因此撤销后流水条数 **+1 而非 −1**。
   */
  undoCheckIn(
    habit: Habit,
    actor: ActorContext = { role: 'guardian' }
  ): string | null {
    // 修 A3：可撤销性同样按**当天流水**判定（`checked` 已不是可写字段）；
    // 真正决定“撤销哪一条”的仍是下面按 habitId 定位的 target。
    if (checkedCountToday(this.records, habit.id) === 0) {
      return `“${habit.title}”今天还没有打卡，不用撤销`
    }
    const reversedIds = new Set(
      this.records
        .filter((record) => record.reversesRecordId !== null)
        .map((record) => record.reversesRecordId)
    )
    const target = this.records.find(
      (record) =>
        record.habitId === habit.id &&
        record.category === 'praise' &&
        record.source !== 'correction' &&
        !reversedIds.has(record.id) &&
        isSameDay(record.time, Date.now())
    )
    if (!target) {
      return `没有找到“${habit.title}”今天的打卡记录`
    }
    // 修 B6 同类保护：扣回不得超过当前余额（禁止静默截断，否则账本不平）
    if (target.points > this.points) {
      return `积分不足，无法撤销（需扣回 ${target.points} 分，当前只有 ${this.points} 分）`
    }
    // 修 A3：这里不再写 `habit.checked = false` —— 它是派生值，
    // 撤销通过「新增一条指向原记录的冲正记录」表达（见 types.ts 的 checkedCountToday）
    this.points -= target.points
    if (this.profile.goodHabitCount > 0) this.profile.goodHabitCount -= 1
    const time = Date.now()
    const record: PointRecord = {
      id: this.newId('rec'),
      title: `撤销：${target.title}`,
      subtitle: recordSubtitle({
        time,
        source: 'correction',
        note: target.title
      }),
      points: -target.points,
      time,
      category: 'adjust',
      icon: 'minus',
      color: '#e9834b',
      source: 'correction',
      operatorRole: actor.role,
      note: target.title,
      habitId: habit.id,
      // 修 C10：冲正记录**继承**原记录的规则与版本 ——
      // "哪一版规则产生了这笔分、又是谁撤销的"因此都留在账上
      ruleId: target.ruleId,
      ruleVersion: target.ruleVersion,
      wishId: null,
      reversesRecordId: target.id,
      balanceAfter: this.points
    }
    this.records.unshift(record)
    this.audit(
      'point_record.undo_check_in',
      'point_record',
      record.id,
      null,
      auditSnapshotOf(record),
      actor
    )
    this.persist()
    return null
  }

  // ------------------------------------------------------- 服务端写入口（W4-E）

  /**
   * 首页打卡的统一入口。
   *
   * · 预览模式：走原来的本地 [checkIn]（返回值语义不变）；
   * · live 模式：POST `/records/check-in`，成功后先把返回的流水落到本地，
   *   再刷新服务端快照（余额 / 好习惯次数以服务端为准）。
   *
   * 写请求全程串行：第二次点击在第一次结束前到达时直接返回提示。
   */
  async submitCheckIn(
    habit: Habit,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    if (!this.isLiveMode) return this.checkIn(habit, actor)
    const api = this.writeApi
    if (api === null) {
      return '只读模式：打卡写入还没有接上后端，这次操作没有保存到服务器。'
    }
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      const result = await api.checkIn(habit.id, this.newIdempotencyKey('checkin'))
      this.applyWrittenRecord(result.record)
      // 写成功后再刷新：即使刷新失败，界面也已经能看到刚写入的那笔流水，
      // 不会把“写入成功、读取失败”误报成“打卡失败”。
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '打卡请求已发出，但结果无法确认。请刷新后查看，避免重复操作。'
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 长按撤销今天的打卡（服务端写入口）。
   *
   * 目标记录优先从已加载流水里找；记录页可能被分类过滤 / 只加载 50 条，
   * 找不到时再单独取一页不分类的流水定位，**不修改**记录页正在展示的列表。
   */
  async submitUndoCheckIn(
    habit: Habit,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    if (!this.isLiveMode) return this.undoCheckIn(habit, actor)
    const api = this.writeApi
    if (api === null) {
      return '只读模式：撤销写入还没有接上后端，这次操作没有保存到服务器。'
    }
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      const target = await this.findUndoRecord(habit.id)
      if (target === null) {
        return `没有找到“${habit.title}”今天的打卡记录`
      }
      const result = await api.reverse(target.id, {
        idempotencyKey: this.newIdempotencyKey('reverse'),
        note: target.title
      })
      this.applyWrittenRecord(result.record)
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '撤销请求已发出，但结果无法确认。请刷新后查看，避免重复操作。'
    } finally {
      this.writeInFlight = false
    }
  }

  // ------------------------------------------------- 服务端写入口（W5-A：规则）

  /**
   * 新增规则（服务端写入口）。
   *
   * · 预览模式：走本地 [addRule]，返回值语义不变；
   * · live 模式：POST `/point-rules`，服务端在一个事务里写规则 + 第 1 版版本行
   *   + 审计日志；成功后把回包落到本地，再用服务端快照校正。
   *
   * 图标白名单 / 每日次数在**发请求前**按双端同一口径校验 —— 输入错误不值得
   * 让用户等一个 400。
   */
  async submitAddRule(
    title: string,
    condition: string,
    dailyLimit: number,
    points: number,
    icon: IconOption['icon'],
    color: string,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    const invalid = this.validateRuleFields(dailyLimit, icon)
    if (invalid !== null) return invalid
    if (!this.isLiveMode) {
      return this.addRule(title, condition, dailyLimit, points, icon, color, actor)
    }
    const api = this.writeApi
    if (api === null) return this.ruleReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      const dto = await api.createRule({
        title,
        condition,
        dailyLimit,
        points,
        icon,
        color,
        idempotencyKey: this.newIdempotencyKey('rule-create')
      })
      this.applyRuleDto(dto)
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '规则请求已发出，但结果无法确认。请刷新后查看，避免重复提交。'
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 编辑规则（服务端写入口）。
   *
   * `expectedVersion` 取的是**界面上看到的**版本号：服务端只接受「改的是当前版」，
   * 否则 409 `RULE_VERSION_CONFLICT` —— 不会悄悄覆盖另一位家长刚做的修改。
   */
  async submitUpdateRule(
    rule: PointRule,
    input: {
      title: string
      condition: string
      dailyLimit: number
      points: number
      /** 变更说明，写进版本记录（家长回看"为什么改"） */
      changeNote?: string
    },
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    const invalid = this.validateRuleFields(input.dailyLimit, rule.icon)
    if (invalid !== null) return invalid
    if (!this.isLiveMode) {
      return this.updateRule(rule, input, actor)
    }
    const api = this.writeApi
    if (api === null) return this.ruleReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      const dto = await api.updateRule(rule.id, {
        title: input.title,
        condition: input.condition,
        dailyLimit: input.dailyLimit,
        points: input.points,
        expectedVersion: rule.currentVersion,
        idempotencyKey: this.newIdempotencyKey('rule-update')
      })
      this.applyRuleDto(dto)
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '规则请求已发出，但结果无法确认。请刷新后查看，避免重复提交。'
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 软删规则（服务端写入口）：删除只改状态位，版本行与历史流水保留。
   *
   * 服务端是幂等的（重复删除同样回 200），这里也照常返回 null。
   */
  async submitRemoveRule(
    rule: PointRule,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    if (!this.isLiveMode) {
      this.removeRule(rule, actor)
      return null
    }
    const api = this.writeApi
    if (api === null) return this.ruleReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      await api.deleteRule(rule.id, this.newIdempotencyKey('rule-delete'))
      // 先让本地镜像跟上：即使随后的刷新失败，也不会留一条「已删却还在列表里」
      // 的规则（回收站条目的 deletedAt 用本地时间，刷新成功后以服务端为准）。
      const local = this.ruleList.find((item) => item.id === rule.id)
      if (local && local.status !== 'deleted') {
        local.status = 'deleted'
        local.deletedAt = Date.now()
        this.persist()
      }
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '删除请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 按规则生成首页习惯（服务端写入口）。
   *
   * 扣分规则 / 重复添加在本地先拦一次（即时反馈），最终仍以服务端判定为准：
   * 服务端按 `sourceRuleId` 判重，改过标题也不会重复生成。
   */
  async submitAddHabitFromRule(
    rule: PointRule,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    if (!this.isLiveMode) return this.addHabitFromRule(rule, actor)
    if (rule.points < 0) {
      return `“${rule.title}”是扣分规则，不能加入今天的习惯`
    }
    if (this.habits.some((habit) => habit.ruleId === rule.id)) {
      return `“${rule.title}”已经在今天的习惯里了`
    }
    const api = this.writeApi
    if (api === null) return this.ruleReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      const dto = await api.addHabitFromRule(
        rule.id,
        this.newIdempotencyKey('rule-habit')
      )
      this.applyHabitDto(dto)
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.writeInFlight = false
    }
  }

  /** 每日次数 / 图标白名单 —— 本地写入口与服务端写入口**共用**同一套校验与文案。 */
  private validateRuleFields(
    dailyLimit: number,
    icon: IconOption['icon']
  ): string | null {
    if (!isDailyLimitValid(dailyLimit)) {
      return `每天次数只能是 ${dailyLimitMin}–${dailyLimitMax} 之间的整数`
    }
    if (!isKnownIconName(icon)) {
      return `图标「${icon}」不在可选列表里`
    }
    return null
  }

  /** 写回包 → UI 规则模型（与服务端快照同一套映射）。 */
  private applyRuleDto(dto: RuleDto): void {
    let rule: PointRule
    try {
      rule = mapRule(dto, 'rule')
    } catch (error) {
      throw asWriteMalformed(error, 'rule')
    }
    this.ruleList = this.ruleList.filter((item) => item.id !== rule.id)
    this.ruleList.unshift(rule)
    this.persist()
  }

  /** 写回包 → UI 习惯模型。 */
  private applyHabitDto(dto: HabitDto): void {
    let habit: Habit
    try {
      habit = mapHabit(dto, 'habit')
    } catch (error) {
      throw asWriteMalformed(error, 'habit')
    }
    this.habitList = this.habitList.filter((item) => item.id !== habit.id)
    this.habitList.push(habit)
    this.persist()
  }

  /** 写回包 → UI 心愿模型（`coverStyle` 沿用服务端给的那个）。 */
  private applyWishDto(dto: WishDto): void {
    let wish: Wish
    try {
      wish = mapWish(dto, 'wish')
    } catch (error) {
      throw asWriteMalformed(error, 'wish')
    }
    this.wishList = this.wishList.filter((item) => item.id !== wish.id)
    this.wishList.unshift(wish)
    this.persist()
  }

  /** 把写端点返回的流水立即落到本地（随后仍会用服务端快照校正）。 */
  private applyWrittenRecord(dto: RecordDto): void {
    let record: PointRecord
    try {
      record = mapRecord(dto)
    } catch (error) {
      if (error instanceof ReadApiException) {
        throw WriteApiException.malformed('record', error.detail ?? undefined)
      }
      throw error
    }
    const existed = this.records.some((item) => item.id === record.id)
    this.records = this.records.filter((item) => item.id !== record.id)
    this.records.unshift(record)
    this.points = dto.balanceAfter

    if (!existed) {
      // 只是刷新失败时的兜底计数：刷新成功后会被服务端的 goodHabitCount 覆盖。
      if (dto.category === 'praise' && dto.source !== 'correction') {
        this.profile.goodHabitCount += 1
      } else if (
        dto.source === 'correction' &&
        dto.points < 0 &&
        this.profile.goodHabitCount > 0
      ) {
        this.profile.goodHabitCount -= 1
      }
    }
    this.persist()
  }

  /** 在当前列表里找「今天、未冲正」的那笔打卡。 */
  private findUndoRecordIn(
    source: PointRecord[],
    habitId: string
  ): PointRecord | null {
    const reversedIds = new Set(
      source
        .filter((record) => record.reversesRecordId !== null)
        .map((record) => record.reversesRecordId)
    )
    for (const record of source) {
      if (
        record.habitId === habitId &&
        record.category === 'praise' &&
        record.source !== 'correction' &&
        !reversedIds.has(record.id) &&
        isSameDay(record.time, Date.now())
      ) {
        return record
      }
    }
    return null
  }

  private async findUndoRecord(habitId: string): Promise<PointRecord | null> {
    const local = this.findUndoRecordIn(this.records, habitId)
    if (local !== null) return local

    const read = this.readApi
    if (read === null) return null
    try {
      // 取一页**不分类**的流水：冲正记录是 adjust，只在 praise 里找会误以为
      // 原记录仍未冲正。200 是后端 DTO 的上限。
      const page = await read.fetchRecords({ limit: 200 })
      return this.findUndoRecordIn(mapRecordsPage(page).records, habitId)
    } catch (error) {
      return null
    }
  }

  /**
   * 幂等键只用于**同一次用户动作**的自动重试；每次用户点击生成一个，
   * 双击由 [writeInFlight] 拦住，断线重试不会变成两笔。
   */
  private newIdempotencyKey(prefix: string): string {
    this.seq += 1
    return `${prefix}-${Date.now()}-${this.seq}`
  }

  // ----------------------------------------------------------------- 记一笔

  /**
   * “记一笔”：家长手动加/减分。[delta] 为负表示扣分。
   * 成功返回 null，失败返回提示文案。
   *
   * **修 B6**：原先 `this.points += delta; if (this.points < 0) this.points = 0`
   * 会**静默截断**余额，而流水照记原始 `delta` —— 例如余额 124、`delta=-9999` 时
   * 余额变 0（实际变动 −124）却记 −9999，**Σ流水 ≠ 余额，账本无法对账**。
   * 现改为**拒绝超额扣分**，与 `redeem` 的语义保持一致。
   *
   * **修 A5**：原先 `if (gain) rewardCount += 1` —— 手动加分被计成一次“奖励兑换”，
   * 但 `rewardCount` 的语义是**累计兑换次数**，只应由 `redeem` 递增。
   */
  addQuickNote(
    delta: number,
    reason: string,
    note = '',
    actor: ActorContext = { role: 'guardian' }
  ): string | null {
    if (delta === 0) {
      return '调整金额不能为 0'
    }
    if (delta < 0 && Math.abs(delta) > this.points) {
      return `积分不足，当前只有 ${this.points} 分，最多可扣 ${this.points} 分`
    }
    const gain = delta > 0
    const source: RecordSource = actor.role === 'child' ? 'child_self' : 'guardian'
    this.points += delta
    const title =
      reason.trim() === '' ? (gain ? '额外奖励' : '扣除积分') : reason.trim()
    const time = Date.now()
    const record: PointRecord = {
      id: this.newId('rec'),
      title,
      subtitle: recordSubtitle({ time, source, note }),
      points: delta,
      time,
      category: 'adjust',
      icon: gain ? 'plus' : 'minus',
      color: gain ? '#6fbf4b' : '#e9834b',
      source,
      operatorRole: actor.role,
      note: note.trim(),
      habitId: null,
      // 手动"记一笔"不来自任何规则 —— 版本号因此为 null（不是"忘了写"）
      ruleId: null,
      ruleVersion: null,
      wishId: null,
      reversesRecordId: null,
      balanceAfter: this.points
    }
    this.records.unshift(record)
    this.audit(
      'point_record.quick_note',
      'point_record',
      record.id,
      null,
      auditSnapshotOf(record),
      actor
    )
    this.persist()
    return null
  }

  // --------------------------------------------- 服务端写入口（W5-B：记一笔）

  /**
   * 「记一笔」的服务端写入口。
   *
   * · 预览模式：走本地 [addQuickNote]，返回值语义完全不变；
   * · live 模式：POST `/records/adjust` —— 服务端在**一个事务**里锁余额、
   *   写流水、写审计；成功后先把回包落到本地，再用服务端快照校正。
   *
   * 与 [addQuickNote] 的两点差别，都是「服务端说了算」的直接后果：
   *   1. **余额够不够扣由服务端在锁内判定**（409 `INSUFFICIENT_POINTS`）；
   *      本地 `points` 可能已被别的设备改过，不能拿它当裁决依据；
   *   2. 流水 id / `balanceAfter` 全部来自回包，本地不先造一条 ——
   *      否则刷新后会出现「本地一条 + 服务端一条」两笔。
   *
   * 写请求全程串行：第二次点击在第一次结束前到达时直接返回提示。
   */
  async submitQuickNote(
    delta: number,
    reason: string,
    note = '',
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    if (delta === 0) {
      return '调整金额不能为 0'
    }
    if (!this.isLiveMode) {
      return this.addQuickNote(delta, reason, note, actor)
    }
    const api = this.writeApi
    if (api === null) {
      return '只读模式：记一笔还没有接上后端，这次操作没有保存到服务器。'
    }
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    // 空事由用默认文案 —— 与 [addQuickNote] 同一口径，标题必须解释这一笔。
    const title =
      reason.trim() === '' ? (delta > 0 ? '额外奖励' : '扣除积分') : reason.trim()

    this.writeInFlight = true
    try {
      const result = await api.adjust({
        title,
        points: delta,
        note,
        idempotencyKey: this.newIdempotencyKey('adjust')
      })
      this.applyWrittenRecord(result.record)
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '记一笔的请求已发出，但结果无法确认。请刷新后查看，避免重复操作。'
    } finally {
      this.writeInFlight = false
    }
  }

  // ----------------------------------------------------------------- 心愿单

  /**
   * 兑换心愿。成功返回 true，积分不足或已兑换返回 false。
   *
   * **修 B8**：原先 `title: \`兑换：${this.shortTitle(wish.title)}\`` 把标题截断到 10 字符后
   * **永久写进流水**（「周末去游乐园玩一整天（亲子票）」→「兑换：周末去游乐园玩一…」），
   * 且没有 `wishId` 回指 —— 心愿删除后这笔扣分再也无法解释。
   * 现改为**完整标题快照 + wishId 回指**，截断交给渲染层的 ellipsis。
   */
  redeem(wish: Wish, actor: ActorContext = { role: 'guardian' }): boolean {
    if (!this.canRedeem(wish)) return false
    const source: RecordSource = actor.role === 'child' ? 'child_self' : 'guardian'
    this.points -= wish.cost
    wish.redeemed = true
    this.profile.rewardCount += 1
    const time = Date.now()
    const record: PointRecord = {
      id: this.newId('rec'),
      // 修 B8：完整标题，不截断
      title: `兑换：${wish.title}`,
      subtitle: recordSubtitle({ time, source, category: 'exchange' }),
      points: -wish.cost,
      time,
      category: 'exchange',
      icon: 'gift',
      color: '#f5a24b',
      source,
      operatorRole: actor.role,
      note: '',
      habitId: null,
      ruleId: null,
      // 兑换与规则无关，版本号同样为 null
      ruleVersion: null,
      // 修 B8：回指心愿，即使心愿被删除也能解释这笔支出
      wishId: wish.id,
      reversesRecordId: null,
      balanceAfter: this.points
    }
    this.records.unshift(record)
    this.audit(
      'point_record.redeem',
      'point_record',
      record.id,
      auditSnapshotOf(wish),
      auditSnapshotOf(record),
      actor
    )
    this.persist()
    return true
  }

  addWish(
    title: string,
    cost: number,
    emoji: string,
    actor: ActorContext = { role: 'guardian' }
  ): void {
    const id = this.newId('wish')
    const wish: Wish = {
      id,
      title: title.trim(),
      cost,
      emoji,
      // 修 E16：配色只由「空档 + id」决定，与列表长度无关 —— 删项后既有心愿不再换色
      // （回收站里的心愿不参与选色：它们不在列表上，配色可以回收再利用）
      coverStyle: pickCoverStyle(
        this.wishes.map((item) => item.coverStyle),
        id
      ),
      redeemed: false,
      // 修 C9：新建即 active；删除只改状态位，数据一律保留
      status: 'active',
      deletedAt: null
    }
    this.wishList.unshift(wish)
    this.audit('wish.create', 'wish', id, null, auditSnapshotOf(wish), actor)
    this.persist()
  }

  /**
   * 删除心愿 —— **软删**（进回收站，90 天内可恢复），修 C9。
   *
   * 原先 `filter` 掉对象：误删不可恢复；且已发生的兑换流水再也找不到它回指的心愿
   * （`wishId` 指向空 —— "这笔扣分换的是什么"从此无解）。
   */
  removeWish(wish: Wish, actor: ActorContext = { role: 'guardian' }): void {
    const live = this.wishList.find((item) => item.id === wish.id)
    if (!live) return
    if (this.softDelete(live, 'wish', actor)) this.persist()
  }

  /**
   * 新增心愿（服务端写入口）。成功返回 null，失败返回可读原因。
   *
   * 三件必须钉住的事：
   *   ① 预览模式仍走本地 [addWish]（配色由本地 `pickCoverStyle` 算，同一套算法）；
   *   ② live 模式**不传** `coverStyle` —— 配色由服务端按「空档优先，否则 id 哈希」
   *      决定；客户端再算一次只会和服务端打架；
   *   ③ 403 `APPROVAL_REQUIRED`（孩子需家长确认）**不算成功**：返回原因让界面提示，
   *      绝不能本地先插一条再被刷新打回 —— 那会让孩子以为存上了。
   */
  async submitAddWish(
    title: string,
    cost: number,
    emoji: string,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    const trimmed = title.trim()
    if (trimmed === '') return '心愿名称不能为空'
    if (!Number.isInteger(cost) || cost < 1) return '所需积分要是 ≥ 1 的整数'
    if (emoji.trim() === '') return '请挑一个图标'
    if (!this.isLiveMode) {
      this.addWish(trimmed, cost, emoji, actor)
      return null
    }
    const api = this.writeApi
    if (api === null) return this.wishReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      const dto = await api.createWish({
        title: trimmed,
        cost,
        emoji,
        idempotencyKey: this.newIdempotencyKey('wish-create')
      })
      this.applyWishDto(dto)
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '心愿请求已发出，但结果无法确认。请刷新后查看，避免重复提交。'
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 删除心愿（服务端写入口）—— 软删，进回收站，不碰流水。
   *
   * `wishId` 而不是整个对象：live 模式下界面手里的 `Wish` 可能来自上一帧快照，
   * 只传 id 能避免「拿旧对象去删新数据」的错觉。
   */
  async submitRemoveWish(
    wishId: string,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    const id = wishId.trim()
    if (id === '') return '心愿 id 不能为空'
    const target = this.wishList.find((item) => item.id === id) ?? null
    if (!this.isLiveMode) {
      if (target === null) return '这个心愿已经不在列表里了'
      this.removeWish(target, actor)
      return null
    }
    const api = this.writeApi
    if (api === null) return this.wishReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      await api.deleteWish(id, this.newIdempotencyKey('wish-delete'))
      if (target !== null) this.removeWish(target, actor)
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '删除请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 兑换心愿（服务端写入口）。
   *
   * 后端**没有**「直接兑换」的接口：`redeem` 在权限矩阵里对两个角色都是
   * `REQUIRE_APPROVAL`，唯一正确路径是 `POST /approvals` 建一条申请。
   * 因此返回值的语义与其它写入口不同 —— **null 只代表「已生效」**，
   * 而 `pending` 是**要展示给用户的正常结果**（文案里明说「等家长确认、
   * 还没扣分」），不能当成功静默掉，更不能本地先扣一次分再被刷新打回。
   *
   * 预览模式仍走本地 [redeem]（没有后端可申请，演示需要能看见扣分）。
   */
  /**
   * 兑换前的**确认文案** —— 只用于弹窗，不参与任何写请求。
   *
   * 两种模式必须说两种话，否则弹窗自己就在骗人：
   *   · live：`redeem` 在矩阵里是 `REQUIRE_APPROVAL` ⇒ 点「提交申请」只是**建一条审批**，
   *     此刻一分不扣（`pending` 不是成功），所以不能写「立即扣除」；
   *   · 预览：没有服务端可申请，确认就直接本地扣分 —— 这时写「等家长确认」
   *     等于演一场永远不会有人批的戏。
   */
  redeemConfirmText(wish: Wish): string {
    if (!this.isLiveMode) {
      return `要花 ${wish.cost} 分兑换“${wish.title}”吗？确认后积分会立即扣除，心愿会标记为已兑换。`
    }
    return `要把“${wish.title}”提交给家长确认吗？家长批准后才会扣 ${wish.cost} 分，现在还没有扣。`
  }

  async submitRedeemWish(
    wishId: string,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    const id = wishId.trim()
    if (id === '') return '心愿 id 不能为空'
    if (!this.isLiveMode) {
      const local = this.wishList.find((item) => item.id === id) ?? null
      if (local === null) return '这个心愿已经不在列表里了'
      return this.redeem(local, actor) ? null : '积分还不够，继续加油打卡吧！'
    }
    const api = this.writeApi
    if (api === null) return this.readOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    // 心愿只用来拼「要扣多少分」这句文案；找不到也照样发请求 ——
    // 真正有没有、还能不能兑换由服务端说了算，客户端手里的列表可能已经过期。
    const target = this.wishList.find((item) => item.id === id) ?? null
    const costText = target === null ? '相应' : String(target.cost)

    this.writeInFlight = true
    try {
      const approval: ApprovalDto = await api.requestRedeem(
        id,
        this.newIdempotencyKey('wish-redeem')
      )
      switch (approval.status) {
        case 'approved':
          // 家长自批（或服务端瞬时批准）：以服务端快照为准，不手写扣分。
          await this.refreshFromServer()
          return null
        case 'pending':
          return `已提交给家长确认：批准后才会扣 ${costText} 分，心愿也会标记为已兑换。`
        case 'rejected':
          return '家长拒绝了这次兑换，积分没有变动。'
        case 'withdrawn':
          return '这次兑换申请已被撤回，积分没有变动。'
        case 'invalidated':
          return `这次兑换无法生效（${this.autoReasonText(
            approval.autoReason
          )}），积分没有变动。`
        default:
          // 未知状态不猜：宁可让用户刷新确认，也不能把「不清楚」说成「成功」。
          return `服务端返回了未知的审批状态「${approval.status}」，请刷新后查看兑换结果。`
      }
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '兑换申请已发出，但结果无法确认。请刷新后查看，避免重复提交。'
    } finally {
      this.writeInFlight = false
    }
  }

  /** 审批被自动判无效的原因 → 家长看得懂的一句话（`02` §4.2）。 */
  private autoReasonText(reason: string | null): string {
    switch (reason) {
      case 'WISH_DELETED':
        return '心愿已经被删除了'
      case 'INSUFFICIENT_POINTS':
        return '积分不够了'
      case 'MEMBER_REMOVED':
        return '成员已经被移出家庭'
      default:
        return '已有前提发生变化'
    }
  }

  // --------------------------------------------------------------- 积分规则

  /**
   * 新增规则。成功返回 null，失败返回提示文案。
   *
   * **修 E15 / A2**：参数由 `detail` 自由串改为 `condition` ＋ `dailyLimit` 结构字段
   * （展示串交给 [ruleDetail] 派生）；`dailyLimit` 越界时**拒绝**而不是夹到边界 ——
   * 静默改写会让家长以为约定已按他的意思生效。
   *
   * **修 D9**：`icon` 必须是白名单里的名字 —— 越界同样**拒绝**。落一个不存在的
   * 名字，界面只会画成「未知」占位（渲染口兜底），家长看不到自己选的那枚图标；
   * 兜底能保证不崩，但不该被当成「存进去了」。
   */
  addRule(
    title: string,
    condition: string,
    dailyLimit: number,
    points: number,
    icon: IconOption['icon'],
    color: string,
    actor: ActorContext = { role: 'guardian' }
  ): string | null {
    const invalid = this.validateRuleFields(dailyLimit, icon)
    if (invalid !== null) return invalid
    const rule: PointRule = {
      id: this.newId('rule'),
      title: title.trim(),
      condition: condition.trim() === '' ? '家长约定' : condition.trim(),
      dailyLimit,
      points,
      icon,
      color,
      // 修 C10：新建即 version 1，并**同时**留下 version 1 的版本记录 ——
      // 于是 `currentVersion` 永远指向一条真实存在的版本（回放不留空档）。
      currentVersion: 1,
      // 修 C9：新建即 active
      status: 'active',
      deletedAt: null
    }
    this.ruleList.unshift(rule)
    this.ruleVersions.push({
      id: this.newId('rv'),
      ruleId: rule.id,
      version: 1,
      title: rule.title,
      condition: rule.condition,
      dailyLimit: rule.dailyLimit,
      points: rule.points,
      changedByRole: actor.role,
      changedAt: Date.now(),
      changeNote: '新建规则'
    })
    this.audit('point_rule.create', 'point_rule', rule.id, null, auditSnapshotOf(rule), actor)
    this.persist()
    return null
  }

  /**
   * 删除规则 —— **软删**（进回收站，90 天内可恢复），修 C9。
   * 版本记录**不跟着删**：否则历史流水的 `(ruleId, ruleVersion)` 指向空
   * （"这分按什么规则给的"永远无法回答，见 `02` §5.6）。
   */
  removeRule(rule: PointRule, actor: ActorContext = { role: 'guardian' }): void {
    const live = this.ruleList.find((item) => item.id === rule.id)
    if (!live) return
    if (this.softDelete(live, 'point_rule', actor)) {
      this.persist()
    }
  }

  /**
   * 按规则生成一个首页习惯（规则页“加入今天的习惯”用）。
   * 成功返回 null，失败返回提示文案。
   *
   * **修 A1**：原先 `points: Math.abs(rule.points)` 把扣分规则**静默转成加分习惯** ——
   * 家长定「打人 −3 分」，孩子打人后打卡反而 **+3 分**。属产品性质级错误。
   * 扣分规则不应生成可打卡习惯，直接拒绝并给出可读文案。
   */
  addHabitFromRule(
    rule: PointRule,
    actor: ActorContext = { role: 'guardian' }
  ): string | null {
    if (this.habits.some((habit) => habit.title === rule.title)) {
      return `“${rule.title}”已经在今天的习惯里了`
    }
    if (rule.points < 0) {
      return `“${rule.title}”是扣分规则，不能加入今天的习惯`
    }
    // 修 E15：条件与频次**直取结构字段** —— 原先这里 `rule.detail.split(' · ')`
    // 反解析：多一段就丢一段、没分隔符就静默落到默认值「每天 1 次」。
    const habit: Habit = {
      id: this.newId('habit'),
      title: rule.title,
      points: rule.points,
      condition: rule.condition,
      dailyLimit: rule.dailyLimit,
      icon: rule.icon,
      color: rule.color,
      // 修 C10：记住"我是由哪条规则派生的" —— 有了这条链，打卡写出的流水
      // 才能同时写清 (ruleId, ruleVersion)；改规则时也才知道该同步谁。
      // 靠标题匹配是 E15 那类病（改个名就断链）。
      ruleId: rule.id,
      // 修 C9：新建即 active
      status: 'active',
      deletedAt: null
    }
    this.habitList.push(habit)
    this.audit('habit.create', 'habit', habit.id, null, auditSnapshotOf(habit), actor)
    this.persist()
    return null
  }

  // ------------------------------------------------------------------ 档案

  renameChild(name: string, actor: ActorContext = { role: 'guardian' }): void {
    const trimmed = name.trim()
    if (trimmed === '') return
    const before = { ...this.profile }
    this.profile.name = trimmed
    // 修 C11：改名是"成员"类变更 —— 用 member.rename 记一条，
    // 而不是混进流水（成员变更不是积分变更）。
    // 成员增删 / 角色切换 / 家长同意在本轮**未实现**（前端没有入口），
    // 因此 AuditAction 里也没有对应取值 —— 不假装覆盖。
    this.audit(
      'member.rename',
      'member',
      this.profile.childId === '' ? 'local-child' : this.profile.childId,
      auditSnapshotOf(before),
      auditSnapshotOf(this.profile),
      actor
    )
    this.persist()
  }

  /**
   * 改孩子昵称（服务端写入口 `edit_child_profile`，W5-E，2026-10-21）。
   *
   * 三种世界三种结局，语义与其它 `submit*` 一致：
   *   · 预览（无后端）：走本地 [renameChild]，返回 null —— 演示数据本来就该生效；
   *   · live 但没注入写客户端：返回只读文案，**不改内存**（否则刷新就打回原形）；
   *   · live 且有写客户端：PATCH 成功后用**服务端返回的 name** 覆盖本地档案；
   *     失败返回可展示文案，本地档案保持原样。
   *
   * 为什么以服务端返回值为准：服务端会 trim、未来还可能做敏感词替换。
   * 本地照抄输入就会显示一个库里并不存在的昵称 —— 那正是「看着成功」的假象。
   *
   * 刻意**不**顺手 `refreshFromServer()`：改名只动 `/home` 里的 `child.name`
   * 这一个字段，而它的权威值已经在 PATCH 回包里了。再拉一次只多一次往返，
   * 还可能被一个滞后（读副本 / 缓存）的快照把刚改好的名字盖回去。
   */
  async submitRenameChild(
    name: string,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    const trimmed = name.trim()
    if (trimmed === '') return '昵称不能为空，这次没有保存。'

    if (!this.isLiveMode) {
      this.renameChild(trimmed, actor)
      return null
    }

    const api = this.writeApi
    if (api === null) return this.profileReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    // 没有变化就不发请求：PATCH 虽然幂等，但白跑一次往返换不回任何信息，
    // 服务端还要多锁一次行。
    if (this.profile.name === trimmed) return '昵称没有变化，这次没有提交。'

    this.writeInFlight = true
    try {
      const dto = await api.renameChild(trimmed)
      this.profile.name = dto.name
      this.persist()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '改名请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.writeInFlight = false
    }
  }

  // ============================================ 回收站（修 C9）＋ 审计（修 C11）

  /**
   * 写入一条审计 —— **追加式**：只 `unshift`、永不 UPDATE、永不删除（修 C11）。
   *
   * [before] / [after] 一律由 [auditSnapshotOf] **深拷贝**而来。
   * 存引用的话，写完之后原对象一改，"变更前后"会同时指向那个已变形的对象 ——
   * 审计就成了摆设，而这正是 C11 要防的"看起来在做安全"（docs/design/08 §6）。
   */
  private audit(
    action: AuditAction,
    targetType: AuditTargetType,
    targetId: string,
    before: AuditSnapshot | null,
    after: AuditSnapshot | null,
    actor: ActorContext
  ): void {
    this.auditLog.unshift({
      id: this.newId('audit'),
      action,
      targetType,
      targetId,
      before,
      after,
      actorRole: actor.role,
      time: Date.now()
    })
  }

  /** 按类型取**含回收站**的原始列表（只给 store 内部与回收站用）。 */
  private listOf(kind: TrashKind): SoftDeletable[] {
    if (kind === 'point_rule') return this.ruleList
    if (kind === 'wish') return this.wishList
    return this.habitList
  }

  /**
   * 软删除：**只改 `status` ＋ `deletedAt`，物理数据一律保留** —— 修 C9。
   *
   * 原先 `removeWish` / `removeRule` 是 `filter` 掉对象：误删不可恢复；
   * 且被删主体一消失，历史流水的回指（`ruleId` / `wishId`）就指向空，
   * "这 +1 分按什么规则给的"再也无法回答。
   */
  private softDelete(item: SoftDeletable, kind: TrashKind, actor: ActorContext): boolean {
    if (item.status === 'deleted') return false
    const before = auditSnapshotOf(item)
    item.status = 'deleted'
    item.deletedAt = Date.now()
    this.audit(`${kind}.delete`, kind, item.id, before, auditSnapshotOf(item), actor)
    return true
  }

  /** 从回收站恢复：回到 `active` 并清掉 `deletedAt` —— 修 C9。 */
  private restoreItem(item: SoftDeletable, kind: TrashKind, actor: ActorContext): boolean {
    if (item.status !== 'deleted') return false
    const before = auditSnapshotOf(item)
    item.status = 'active'
    item.deletedAt = null
    this.audit(`${kind}.restore`, kind, item.id, before, auditSnapshotOf(item), actor)
    return true
  }

  /**
   * 回收站条目（规则 / 心愿 / 习惯三类汇总）—— 修 C9。
   *
   * [now] 由调用方传入，好让"90 天边界"可以被确定性地测试（见 [isTrashExpired]）。
   * 是否**已过期**只是判定；真正清理要等 UI 调 [purgeExpiredTrash] ——
   * **不做任何自动清理**（过期不等于必须删，产品决定）。
   */
  trashItems(now: number = Date.now()): TrashItem[] {
    // live：条目来自 `GET /trash`（服务端只说“哪条被删了、什么时候删的”），
    // 本地列表只是首页镜像 —— 拿它当回收站会把已恢复的条目又列出来。
    //
    // 这里**刻意不看** `usingPreview`：那个标志的含义是「首页还没成功拉过一次」，
    // 首页拉失败 / 还没拉完时回收站照样可以独立展示自己拉到的结果；
    // 也只有 `readApi !== null` 才可能有服务端结果，预览模式的回收站仍来自本地。
    if (this.readApi !== null) {
      return this.trashRows
        .map((item) => ({
          ...item,
          expired: isTrashExpired(item.deletedAt, now)
        }))
        .sort((a, b) => b.deletedAt - a.deletedAt)
    }

    const rows: TrashItem[] = []
    const collect = (kind: TrashKind): void => {
      for (const item of trashOnly(this.listOf(kind))) {
        rows.push({
          kind,
          id: item.id,
          title: item.title,
          deletedAt: item.deletedAt ?? 0,
          expired: isTrashExpired(item.deletedAt, now)
        })
      }
    }
    collect('point_rule')
    collect('wish')
    collect('habit')
    return rows.sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /** 从回收站恢复某一条（按类型 + id 定位）。 */
  restoreTrash(
    kind: TrashKind,
    id: string,
    actor: ActorContext = { role: 'guardian' }
  ): boolean {
    const item = this.listOf(kind).find((row) => row.id === id)
    if (!item) return false
    if (!this.restoreItem(item, kind, actor)) return false
    this.persist()
    return true
  }

  /** 从回收站恢复某条规则（规则页 / 回收站页用）—— 修 C9。 */
  restoreRule(rule: PointRule, actor: ActorContext = { role: 'guardian' }): boolean {
    return this.restoreTrash('point_rule', rule.id, actor)
  }

  /** 从回收站恢复某个心愿（心愿页 / 回收站页用）—— 修 C9。 */
  restoreWish(wish: Wish, actor: ActorContext = { role: 'guardian' }): boolean {
    return this.restoreTrash('wish', wish.id, actor)
  }

  /**
   * **彻底**删除某条回收站内容 —— 修 C9。
   *
   * 只允许删除 `status === 'deleted'` 的条目：列表里的东西想删必须先软删，
   * 否则"彻底删除"就成了绕过回收站的物理删（C9 又回来了）。
   */
  purgeTrash(
    kind: TrashKind,
    id: string,
    actor: ActorContext = { role: 'guardian' }
  ): boolean {
    const list = this.listOf(kind)
    const index = list.findIndex((row) => row.id === id && row.status === 'deleted')
    if (index < 0) return false
    const item = list[index]
    this.audit(`${kind}.purge`, kind, item.id, auditSnapshotOf(item), null, actor)
    list.splice(index, 1)
    this.persist()
    return true
  }

  /**
   * 清理**已过期**（满 90 天）的回收站条目，返回清掉的条数 —— 修 C9。
   *
   * **只在 UI 显式调用时执行**（回收站页的"清理已过期"按钮）：
   * 到期不等于必须删 —— 见 docs/design/08 §3.5（判定是纯函数，动作由产品决定）。
   */
  purgeExpiredTrash(
    now: number = Date.now(),
    actor: ActorContext = { role: 'guardian' }
  ): number {
    let purged = 0
    const sweep = <T extends SoftDeletable>(list: T[], kind: TrashKind): T[] => {
      const keep: T[] = []
      for (const item of list) {
        if (item.status === 'deleted' && isTrashExpired(item.deletedAt, now)) {
          this.audit(`${kind}.purge`, kind, item.id, auditSnapshotOf(item), null, actor)
          purged += 1
        } else {
          keep.push(item)
        }
      }
      return keep
    }
    this.ruleList = sweep(this.ruleList, 'point_rule')
    this.wishList = sweep(this.wishList, 'wish')
    this.habitList = sweep(this.habitList, 'habit')
    if (purged > 0) this.persist()
    return purged
  }

  // ============================================ 回收站：服务端读写（W5-F）

  /**
   * 拉取回收站（`GET /trash`）—— **打开回收站弹窗时**调用，不进首页刷新。
   *
   * 失败**不清空**上一次成功的结果：把列表清成「回收站是空的」会让用户
   * 以为东西已经被彻底删了，那是最坏的一种谎言。错误经 `trashError` 上报，
   * 页面照实显示（403 = 没有查看资格）。
   *
   * 这里**刻意不看** `usingPreview`：那个标志的含义是「首页还没成功拉过一次」，
   * 首页拉失败 / 还没拉完时回收站照样可以独立请求 —— 否则一次首页故障
   * 会顺带把回收站也画成空白。
   */
  async refreshTrash(): Promise<void> {
    const api = this.readApi
    // 纯本地预览（`readApi === null`）：回收站来自本地列表，没有可拉的东西。
    if (api === null) return

    const epoch = ++this.trashEpoch
    this.trashStatusValue = 'loading'
    this.trashErrorValue = null
    this.persist()

    try {
      const dto = await api.fetchTrash()
      if (epoch !== this.trashEpoch) return
      this.trashRows = mapTrash(dto)
      this.trashStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.trashEpoch) return
      this.trashErrorValue = toReadApiException(error)
      this.trashStatusValue = 'error'
    }
    this.persist()
  }

  /**
   * 删除首页习惯（服务端写入口，`DELETE /habits/:id`）—— 修 C9 / W5-F。
   *
   * 软删：服务端只改 `status='deleted'` + `deletedAt`，**不碰流水**，
   * 因此卡片上的历史打卡仍能回指这条习惯。本地镜像立刻跟上，随后刷新。
   */
  async submitRemoveHabit(
    habit: Habit,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    if (!this.isLiveMode) {
      this.removeHabit(habit, actor)
      return null
    }
    const api = this.writeApi
    if (api === null) return this.habitReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      await api.deleteHabit(habit.id, this.newIdempotencyKey('habit-delete'))
      // 先让本地镜像跟上：即使随后的刷新失败，也不会留一条「已删却还在首页」
      // 的习惯（`deletedAt` 用本地时间，刷新成功后以服务端为准）。
      const local = this.habitList.find((item) => item.id === habit.id)
      if (local && local.status !== 'deleted') {
        local.status = 'deleted'
        local.deletedAt = Date.now()
        this.persist()
      }
      await this.refreshFromServer()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '删除请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.writeInFlight = false
    }
  }

  // ============================================ 家庭成员：服务端读写（W5-H）

  /**
   * 拉取成员列表（`GET /members`）—— **打开成员弹窗时**调用，不进首页刷新。
   *
   * 失败**不清空**上一次成功的结果：把列表清成「没有成员」会让用户以为
   * 家庭真的空了，那是最坏的一种谎言。错误经 `memberError` 上报，页面照实
   * 显示（403 = 没有查看资格 / 会话过期）。
   */
  async refreshMembers(): Promise<void> {
    const api = this.readApi
    // 纯本地预览（`readApi === null`）：没有真实成员，弹窗显示空态。
    if (api === null) return

    const epoch = ++this.memberEpoch
    this.memberStatusValue = 'loading'
    this.memberErrorValue = null
    this.persist()

    try {
      const dto = await api.fetchMembers()
      if (epoch !== this.memberEpoch) return
      this.memberRows = mapMembers(dto)
      this.memberStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.memberEpoch) return
      this.memberErrorValue = toReadApiException(error)
      this.memberStatusValue = 'error'
    }
    this.persist()
  }

  /**
   * 改成员角色（`PATCH /members/:id`，W5-H）。成功返回 null，失败返回文案。
   *
   * 目标角色只从**这一行**推出来（家长 ⇄ 孩子）；`viewer` 没有可切目标 ——
   * 后端也只接受 `guardian` / `child`。
   *
   * 不预先校验「我是不是家长」：那条判断来自可能已经过时的列表，
   * 服务端 403 才是权威 —— 它会给出一句可执行的中文原因，原样展示。
   */
  async submitChangeMemberRole(
    member: FamilyMember
  ): Promise<string | null> {
    if (!this.isLiveMode) return '预览模式没有真实的家庭成员，这次没有提交。'
    const api = this.writeApi
    if (api === null) return this.memberReadOnlyWriteMessage
    if (this.busyMemberIdValue !== null) {
      return '上一次成员操作正在保存中，请稍候…'
    }

    if (member.isSelf) {
      return '不能修改自己的家庭成员身份，这次操作没有保存。请让另一位家长来处理。'
    }
    if (member.status !== 'active') {
      return '这个成员已经被移出家庭了，请刷新成员列表。'
    }
    const target: MutableMemberRole | null =
      member.role === 'guardian'
        ? 'child'
        : member.role === 'child'
          ? 'guardian'
          : null
    if (target === null) {
      return '访客不能改成家长或孩子，这次操作没有保存。'
    }

    this.busyMemberIdValue = member.memberId
    this.persist()
    try {
      const written = await api.changeMemberRole(member.memberId, target)
      this.replaceMember(written)
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        // 409 / 404：本地这一行已经过时了（别人先改过 / 已被移出）。
        // 刷新后界面才与服务端一致，否则家长会对着一条点不动的行反复点。
        if (error.kind === 'conflict' || error.kind === 'notFound') {
          await this.refreshMembers()
        }
        return error.userMessage
      }
      return '改角色请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.busyMemberIdValue = null
      this.persist()
    }
  }

  /**
   * 移出成员（`DELETE /members/:id`，W5-H）。成功返回 null，失败返回文案。
   *
   * 服务端只做软删并保留会话，因此这里成功后直接把该行从列表里去掉，
   * 不需要额外重拉 —— DELETE 回包已经确认了「哪一行、什么时候被移出」。
   */
  async submitRemoveMember(member: FamilyMember): Promise<string | null> {
    if (!this.isLiveMode) return '预览模式没有真实的家庭成员，这次没有提交。'
    const api = this.writeApi
    if (api === null) return this.memberReadOnlyWriteMessage
    if (this.busyMemberIdValue !== null) {
      return '上一次成员操作正在保存中，请稍候…'
    }

    if (member.isSelf) {
      return '不能移出自己，这次操作没有保存。请让另一位家长来处理。'
    }
    if (member.status !== 'active') {
      return '这个成员已经被移出家庭了，请刷新成员列表。'
    }

    this.busyMemberIdValue = member.memberId
    this.persist()
    try {
      const written: MemberRemoveDto = await api.removeMember(member.memberId)
      if (written.memberId !== member.memberId) {
        // 客户端已经在 API 层校验过；这里再守一次，避免「删了别人」被当成功。
        await this.refreshMembers()
        return '服务端返回的成员与这次操作不一致，请刷新成员列表确认。'
      }
      this.memberRows = this.memberRows.filter(
        (row) => row.memberId !== member.memberId
      )
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        if (error.kind === 'conflict' || error.kind === 'notFound') {
          await this.refreshMembers()
        }
        return error.userMessage
      }
      return '移出请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.busyMemberIdValue = null
      this.persist()
    }
  }

  /**
   * 用写接口回包刷新本地那一行（服务端是权威值：角色 / 昵称 / 时间）。
   *
   * 本行还不在列表里（例如弹窗没拉过）时不凭空造行 —— 交给下一次刷新。
   */
  private replaceMember(dto: MemberDto): void {
    const index = this.memberRows.findIndex(
      (row) => row.memberId === dto.memberId
    )
    if (index < 0) return
    const next = this.memberRows.slice()
    next[index] = mapMember(dto)
    this.memberRows = next
  }

  // ============================================ 邀请码：服务端读写（W5-I）

  /**
   * 拉取邀请码列表（`GET /invites`）—— **打开邀请码面板时**调用。
   *
   * 只有家长能看（矩阵 `invite_member` 对 child 是 DENY）；调用方先用
   * `canManageInvites` 判断，孩子视角不要发这个请求 —— 用一次注定 403 的
   * 请求去「探测」角色，既慢又会把「没有权限」画成「加载失败」。
   *
   * 失败**不清空**上一次成功的结果：把列表清成「还没有邀请码」会让家长
   * 以为自己的码被删了。错误经 `inviteError` 上报，页面照实显示。
   */
  async refreshInvites(): Promise<void> {
    const api = this.readApi
    // 纯本地预览（`readApi === null`）：没有真实邀请码，面板显示空态文案。
    if (api === null) return

    const epoch = ++this.inviteEpoch
    this.inviteStatusValue = 'loading'
    this.inviteErrorValue = null
    this.persist()

    try {
      const dto = await api.fetchInvites()
      if (epoch !== this.inviteEpoch) return
      this.inviteRows = mapInvites(dto)
      this.inviteStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.inviteEpoch) return
      this.inviteErrorValue = toReadApiException(error)
      this.inviteStatusValue = 'error'
    }
    if (epoch !== this.inviteEpoch) return
    this.persist()
  }

  /**
   * 生成邀请码（`POST /invites`，W5-I）。成功返回 null，失败返回文案。
   *
   * 回包是**新码全量行**，直接插到列表头 —— 不重拉整页：重拉会让「刚生成
   * 的那个码」排到服务端顺序里的某个位置，用户复制错了就是别人的码。
   *
   * 参数范围在 `WriteApiClient.createInvite` 里先拦一次（与后端 DTO 同口径），
   * 这里只做「现在能不能写」的判断。
   */
  async submitCreateInvite(input: {
    role: InviteRole
    maxUses: number
    expiresInDays: number
  }): Promise<string | null> {
    if (!this.isLiveMode) {
      return '预览模式没有真实的邀请码，这次没有提交。'
    }
    const api = this.writeApi
    if (api === null) return this.inviteReadOnlyWriteMessage
    if (this.isInviteWriteBusy) {
      return '上一次邀请码操作正在保存中，请稍候…'
    }
    const { role, maxUses, expiresInDays } = input
    if (role !== 'guardian' && role !== 'child') {
      return '邀请码只能邀请「孩子」或「家长」，这次没有提交。'
    }

    this.creatingInviteValue = true
    this.persist()
    try {
      const written = await api.createInvite({
        role,
        maxUses,
        expiresInDays
      })
      this.inviteRows = [mapInvite(written), ...this.inviteRows]
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        // 403（不是家长）/ 409（撞码）：列表的「当前身份」或内容可能需要
        // 重看，刷新一次比让家长对着旧状态再点一次更省事。
        if (error.kind === 'forbidden' || error.kind === 'conflict') {
          await this.refreshInvites()
        }
        return error.userMessage
      }
      return '生成邀请码的请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.creatingInviteValue = false
      this.persist()
    }
  }

  /**
   * 吊销邀请码（`POST /invites/:id/revoke`，W5-I）。成功返回 null。
   *
   * 服务端构造幂等（已吊销再吊销仍是 200、不写第二条审计），所以这里
   * 成功后只把这一行标成吊销 —— 不重拉、也不提示「已吊销过一次」。
   */
  async submitRevokeInvite(invite: InviteCode): Promise<string | null> {
    if (!this.isLiveMode) {
      return '预览模式没有真实的邀请码，这次没有提交。'
    }
    const api = this.writeApi
    if (api === null) return this.inviteReadOnlyWriteMessage
    if (this.isInviteWriteBusy) {
      return '上一次邀请码操作正在保存中，请稍候…'
    }
    if (invite.revoked) {
      return '这个邀请码已经吊销过了，不需要重复吊销。'
    }

    this.busyInviteIdValue = invite.id
    this.persist()
    try {
      const written = await api.revokeInvite(invite.id)
      if (written.id !== invite.id) {
        // API 层已验过；这里再守一次，避免「吊销了别的码」被当成功。
        await this.refreshInvites()
        return '服务端返回的邀请码与这次操作不一致，请刷新邀请码列表确认。'
      }
      this.inviteRows = this.inviteRows.map((row) =>
        row.id === invite.id ? revokedInviteCopy(row) : row
      )
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        // 404：这一行已经不在了（别的设备删过 / 不属于这个孩子）。
        if (error.kind === 'notFound' || error.kind === 'conflict') {
          await this.refreshInvites()
        }
        return error.userMessage
      }
      return '吊销请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.busyInviteIdValue = null
      this.persist()
    }
  }

  /**
   * 拉取同意状态（`GET /consent`）—— **打开同意面板时**调用。
   *
   * 只有家长能看（`view_consent` guardian ALLOW / child DENY）；调用方先用
   * [canManageConsent] 判断，孩子视角不要发这个请求（否则每次都是 403）。
   *
   * 失败**不清空**上一次成功的结果：把状态改写成「未同意」是最坏的一种
   * 谎言 —— 家长会以为同意丢了，孩子会看到一个假的按钮。错误经
   * [consentError] 上报，面板照实显示。
   */
  async refreshConsent(): Promise<void> {
    const api = this.readApi
    if (api === null) return

    const epoch = ++this.consentEpoch
    this.consentStatusValue = 'loading'
    this.consentErrorValue = null
    this.persist()

    try {
      const dto = await api.fetchConsent()
      if (epoch !== this.consentEpoch) return
      this.consentValue = mapConsent(dto)
      this.consentStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.consentEpoch) return
      this.consentErrorValue = toReadApiException(error)
      this.consentStatusValue = 'error'
    }
    if (epoch !== this.consentEpoch) return
    this.persist()
  }

  /**
   * 作出同意（`POST /consent`，W7-B）。成功返回 null。
   *
   * 服务端构造幂等（已同意再调仍是 200、`grantedAt` 保持第一次的时间），
   * 因此成功后直接用回包替换本地快照 —— 不重拉整份状态，也不提示
   * 「已经同意过一次」。
   */
  async submitGrantConsent(): Promise<string | null> {
    if (!this.isLiveMode) {
      return '预览模式没有真实的同意记录，这次没有提交。'
    }
    const api = this.writeApi
    if (api === null) return this.consentReadOnlyWriteMessage
    if (this.consentWriteBusyValue) {
      return '上一次同意操作正在保存中，请稍候…'
    }

    this.consentWriteBusyValue = true
    this.persist()
    try {
      const written = await api.grantConsent()
      this.consentValue = mapConsent(written)
      this.consentStatusValue = 'ready'
      this.consentErrorValue = null
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        // 403 / 409：本地快照可能已经过时（角色被降级 / 另一台设备刚撤回）。
        // 拉一次真状态，比让家长对着旧状态再点一次更诚实。
        if (error.kind === 'forbidden' || error.kind === 'conflict') {
          await this.refreshConsent()
        }
        return error.userMessage
      }
      return '同意请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.consentWriteBusyValue = false
      this.persist()
    }
  }

  /**
   * 撤回同意（`POST /consent/withdraw`，W7-B）。成功返回 null。
   *
   * 撤回后写动作会被 `ConsentGuard` 拦成 403 `CONSENT_REQUIRED`；读取与
   * 重新同意不受影响 —— 面板必须把这句话说出来，否则家长会以为
   * 「撤回 = 数据被删了」。
   *
   * 回包状态是 `withdrawn`（曾同意过）或 `none`（从没同意过）：两种都
   * 可以用同一个快照替换，界面按状态文案区分。
   */
  async submitWithdrawConsent(): Promise<string | null> {
    if (!this.isLiveMode) {
      return '预览模式没有真实的同意记录，这次没有提交。'
    }
    const api = this.writeApi
    if (api === null) return this.consentReadOnlyWriteMessage
    if (this.consentWriteBusyValue) {
      return '上一次同意操作正在保存中，请稍候…'
    }
    if (this.consentValue.status === 'withdrawn') {
      return '同意已经撤回过了，不需要重复撤回。'
    }

    this.consentWriteBusyValue = true
    this.persist()
    try {
      const written = await api.withdrawConsent()
      this.consentValue = mapConsent(written)
      this.consentStatusValue = 'ready'
      this.consentErrorValue = null
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        if (error.kind === 'forbidden' || error.kind === 'conflict') {
          await this.refreshConsent()
        }
        return error.userMessage
      }
      return '撤回请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.consentWriteBusyValue = false
      this.persist()
    }
  }

  /**
   * 下载家庭数据导出文件（`GET /export`）—— **打开导出面板时**调用。
   *
   * 只有家长能导出（`export_family_data` guardian ALLOW / child DENY）；
   * 调用方先用 [canExportFamilyData] 判断，孩子视角不要发这个请求 ——
   * 否则每次都是 403，还会把「没有权限」画成「加载失败」。
   *
   * ── 与同意状态的**关键差别** ────────────────────────────────────────────────
   *   导出**不受** `ConsentGuard` 管辖：撤回同意后仍然必须可用
   *   （04 §5 的可携带权 —— 家长撤回后想把自己提供的数据取走，
   *   正是这个权利最典型的场景）。因此这里刻意**不读** `consentValue`：
   *   任何「先确认同意生效」的前置判断都会把「撤回」变成「数据扣留」。
   *
   * 失败**不清空**上一次成功的结果（家长可能刚复制过一份，界面不该突然说
   * 「没有文件」）；错误经 [exportError] 上报，面板照实显示。
   */
  async loadExport(): Promise<void> {
    const api = this.readApi
    if (api === null) {
      // 预览模式没有服务端文件 —— 直接进入 ready 空态，而不是发一个只会 401
      // 的请求再把 401 说成「网络错误」。
      this.exportValue = null
      this.exportStatusValue = 'ready'
      this.exportErrorValue = null
      this.persist()
      return
    }
    // 单飞：连点只会拿到**一份**文件，因此这里不需要 epoch。
    if (this.exportBusyValue) return

    this.exportBusyValue = true
    this.exportStatusValue = 'loading'
    this.exportErrorValue = null
    this.persist()
    try {
      const dto = await api.fetchExport()
      this.exportValue = mapFamilyExport(dto)
      this.exportStatusValue = 'ready'
    } catch (error) {
      this.exportErrorValue = toReadApiException(error)
      this.exportStatusValue = 'error'
    } finally {
      this.exportBusyValue = false
      this.persist()
    }
  }

  // ------------------------------------------- 家庭数据删除（W7-D）

  /**
   * 拉取删除状态（`GET /family-deletion`）—— **打开删除面板时**调用。
   *
   * 只有家长能看（`view_family_deletion` 对 child 是 DENY）；调用方先用
   * [canManageFamilyDeletion] 判断，孩子视角不要发这个请求。
   *
   * 失败**不清空**上一次成功的结果（家长可能正对着「将于 X 日删除」做决定，
   * 界面不该因为一次断网突然说「从未申请」）；错误经 [deletionError] 上报。
   */
  async loadFamilyDeletion(): Promise<void> {
    const api = this.readApi
    if (api === null) {
      // 预览模式没有服务端删除状态 —— 进入 ready 空态，而不是发一个只会 401 的请求。
      this.familyDeletionValue = null
      this.deletionStatusValue = 'ready'
      this.deletionErrorValue = null
      this.persist()
      return
    }

    const epoch = ++this.deletionEpoch
    this.deletionStatusValue = 'loading'
    this.deletionErrorValue = null
    this.persist()
    try {
      const dto = await api.fetchFamilyDeletion()
      if (epoch !== this.deletionEpoch) return
      this.familyDeletionValue = mapFamilyDeletion(dto)
      this.deletionStatusValue = 'ready'
    } catch (error) {
      if (epoch !== this.deletionEpoch) return
      this.deletionErrorValue = toReadApiException(error)
      this.deletionStatusValue = 'error'
    } finally {
      if (epoch === this.deletionEpoch) this.persist()
    }
  }

  /**
   * 申请删除（`POST /family-deletion`，`{confirmed: true}`）。成功返回 null。
   *
   * ★ 二次确认在**界面**完成（先展开警告、再点「确认删除」）；
   *   这里仍然显式发送 `confirmed: true` —— 服务端不接受默认同意。
   *
   * 构造幂等：已在冷却期再调仍是 200、回同一条请求，因此成功后直接替换
   * 本地状态，不提示「已经申请过一次」。
   */
  async submitRequestFamilyDeletion(): Promise<string | null> {
    if (!this.isLiveMode) {
      return '预览模式没有真实的家庭数据，这次没有提交。'
    }
    const api = this.writeApi
    if (api === null) {
      return '只读模式：删除状态暂时写不进去（写客户端未就绪），这次没有提交到服务器。'
    }
    if (this.deletionBusyValue) return '上一次删除操作正在提交中，请稍候…'

    this.deletionBusyValue = true
    this.persist()
    try {
      const dto: FamilyDeletionStateDto = await api.requestFamilyDeletion()
      this.familyDeletionValue = mapFamilyDeletion(dto)
      this.deletionStatusValue = 'ready'
      this.deletionErrorValue = null
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        // 403 / 409：本地状态可能已经过时（角色被降级 / 另一台设备刚执行了删除）。
        if (error.kind === 'forbidden' || error.kind === 'conflict') {
          await this.loadFamilyDeletion()
        }
        return error.userMessage
      }
      return '删除申请已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.deletionBusyValue = false
      this.persist()
    }
  }

  /**
   * 撤销待执行的删除（`POST /family-deletion/cancel`）。成功返回 null。
   *
   * 没有 pending 时服务端回 409 `FAMILY_DELETION_NOT_PENDING` —— 那不是
   * 「现在不能撤销」而是「没有可撤销的对象」；照实上报并刷新状态。
   */
  async submitCancelFamilyDeletion(): Promise<string | null> {
    if (!this.isLiveMode) {
      return '预览模式没有真实的家庭数据，这次没有提交。'
    }
    const api = this.writeApi
    if (api === null) {
      return '只读模式：删除状态暂时写不进去（写客户端未就绪），这次没有提交到服务器。'
    }
    if (this.deletionBusyValue) return '上一次删除操作正在提交中，请稍候…'
    if (this.familyDeletionValue !== null && !this.familyDeletionValue.canCancel) {
      return '当前没有可以撤销的删除请求。'
    }

    this.deletionBusyValue = true
    this.persist()
    try {
      const dto: FamilyDeletionStateDto = await api.cancelFamilyDeletion()
      this.familyDeletionValue = mapFamilyDeletion(dto)
      this.deletionStatusValue = 'ready'
      this.deletionErrorValue = null
      return null
    } catch (error) {
      if (error instanceof WriteApiException) {
        if (error.kind === 'forbidden' || error.kind === 'conflict') {
          await this.loadFamilyDeletion()
        }
        return error.userMessage
      }
      return '撤销请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.deletionBusyValue = false
      this.persist()
    }
  }

  /**
   * 从回收站恢复一条（`POST /trash/:kind/:id/restore`）—— W5-F。
   *
   * 返回 null 才是成功；字符串是**要展示给用户的失败原因**（409
   * `TRASH_PARENT_RULE_DELETED` 之类的服务端判定，客户端不自己编）。
   */
  async submitRestoreTrash(
    item: TrashItem,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    if (!this.isLiveMode) {
      return this.restoreTrash(item.kind, item.id, actor)
        ? null
        : '这条内容已经不在了，请刷新回收站。'
    }
    const api = this.writeApi
    if (api === null) return this.trashReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      await api.restoreTrashItem(item.kind, item.id)
      // 恢复会改变首页 / 规则页 / 心愿页的可见集合 ⇒ 读状态与回收站都要刷新。
      await Promise.all([this.refreshFromServer(), this.refreshTrash()])
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '恢复请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 彻底删除一条（`DELETE /trash/:kind/:id`）—— **不可逆**，W5-F。
   *
   * 服务端拒绝时（还有流水引用 / 根本没软删）原样返回原因 ——
   * 这两种「拒绝」都是正确行为，不能当成功。
   */
  async submitPurgeTrash(
    item: TrashItem,
    actor: ActorContext = { role: 'guardian' }
  ): Promise<string | null> {
    if (!this.isLiveMode) {
      return this.purgeTrash(item.kind, item.id, actor)
        ? null
        : '这条内容已经不在回收站里了，请刷新后重试。'
    }
    const api = this.writeApi
    if (api === null) return this.trashReadOnlyWriteMessage
    if (this.writeInFlight) return '上一次操作正在保存中，请稍候…'

    this.writeInFlight = true
    try {
      await api.purgeTrashItem(item.kind, item.id)
      this.trashRows = this.trashRows.filter(
        (row) => !(row.kind === item.kind && row.id === item.id)
      )
      this.persist()
      await this.refreshTrash()
      return null
    } catch (error) {
      if (error instanceof WriteApiException) return error.userMessage
      return '彻底删除请求已发出，但结果无法确认。请刷新后查看。'
    } finally {
      this.writeInFlight = false
    }
  }

  /**
   * 清理**已过期**（满 90 天）的回收站条目 —— W5-F。
   *
   * 批量是**逐条**调的，所以如实把「清掉几条 / 几条没清掉」报回去
   * （`TrashPurgeOutcome`）：第 3 条失败时前 2 条真的已经删了，
   * 只说成功或只说失败都是在骗人。
   */
  async submitPurgeExpiredTrash(
    now: number = Date.now(),
    actor: ActorContext = { role: 'guardian' }
  ): Promise<TrashPurgeOutcome> {
    const expired = this.trashItems(now).filter((item) => item.expired)
    if (expired.length === 0) {
      return { purged: 0, failed: 0, error: null }
    }
    if (!this.isLiveMode) {
      return {
        purged: this.purgeExpiredTrash(now, actor),
        failed: 0,
        error: null
      }
    }
    const api = this.writeApi
    if (api === null) {
      return {
        purged: 0,
        failed: expired.length,
        error: this.trashReadOnlyWriteMessage
      }
    }

    let purged = 0
    let failed = 0
    let firstError: string | null = null
    for (const item of expired) {
      try {
        await api.purgeTrashItem(item.kind, item.id)
        purged += 1
        this.trashRows = this.trashRows.filter(
          (row) => !(row.kind === item.kind && row.id === item.id)
        )
      } catch (error) {
        failed += 1
        firstError =
          firstError ??
          (error instanceof WriteApiException
            ? error.userMessage
            : '请求已发出，但结果无法确认。请刷新后查看。')
      }
    }
    if (purged > 0) {
      this.persist()
      await this.refreshTrash()
    }
    return { purged, failed, error: firstError }
  }

  /** 删除首页习惯 —— **软删**（进回收站，90 天内可恢复），修 C9。 */
  removeHabit(habit: Habit, actor: ActorContext = { role: 'guardian' }): void {
    const live = this.habitList.find((item) => item.id === habit.id)
    if (!live) return
    if (this.softDelete(live, 'habit', actor)) this.persist()
  }

  /** 从回收站恢复某个习惯 —— 修 C9。 */
  restoreHabit(habit: Habit, actor: ActorContext = { role: 'guardian' }): boolean {
    return this.restoreTrash('habit', habit.id, actor)
  }

  // =================================================== 规则编辑（修 C10）

  /** 某条规则**当前**的版本号（规则不在体系里时 null）。 */
  private currentRuleVersion(ruleId: string | null): number | null {
    if (ruleId === null) return null
    const rule = this.ruleList.find((item) => item.id === ruleId)
    return rule ? rule.currentVersion : null
  }

  /**
   * 编辑规则 —— **四步一笔**（docs/design/02 §5.3：读版本 → 归档版本 →
   * 更新规则 → 写审计），修 C10。
   *
   * 四件事在**一次调用里做完、只 `persist()` 一次**：分成两次调用就会留下
   * "改了但没记"的窗口 —— 那正是 C10 ＋ C11 要一起防的东西。
   *
   * 时间线语义（§3.2 / `02` §5.4）：**历史不可回溯、未来从新规**。
   * 已发生流水的 `points` / `ruleVersion` **一字不动**；由这条规则派生的
   * 首页习惯跟着新规走，于是"今日剩余额度"自然按新规重算（A3 的派生设计）。
   *
   * 成功返回 null，失败返回提示文案（与 `addRule` 同约定）。
   */
  updateRule(
    rule: PointRule,
    input: {
      title: string
      condition: string
      dailyLimit: number
      points: number
      /** 变更说明，写进版本记录（家长回看"为什么改"） */
      changeNote?: string
    },
    actor: ActorContext = { role: 'guardian' }
  ): string | null {
    const live = this.ruleList.find((item) => item.id === rule.id)
    if (!live) return '这条规则已经不在了'
    if (live.status === 'deleted') return `“${live.title}”在回收站里，先恢复再改`
    if (!isDailyLimitValid(input.dailyLimit)) {
      return `每天次数只能是 ${dailyLimitMin}–${dailyLimitMax} 之间的整数`
    }
    const title = input.title.trim() === '' ? live.title : input.title.trim()
    const condition = input.condition.trim() === '' ? '家长约定' : input.condition.trim()
    if (
      title === live.title &&
      condition === live.condition &&
      input.dailyLimit === live.dailyLimit &&
      input.points === live.points
    ) {
      return '没有改动，规则保持原样'
    }

    const time = Date.now()
    const changed = auditSnapshotOf(live)
    const version = live.currentVersion + 1

    // ① 先归档新版本（装的**是**新值）—— 顺序不能反：先改 `PointRule` 再补版本，
    //    中间那一瞬 `currentVersion` 会指向一条不存在的版本记录（回放即见空档）。
    this.ruleVersions.push({
      id: this.newId('rv'),
      ruleId: live.id,
      version,
      title,
      condition,
      dailyLimit: input.dailyLimit,
      points: input.points,
      changedByRole: actor.role,
      changedAt: time,
      changeNote: input.changeNote?.trim() ?? ''
    })

    // ② 原地更新规则本体 —— **`id` 不变**（改价不等于换对象，否则历史断裂）
    live.title = title
    live.condition = condition
    live.dailyLimit = input.dailyLimit
    live.points = input.points
    live.currentVersion = version

    // ③ 派生同步：由这条规则生成的首页习惯跟着新规走（§3.2「未来从新规」）。
    //    习惯是规则的**派生**，不单独记审计 —— 否则一次改动会产生两条审计，
    //    回放时会把"同步"误读成一次独立变更。
    for (const habit of this.habitList) {
      if (habit.ruleId !== live.id) continue
      habit.title = live.title
      habit.condition = live.condition
      habit.dailyLimit = live.dailyLimit
      habit.points = live.points
      habit.icon = live.icon
      habit.color = live.color
    }

    // ④ 记一条审计（`before` / `after` 是真快照）
    this.audit('point_rule.update', 'point_rule', live.id, changed, auditSnapshotOf(live), actor)
    this.persist()
    return null
  }

  /**
   * 今日"这条规则"已经产生几次表扬流水 —— 给 §3.3 的影响提示用（修 C10）。
   * 直接复用 types.ts 的同一口径，别在页面里另算一遍。
   */
  checkedCountTodayOfRule(rule: PointRule, now: number = Date.now()): number {
    return checkedCountTodayByRule(this.records, rule.id, now)
  }
  // -------------------------------------------------------------- 内部工具

  private newId(prefix: string): string {
    this.seq += 1
    return `${prefix}-${Date.now()}-${this.seq}`
  }

  // （原先这里有个 private isToday()：现统一用 types.ts 的 isSameDay()，
  //   与 Flutter 侧同一个判据，避免“两端各自实现、各自漂移”）

}

/**
 * 映射层抛出的只读异常 → 写异常（`malformed`）。
 *
 * 页面只处理一种错误类型：不必知道「这次是读 DTO 报的错」还是传输层报的错。
 */
function asWriteMalformed(error: unknown, path: string): unknown {
  if (error instanceof ReadApiException) {
    return WriteApiException.malformed(path, error.detail ?? error.userMessage)
  }
  return error
}

/**
 * 非 `ReadApiException` 的意外错误也归一成可展示异常 ——
 * 页面永远只处理一种错误类型。
 */
function toReadApiException(error: unknown): ReadApiException {
  if (error instanceof ReadApiException) return error
  return new ReadApiException(
    'malformed',
    '读取数据时发生意外错误。请重试；若持续出现请反馈。',
    {
      code: 'UNEXPECTED_READ_ERROR',
      detail: String(error)
    }
  )
}

/** 全局唯一的状态中心。 */
export const store = new AppStore()

/**
 * 订阅状态中心的 Hook（只在页面组件里调用），
 * 页面每次 show 时也会刷新一次，保证从二级页返回后展示最新数据。
 *
 * live 模式下的首帧读取也在这里触发：store 的 `idle` 守卫保证
 * 无论先挂载哪个页面，都只发一次请求。
 */
export function useStore(): AppStore {
  const [, setTick] = useState(0)
  useEffect(() => store.subscribe(() => setTick((tick) => tick + 1)), [])
  useEffect(() => {
    store.ensureInitialRead()
  }, [])
  useDidShow(() => setTick((tick) => tick + 1))
  return store
}

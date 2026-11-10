import type {
  ApprovalInboxItemDto,
  ApprovalsPageDto,
  ConsentStateDto,
  FamilyDeletionStateDto,
  FamilyExportDto,
  HabitDto,
  HomeDto,
  InviteDto,
  InviteListDto,
  MemberDto,
  MemberListDto,
  NotificationDto,
  NotificationsPageDto,
  RecordsPageDto,
  RecordDto,
  RuleDto,
  TrashItemDto,
  TrashListDto,
  WishDto
} from './read_dto'
import { ReadApiException } from './read_api_errors'
import type { IconName } from '../components/Icon/icons'
import type { ApprovalInboxItem, ApprovalsPage } from './approval'
import { notificationApprovalId } from './notification'
import type { NotificationItem, NotificationsPage } from './notification'
import type {
  FamilyDeletion,
  FamilyDeletionRedactionCounts,
  FamilyExport,
  FamilyMember,
  GuardianConsent,
  Habit,
  InviteCode,
  MemberRole,
  PointRecord,
  PointRule,
  RecordCategory,
  RecordSource,
  TrashItem,
  Wish,
  WishCoverStyle
} from './types'
import {
  isTrashExpired,
  recordSubtitle,
  trashKindFromWire,
  wishCoverStyles
} from './types'

/**
 * 服务端字段 → 现有 UI 模型（字段改名只在这**一次**转换里发生）。
 *
 * 映射层同时负责**枚举校验**：服务端出现 `direction = "bonus"` 这类未知值时，
 * 宁可整次读取失败并明确报错，也不把它硬塞进 UI 模型、再让页面画出错误语义。
 * 与 Flutter `lib/data/read_mapper.dart` 同口径。
 */

export interface HomeSnapshot {
  childName: string
  childId: string
  pointsBalance: number
  goodHabitCount: number
  rewardCount: number
  habits: Habit[]
  rules: PointRule[]
  wishes: Wish[]
}

export interface RecordsPage {
  records: PointRecord[]
  hasMore: boolean
  nextCursor: string | null
  limit: number
}

export function mapHome(dto: HomeDto): HomeSnapshot {
  return {
    childName: dto.childName,
    childId: dto.childId,
    pointsBalance: dto.pointsBalance,
    goodHabitCount: dto.goodHabitCount,
    rewardCount: dto.rewardCount,
    habits: dto.habits.map((item, index) => mapHabit(item, `habits[${index}]`)),
    rules: dto.rules.map((item, index) => mapRule(item, `rules[${index}]`)),
    wishes: dto.wishes.map((item, index) =>
      mapWish(item, `wishes[${index}]`)
    )
  }
}

/**
 * 心愿 DTO → UI 模型（`GET /home` 与预览模式新增心愿共用）。
 *
 * `coverStyle` 由服务端给定（A–D）；预览模式新增心愿时由本地
 * `pickCoverStyle` 算 —— 两处同一套算法，颜色不会因为“谁写的”而不同。
 */
export function mapWish(dto: WishDto, path = 'wish'): Wish {
  return {
    id: dto.id,
    title: dto.title,
    cost: dto.cost,
    emoji: dto.emoji,
    coverStyle: asEnum(
      dto.coverStyle,
      wishCoverStyles,
      `${path}.coverStyle`
    ) as WishCoverStyle,
    redeemed: dto.redeemed,
    status: 'active',
    deletedAt: null
  }
}

/**
 * `GET /trash` → 回收站展示模型（W5-F）。
 *
 * `kind` 在 DTO 里是**字符串**，在这里严格校验：不认识就抛 malformed ——
 * 不能默默跳过一行（回收站少一条 = 家长以为它已经被彻底删掉了）。
 *
 * `expired` 由 `isTrashExpired` 现算（同一份 90 天常量），不信任服务端字段
 * —— 服务端本来也不下发它。
 */
export function mapTrash(
  dto: TrashListDto,
  now: number = Date.now()
): TrashItem[] {
  return dto.items.map((item: TrashItemDto, index: number) => {
    const path = `items[${index}]`
    const kind = trashKindFromWire(item.kind)
    if (kind === null) {
      throw ReadApiException.malformed(
        `${path}.kind`,
        `未知回收站类型：${item.kind}`
      )
    }
    return {
      kind,
      id: item.id,
      title: item.title,
      deletedAt: item.deletedAt,
      expired: isTrashExpired(item.deletedAt, now)
    }
  })
}

/**
 * 单条习惯 DTO → UI 模型（`GET /home` 与 `POST /point-rules/:id/habits` 共用）。
 *
 * 图标名不做白名单校验：未知图标由 Icon 组件渲染兜底图标，
 * 不能因为换了一个图标名就让整页读取失败。
 */
export function mapHabit(dto: HabitDto, path = 'habit'): Habit {
  return {
    id: dto.id,
    title: dto.title,
    points: dto.points,
    condition: dto.condition,
    dailyLimit: dto.dailyLimit,
    icon: dto.icon as IconName,
    color: requireHexColor(dto.color, `${path}.color`),
    ruleId: dto.ruleId,
    status: 'active',
    deletedAt: null
  }
}

/**
 * 单条规则 DTO → UI 模型（`GET /home` 与写端点回包共用）。
 *
 * `direction` 只用来**校验**：DTO 的 `points` 已经带符号，这里不再取反。
 */
export function mapRule(dto: RuleDto, path = 'rule'): PointRule {
  asEnum(dto.direction, ['reward', 'penalty'] as const, `${path}.direction`)
  return {
    id: dto.id,
    title: dto.title,
    condition: dto.condition,
    dailyLimit: dto.dailyLimit,
    points: dto.points,
    icon: dto.icon as IconName,
    color: requireHexColor(dto.color, `${path}.color`),
    currentVersion: dto.currentVersion,
    status: 'active',
    deletedAt: null
  }
}

export function mapRecordsPage(dto: RecordsPageDto): RecordsPage {
  return {
    records: dto.records.map((item, index) =>
      mapRecord(item, `records[${index}]`)
    ),
    hasMore: dto.hasMore,
    nextCursor: dto.nextCursor,
    limit: dto.limit
  }
}

/**
 * 单条线格式流水 → 本地模型。写端点返回的记录与 `GET /records` 同构，
 * 因此复用同一函数（避免“读取一条口径、写入另一条口径”）。
 */
export function mapRecord(dto: RecordDto, path = 'record'): PointRecord {
  const category = asEnum(
    dto.category,
    ['praise', 'exchange', 'adjust'] as const,
    `${path}.category`
  )
  const source = asEnum(
    dto.source,
    [
      'child_self',
      'guardian',
      'agent',
      'approval',
      'system',
      'correction'
    ] as const,
    `${path}.source`
  )
  const operatorRole =
    dto.operatorRole === null
      ? null
      : asEnum(
          dto.operatorRole,
          ['guardian', 'child', 'viewer'] as const,
          `${path}.operatorRole`
        )

  const icon: IconName =
    category === 'exchange'
      ? 'gift'
      : category === 'adjust'
        ? dto.points < 0
          ? 'minus'
          : 'plus'
        : source === 'child_self'
          ? 'check'
          : 'starFill'
  const color =
    category === 'exchange'
      ? '#f5a24b'
      : category === 'adjust'
        ? dto.points < 0
          ? '#e26a5a'
          : '#7fbf55'
        : source === 'child_self'
          ? '#7fbf55'
          : '#f2c14e'

  return {
    id: dto.id,
    title: dto.title,
    subtitle: recordSubtitle({
      time: dto.createdAt,
      source,
      category,
      note: dto.note
    }),
    points: dto.points,
    time: dto.createdAt,
    category,
    icon,
    color,
    source,
    operatorRole: operatorRole as MemberRole | null,
    note: dto.note,
    habitId: dto.habitId,
    ruleId: dto.ruleId,
    ruleVersion: dto.ruleVersion,
    wishId: dto.wishId,
    reversesRecordId: dto.reversesRecordId,
    balanceAfter: dto.balanceAfter
  }
}

/**
 * 审批收件箱一行 → 本地模型。
 *
 * `action` / `status` **不做枚举校验**（与 `ApprovalDto` 同口径）：后端将来加
 * 动作或状态时，客户端要能如实显示「状态未知（xxx）」，不能在解析层崩掉。
 * `summary` 已经在 DTO 层区分了「读不懂」与「契约漂移」：前者是 `null`。
 */
export function mapApprovalInboxItem(
  dto: ApprovalInboxItemDto,
  path = 'item'
): ApprovalInboxItem {
  if (
    dto.summary !== null &&
    dto.summary.kind === 'redeem' &&
    dto.summary.wishId.trim() === ''
  ) {
    // 空 wishId 说明服务端快照坏了：批准它等于兑一个不存在的心愿。
    throw ReadApiException.malformed(`${path}.summary.wishId`, '不能为空')
  }
  return {
    id: dto.id,
    action: dto.action,
    status: dto.status,
    requesterUserId: dto.requesterUserId,
    decidedByUserId: dto.decidedByUserId,
    executedRecordId: dto.executedRecordId,
    autoReason: dto.autoReason,
    createdAt: dto.createdAt,
    decidedAt: dto.decidedAt,
    expiresAt: dto.expiresAt,
    summary: dto.summary,
    requesterRole: dto.requesterRole
  }
}

export function mapApprovalsPage(dto: ApprovalsPageDto): ApprovalsPage {
  return {
    items: dto.items.map((item, index) =>
      mapApprovalInboxItem(item, `items[${index}]`)
    ),
    hasMore: dto.hasMore,
    nextCursor: dto.nextCursor
  }
}

function asEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  path: string
): T {
  const match = allowed.find((item) => item === value)
  if (match === undefined) {
    throw ReadApiException.malformed(
      path,
      `未知枚举值 "${value}"，允许：${allowed.join(' / ')}`
    )
  }
  return match
}

function requireHexColor(value: string, path: string): string {
  const trimmed = value.trim()
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed)) {
    throw ReadApiException.malformed(path, `不是 #RGB / #RRGGBB 颜色：${value}`)
  }
  return trimmed
}

// ───────────────────────────── 家庭成员（W5-H） ─────────────────────────────

/**
 * 线格式 → [FamilyMember]。
 *
 * `role` / `status` 在 DTO 里是字符串，**只有这里**决定哪些值是认识的：
 * 不认识就抛 [ReadApiException]（一条坏行会让整页显式失败），而不是
 * 猜成 `child` —— 猜错等于把权限边界画错。
 */
export function mapMember(dto: MemberDto, path = '$'): FamilyMember {
  if (dto.memberId.trim() === '') {
    throw ReadApiException.malformed(`${path}.memberId`, 'memberId 不能为空')
  }
  return {
    memberId: dto.memberId,
    userId: dto.userId,
    displayName: dto.displayName,
    role: asEnum(dto.role, ['guardian', 'child', 'viewer'] as const, `${path}.role`),
    status: asEnum(dto.status, ['active', 'removed'] as const, `${path}.status`),
    joinedAt: dto.joinedAt,
    removedAt: dto.removedAt,
    isSelf: dto.isSelf
  }
}

export function mapMembers(dto: MemberListDto): FamilyMember[] {
  return dto.items.map((item, index) => mapMember(item, `items[${index}]`))
}

// ============================================================ 邀请码（W5-I）

/**
 * `InviteDto` → [InviteCode]。
 *
 * 比成员多两条**本地一致性校验**，都是「画错了会误导用户」的字段：
 *   · `role` 只接受 `child` / `guardian` —— `viewer` 不是可邀请的角色，
 *     画出来会变成一张「加入后什么都做不了」的票；
 *   · `usedCount` 不能超过 `maxUses`、两者都必须是正整数 —— 名额是这张票
 *     最要紧的信息，负剩余名额无法解释。
 *
 * `code` 不做格式校验：8 位是服务端生成的，但老数据 / 手工建的码只要能用
 * 就该显示；格式只影响展示时的分组（`inviteDisplayCode`）。
 */
export function mapInvite(dto: InviteDto, path = '$'): InviteCode {
  if (dto.id.trim() === '') {
    throw ReadApiException.malformed(`${path}.id`, 'id 不能为空')
  }
  if (dto.code.trim() === '') {
    // 空码复制出去什么都做不了，且用户会以为是自己的问题。
    throw ReadApiException.malformed(`${path}.code`, 'code 不能为空')
  }
  if (dto.maxUses < 1) {
    throw ReadApiException.malformed(
      `${path}.maxUses`,
      `maxUses=${dto.maxUses} 必须 ≥ 1`
    )
  }
  if (dto.usedCount < 0 || dto.usedCount > dto.maxUses) {
    throw ReadApiException.malformed(
      `${path}.usedCount`,
      `usedCount=${dto.usedCount} 超出 0–${dto.maxUses}`
    )
  }
  return {
    id: dto.id,
    code: dto.code,
    role: asEnum(dto.role, ['child', 'guardian'] as const, `${path}.role`),
    maxUses: dto.maxUses,
    usedCount: dto.usedCount,
    expiresAt: dto.expiresAt,
    revoked: dto.revoked,
    createdAt: dto.createdAt
  }
}

export function mapInvites(dto: InviteListDto): InviteCode[] {
  return dto.items.map((item, index) => mapInvite(item, `items[${index}]`))
}

// ============================================================ 监护人同意（W7-B）

/**
 * `ConsentStateDto` → [GuardianConsent]。
 *
 * `status` 只认识 `granted` / `withdrawn` / `none`；**不认识就抛**，不猜成
 * `none` —— 猜成 `none` 会让「已同意」的家庭看到一个「同意」按钮，点下去
 * 就是第二次同意（服务端虽然幂等，但界面在说谎）。
 *
 * 形状校验（版本号 / 时间是否齐）已在 [ConsentStateDto] 构造时做过，
 * 这里只做语义转换。
 */
export function mapConsent(dto: ConsentStateDto, path = '$'): GuardianConsent {
  return {
    childId: dto.childId,
    status: asEnum(
      dto.status,
      ['granted', 'withdrawn', 'none'] as const,
      `${path}.status`
    ),
    consentVersion: dto.consentVersion,
    grantedAt: dto.grantedAt,
    withdrawnAt: dto.withdrawnAt
  }
}

// ============================================================ 家庭数据导出（W7-C）

/**
 * `FamilyExportDto` → [FamilyExport]。
 *
 * 这条「映射」几乎只是搬运 —— 导出文件没有枚举、没有跨字段语义，形状校验
 * 已全部在 [FamilyExportDto] 构造时做完。这里保留独立函数只为与其它读取
 * 保持同一个入口（调用方永远只依赖 mapper，不直接摸 DTO）。
 *
 * 唯一一条断言：`truncated === (truncatedSections 非空)` 已经在 DTO 里校验
 * 过，这里**不重新计算** —— 重算等于用客户端猜测覆盖服务端事实。
 */
export function mapFamilyExport(dto: FamilyExportDto): FamilyExport {
  return {
    rawJson: dto.rawJson,
    schemaVersion: dto.schemaVersion,
    generator: dto.generator,
    generatedAt: dto.generatedAt,
    childId: dto.childId,
    childName: dto.childName,
    pointsBalance: dto.pointsBalance,
    counts: { ...dto.counts },
    totals: { ...dto.totals },
    truncated: dto.truncated,
    truncatedSections: [...dto.truncatedSections]
  }
}

// ============================================================ 站内通知（W5-L）

/**
 * `NotificationDto` → [NotificationItem]。
 *
 * 两条校验，都是「画出来会误导人」的边界：
 *   · `id` 空 ⇒ 无法标记已读 / 无法做列表 key，整页显式失败；
 *   · `title` / `body` 空 ⇒ 行会渲染成一块空白，用户以为加载坏了 ——
 *     显式失败时至少还能给出「消息没能加载」和重试入口。
 *
 * `type` **不做**白名单：服务端加新类型时，老客户端仍应把这条列出来。
 */
export function mapNotification(
  dto: NotificationDto,
  path = '$'
): NotificationItem {
  if (dto.id.trim() === '') {
    throw ReadApiException.malformed(`${path}.id`, '通知 id 不能为空')
  }
  if (dto.title.trim() === '') {
    throw ReadApiException.malformed(`${path}.title`, '通知标题不能为空')
  }
  if (dto.body.trim() === '') {
    throw ReadApiException.malformed(`${path}.body`, '通知正文不能为空')
  }
  return {
    id: dto.id,
    type: dto.type,
    title: dto.title,
    body: dto.body,
    approvalId: notificationApprovalId(dto.payload),
    readAt: dto.readAt,
    createdAt: dto.createdAt
  }
}

export function mapNotificationsPage(
  dto: NotificationsPageDto
): NotificationsPage {
  return {
    items: dto.items.map((item, index) =>
      mapNotification(item, `items[${index}]`)
    ),
    hasMore: dto.hasMore,
    nextCursor: dto.nextCursor,
    unreadCount: dto.unreadCount
  }
}

// ============================================================ 家庭数据删除（W7-D）

/**
 * `FamilyDeletionStateDto` → [FamilyDeletion]。
 *
 * 状态线值在 DTO 里已经过白名单校验（未知值抛 `malformed`）；这里只做
 * 无歧义映射。把未知状态当 `none` 会让「后端加了新状态」显示成
 * 「从未申请删除」—— 最坏的一种默认值。
 */
export function mapFamilyDeletion(dto: FamilyDeletionStateDto): FamilyDeletion {
  const summary = dto.summary
  const redacted = summary === null ? null : summary.redacted
  const counts: FamilyDeletionRedactionCounts = {
    child: redacted?.child ?? 0,
    members: redacted?.members ?? 0,
    rules: redacted?.rules ?? 0,
    ruleVersions: redacted?.ruleVersions ?? 0,
    habits: redacted?.habits ?? 0,
    wishes: redacted?.wishes ?? 0,
    records: redacted?.records ?? 0,
    approvals: redacted?.approvals ?? 0,
    consents: redacted?.consents ?? 0,
    notifications: redacted?.notifications ?? 0
  }

  return {
    childId: dto.childId,
    status: dto.status as FamilyDeletion['status'],
    requestedAt: dto.requestedAt,
    scheduledFor: dto.scheduledFor,
    cancelledAt: dto.cancelledAt,
    executedAt: dto.executedAt,
    daysRemaining: dto.daysRemaining,
    canCancel: dto.canCancel,
    summary:
      summary === null
        ? null
        : {
            coolingDays: summary.coolingDays,
            redacted: counts,
            keptRecords: summary.keptRecords,
            keptPointsBalance: summary.keptPointsBalance,
            note: summary.note
          }
  }
}


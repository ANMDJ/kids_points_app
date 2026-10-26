import type { IconName } from '../components/Icon/icons'

/** 积分记录的来源分类，对应记录页顶部的筛选标签。 */
export type RecordCategory = 'praise' | 'exchange' | 'adjust'

/** 成员角色。对应后端 ChildMember.role（见 docs/design/02）。 */
export type MemberRole = 'guardian' | 'child' | 'viewer'

/**
 * 积分记录的**操作来源**。
 *
 * 修复 A4：原先所有流水都硬编码成“家长记录”，孩子自己打卡也写“家长记录”，
 * 流水在撒谎、责任链断裂。改为记录真实来源，subtitle 由其派生（见 E19）。
 */
export type RecordSource =
  | 'child_self'
  | 'guardian'
  | 'agent'
  | 'approval'
  | 'system'
  | 'correction'


/**
 * 一个可以打卡的习惯（首页“今天的习惯”）。
 *
 * **修 A2 / A3 / E17**：原先 `limitText` / `doneText` / `checked` 都是**可写字段** ——
 * “每天最多 2 次”因此只是给人看的字符串（系统无法判断今天还能打几次）；
 * `checked: boolean` 与“每天最多 N 次”**直接矛盾**（打完 1 次就再也打不了第 2 次，
 * 规则承诺的次数永远不可达）；`doneText` 更是 seed 里手写的 `'今日已完成 1 次'`，
 * 与真实完成次数毫无关系。
 *
 * 现在只保留结构字段 `condition` ＋ `dailyLimit`（与 `backend/prisma/schema.prisma`
 * 的 `Habit.condition` / `Habit.dailyLimit` 同构）；
 * 展示串与“是否已完成”一律由 [habitView] 从**当天流水**派生。
 */
export interface Habit {
  id: string
  /** 习惯名称，例如“番茄钟写作业” */
  title: string
  /** 完成一次获得的积分 */
  points: number
  /** 达成条件，例如“专注 25 分钟” */
  condition: string
  /** 每天可完成的次数上限（1–5 的整数，可运算、可校验）—— 修 A2 */
  dailyLimit: number
  icon: IconName
  color: string

  /**
   * 派生来源：这条习惯由哪条规则生成（`null` = 手工新建的习惯）—— 修 C10。
   *
   * 有了这条链，打卡写流水时才能把 `(ruleId, ruleVersion)` 一并钉上，
   * 改规则时也才知道该同步哪个习惯。**按 id 匹配**，绝不按标题
   * （按标题匹配是 E15 那类病：规则改个名就断链）。
   */
  ruleId: string | null

  // ──────────────────────────────────────────── 软删除（修 C9）
  /** `active` 才出现在列表里；`deleted` 进回收站，90 天内可恢复 */
  status: RecordStatus
  /** 进入回收站的时间（`status === 'active'` 时为 null） */
  deletedAt: number | null
}

/**
 * 心愿插画的配色方案 —— **稳定枚举**，与后端 `enum WishCoverStyle` 一一对应
 * （`backend/prisma/schema.prisma`）。
 *
 * 修 E16：原先用 `backgroundIndex: number`（值＝`wishes.length % 4`）表达配色，
 * 于是配色由**插入时的列表长度**决定 —— 删除中间某个心愿后，
 * 后续新增的心愿会与既有心愿撞色，既有心愿的配色也可能跳变。
 */
export type WishCoverStyle = 'A' | 'B' | 'C' | 'D'

/** 配色枚举的全部取值，以及补空档时的优先顺序。 */
export const wishCoverStyles: WishCoverStyle[] = ['A', 'B', 'C', 'D']

/**
 * id → 稳定哈希（跨端同源：Flutter 侧 `wishCoverHash` 必须用同一算式）。
 * 取模前的 `% 1000003` 只为避免大数，与配色语义无关。
 */
export function wishCoverHash(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) % 1000003
  }
  return hash
}

/**
 * 挑一个配色 —— **与列表长度无关**，所以删项不会让既有心愿变色。
 *
 * ① 还有空档：按 A → D 补第一个空档（新增不与既有撞色）；
 * ② 四个都占满：由 `id` 哈希稳定取值（可能撞色，但**永不漂移** —— 同一个 id 永远同一个色）。
 */
export function pickCoverStyle(
  taken: WishCoverStyle[],
  id: string
): WishCoverStyle {
  const used = new Set(taken)
  const free = wishCoverStyles.find((style) => !used.has(style))
  if (free) return free
  return wishCoverStyles[wishCoverHash(id) % wishCoverStyles.length]
}

/** 心愿单里可以兑换的奖励。 */
export interface Wish {
  id: string
  title: string
  /** 兑换所需积分 */
  cost: number
  /** 插画用的 emoji（无图片资源时也能保持可爱风格） */
  emoji: string
  /** 插画底色方案（**稳定枚举**，不再用数组下标）—— 修 E16 */
  coverStyle: WishCoverStyle
  /** 是否已兑换 */
  redeemed: boolean

  // ──────────────────────────────────────────── 软删除（修 C9）
  /** `active` 才出现在列表里；`deleted` 进回收站，90 天内可恢复 */
  status: RecordStatus
  /** 进入回收站的时间（`status === 'active'` 时为 null） */
  deletedAt: number | null
}

/**
 * 一条积分流水（账本条目）。
 *
 * **不可变原则**：流水一经写入不得修改或删除，撤销用**冲正**（`reversesRecordId`）。
 * 详见 docs/design/02 §5 与 docs/design/03 的 B6 / B7。
 */
export interface PointRecord {
  id: string
  /** 当时标题的**完整快照**（不截断；截断只发生在渲染层）—— 修 B8 */
  title: string
  /** 派生自 source + time + note，禁止手工拼接 —— 修 A4 / E19 */
  subtitle: string
  /** 正数为加分，负数为扣分 */
  points: number
  /** 时间戳 */
  time: number
  category: RecordCategory
  icon: IconName
  color: string

  // ───────────────────────── 账本可追溯性（A4 / B6 / B7 / B8）
  /** 操作来源，决定 subtitle 文案与统计口径 —— 修 A4 */
  source: RecordSource
  /** **真实操作人角色**（`system` / `correction` 时为 null）—— 修 A4 */
  operatorRole: MemberRole | null
  /** 补充说明，作为 subtitle 的**附加段**而非替换来源 —— 修 E19 */
  note: string
  /** 回指习惯（用唯一 id 匹配，修掉按 title 匹配导致的同名误删）—— 修 B7 */
  habitId: string | null
  /** 回指的积分规则 id（W0 起配合 ruleVersion 定位 PointRuleVersion） */
  ruleId: string | null
  /**
   * 写入当时那条规则的**版本号**（不在规则体系里时为 null）—— 修 C10。
   *
   * 没有它，`ruleId` 指向的是**已经变形的规则**：`+1` 的流水在规则被改成
   * `+3` 之后无法解释（`02` §5.4）。改规则时这一列**一字不改**。
   */
  ruleVersion: number | null
  /** 回指的心愿 id（心愿删除后仍能解释这笔扣分）—— 修 B8 */
  wishId: string | null
  /** 冲正：指向被冲正的记录 id —— 修 B7 */
  reversesRecordId: string | null
  /** **记完之后的余额**，账本对账基准 —— 修 B6 */
  balanceAfter: number
}

/** 操作上下文：谁在操作。W2 起由服务端 ChildMember 提供。 */
export interface ActorContext {
  role: MemberRole
  userId?: string
}

// ============================================================== 软删除（修 C9）

/**
 * 配置项（规则 / 习惯 / 心愿）的统一软删状态位 —— 与后端 `enum RecordStatus`
 * （`backend/prisma/schema.prisma`）一一对应。
 *
 * **修 C9**：原先删除一律是**物理删除**（`rules.filter((item) => item !== rule)`）——
 * 误删不可恢复；被删主体从数据里消失后，历史流水的回指（`ruleId` / `wishId`）
 * 指向空，"这 +1 分按什么规则给的"再也无法回答。
 * 现在删除**只改状态位**：主体留在数据里（只是从列表消失），回收站保留 90 天可恢复。
 */
export type RecordStatus = 'active' | 'deleted'

/** 回收站保留天数（Q12 结论：90 天）—— 修 C9。 */
export const trashRetentionDays = 90

/** 一天的毫秒数（本文件内部使用）。 */
const msPerDay = 86400000

/** 具备软删字段的配置项（规则 / 习惯 / 心愿）。 */
export interface SoftDeletable {
  id: string
  title: string
  status: RecordStatus
  deletedAt: number | null
}

/**
 * 回收站里这条是否**已过期**（过了保留期，判定为可清理）—— 修 C9。
 *
 * 刻意写成**纯函数**（`now` 由调用方传入）：89 / 90 / 91 天的边界因此可以
 * 被确定性地测试。**是否真的物理清理由 UI 决定**（`AppStore.purgeExpiredTrash`），
 * 本函数只负责判定 —— 见 docs/design/08 §3.5。
 *
 * 口径：自 `deletedAt` 起**满 90 天**即算过期（`>=`）—— 第 89 天仍可恢复。
 */
export function isTrashExpired(
  deletedAt: number | null,
  now: number = Date.now()
): boolean {
  if (deletedAt === null) return false
  return now - deletedAt >= trashRetentionDays * msPerDay
}

/**
 * 列表的**唯一**过滤器：只留 `status === 'active'` 的项 —— 修 C9。
 *
 * 硬约束（docs/design/08 §3.6）：排除 `deleted` 的写法**只能有这一处**。
 * 两端各写一遍 `item.status === 'active'` 迟早漂移 —— 那正是 E15 / E17 教过的。
 */
export function activeOnly<T extends { status: RecordStatus }>(items: T[]): T[] {
  return items.filter((item) => item.status === 'active')
}

/** 回收站视图的**唯一**过滤器：只留 `status === 'deleted'` 的项 —— 修 C9。 */
export function trashOnly<T extends { status: RecordStatus }>(items: T[]): T[] {
  return items.filter((item) => item.status === 'deleted')
}

/** 回收站条目类型。 */
export type TrashKind = 'point_rule' | 'wish' | 'habit'

/** 回收站条目的展示模型（三类配置汇总成一个列表）。 */
export interface TrashItem {
  kind: TrashKind
  id: string
  title: string
  deletedAt: number
  /** 已过 90 天保留期 → 可被清理（判定见 isTrashExpired） */
  expired: boolean
}

/**
 * 线值 → 枚举（`'point_rule' | 'wish' | 'habit'`）—— W5-F。
 *
 * **不认识的返回 null**（调用方决定是报错还是忽略）。与 Flutter
 * `trashKindFromWire` 同一张表：两端各写一份映射，迟早有一边认不出新类型。
 *
 * 注意：`TrashKind` 本身就是线值，所以这里只做**白名单校验**，
 * 不做命名转换（`point_rule` 不写成 `pointRule`）。
 */
export function trashKindFromWire(raw: string): TrashKind | null {
  switch (raw.trim()) {
    case 'point_rule':
      return 'point_rule'
    case 'wish':
      return 'wish'
    case 'habit':
      return 'habit'
  }
  return null
}

/** 回收站条目类型的展示文案。 */
export function trashKindLabelOf(kind: TrashKind): string {
  switch (kind) {
    case 'point_rule':
      return '规则'
    case 'wish':
      return '心愿'
    case 'habit':
      return '习惯'
  }
}

/**
 * 回收站条目的“还能恢复几天” —— 由 `deletedAt` 派生的**唯一**展示串（C9）。
 *
 * 与 [isTrashExpired] 同一口径（自 `deletedAt` 起满 90 天过期）：
 * 第 0 天删除 → 还能恢复 90 天；第 89 天 → 还能恢复 1 天；第 90 天起 → 已过保留期。
 * 刻意写成**纯函数**：天数边界可被确定性测试，页面里不出现第二处除法。
 */
export function trashRetentionText(
  deletedAt: number,
  now: number = Date.now()
): string {
  const days = Math.floor((now - deletedAt) / msPerDay)
  const left = trashRetentionDays - days
  if (left <= 0) return "已过保留期"
  return `还能恢复 ${left} 天`
}

/**
 * 批量清理的**结果事实**（W5-F）：清掉几条、几条没清掉、第一条失败原因。
 *
 * 为什么不只是一个数字：批量清理是**逐条**调的，第 3 条失败时前 2 条已经真的
 * 删了 —— 只说「失败」会让家长以为一条都没清，只说「成功」又是撒谎。
 * 与 Flutter `TrashPurgeOutcome` 同构。
 */
export interface TrashPurgeOutcome {
  /** 已彻底删除的条数 */
  purged: number
  /** 没能删掉的条数（0 = 全部成功） */
  failed: number
  /** 第一条可读的失败原因（`failed === 0` 时为 null） */
  error: string | null
}

/**
 * 批量清理结果的**展示串** —— 部分成功必须分段说清。
 *
 * 放在这里（而不是组件里）与 [trashRetentionText] 同理：这是唯一一处
 * 把「清掉 N 条 / 没清掉 M 条」翻译成中文的地方，页面不各自造句。
 */
export function trashPurgeOutcomeText(outcome: TrashPurgeOutcome): string {
  if (outcome.failed <= 0) {
    return outcome.purged > 0
      ? `已清理 ${outcome.purged} 条`
      : '没有可清理的内容'
  }
  if (outcome.purged > 0) {
    return `已清理 ${outcome.purged} 条，还有 ${outcome.failed} 条没清掉：${outcome.error}`
  }
  return `没能清理：${outcome.error}`
}

// ============================================================ 家庭成员（W5-H）

/** 成员位的库内状态（`GET /members` 目前只下发 `active`）。 */
export type MemberStatus = 'active' | 'removed'

/** `PATCH /members/:id` 唯一接受的两个目标角色（`viewer` 不是合法目标）。 */
export type MutableMemberRole = Extract<MemberRole, 'child' | 'guardian'>

/**
 * 家庭成员（`GET /members` 的一行）。
 *
 * **只有事实**：昵称 / 角色 / 状态 / 时间 / `isSelf`。没有
 * `canChangeRole` / `canRemove` —— 「我是家长」由
 * `store.canManageMembers` 从 `isSelf` 那一行推出来，服务端仍是最终裁决者
 * （被拒绝时按 403 的 `code` 解释原因，`25-w5h-handoff.md` §2.6）。
 */
export interface FamilyMember {
  memberId: string
  userId: string
  /** 服务端原样下发的昵称；null = 没设置（界面用「未命名成员」占位）。 */
  displayName: string | null
  role: MemberRole
  status: MemberStatus
  joinedAt: number
  removedAt: number | null
  /** 服务端算的「这一行是不是我」：客户端不知道自己的 userId。 */
  isSelf: boolean
}

/** 昵称的展示值：空白与 null 都不能画成一行空白（那看起来像加载失败）。 */
export function memberNameOf(displayName: string | null): string {
  const trimmed = (displayName ?? '').trim()
  return trimmed === '' ? '未命名成员' : trimmed
}

/** 角色徽标文案；`viewer` 只在历史数据里出现。 */
export function memberRoleLabelOf(role: MemberRole): string {
  switch (role) {
    case 'guardian':
      return '家长'
    case 'child':
      return '孩子'
    case 'viewer':
      return '访客'
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`
}

/** 「2026-10-01 加入」—— 本地时区；不做「几天前」这类会随刷新漂移的文案。 */
export function memberJoinedText(joinedAt: number): string {
  const date = new Date(joinedAt)
  if (Number.isNaN(date.getTime())) return '加入时间未知'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )} 加入`
}

/**
 * 可切换到的另一个角色；家长 ⇒ 孩子，孩子 ⇒ 家长。
 *
 * 返回 null 表示「没有可切的角色」（`viewer` 不是合法目标角色）。
 * 真正提交前仍会被服务端屏障二复核。
 */
export function switchableMemberRole(role: MemberRole): MutableMemberRole | null {
  switch (role) {
    case 'guardian':
      return 'child'
    case 'child':
      return 'guardian'
    case 'viewer':
      return null
  }
}

/** 「设为孩子 / 设为家长」按钮文案（没有可切角色时为 null）。 */
export function switchableMemberRoleLabel(role: MemberRole): string | null {
  const target = switchableMemberRole(role)
  if (target === null) return null
  return target === 'child' ? '设为孩子' : '设为家长'
}

// ============================================================ 邀请码（W5-I）

/** 一个邀请码最多能被几个人用（后端 DTO `@Max(10)` 同口径）。 */
export const INVITE_MAX_USES = 10

/** 邀请码最长有效期（天），对应后端 `MAX_INVITE_TTL_DAYS = 30`。 */
export const INVITE_MAX_TTL_DAYS = 30

/** 邀请码长度：服务端 8 位、不含易混字符（0/O/1/I/L）。 */
export const INVITE_CODE_LENGTH = 8

/**
 * 邀请码只能邀请 `child` / `guardian`。
 *
 * `viewer` 不是合法目标角色（后端 `CreateInviteDto` 用 `@IsIn` 拒绝）；
 * `mapInvite` 遇到它会显式报错，而不是画出一张「加入后什么都做不了」的票。
 */
export type InviteRole = Extract<MemberRole, 'child' | 'guardian'>

/** 邀请码的**可用状态**（`GET /invites` 的派生结论，客户端现算）。 */
export type InviteCodeStatus = 'usable' | 'exhausted' | 'expired' | 'revoked'

/**
 * 邀请码（`GET /invites` 的一行 / `POST /invites` 的回包）。
 *
 * 服务端只下发**事实**：`usedCount` / `maxUses` / `expiresAt` / `revoked`
 * （`invites.types.ts` 的「不下发结论」纪律）。「还能不能用」由
 * [inviteStatusOf] 在渲染时现算 —— 缓存一个 `expired` 布尔值，
 * 弹窗开着跨过有效期就会说谎。
 */
export interface InviteCode {
  id: string
  /** 服务端生成的 8 位码，客户端**不改写**它。 */
  code: string
  role: InviteRole
  maxUses: number
  usedCount: number
  expiresAt: number
  revoked: boolean
  createdAt: number
}

/**
 * 还剩几个名额。
 *
 * 服务端理论上不会让 `usedCount` 超过 `maxUses`，这里仍夹到 0，
 * 避免一条越界的行被画成负数。
 */
export function inviteRemainingUses(invite: InviteCode): number {
  const left = invite.maxUses - invite.usedCount
  return left > 0 ? left : 0
}

export function inviteIsExpiredAt(invite: InviteCode, now: number): boolean {
  return invite.expiresAt <= now
}

/**
 * 某个时刻的状态。三类「不能用」按**最确定的事实**排序：
 * 已吊销 ⇒ 已用完 ⇒ 已过期（一个码可能同时满足多条，徽标只说最重要的那条）。
 */
export function inviteStatusOf(
  invite: InviteCode,
  now: number = Date.now()
): InviteCodeStatus {
  if (invite.revoked) return 'revoked'
  if (invite.usedCount >= invite.maxUses) return 'exhausted'
  if (inviteIsExpiredAt(invite, now)) return 'expired'
  return 'usable'
}

/** 状态徽标文案（双端口径一致，见 Flutter `inviteCodeStatusLabel`）。 */
export function inviteStatusLabelOf(status: InviteCodeStatus): string {
  switch (status) {
    case 'usable':
      return '可用'
    case 'exhausted':
      return '已用完'
    case 'expired':
      return '已过期'
    case 'revoked':
      return '已吊销'
  }
}

/** 角色徽标文案；复用成员口径（家长 / 孩子），邀请码不会是访客。 */
export function inviteRoleLabelOf(role: InviteRole): string {
  return memberRoleLabelOf(role)
}

/** 「已用 1/3」—— 名额是这张票最要紧的信息，放在最前面。 */
export function inviteUsageText(invite: InviteCode): string {
  return `已用 ${invite.usedCount}/${invite.maxUses}`
}

/**
 * 「有效至 2026-11-01 12:00」—— 本地时区。
 *
 * 不用「还有 7 天」：相对文案会随刷新漂移，且跨天时算不准。
 */
export function inviteExpiresText(expiresAt: number): string {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return '有效期未知'
  return `有效至 ${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 展示用的分组：`ABCD2345` ⇒ `ABCD-2345`（与后端 `formatInviteCode` 同形）。
 *
 * **只用于展示**：复制出去的仍是原始 `code`，服务端 `normalizeInviteCode`
 * 会去掉连字符，两种写法都能加入。
 */
export function inviteDisplayCode(code: string): string {
  if (code.length !== INVITE_CODE_LENGTH) return code
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * 吊销成功后的本地副本：服务端回包只有 `{id, revoked: true}`，
 * 其余事实保持不变（不重拉也能立刻把按钮收掉）。
 */
export function revokedInviteCopy(invite: InviteCode): InviteCode {
  return { ...invite, revoked: true }
}

// ============================================================ 监护人同意（W7-B）

/**
 * 监护人同意的**库内状态**（`GET /consent` 的 `status`）。
 *
 * 线值只有三个：`granted` / `withdrawn` / `none`。后两者是不同事实
 * （「撤回」与「从没同意过」），文案也分开 —— 撤回过的家庭再点同意
 * 是**恢复**，不是首次同意。
 */
export type GuardianConsentStatus = 'granted' | 'withdrawn' | 'none'

/**
 * 当前孩子的监护人同意快照（`GET /consent`）。
 *
 * **只有事实**：状态 / 协议版本 / 两个时间点。谁能写由服务端矩阵判定
 * （`grant_consent` / `withdraw_consent` 仅 guardian ALLOW），客户端
 * 只负责在服务端拒绝时把 403 的 code 原样解释出来。
 *
 * `consentVersion` 是**同意时**的协议版本，不是当前协议版本：协议升级后
 * 旧记录仍显示旧版本号，「孩子的新资料按哪一版处理」才有据可查。
 */
export interface GuardianConsent {
  childId: string
  status: GuardianConsentStatus
  /** 同意时的协议版本（例如 `2026-10-27`）；`none` 时为 null。 */
  consentVersion: string | null
  /** 同意时间（epoch 毫秒）；`none` 时为 null。 */
  grantedAt: number | null
  /** 撤回时间（epoch 毫秒）；仅 `withdrawn` 时有值。 */
  withdrawnAt: number | null
}

/**
 * 「还没有任何记录」的本地初值 —— **不是**服务端下发的事实。
 *
 * 界面用它画空态，但不应把它当成「服务端说没同意」：在
 * `consentReadStatus !== 'ready'` 时显示「同意状态未知」更诚实。
 */
export const unknownGuardianConsent: GuardianConsent = {
  childId: '',
  status: 'none',
  consentVersion: null,
  grantedAt: null,
  withdrawnAt: null
}

/** 状态徽标文案（双端口径一致，见 Flutter `GuardianConsent.statusLabel`）。 */
export function guardianConsentStatusLabelOf(
  status: GuardianConsentStatus
): string {
  switch (status) {
    case 'granted':
      return '已同意'
    case 'withdrawn':
      return '已撤回'
    case 'none':
      return '未同意'
  }
}

/** 协议版本展示值：没有版本号时显示「—」，不要留空（看起来像加载失败）。 */
export function consentVersionLabel(consent: GuardianConsent): string {
  const raw = (consent.consentVersion ?? '').trim()
  return raw === '' ? '—' : raw
}

/**
 * 协议文本仍是占位版（`*-draft`）—— 界面据此提醒「法务文本待替换」。
 *
 * 后端只保证 `CONSENT_VERSION` 这一常量，「是不是草案」是**命名约定**，
 * 放在 UI 侧解释比新增一个只读字段更轻。
 */
export function isDraftConsentVersion(consent: GuardianConsent): boolean {
  const raw = (consent.consentVersion ?? '').trim()
  return raw === '' || raw.endsWith('-draft')
}

/**
 * 「2026-10-27 09:30 同意」；没有时间时返回 null（不编一个假时间）。
 */
export function consentGrantedText(consent: GuardianConsent): string | null {
  if (consent.grantedAt === null) return null
  return `${formatConsentMoment(consent.grantedAt)} 同意`
}

/** 「2026-10-27 10:05 撤回」；没有时间时返回 null。 */
export function consentWithdrawnText(consent: GuardianConsent): string | null {
  if (consent.withdrawnAt === null) return null
  return `${formatConsentMoment(consent.withdrawnAt)} 撤回`
}

function formatConsentMoment(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

// ============================================================ 规则版本（修 C10）

/**
 * 规则版本 —— **只增不删，永久保留**（`02` §5.3 / §5.6）。
 *
 * **修 C10**：原先只有 `addRule` / `removeRule`，家长想改分值只能"删了重建" →
 * `id` 变化 → 历史断裂（且因无 `ruleId`，连断裂都看不出来）。
 *
 * 规则被软删时**版本不跟着删**：否则历史流水的 `(ruleId, ruleVersion)` 指向空，
 * "这分按什么规则给的"永远无法回答。
 */
export interface RuleVersion {
  id: string
  ruleId: string
  version: number
  title: string
  condition: string
  dailyLimit: number
  points: number
  changedByRole: MemberRole
  changedAt: number
  changeNote: string
}

/**
 * 改规则对"今天已打卡"的影响提示（`02` §5.5）—— **验收标准，不是可选项**。
 *
 * 语义：**历史不可回溯、未来从新规** —— 已发生的流水不动（值 / 含义都不变）；
 * 今日剩余额度**按新规重算**；已得的分不补差、不追扣。
 * 若今日已打卡数 ≥ 新上限，家长**必须**被告知"今天不能再打卡了"，
 * 否则必然产生投诉（改完规则孩子打不了卡，却不知原因）。
 *
 * 刻意做成**纯函数**并钉死断言：写在 JSX / Widget 里的文案**无法被测试** ——
 * 那正是 E17 的老病（展示串被外部写入、必然与真实状态脱节）。不需要提示时返回 null。
 */
export function ruleChangeNotice(input: {
  childName: string
  checkedCountToday: number
  newDailyLimit: number
}): string | null {
  if (input.checkedCountToday < input.newDailyLimit) return null
  const name = input.childName.trim() === '' ? '孩子' : input.childName.trim()
  const limit = limitTextOf(input.newDailyLimit)
  return `改动后，${name}今天已完成 ${input.checkedCountToday} 次，按新规则「${limit}」，今天不能再打卡了。`
}

/**
 * 今天某条规则已经产生几次表扬流水 —— 修 C10（配合 §5.5 的额度重算）。
 *
 * 与 `checkedCountToday` **同一口径**（同一天 / 表扬类 / 非冲正 / 排除已被冲正的原记录），
 * 只是按 `ruleId` 而不是 `habitId` 匹配 —— 规则可以不在"今天的习惯"里，
 * 但已发生的流水仍然回指着它。
 */
export function checkedCountTodayByRule(
  records: PointRecord[],
  ruleId: string,
  now: number = Date.now()
): number {
  const reversedIds = new Set(
    records
      .filter((record) => record.reversesRecordId !== null)
      .map((record) => record.reversesRecordId)
  )
  return records.filter(
    (record) =>
      record.ruleId === ruleId &&
      record.category === 'praise' &&
      record.source !== 'correction' &&
      !reversedIds.has(record.id) &&
      isSameDay(record.time, now)
  ).length
}

// ================================================================ 审计（修 C11）

/**
 * 审计动作 —— **联合类型**（编译期穷尽），修 C11。
 *
 * 刻意**不用** `action: string`：字符串里的拼写漂移（`point_rule.updte`）不会报错，
 * 只会在几个月后"查不到那次改动"时才被发现 —— 与 E16 用枚举取代下标同理。
 *
 * 白名单（`02` §5 与 `backend/prisma/schema.prisma` 的 `AuditAction`）共五类：
 * 规则 / 心愿 / 习惯 / 成员 / 同意。本轮前端只有前四类的部分动作可达：
 *   - `member.rename` —— 成员改名（"我的"页可达）；
 *   - ❌ **成员增删 / 角色切换 / 家长同意（consent）**：前端没有对应入口，
 *     **未实现**，故**不在**本联合类型里 —— 不假装覆盖（见 docs/design/03 §C11）。
 */
export type AuditAction =
  | 'point_rule.create'
  | 'point_rule.update'
  | 'point_rule.delete'
  | 'point_rule.restore'
  | 'point_rule.purge'
  | 'wish.create'
  | 'wish.delete'
  | 'wish.restore'
  | 'wish.purge'
  | 'habit.create'
  | 'habit.delete'
  | 'habit.restore'
  | 'habit.purge'
  | 'point_record.check_in'
  | 'point_record.undo_check_in'
  | 'point_record.quick_note'
  | 'point_record.redeem'
  | 'member.rename'

/** 审计对象类型（与 `AuditAction` 的前缀一一对应）。 */
export type AuditTargetType =
  | 'point_rule'
  | 'wish'
  | 'habit'
  | 'point_record'
  | 'member'

/** 审计里的变更快照（`before` / `after`）。 */
export interface AuditSnapshot {
  [key: string]: unknown
}

/**
 * 一条审计记录 —— **追加式**（只增不删、永不 UPDATE），修 C11。
 *
 * 与后端 `AuditLog`（`backend/prisma/schema.prisma`）同构：
 * `action` / `targetType` / `targetId` / `before` / `after`（JSON 快照）/
 * `actorRole` / `createdAt`（此处为 `time`）。
 */
export interface AuditEntry {
  id: string
  action: AuditAction
  targetType: AuditTargetType
  targetId: string
  /** **变更前**快照；新增类动作（create）为 null */
  before: AuditSnapshot | null
  /** **变更后**快照；删除类动作保留末态 */
  after: AuditSnapshot | null
  actorRole: MemberRole
  time: number
}

/**
 * 生成**真快照** —— 深拷贝。
 *
 * 若只存对象引用，写入审计之后原对象一改，"变更前后"会同时指向那个已变形的对象，
 * 审计就成了摆设（这正是 C11 要防的"看起来在做安全"）。
 * 08 §6 把这一条列为**测试全绿也抓不到**的失败形态之一：
 * 断言 `auditCount === 1` 会全绿，快照其实是活的 ——
 * 抓法是"写完审计再改原对象，再读审计，内容必须不变"。
 */
export function auditSnapshotOf(item: object): AuditSnapshot {
  return JSON.parse(JSON.stringify(item)) as AuditSnapshot
}


/**
 * 积分规则：家长约定“做到什么 → 得多少分”。
 *
 * **修 E15**：原先只有一个 `detail: string` —— 结构化信息（条件 / 频次）被塞进
 * 面向人的展示串，再靠 `detail.split(' · ')` **反解析**回来：多一段就丢一段
 * （`'连续 3 天 · 每天 1 次 · 需要家长确认'` 的第三段消失），没有分隔符就静默落到
 * 默认值 `'每天 1 次'`（与家长意图无关）。
 *
 * 现在 `condition` / `dailyLimit` 是结构字段，[ruleDetail] 只负责拼展示串。
 */
export interface PointRule {
  id: string
  title: string
  /** 达成条件，例如“专注 25 分钟” */
  condition: string
  /** 每天可完成的次数上限（1–5 的整数）—— 修 A2 */
  dailyLimit: number
  /** 分值，可为负数（扣分规则） */
  points: number
  icon: IconName
  color: string

  // ───────────────────────────────────── 软删除 + 版本化（修 C9 / C10）
  /**
   * 规则版本号：新建时为 1，每次 `AppStore.updateRule` **+1**（`02` §5.3）。
   * 历史流水按 `(ruleId, ruleVersion)` 定位当时的真相。
   */
  currentVersion: number
  /** `active` 才出现在规则列表里；`deleted` 进回收站，90 天内可恢复 */
  status: RecordStatus
  /** 进入回收站的时间（`status === 'active'` 时为 null） */
  deletedAt: number | null
}

/** 孩子档案，对应“我的”页顶部信息与战绩。 */
export interface ChildProfile {
  name: string
  childId: string
  /** 累计达成的好习惯次数 */
  goodHabitCount: number
  /** 累计奖励（兑换）次数 */
  rewardCount: number
}

/** 一个可选的图标 + 配色（规则图标选择器）。 */
export interface IconOption {
  icon: IconName
  color: string
}

// ------------------------------------------------------------------ 文案工具

export const recordCategoryLabels: Record<RecordCategory, string> = {
  praise: '表扬',
  exchange: '兑换',
  adjust: '调整'
}

/** 操作来源的展示文案（修 A4）。 */
export const recordSourceLabels: Record<RecordSource, string> = {
  child_self: '自己完成',
  guardian: '家长记录',
  agent: '积分小助手',
  approval: '家长审批通过',
  system: '系统',
  correction: '撤销'
}

/**
 * 由**结构化字段**派生 `subtitle` —— 修 A4 / E19。
 *
 * 禁止在写入处手工拼接文案：那正是 A4“流水撒谎”的成因
 * （无论谁操作都写死“家长记录”）。所有写入方必须经由本函数。
 */
export function recordSubtitle(input: {
  time: number
  source: RecordSource
  category?: RecordCategory
  note?: string
}): string {
  const head =
    input.category === 'exchange'
      ? '兑换奖励'
      : recordSourceLabels[input.source]
  const parts: string[] = [clockText(input.time), head]
  const note = (input.note ?? '').trim()
  if (note !== '') parts.push(note)
  return parts.join(' · ')
}

// ------------------------------------------- 结构字段 → 派生值（修 A2 / A3 / E15 / E17）
// 与 `backend/prisma/schema.prisma` 的结构字段一一对应（见 docs/design/03 §A2 / §A3 / §E15）。

/** 每日次数上限的允许区间 —— 与后端模板校验（`backend/prisma/seed/templates.data.ts`）同口径。 */
export const dailyLimitMin = 1
export const dailyLimitMax = 5

/** 频次是否合法：`dailyLimit` 必须是 1–5 的整数。 */
export function isDailyLimitValid(dailyLimit: number): boolean {
  return (
    Number.isInteger(dailyLimit) &&
    dailyLimit >= dailyLimitMin &&
    dailyLimit <= dailyLimitMax
  )
}

/** 频次的展示串 —— 修 E17：由 `dailyLimit` 派生，禁止任何地方手工写死。 */
export function limitTextOf(dailyLimit: number): string {
  return dailyLimit === 1 ? '每天 1 次' : `每天最多 ${dailyLimit} 次`
}

/** 今日完成次数的展示串 —— 修 E17。 */
export function doneTextOf(checkedCountToday: number): string {
  return `今日已完成 ${checkedCountToday} 次`
}

/** 两个时间戳是否同一天（本地时区）。 */
export function isSameDay(time: number, other: number): boolean {
  const a = new Date(time)
  const b = new Date(other)
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * 今天这个习惯已经完成几次 —— 修 A3。
 *
 * 由**当天流水**统计，不存字段：布尔量 `checked` 根本无法表达“每天最多 2 次”。
 * 必须排除四类记录，缺一条派生态就会撒谎：
 *   1. 非本习惯（按 `habitId` 唯一匹配，不是 title）；
 *   2. 非表扬类（兑换 / 调整流水不算完成习惯）；
 *   3. `source === 'correction'` —— 冲正记录本身不是一次完成；
 *   4. **已被冲正的原记录** —— 撤销后它仍留在账上（账本不可变），但不应再计入今日完成。
 * 第 4 条是 `03` §A3 公式里漏掉的（原文只写了“source≠correction”）：
 * 漏掉它 → **撤销打卡后界面仍显示“已打卡”**，撤销看起来没生效。
 */
export function checkedCountToday(
  records: PointRecord[],
  habitId: string,
  now: number = Date.now()
): number {
  const reversedIds = new Set(
    records
      .filter((record) => record.reversesRecordId !== null)
      .map((record) => record.reversesRecordId)
  )
  return records.filter(
    (record) =>
      record.habitId === habitId &&
      record.category === 'praise' &&
      record.source !== 'correction' &&
      !reversedIds.has(record.id) &&
      isSameDay(record.time, now)
  ).length
}

/**
 * 习惯的**派生视图**：首页渲染与打卡判定都消费它。
 *
 * 它是 E17 的落点 —— 页面拿不到任何“可被写入的展示串”，
 * 想改文案只能改派生函数（一处改、两端同步）。
 */
export interface HabitView extends Habit {
  /** 今天已完成次数（由当天流水数出）*/
  checkedCountToday: number
  /** 由 `dailyLimit` 派生的频次串 */
  limitText: string
  /** 由 `checkedCountToday` 派生的完成串 */
  doneText: string
  /** 是否已达今日上限（`checkedCountToday >= dailyLimit`）—— 修 A3 */
  checked: boolean
}

/** 由结构字段 ＋ 当天流水派生习惯视图 —— 修 A2 / A3 / E17。 */
export function habitView(
  habit: Habit,
  records: PointRecord[],
  now: number = Date.now()
): HabitView {
  const count = checkedCountToday(records, habit.id, now)
  return {
    ...habit,
    checkedCountToday: count,
    limitText: limitTextOf(habit.dailyLimit),
    doneText: doneTextOf(count),
    checked: count >= habit.dailyLimit
  }
}

/** 规则的展示串 —— 修 E15：由结构字段拼出，不再存在自由的 `detail` 字符串。 */
export function ruleDetail(rule: PointRule): string {
  return `${rule.condition} · ${limitTextOf(rule.dailyLimit)}`
}


/** 规则版本的展示串 —— 由同一套结构字段派生（与 ruleDetail 同口径）。 */
export function ruleVersionDetail(version: RuleVersion): string {
  return `${version.condition} · ${limitTextOf(version.dailyLimit)}`
}

/**
 * 规则最新一版的版本号（含"还没改过"的初始版）。
 * 给 UI 用的唯一读法 —— 别在页面里手写 `Math.max(...)`。
 */
export function latestRuleVersion(
  versions: RuleVersion[],
  ruleId: string
): RuleVersion | null {
  let latest: RuleVersion | null = null
  for (const version of versions) {
    if (version.ruleId !== ruleId) continue
    if (!latest || version.version > latest.version) latest = version
  }
  return latest
}


export function isGain(points: number): boolean {
  return points >= 0
}

export function amountText(points: number): string {
  return points >= 0 ? `+${points}` : `${points}`
}

/** HH:mm */
export function clockText(time: number): string {
  const date = new Date(time)
  const hh = `${date.getHours()}`.padStart(2, '0')
  const mm = `${date.getMinutes()}`.padStart(2, '0')
  return `${hh}:${mm}`
}

/** 把时间转成“今天 / 昨天 / 前天 / M 月 d 日”。 */
export function dayLabel(time: number): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const date = new Date(time)
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diff = Math.round((today - day) / 86400000)
  switch (diff) {
    case 0:
      return '今天'
    case 1:
      return '昨天'
    case 2:
      return '前天'
    default:
      return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
  }
}

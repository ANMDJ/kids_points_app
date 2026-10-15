/**
 * 账本内核 · **判定与构造**（docs/design/01 §4 / 02 §5、§5.7）
 *
 * 回答一句话：**「这一笔分该怎么记，才让账永远对得上、且永远解释得清？」**
 *
 *     规则版本行 / 手动金额  →  本内核  →  PointRecord 草稿（含 balanceAfter）
 *                                          | 拒绝（LedgerDeniedError）
 *                                          | 数据/装配坏了（LedgerShapeError）
 *
 * ── 为什么内核必须独立成一层（与前端 store 的取舍同源）────────────────────
 *   前端（`kids_points_mp/src/data/store.ts`、`lib/data/app_store.dart`）已经把语义定死了：
 *   方向由 `direction` 表达（**不用 `Math.abs` 抹平**）、扣分**拒绝**而不是截断、
 *   撤销写**冲正**记录、标题**完整不截断**、`operatorRole` 记真实操作人。
 *   后端若各写一份，两端迟早漂移 —— 而漂移的地方正好是"账目"。
 *   所以这里把语义收口成**纯函数**：不碰 HTTP、不碰数据库、不碰 Prisma 客户端实例
 *   （只借 Prisma 的**枚举类型**，见下），于是可以离线穷举
 *   （`test/ledger-gate.test.ts`），且 **W2-B 的真库不变量套件可以直接复用**
 *   `verifyBalanceChain()` / `findSnapshotMismatches()` 这两把尺子。
 *
 * ── 与 02 §5.7 的对应（哪条不变量在这里落地）────────────────────────────
 *   · I4 记录快照 == 其 PointRuleVersion 的对应值 → `findSnapshotMismatches()`，
 *        并**由构造保证**：传了版本行时，快照字段一律取自版本行，调用方**无法**自己拼标题。
 *   · I6 撤销打卡后原记录仍在 ＋ 新增冲正记录 → `reverseRecordDraft()`。
 *   · I2 `balanceAfter` 链自洽 → `verifyBalanceChain()`（读侧尺子，W2-B 真库套件用）。
 *   · I1 / I3 / I5 需要真库（逐字段 diff / 复合外键 / REVOKE），**本层不冒充**它们已成立。
 *
 * ── ★ 形状坏 ⇒ 异常（500）；业务拒绝 ⇒ 异常（400/409）—— 两者**分类型**──────
 *   与 `session.gate.ts` 同一条纪律：**数据/装配的问题不许伪装成"用户操作不对"**。
 *   · `LedgerShapeError`：库里的坏数据（余额为负、枚举外的取值）、快照与版本不一致、
 *     A4 的操作人缺失 —— 这些是**我们的 bug**，翻成 500；
 *   · `LedgerDeniedError`：孩子积分不够、重复冲正 —— 这些是**正常业务分支**，
 *     翻成 400/409，且必须给用户看得懂的话。
 *
 * ── ★ 枚举白名单与 Prisma 的**双向**编译期耦合（不抄第二份列表）────────────
 *   `CATEGORY_KEYS` / `SOURCE_KEYS` / `OPERATOR_ROLE_KEYS` / `DIRECTION_KEYS` 写成
 *   `Record<Prisma 枚举, true>`：**漏一个键或写一个无关字面量都编译不过**。
 *   这样既保留"运行期白名单"（数据库里可能存着枚举外的值 —— 见 session.gate 的同一教训），
 *   又不会出现 D9 那种"手抄列表迟早漂移"。
 *   将来 Prisma 枚举加值 ⇒ 这里编译报错 ⇒ **被迫做决定**（而不是静默放行）。
 */


import type { MemberRole, RecordCategory, RecordSource, RuleDirection } from '@prisma/client'

// ── 枚举白名单：`Record<枚举, true>` 提供**编译期穷举**（缺键 / 多键都会报错）──────
const CATEGORY_KEYS: Record<RecordCategory, true> = { praise: true, exchange: true, adjust: true }
const SOURCE_KEYS: Record<RecordSource, true> = {
  child_self: true,
  guardian: true,
  agent: true,
  approval: true,
  system: true,
  correction: true
}
const OPERATOR_ROLE_KEYS: Record<MemberRole, true> = { guardian: true, child: true, viewer: true }
const DIRECTION_KEYS: Record<RuleDirection, true> = { reward: true, penalty: true }

/** 本内核认识的类别（运行期白名单；不认识的值一律 `INVALID_CATEGORY`）。 */
export const KNOWN_CATEGORIES = Object.keys(CATEGORY_KEYS) as readonly RecordCategory[]
/** 本内核认识的来源。 */
export const KNOWN_SOURCES = Object.keys(SOURCE_KEYS) as readonly RecordSource[]

function isKnownCategory(value: string): value is RecordCategory {
  return (KNOWN_CATEGORIES as readonly string[]).includes(value)
}

function isKnownSource(value: string): value is RecordSource {
  return (KNOWN_SOURCES as readonly string[]).includes(value)
}

function isKnownOperatorRole(value: string): value is MemberRole {
  return Object.prototype.hasOwnProperty.call(OPERATOR_ROLE_KEYS, value)
}

function isKnownDirection(value: string): value is RuleDirection {
  return Object.prototype.hasOwnProperty.call(DIRECTION_KEYS, value)
}

// ── 两类错误：形状（500）与拒绝（400/409）────────────────────────────────────
export type LedgerShapeCode =
  | 'INVALID_DIRECTION' // 规则方向不在枚举内（将来加值 ⇒ 这里响亮）
  | 'INVALID_CATEGORY' // 流水类别不在枚举内
  | 'INVALID_SOURCE' // 流水来源不在枚举内
  | 'INVALID_RULE_POINTS' // 规则积分为 0 / 负 / 非整数（`points` 恒为正，符号由 direction 表达）
  | 'INVALID_AMOUNT' // 变动金额非整数（含库里读出 0 变的坏记录）
  | 'INVALID_CURRENT_BALANCE' // 当前余额为负 / 非整数（库里的坏数据）
  | 'INVALID_OPERATOR_ROLE' // 操作人角色不在 MemberRole 内
  | 'MISSING_ACTOR' // 该带操作人的来源却没有操作人 —— 修 A4：流水不许撒谎
  | 'UNEXPECTED_ACTOR' // `system` 来源却带了操作人（"系统干的"与"某人干的"必须分得开）
  | 'SOURCE_OPERATOR_MISMATCH' // `child_self` / `guardian` 与实际操作人角色不符 —— 修 A4
  | 'MISSING_TITLE_SNAPSHOT' // 与规则无关的记录必须自带完整标题快照 —— 修 B8
  | 'MISSING_COST_SNAPSHOT' // 兑换必须带成本快照，否则这笔扣分永久无法解释 —— 修 B8
  | 'DELTA_RULE_MISMATCH' // 变动与规则版本不符（典型：负分规则被 `Math.abs` 抹成加分）—— 修 A1
  | 'DELTA_CATEGORY_MISMATCH' // 变动符号与类别不符（如"兑换"却是正数）
  | 'SNAPSHOT_VERSION_MISMATCH' // I4：快照与版本行不一致（调用方自己拼了快照）
  | 'INVALID_CHAIN_ROW' // I2 尺子：行缺字段 / 整数非法 / 时间解析不出
  | 'INVALID_APPEND_CLOCK' // 写侧定序：端口给的库钟 / 已有最新 createdAt 不是合法时间

/** 形状错误 —— 守卫/服务层把它翻成 **500**（我们的 bug，不是用户操作不对）。 */
export class LedgerShapeError extends Error {
  constructor(
    readonly code: LedgerShapeCode,
    message: string
  ) {
    super(message)
    this.name = 'LedgerShapeError'
  }
}

export type LedgerDeniedCode =
  | 'INSUFFICIENT_POINTS' // 积分不足（**拒绝**，绝不静默截断到 0）—— 修 B6
  | 'ZERO_DELTA' // "记一笔"填了 0（正常输入错误，不是异常）
  | 'ALREADY_REVERSED' // 这笔已被冲正过（幂等保护；再冲一次会让账翻倍）
  | 'CANNOT_REVERSE_REVERSAL' // 冲正记录不能再被冲正（否则语义失控）

/** 业务拒绝 —— 服务层翻成 **400/409**，并带一句用户看得懂的话（`message`）。 */
export class LedgerDeniedError extends Error {
  constructor(
    readonly code: LedgerDeniedCode,
    message: string
  ) {
    super(message)
    this.name = 'LedgerDeniedError'
  }
}

// ── 输入/输出结构 ────────────────────────────────────────────────────────────

/** 操作人：`PointRecord.operatorUserId` + `operatorRole` 的来源（**修 A4**）。 */
export interface LedgerOperator {
  /** 服务端权威的 userId（当前来自 `DeviceSession` 行，不来自请求头）。 */
  userId: string
  role: MemberRole
}

/**
 * `PointRuleVersion` 的**原始行**（字段故意宽松：它来自数据库，未经验证）。
 * 真相之源 —— 快照字段一律由它派生（`02` §5.1「以版本行为准」）。
 */
export interface RuleVersionSnapshot {
  ruleId: string
  version: number
  title: string
  condition: string
  dailyLimit: number
  /** 恒为正；符号由 `direction` 表达（前端 A1 的病就是把符号交给 `Math.abs` 处理）。 */
  points: number
  direction: string
}

/** 一条 `PointRecord` 的**写入草稿**（字段名一比一对应 schema.prisma）。 */
export interface PointRecordDraft {
  childId: string
  ruleId: string | null
  ruleVersion: number | null
  habitId: string | null
  wishId: string | null
  titleSnapshot: string
  conditionSnapshot: string | null
  dailyLimitSnapshot: number | null
  costSnapshot: number | null
  pointsDelta: number
  category: RecordCategory
  source: RecordSource
  note: string
  operatorUserId: string | null
  operatorRole: MemberRole | null
  /** ★ 记完之后的余额 —— 缺失即无法对账（修 B6）。 */
  balanceAfter: number
  idempotencyKey: string | null
  reversesRecordId: string | null
  createdAt: Date
}

export interface RecordDraftInput {
  childId: string
  /** 依据的规则版本行；`null` = 与规则无关（"记一笔" / 兑换）。 */
  ruleVersionRow: RuleVersionSnapshot | null
  /**
   * 与规则无关时的**完整标题快照**（修 B8：截断只允许发生在渲染层）。
   * 传了版本行时：可以不传（一律取版本行的 `title`）；传了则必须**与版本行一致**。
   */
  titleSnapshot?: string
  /** 与规则无关时必须显式给出的变动（带符号）。传了版本行时**禁止**与规则算出的一致不符。 */
  pointsDelta?: number
  category: string
  source: string
  /** `system` 来源必须为 `null`；其余来源必须给（修 A4）。 */
  operator: LedgerOperator | null
  note?: string
  habitId?: string | null
  wishId?: string | null
  /** 兑换必须给（修 B8：没有它，这笔扣分在心愿被删后永久无法解释）。 */
  costSnapshot?: number | null
  idempotencyKey?: string | null
  /** 写入前的余额（`Child.pointsBalance`，同事务内读出）。 */
  currentBalance: number
  /** 由调用方注入时钟（**不在内核里 `new Date()`**：判定必须可复现）。 */
  now: Date
}

// ── 原语 ────────────────────────────────────────────────────────────────────

function requireInteger(value: number, code: LedgerShapeCode, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new LedgerShapeError(code, `${what}不是整数：${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 方向 × 数值 ⇒ **带符号的变动**（本内核唯一的符号来源）。
 *
 * ★ 修 A1：前端旧实现是 `points * (direction === 'penalty' ? 1 : 1)` 之上再套
 *   `Math.abs(...)` —— 负分规则记成加分（"扣 5 分"变"+5 分"）。
 *   本函数**绝不**用 `Math.abs` 抹平：`penalty` ⇒ 负；`reward` ⇒ 正。
 *
 * ★ `points` 必须为**正整数**：0 或负数意味着规则本身坏了（schema 注释里
 *   `points` 恒为正、符号由 direction 表达）⇒ `INVALID_RULE_POINTS` 而不是猜。
 * ★ 未知 `direction` ⇒ `INVALID_DIRECTION`（不认识 ≠ 按 reward 处理）。
 */
export function signedDelta(points: number, direction: string): number {
  if (!isKnownDirection(direction)) {
    throw new LedgerShapeError(
      'INVALID_DIRECTION',
      `规则方向非法：${JSON.stringify(direction)}（RuleDirection 只有 reward / penalty）。` +
        '★ 绝不默认成 reward —— 那会把未来的新方向静默当成加分。'
    )
  }
  if (!Number.isInteger(points) || points <= 0) {
    throw new LedgerShapeError(
      'INVALID_RULE_POINTS',
      `规则积分必须是正整数（符号由 direction 表达），收到 ${JSON.stringify(points)}。`
    )
  }
  return direction === 'penalty' ? -points : points
}

export type BalanceVerdict =
  | { kind: 'OK'; balanceAfter: number }
  | { kind: 'DENY'; code: 'INSUFFICIENT_POINTS'; message: string }

/**
 * 记完之后余额是多少 —— **要么算得出来，要么拒绝**（修 B6）。
 *
 * ★ 前端旧实现 `this.points += delta; if (this.points < 0) this.points = 0`
 *   会**静默截断**：余额 124、`delta = -9999` ⇒ 余额变 0（实际变动 −124），
 *   而流水照记 −9999 ⇒ **Σ流水 ≠ 余额，账本无法对账**。
 *   这里改为**拒绝**（`INSUFFICIENT_POINTS`），与兑换语义一致；
 *   于是「余额为负」这条在库里**不可能出现**（真库套件可以把它当红线查）。
 *
 * ★ 当前余额为负 / 非整数 ⇒ 形状错误（500）：那是历史坏数据，不是本次操作的问题。
 */
export function resolveBalanceAfter(currentBalance: number, pointsDelta: number): BalanceVerdict {
  requireInteger(currentBalance, 'INVALID_CURRENT_BALANCE', '当前余额')
  if (currentBalance < 0) {
    throw new LedgerShapeError(
      'INVALID_CURRENT_BALANCE',
      `当前余额为负（${currentBalance}）—— 账本从一开始就不平，先用 I2 链校验定位第一处断裂。`
    )
  }
  requireInteger(pointsDelta, 'INVALID_AMOUNT', '变动金额')
  const balanceAfter = currentBalance + pointsDelta
  if (balanceAfter < 0) {
    return {
      kind: 'DENY',
      code: 'INSUFFICIENT_POINTS',
      message: `积分不足：当前 ${currentBalance} 分，本次要扣 ${-pointsDelta} 分（最多可扣 ${currentBalance} 分）`
    }
  }
  return { kind: 'OK', balanceAfter }
}

// ── 写侧定序：让 I2 在**真库**上可判定（W2-B 实测到的真库陷阱）───────────────

/** 端口的写入时钟 —— 两个输入都必须来自**同一个事务内**的数据库查询。 */
export interface AppendClockInput {
  /**
   * 数据库的**UTC 墙钟**：`(clock_timestamp() AT TIME ZONE 'UTC')`。
   *
   * ★ 两个坑，缺一不可（W2-B 真库实测）：
   *   ① 必须是 `clock_timestamp()` 而**不是** `now()`：`now()` 在一个事务里恒定不变
   *      ⇒ 同事务写多笔时 `createdAt` 全部并列 ⇒ I2「顺序不可判」；
   *   ② 必须再 `AT TIME ZONE 'UTC'`：`PointRecord.createdAt` 是**无时区**列，Prisma 的
   *      约定是"naive 值 = UTC 墙钟"；直接把 timestamptz 塞进 naive 列会被 PG 按**会话
   *      时区**换算（本机 Asia/Shanghai）⇒ 落库值整体偏移 +8h（读回来像"未来的流水"）。
   */
  dbNow: Date
  /** 该孩子**已有**的最新 `createdAt`（`MAX("createdAt")`）；空账本传 `null`。 */
  latestCreatedAt: Date | null
}

/** 时间字段的合法性（库钟读不出来 = 我们的 bug ⇒ 形状错误，不猜）。 */
function requireDate(value: Date, what: string): number {
  const ms = value instanceof Date ? value.getTime() : Number.NaN
  if (!Number.isFinite(ms)) {
    throw new LedgerShapeError(
      'INVALID_APPEND_CLOCK',
      `${what}不是合法时间：${JSON.stringify(value)} —— ` +
        '定序是 I2 的前提，输入读不出来就必须响亮（绝不用 `new Date()` 兜底：那会让账本依赖进程时钟）。'
    )
  }
  return ms
}

/**
 * 追加一笔时**由端口决定**的 `createdAt` —— 保证"同一孩子的流水按时间戳**可定序**"。
 *
 * ── 为什么这件事不属于内核、而必须由端口做 ──────────────────────────────────
 *   内核是**纯函数**：调用方把 `now` 注入进来（判定必须可复现）。
 *   但"已经有哪些行、库钟现在是几"是 **I/O 事实** —— 只有持库连接的人知道，
 *   所以端口负责**顺序**、内核负责**语义**（见 `ledger.repository.ts` 的分工声明）。
 *
 * ── 规则（严格单调，不依赖库钟的精度）──────────────────────────────────────
 *   · 空账本 ⇒ 直接用库钟；
 *   · 库钟**晚于**已有最新 ⇒ 用库钟（正常情形）；
 *   · 否则（并列 / 库钟回退 / 有人手写过未来时间戳）⇒ 已有最新 **+1ms**。
 *   ⇒ 端口写出的行永远**严格晚于**该孩子已有的任何一行 ⇒ `verifyBalanceChain()`
 *     不必再报「顺序不可判」，滚动求和有唯一解。
 *
 * ★ 为什么不是"给 createdAt 加个序列表"：那是另一种合法解（也更强），但要多一张表
 *   ＋一次迁移；本阶段选择"锁住孩子行 + 严格递增修正"，代价是时间戳可能出现
 *   1ms 的人工间隔 —— 它在展示层不可见，而且**不改 schema**（取舍记在 README 第 20 条）。
 */
export function resolveAppendCreatedAt(input: AppendClockInput): Date {
  const nowMs = requireDate(input.dbNow, '数据库时钟')
  if (input.latestCreatedAt === null) return new Date(nowMs)
  const latestMs = requireDate(input.latestCreatedAt, '已有最新 createdAt')
  if (latestMs < nowMs) return new Date(nowMs)
  return new Date(latestMs + 1)
}

// ── 装配（两个构造器共用的收口）──────────────────────────────────────────────

interface DraftParts {
  childId: string
  ruleId: string | null
  ruleVersion: number | null
  habitId: string | null
  wishId: string | null
  titleSnapshot: string
  conditionSnapshot: string | null
  dailyLimitSnapshot: number | null
  costSnapshot: number | null
  pointsDelta: number
  category: string
  source: string
  note: string
  operator: LedgerOperator | null
  idempotencyKey: string | null
  reversesRecordId: string | null
  currentBalance: number
  now: Date
}

/**
 * 操作人的判定（**修 A4** 落地处）—— `system` 与"某个人干的"必须分得开：
 *   · `source === 'system'` ⇒ **不许**带操作人（带了说明调用方搞不清谁在操作）
 *   · 其余来源 ⇒ **必须**带；`child_self` 必须是孩子、`guardian` 必须是家长
 *     —— 否则流水在撒谎（前端旧实现硬编码"家长记录"就是这个病）。
 */
function resolveOperator(source: RecordSource, operator: LedgerOperator | null): void {
  if (operator === null) {
    if (source !== 'system') {
      throw new LedgerShapeError(
        'MISSING_ACTOR',
        `来源 ${source} 的记录必须带真实操作人（operatorUserId/operatorRole）—— 修 A4：` +
          '流水里"谁干的"不许留空、也不许硬编码成"家长记录"。只有 system（系统自动）可以为空。'
      )
    }
    return
  }
  if (source === 'system') {
    throw new LedgerShapeError(
      'UNEXPECTED_ACTOR',
      `来源 system 的记录带了操作人 ${operator.userId}：系统自动产生的变动不该挂在某个人头上。`
    )
  }
  if (typeof operator.userId !== 'string' || operator.userId.trim() === '') {
    throw new LedgerShapeError(
      'MISSING_ACTOR',
      `操作人 userId 为空：${JSON.stringify(operator.userId)}`
    )
  }
  if (!isKnownOperatorRole(operator.role)) {
    throw new LedgerShapeError(
      'INVALID_OPERATOR_ROLE',
      `操作人角色非法：${JSON.stringify(operator.role)}（MemberRole 只有 guardian / child / viewer）`
    )
  }
  if (source === 'child_self' && operator.role !== 'child') {
    throw new LedgerShapeError(
      'SOURCE_OPERATOR_MISMATCH',
      `来源 child_self（孩子自己完成）却由 ${operator.role} 操作 —— 流水在撒谎（修 A4）`
    )
  }
  if (source === 'guardian' && operator.role !== 'guardian') {
    throw new LedgerShapeError(
      'SOURCE_OPERATOR_MISMATCH',
      `来源 guardian 却由 ${operator.role} 操作 —— 流水在撒谎（修 A4）；` +
        'viewer 是只读角色，不许产生家长署名的记录。'
    )
  }
}

/** 幂等键归一：空白串**不是**"给了键"，归一成 `null`（否则重放保护形同虚设）。 */
function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function assembleDraft(parts: DraftParts): PointRecordDraft {
  if (!isKnownCategory(parts.category)) {
    throw new LedgerShapeError(
      'INVALID_CATEGORY',
      `流水类别非法：${JSON.stringify(parts.category)}（RecordCategory 只有 ` +
        `${KNOWN_CATEGORIES.join(' / ')}）—— 不认识的值绝不当作 praise 放行。`
    )
  }
  if (!isKnownSource(parts.source)) {
    throw new LedgerShapeError(
      'INVALID_SOURCE',
      `流水来源非法：${JSON.stringify(parts.source)}（RecordSource 只有 ${KNOWN_SOURCES.join(' / ')}）`
    )
  }
  resolveOperator(parts.source, parts.operator)
  requireInteger(parts.pointsDelta, 'INVALID_AMOUNT', '变动金额')

  const verdict = resolveBalanceAfter(parts.currentBalance, parts.pointsDelta)
  if (verdict.kind === 'DENY') throw new LedgerDeniedError(verdict.code, verdict.message)

  return {
    childId: parts.childId,
    ruleId: parts.ruleId,
    ruleVersion: parts.ruleVersion,
    habitId: parts.habitId,
    wishId: parts.wishId,
    titleSnapshot: parts.titleSnapshot,
    conditionSnapshot: parts.conditionSnapshot,
    dailyLimitSnapshot: parts.dailyLimitSnapshot,
    costSnapshot: parts.costSnapshot,
    pointsDelta: parts.pointsDelta,
    category: parts.category,
    source: parts.source,
    note: parts.note,
    operatorUserId: parts.operator === null ? null : parts.operator.userId,
    operatorRole: parts.operator === null ? null : parts.operator.role,
    balanceAfter: verdict.balanceAfter,
    idempotencyKey: normalizeIdempotencyKey(parts.idempotencyKey),
    reversesRecordId: parts.reversesRecordId,
    createdAt: parts.now
  }
}

// ── I4：快照 == 版本行的对应值 ───────────────────────────────────────────────

/** 读侧尺子的输入：一条记录里与版本有关的字段（`PointRecord` 的子集）。 */
export interface SnapshotLike {
  ruleId: string | null
  ruleVersion: number | null
  titleSnapshot: string
  conditionSnapshot: string | null
  dailyLimitSnapshot: number | null
  pointsDelta: number
  category: string
  source: string
}

/**
 * I4 的**读侧尺子**：返回"快照与版本行对不上的地方"（空数组 = 一致）。
 *
 * 两种用法：
 *  ① 写侧（本文件内）：`assertSnapshotMatchesVersion()` 在落库前把它变成异常；
 *  ② 读侧（W2-B 的真库套件）：对历史数据**逐行**跑，输出点名到 `ruleId#version`。
 *     ★ 同一个尺子两处用，才不会出现"写入时校验一套、验证时另一套"。
 *
 * ★ `source === 'correction'` 的**冲正记录例外**：它继承 `ruleId/ruleVersion`（回答
 *   "哪一版规则产生的这笔分、又被谁撤销"），但 `titleSnapshot` 刻意是 `撤销：…`
 *   —— 拿它跟版本标题比**必然会红**，那是尺子错而不是数据错。故冲正记录只校验
 *   `(ruleId, ruleVersion)` 成对与指向，不比内容快照。
 */
export function findSnapshotMismatches(record: SnapshotLike, version: RuleVersionSnapshot): string[] {
  const problems: string[] = []
  const where = `ruleId=${record.ruleId} ruleVersion=${record.ruleVersion}`

  if (record.ruleId === null && record.ruleVersion === null) {
    // 与规则无关的记录（"记一笔" / 兑换）：I4 不适用（其 (ruleId, ruleVersion) 为 null，I3 也不适用）。
    return problems
  }
  if (record.ruleId === null || record.ruleVersion === null) {
    problems.push(`(ruleId, ruleVersion) 不成对：${where} —— 半个引用无法命中任何版本行`)
    return problems
  }
  if (record.ruleId !== version.ruleId || record.ruleVersion !== version.version) {
    problems.push(
      `记录指向的版本行是 ${version.ruleId}#${version.version}，与记录上的 ${where} 不符`
    )
    return problems
  }
  if (record.source === 'correction') return problems

  if (record.titleSnapshot !== version.title) {
    problems.push(
      `titleSnapshot=${JSON.stringify(record.titleSnapshot)} ≠ 版本行 ${JSON.stringify(version.title)}` +
        '（★ 以版本行为准；截断只允许发生在渲染层 —— 修 B8）'
    )
  }
  if (record.conditionSnapshot !== version.condition) {
    problems.push(
      `conditionSnapshot=${JSON.stringify(record.conditionSnapshot)} ≠ 版本行 ${JSON.stringify(version.condition)}`
    )
  }
  if (record.dailyLimitSnapshot !== version.dailyLimit) {
    problems.push(
      `dailyLimitSnapshot=${JSON.stringify(record.dailyLimitSnapshot)} ≠ 版本行 ${version.dailyLimit}`
    )
  }
  if (record.category === 'praise') {
    try {
      const expected = signedDelta(version.points, version.direction)
      if (record.pointsDelta !== expected) {
        problems.push(
          `pointsDelta=${record.pointsDelta} ≠ 版本行算出的 ${expected}` +
            '（direction × points —— 修 A1：负分规则被抹成加分会在这里现形）'
        )
      }
    } catch (err) {
      problems.push(`版本行本身非法：${(err as Error).message}`)
    }
  }
  return problems
}

/** 写侧：不一致就**拒绝落库**（宁可 500，也不写一条自相矛盾的记录）。 */
export function assertSnapshotMatchesVersion(
  record: SnapshotLike,
  version: RuleVersionSnapshot
): void {
  const problems = findSnapshotMismatches(record, version)
  if (problems.length > 0) {
    throw new LedgerShapeError(
      'SNAPSHOT_VERSION_MISMATCH',
      `I4 不成立（快照与版本行不一致，${problems.length} 处）：${problems.join('；')}。` +
        '★ 快照只是"列表渲染不用 join"的缓存，真相之源永远是 PointRuleVersion —— ' +
        '调用方自己拼一份快照是**不许**的（这正是 `02` §5.1 那条一致性规则的落地处）。'
    )
  }
}

// ── 构造一：普通一笔（打卡 / 记一笔 / 兑换）───────────────────────────────────

/**
 * 构造一条 `PointRecord` 草稿 —— **所有写入路径的唯一入口**（打卡、记一笔、兑换、
 * 审批执行、系统自动扣分都走它）。
 *
 * 三条硬约束（都是"能编译、能跑、但语义错"的病的解药）：
 *  ① **传了版本行时，快照字段一律取自版本行**（`titleSnapshot` / `conditionSnapshot` /
 *     `dailyLimitSnapshot`）。调用方若另传一份 `titleSnapshot` 且与之不符 ⇒ 500
 *     —— 这就是 `02` §5.1「以版本行为准」落到代码上的样子。
 *  ② **传了版本行时，变动必须等于 `direction × points`**（`signedDelta`）。
 *     调用方若自己算成 `+Math.abs(points)`（**A1 的原始病**）⇒ `DELTA_RULE_MISMATCH`。
 *     ⇒ 负分规则**不可能**再记成加分，无论调用方怎么写。
 *  ③ **余额算不出来就拒绝**（`INSUFFICIENT_POINTS`），绝不截断到 0（**B6**）。
 *
 * ★ 兑换（`category='exchange'`）额外要求：`costSnapshot` 是正整数且 `=== -pointsDelta`。
 *   缺了它，心愿被删之后这笔扣分**永久无法解释**（**B8**）。
 */
export function buildRecordDraft(input: RecordDraftInput): PointRecordDraft {
  const row = input.ruleVersionRow

  if (row !== null) {
    const delta = signedDelta(row.points, row.direction)
    if (input.pointsDelta !== undefined && input.pointsDelta !== delta) {
      throw new LedgerShapeError(
        'DELTA_RULE_MISMATCH',
        `变动与规则版本不符：调用方给 ${input.pointsDelta}，版本行 ${row.ruleId}#${row.version} ` +
          `（direction=${row.direction} points=${row.points}）算出 ${delta}。` +
          '★ 修 A1：负分规则被 `Math.abs` 抹平后正好长得这个样子 —— 拒绝，不猜。'
      )
    }
    if (input.titleSnapshot !== undefined && input.titleSnapshot !== row.title) {
      throw new LedgerShapeError(
        'SNAPSHOT_VERSION_MISMATCH',
        `调用方自带的 titleSnapshot=${JSON.stringify(input.titleSnapshot)} 与版本行 ` +
          `${JSON.stringify(row.title)} 不符 —— 快照必须来自版本行（修 B8：不许截断、不许另拼）。`
      )
    }
    if (!Number.isInteger(row.dailyLimit)) {
      throw new LedgerShapeError(
        'INVALID_CHAIN_ROW',
        `版本行的 dailyLimit 非整数：${JSON.stringify(row.dailyLimit)}`
      )
    }
    return assembleDraft({
      childId: input.childId,
      ruleId: row.ruleId,
      ruleVersion: row.version,
      habitId: input.habitId ?? null,
      wishId: null,
      titleSnapshot: row.title,
      conditionSnapshot: row.condition,
      dailyLimitSnapshot: row.dailyLimit,
      costSnapshot: null,
      pointsDelta: delta,
      category: input.category,
      source: input.source,
      note: input.note ?? '',
      operator: input.operator,
      idempotencyKey: input.idempotencyKey ?? null,
      reversesRecordId: null,
      currentBalance: input.currentBalance,
      now: input.now
    })
  }

  // ── 与规则无关（"记一笔" / 兑换）：标题与金额由调用方给出 ────────────────────
  if (input.pointsDelta === undefined) {
    throw new LedgerShapeError(
      'INVALID_AMOUNT',
      '与规则无关的记录必须显式给出 pointsDelta（带符号）—— 内核不会替你猜金额。'
    )
  }
  const delta = requireInteger(input.pointsDelta, 'INVALID_AMOUNT', '变动金额')
  if (delta === 0) {
    throw new LedgerDeniedError('ZERO_DELTA', '调整金额不能为 0')
  }
  const title = input.titleSnapshot
  if (title === undefined || title.trim() === '') {
    throw new LedgerShapeError(
      'MISSING_TITLE_SNAPSHOT',
      'titleSnapshot 为空 —— 没有标题的流水无法解释（修 B8：标题必须**完整**落库）。'
    )
  }
  if (input.category === 'exchange') {
    const cost = input.costSnapshot
    if (cost === null || cost === undefined || !Number.isInteger(cost) || cost <= 0) {
      throw new LedgerShapeError(
        'MISSING_COST_SNAPSHOT',
        `兑换必须带成本快照（收到 ${JSON.stringify(cost)}）—— 修 B8：心愿被删/改价后，` +
          '这笔扣分靠它才能解释。'
      )
    }
    if (-delta !== cost) {
      throw new LedgerShapeError(
        'DELTA_CATEGORY_MISMATCH',
        `兑换的扣分必须等于成本快照：pointsDelta=${delta} 而 costSnapshot=${cost}`
      )
    }
  }
  return assembleDraft({
    childId: input.childId,
    ruleId: null,
    ruleVersion: null,
    habitId: input.habitId ?? null,
    wishId: input.wishId ?? null,
    titleSnapshot: title,
    conditionSnapshot: null,
    dailyLimitSnapshot: null,
    costSnapshot: input.category === 'exchange' ? (input.costSnapshot ?? null) : null,
    pointsDelta: delta,
    category: input.category,
    source: input.source,
    note: input.note ?? '',
    operator: input.operator,
    idempotencyKey: input.idempotencyKey ?? null,
    reversesRecordId: null,
    currentBalance: input.currentBalance,
    now: input.now
  })
}


// ── 构造二：冲正（撤销打卡 = 新增一条指向原记录的记录）────────────────────────

/** 原记录中参与冲正判定的字段（从库里读出的一行）。 */
export interface ReversibleRecord {
  id: string
  childId: string
  titleSnapshot: string
  pointsDelta: number
  source: string
  ruleId: string | null
  ruleVersion: number | null
  habitId: string | null
  wishId: string | null
  /** 非 `null` ⇒ 这条本身就是冲正记录（不能再被冲正）。 */
  reversesRecordId: string | null
}

export interface ReversalInput {
  operator: LedgerOperator | null
  currentBalance: number
  /**
   * 事务内查到的「已被冲正的原记录 id」（`SELECT reversesRecordId FROM … WHERE childId=…`）。
   * ★ 查询**不在内核里做** —— 判定与 IO 分离，否则内核就不能离线穷举了；
   *   真实现必须在**同一事务**内取这个集合，并配合库层约束防并发双冲。
   */
  alreadyReversedIds: readonly string[]
  /**
   * 原记录的规则版本行。★ 原记录带 `ruleId` 时**必须**给：
   * 冲正记录要继承"哪一版规则产生的这笔分"，给不出就得拒绝（不许落一条解释不清的记录）。
   */
  ruleVersionRow?: RuleVersionSnapshot | null
  /** 冲正备注；默认取原标题（前端实现即如此）。 */
  note?: string
  now: Date
}

/**
 * 冲正草稿（**I6 / 修 B7**）。
 *
 * 前端旧实现是**把今天的流水 `filter` 掉** —— 历史被物理抹掉，且按 `title` 匹配会
 * 误删同名习惯的记录。正解是两件事：
 *   ① 原记录**完全不动**（append-only）；
 *   ② 新增一条 `source='correction'`、`reversesRecordId=原id`、`pointsDelta = -原delta` 的记录。
 * ⇒ **流水条数 +1 而非 −1**（这正是 I6 的判据）。
 *
 * 两条 fail-closed：
 *   · 冲正记录**不能**再被冲正（`CANNOT_REVERSE_REVERSAL`）——"撤销的撤销"语义失控；
 *   · 已被冲正过的记录**不能**再冲（`ALREADY_REVERSED`）—— 否则余额翻倍。
 *   ★ 这两条 ＋ 库层约束，共同保证"一次撤销只生效一次"。
 */
export function reverseRecordDraft(
  original: ReversibleRecord,
  input: ReversalInput
): PointRecordDraft {
  if (original.reversesRecordId !== null) {
    throw new LedgerDeniedError(
      'CANNOT_REVERSE_REVERSAL',
      `记录 ${original.id} 本身就是一条冲正记录（指向 ${original.reversesRecordId}）—— ` +
        '"撤销的撤销"不是合法操作：要恢复请重新打卡（新的一笔），而不是抹掉撤销这件事。'
    )
  }
  if (input.alreadyReversedIds.includes(original.id)) {
    throw new LedgerDeniedError(
      'ALREADY_REVERSED',
      `记录 ${original.id} 已经被冲正过 —— 再冲一次会让这笔分**翻倍**（幂等保护）。`
    )
  }

  const delta = requireInteger(original.pointsDelta, 'INVALID_AMOUNT', '原记录的变动金额')
  if (delta === 0) {
    throw new LedgerShapeError(
      'INVALID_AMOUNT',
      `原记录 ${original.id} 的变动为 0 —— 账本里不该出现 0 变动的记录（数据坏了）。`
    )
  }

  const row = input.ruleVersionRow ?? null
  if (original.ruleId !== null) {
    if (row === null) {
      throw new LedgerShapeError(
        'SNAPSHOT_VERSION_MISMATCH',
        `原记录 ${original.id} 带 ruleId=${original.ruleId}，冲正时必须一并给出它的版本行 —— ` +
          '否则冲正记录无法解释"哪一版规则产生了这笔分"（修 C10 的继承要求）。'
      )
    }
    if (row.ruleId !== original.ruleId || row.version !== original.ruleVersion) {
      throw new LedgerShapeError(
        'SNAPSHOT_VERSION_MISMATCH',
        `原记录 ${original.id} 指向 ${original.ruleId}#${original.ruleVersion}，` +
          `但拿到的版本行是 ${row.ruleId}#${row.version} —— 冲正记录必须继承**同一个**版本。`
      )
    }
  }

  return assembleDraft({
    childId: original.childId,
    // ★ 继承 ruleId/ruleVersion（前端 C10 的语义："哪一版规则产生了这笔分、又是谁撤销的"都留在账上）
    ruleId: original.ruleId,
    ruleVersion: original.ruleVersion,
    habitId: original.habitId,
    wishId: original.wishId,
    titleSnapshot: `撤销：${original.titleSnapshot}`,
    conditionSnapshot: row === null ? null : row.condition,
    dailyLimitSnapshot: row === null ? null : row.dailyLimit,
    costSnapshot: null,
    pointsDelta: -delta,
    category: 'adjust',
    source: 'correction',
    note: input.note ?? original.titleSnapshot,
    operator: input.operator,
    idempotencyKey: null,
    reversesRecordId: original.id,
    currentBalance: input.currentBalance,
    now: input.now
  })
}



// ── I2 尺子：`balanceAfter` 链自洽（读侧；W2-B 真库套件复用同一把尺子）────────

/** 链校验的输入行（`PointRecord` 的最小字段集）。 */
export interface LedgerChainRow {
  id: string
  childId: string
  pointsDelta: number
  balanceAfter: number
  createdAt: Date | string
}

function toEpochMs(createdAt: Date | string): number {
  const ms = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt)
  return Number.isFinite(ms) ? ms : Number.NaN
}

/**
 * I2 尺子：按 `(childId, createdAt)` 排序滚动求和，必须**逐行**等于 `balanceAfter`。
 *
 * 返回**人类可读的违例句**（空数组 = 自洽），可以直接打出来给人看：
 *   `I2 断裂：rec#3 期望 balanceAfter=4，实际 5（childId=child-1）`
 *
 * ★ 起点是 0：前提是"该孩子的账本从空开始，且**每一次**余额变动都经账本"。
 *   将来若引入"期初余额 / 数据迁移"，**必须**改这个函数的签名（显式传起点）——
 *   悄悄改起点等于让尺子说谎。
 *
 * ★★ **真库陷阱（本阶段发现的坑）**：PostgreSQL 的 `now()` 在**同一事务内是同一个值**
 *   ⇒ 同事务写入的两条记录 `createdAt` **完全相同** ⇒ 单靠 `(childId, createdAt)`
 *   **无法定序**，滚动求和失去唯一解。本函数遇到同一孩子的并列时间戳时
 *   **不报断裂**（那可能是排序假象 —— 点名一个假病比不报更糟），而是报
 *   `I2 顺序不可判：…`，把问题推回**写入侧**（时间戳必须严格递增），而不是替它猜顺序。
 */
export function verifyBalanceChain(rows: readonly LedgerChainRow[]): string[] {
  const violations: string[] = []
  const byChild = new Map<string, LedgerChainRow[]>()

  for (const row of rows) {
    if (!Number.isInteger(row.pointsDelta) || !Number.isInteger(row.balanceAfter)) {
      violations.push(
        `I2 不可判定：记录 ${row.id} 的 pointsDelta/balanceAfter 不是整数` +
          `（${JSON.stringify(row.pointsDelta)} / ${JSON.stringify(row.balanceAfter)}）`
      )
      continue
    }
    if (Number.isNaN(toEpochMs(row.createdAt))) {
      violations.push(
        `I2 不可判定：记录 ${row.id} 的 createdAt 解析不出：${JSON.stringify(row.createdAt)}`
      )
      continue
    }
    const list = byChild.get(row.childId)
    if (list === undefined) byChild.set(row.childId, [row])
    else list.push(row)
  }

  for (const [childId, list] of byChild) {
    // `id` 只作**稳定**次序（同毫秒时输出可复现），不作为"真相"—— 见上面 ★★
    const sorted = list
      .slice()
      .sort((a, b) => toEpochMs(a.createdAt) - toEpochMs(b.createdAt) || (a.id < b.id ? -1 : 1))

    const tiedAt = sorted.findIndex(
      (row, index) =>
        index > 0 && toEpochMs(row.createdAt) === toEpochMs(sorted[index - 1].createdAt)
    )
    if (tiedAt > 0) {
      const a = sorted[tiedAt - 1]
      const b = sorted[tiedAt]
      violations.push(
        `I2 顺序不可判：childId=${childId} 的 ${a.id} 与 ${b.id} 时间戳相同` +
          `（${new Date(toEpochMs(a.createdAt)).toISOString()}）—— ` +
          '事务内 now() 相同 ⇒ 谁先谁后无从判定，滚动求和没有唯一解。' +
          '★ 修法在**写入侧**（时间戳必须严格递增），不是让尺子猜顺序。'
      )
      continue // 顺序不定时不报断裂：那可能是排序假象
    }

    let running = 0
    for (const row of sorted) {
      running += row.pointsDelta
      if (running !== row.balanceAfter) {
        violations.push(
          `I2 断裂：${row.id} 期望 balanceAfter=${running}，实际 ${row.balanceAfter}` +
            `（childId=${childId}）—— 这一笔或它之前的余额/流水被改过`
        )
        running = row.balanceAfter // 以实际值为新基准继续，才能把**每一处**断裂都点亮
      }
    }
  }

  return violations
}

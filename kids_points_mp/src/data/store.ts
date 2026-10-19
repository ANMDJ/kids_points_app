import { useEffect, useState } from 'react'
import { useDidShow } from '@tarojs/taro'

import { buildSeedData } from './seed'
import { isKnownIconName } from '../components/Icon/icons'
import {
  createReadApiFromEnvironment,
  ReadApiClient
} from './read_api'
import { ReadApiException } from './read_api_errors'
import { mapHabit, mapHome, mapRecord, mapRecordsPage, mapRule } from './read_mapper'
import type { RecordsPage } from './read_mapper'
import type { HabitDto, RecordDto, RuleDto } from './read_dto'
import { createWriteApiFromEnvironment, WriteApi } from './write_api'
import { WriteApiException } from './write_api_errors'
import type { WrittenRecordDto } from './write_dto'
import type {
  ActorContext,
  AuditAction,
  AuditEntry,
  AuditSnapshot,
  AuditTargetType,
  ChildProfile,
  Habit,
  HabitView,
  IconOption,
  PointRecord,
  PointRule,
  RecordCategory,
  RecordSource,
  RuleVersion,
  SoftDeletable,
  TrashItem,
  TrashKind,
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
  trashOnly
} from './types'

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

  /** 其它写入口（记一笔 / 心愿 / 规则 / 档案）仍只读。 */
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

  /** 只读模式下写操作统一文案 —— 页面直接展示，不另编理由。 */
  get readOnlyWriteMessage(): string {
    return '只读模式：记一笔 / 心愿等写入还没接后端，这次操作没有保存到服务器。'
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

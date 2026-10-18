import 'package:flutter/material.dart';

import '../models/audit.dart';
import '../models/child_profile.dart';
import '../models/habit.dart';
import '../models/point_record.dart';
import '../models/point_rule.dart';
import '../models/rule_version.dart';
import '../models/trash.dart';
import '../models/wish.dart';
import '../theme/app_colors.dart';
import '../theme/app_icons.dart';
import 'seed_data.dart';
import 'read_api.dart';
import 'read_api_errors.dart';
import 'read_dto.dart';
import 'read_mapper.dart';

/// release / profile 构建的判定 —— **编译期常量**（等价于 `!kDebugMode`）。
///
/// 用 `bool.fromEnvironment` 直接表达，以免在纯数据层引入对 flutter/foundation 的依赖。
const bool _isReleaseBuild = bool.fromEnvironment('dart.vm.product') ||
    bool.fromEnvironment('dart.vm.profile');

/// 演示数据的**准入判据**（修 E18）。
///
/// 刻意写成纯函数：若判据只存在于 [allowDemoReset] 这个编译期常量里，
/// 测试就只能靠“碰巧跑在调试构建”才验证得到它；
/// 现在可以确定性地断言 `demoResetAllowed(isRelease: true) == false`。
bool demoResetAllowed({bool isRelease = _isReleaseBuild}) => !isRelease;

/// 是否允许“恢复演示数据”（修 E18）。
///
/// 该方法原先是**生产可达**的公开 API，“我的”页按钮直接调用 ——
/// 用户可一键清空真实数据并恢复假演示数据（124 分 / 324 好习惯 / 4 次奖励）。
/// release / profile 构建下为 false，入口在编译期被整段树摇掉。
const bool allowDemoReset = !_isReleaseBuild;

/// 只读数据的加载状态（W4-B）。
///
/// `ready` 之后仍可能 `loadingMore`（追加下一页）或 `error`（保留已加载内容）。
enum ReadStatus { idle, loading, ready, loadingMore, error }

/// 应用状态中心：积分余额、习惯、心愿、流水、规则。
///
/// 目前是纯内存实现（会话内有效）。要落地持久化时，
/// 只需在 [_persist] 中接入 shared_preferences / sqflite 即可，UI 层无需改动。
class AppStore extends ChangeNotifier {
  /// 首启是**空态**（修 E18 第二半）。
  ///
  /// 原先构造即 `_reset()` → 应用一打开就是假数据（124 分 / 324 好习惯 /
  /// “萌新铲屎官的小可爱”）：新用户看到“我完成了 324 个好习惯”是荒谬的。
  /// seed 自此只作**测试夹具**，由 [resetToSeed] 显式载入。
  AppStore({ReadApiClient? readApi}) : _readApi = readApi {
    _resetToEmpty();
  }

  /// 只读 API 客户端；为 null 表示**没有配置后端**，整个 App 用本地数据。
  ///
  /// 只有 `main()` 按 `--dart-define` 注入：测试 / 演示默认走原路径，
  /// 不会因为环境里恰好有变量就偷偷发请求。
  final ReadApiClient? _readApi;

  /// 一页流水条数 —— 与后端 DTO 的上限（200）同口径，50 是「首屏够用」的折中。
  static const int _recordsPageSize = 50;

  ReadStatus _readStatus = ReadStatus.idle;
  ReadApiException? _readError;
  bool _usingPreview = true;
  bool _hasMoreRecords = false;
  String? _nextCursor;
  RecordCategory? _recordFilter;

  /// 每次「重新加载 / 切分类」都 +1；在途的旧响应据此丢弃（防串页）。
  int _readEpoch = 0;
  bool _disposed = false;

  /// 是否接入了后端（与「当前是否已加载成功」是两件事）。
  bool get isLiveMode => _readApi != null;

  /// 只读模式：接后端时**不提供写入口**（W4 只实现了读端点）。
  /// 本地预览数据不受影响，可以随便点 —— 那本来就是演示。
  bool get isReadOnly => isLiveMode;

  ReadStatus get readStatus => _readStatus;

  ReadApiException? get readError => _readError;

  /// 当前展示的是本地预览数据（未配置后端，或首次加载尚未成功）。
  bool get usingPreview => _usingPreview;

  /// 服务端还有下一页（仅 live 有效）。
  bool get hasMoreRecords => _hasMoreRecords;

  /// 当前记录页的服务端筛选（null = 全部）。
  RecordCategory? get recordFilter => _recordFilter;

  /// 只读模式下写操作统一文案 —— 页面直接展示，不另编理由。
  String get readOnlyWriteMessage => '只读模式：后端写入接口还没上线（W4），这次操作没有保存到服务器。';

  /// 记录页要展示的流水：
  ///   · 预览模式：对本地流水按分类过滤（原逻辑）；
  ///   · live 模式：服务端已按 `category` 过滤，这里不再二次过滤，
  ///     否则「全部」只加载 50 条时会漏掉后面的同类记录。
  List<PointRecord> get visibleRecords => _usingPreview
      ? recordsOf(_recordFilter)
      : List<PointRecord>.unmodifiable(records);

  int _points = 0;
  late ChildProfile profile;

  /// 流水：**只增不删**（撤销也走冲正记录）—— 与审计、版本表同等待遇。
  final List<PointRecord> records = <PointRecord>[];

  /// 规则版本表 —— **只增不删、永不 UPDATE**（`02` §5.3 / §5.6），修 C10。
  final List<RuleVersion> ruleVersions = <RuleVersion>[];

  /// 审计流水 —— **追加式**（只增不删、永不 UPDATE），修 C11。
  final List<AuditEntry> auditLog = <AuditEntry>[];

  // 三个配置列表的**唯一**存储：含回收站条目（status 为 deleted 的项）。
  // 页面**不得**直接读它们 —— 一律走下面的 getter（自动过滤回收站，§3.6）。
  final List<Habit> _habitList = <Habit>[];
  final List<Wish> _wishList = <Wish>[];
  final List<PointRule> _ruleList = <PointRule>[];

  /// 列表的**唯一**读法（docs/design/08 §3.6）：[activeOnly] 只在这里收口。
  ///
  /// 页面拿到的是“活着的”；回收站拿的是 `deleted` 的 ——
  /// 排除 `deleted` 的判断全仓库只有 trash.dart 一处，
  /// 两端各写一遍 `status == active` 迟早漂移（那正是 E15 / E17 教过的）。
  List<Habit> get habits => activeOnly(_habitList);

  List<Wish> get wishes => activeOnly(_wishList);

  List<PointRule> get rules => activeOnly(_ruleList);

  int get points => _points;

  int _seq = 0;

  /// 空态：每个真实用户的第一步都从这里开始（修 E18）。
  void _resetToEmpty() {
    _points = 0;
    profile = ChildProfile(
      name: '',
      childId: '',
      goodHabitCount: 0,
      rewardCount: 0,
    );
    _habitList.clear();
    _wishList.clear();
    _ruleList.clear();
    records.clear();
    ruleVersions.clear();
    auditLog.clear();
  }

  /// 载入演示数据 —— 只由 [resetToSeed] 调用（调试构建 / 测试夹具）。
  void _applySeed() {
    final SeedBundle seed = buildSeedData();
    _points = seed.points;
    profile = seed.profile;
    _habitList
      ..clear()
      ..addAll(seed.habits);
    _wishList
      ..clear()
      ..addAll(seed.wishes);
    records
      ..clear()
      ..addAll(seed.records);
    _ruleList
      ..clear()
      ..addAll(seed.rules);
    ruleVersions
      ..clear()
      ..addAll(seed.ruleVersions);
    // 夹具的审计**从空开始**：审计记录的是“这台设备上发生过的变更”，
    // 预置数据不是变更（否则回收站 / 审计页会显示一堆没人做过的操作）。
    auditLog.clear();
  }

  /// 恢复演示数据（“我的”页长按头像可触发）。返回是否真的执行了恢复。
  ///
  /// **修 E18**：原先是**生产可达**的公开方法 —— 用户可一键清空真实数据并恢复假演示数据。
  /// 现由 [allowDemoReset]（编译期常量）守卫，仅调试构建可用。
  ///
  /// 注意它现在是演示数据的**唯一**入口：首启不再自动载入 seed（那是 E18 的另一半）。
  bool resetToSeed() {
    if (!allowDemoReset) return false;
    _applySeed();
    _persist();
    return true;
  }

  // ---------------------------------------------------------------- 查询

  /// 按分类过滤流水，[category] 为 null 表示“全部”。
  List<PointRecord> recordsOf(RecordCategory? category) {
    if (category == null) return List<PointRecord>.unmodifiable(records);
    return records.where((PointRecord r) => r.category == category).toList();
  }

  // ------------------------------------------------------- 只读 API（W4-B）

  /// 从后端拉取首页快照 + 第一页流水；失败时**保留已有数据**并记录错误。
  ///
  /// 两个请求并发：首页和流水各自独立，任何一个失败都会走 catch，
  /// 不会出现「首页更新了、流水还是旧的」这种半新半旧的静默状态。
  Future<void> refreshFromServer() async {
    final ReadApiClient? api = _readApi;
    if (api == null) return;

    final int epoch = ++_readEpoch;
    _readStatus = ReadStatus.loading;
    _readError = null;
    _notify();

    try {
      final List<Object> results = await Future.wait<Object>(<Future<Object>>[
        api.fetchHome(),
        api.fetchRecords(
          category: _recordFilter?.name,
          limit: _recordsPageSize,
        ),
      ]);
      if (epoch != _readEpoch || _disposed) return;

      final HomeSnapshot home = mapHome(results[0] as HomeDto);
      final RecordsPage page = mapRecordsPage(results[1] as RecordsPageDto);

      _applyHomeSnapshot(home);
      _applyRecordsPage(page, append: false);
      _usingPreview = false;
      _readStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = error;
      _readStatus = ReadStatus.error;
    } catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = _unexpectedReadError(error);
      _readStatus = ReadStatus.error;
    }
    _notify();
  }

  /// 追加下一页。**必须**用服务端给的 `nextCursor` 原样请求；
  /// 没有更多 / 正在加载 / 预览模式时直接返回（不会重复请求同一页）。
  Future<void> loadMoreRecords() async {
    final ReadApiClient? api = _readApi;
    final String? cursor = _nextCursor;
    if (api == null ||
        _usingPreview ||
        !_hasMoreRecords ||
        cursor == null ||
        _readStatus == ReadStatus.loadingMore ||
        _readStatus == ReadStatus.loading) {
      return;
    }

    final int epoch = _readEpoch;
    _readStatus = ReadStatus.loadingMore;
    _readError = null;
    _notify();

    try {
      final RecordsPageDto dto = await api.fetchRecords(
        category: _recordFilter?.name,
        limit: _recordsPageSize,
        cursor: cursor,
      );
      if (epoch != _readEpoch || _disposed) return;

      _applyRecordsPage(mapRecordsPage(dto), append: true);
      _readStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = error;
      _readStatus = ReadStatus.error;
    } catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = _unexpectedReadError(error);
      _readStatus = ReadStatus.error;
    }
    _notify();
  }

  /// 切换记录页分类。live 模式下**重新向服务端要第一页**（带 `category`），
  /// 因为本地只过滤已加载的 50 条会漏掉后面的同类记录（那是假「共 N 条」）。
  Future<void> setRecordFilter(RecordCategory? category) async {
    if (_recordFilter == category) return;
    _recordFilter = category;

    if (_readApi == null || _usingPreview) {
      _notify();
      return;
    }
    final ReadApiClient api = _readApi!;

    final int epoch = ++_readEpoch;
    _readStatus = ReadStatus.loading;
    _readError = null;
    _nextCursor = null;
    _hasMoreRecords = false;
    records.clear();
    _notify();

    try {
      final RecordsPageDto dto = await api.fetchRecords(
        category: _recordFilter?.name,
        limit: _recordsPageSize,
      );
      if (epoch != _readEpoch || _disposed) return;

      _applyRecordsPage(mapRecordsPage(dto), append: false);
      _readStatus = ReadStatus.ready;
    } on ReadApiException catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = error;
      _readStatus = ReadStatus.error;
    } catch (error) {
      if (epoch != _readEpoch || _disposed) return;
      _readError = _unexpectedReadError(error);
      _readStatus = ReadStatus.error;
    }
    _notify();
  }

  void _applyHomeSnapshot(HomeSnapshot home) {
    _points = home.pointsBalance;
    profile = ChildProfile(
      name: home.childName,
      childId: home.childId,
      goodHabitCount: home.goodHabitCount,
      rewardCount: home.rewardCount,
    );
    _habitList
      ..clear()
      ..addAll(home.habits);
    _ruleList
      ..clear()
      ..addAll(home.rules);
    _wishList
      ..clear()
      ..addAll(home.wishes);
  }

  void _applyRecordsPage(RecordsPage page, {required bool append}) {
    if (!append) records.clear();
    // 按 id 去重：键集翻页本不该重叠，但客户端多一道保险 ——
    // 宁可少显示一条重复，也不能让「加载更多」把同一笔流水堆两遍。
    final Set<String> known = records.map((PointRecord r) => r.id).toSet();
    records.addAll(page.records.where((PointRecord r) => known.add(r.id)));
    _nextCursor = page.nextCursor;
    _hasMoreRecords = page.hasMore;
  }

  ReadApiException _unexpectedReadError(Object error) => ReadApiException(
        ReadFailureKind.malformed,
        '读取数据时发生意外错误。请重试；若持续出现请反馈。',
        code: 'UNEXPECTED_READ_ERROR',
        detail: error.toString(),
      );

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _readApi?.close();
    super.dispose();
  }

  /// 首页用的**派生视图**列表 —— 修 A2 / A3 / E17。
  ///
  /// 页面不再读任何“状态字段”：checked / limitText / doneText 都在这里
  /// 由 `dailyLimit` ＋ 当天流水现算。视图是**快照对象**，不回写 store，
  /// 因此也不存在“谁改了 checked 导致状态与流水不一致”的可能。
  List<HabitView> get habitViews =>
      habits.map((Habit habit) => habitView(habit, records)).toList();

  /// 单个习惯的派生视图（用于“刚打完卡”的单点查询）。
  HabitView habitViewOf(Habit habit) => habitView(habit, records);

  bool canRedeem(Wish wish) => !wish.redeemed && _points >= wish.cost;

  int gapOf(Wish wish) {
    final int gap = wish.cost - _points;
    return gap > 0 ? gap : 0;
  }

  // ---------------------------------------------------------------- 打卡

  /// 首页习惯打卡。成功返回 null，失败返回提示文案。
  ///
  /// [actor] 记录**真实操作人** —— 修 A4：原先无论谁打卡都写死“家长记录”，
  /// 孩子自己完成也显示“家长记录”，流水在撒谎且责任链断裂。
  String? checkIn(Habit habit, {ActorContext actor = const ActorContext()}) {
    // 修 A3：上限判定必须来自**当天流水**，不能是布尔量 checked ——
    // 否则“每天最多 2 次”的规则打完 1 次就再也打不了第 2 次（承诺的次数永远不可达）。
    // 习惯以 store 里的**当前**定义为准（视图是快照，不能信任调用方传进来的副本）。
    Habit? live;
    for (final Habit item in habits) {
      if (item.id == habit.id) {
        live = item;
        break;
      }
    }
    if (live == null) {
      return '“${habit.title}”已经不在今天的习惯里了';
    }
    final int done = checkedCountToday(records, live.id);
    if (done >= live.dailyLimit) {
      return '“${live.title}”今天已经完成 $done 次啦，明天继续加油～';
    }
    final RecordSource source = actor.role == MemberRole.child
        ? RecordSource.childSelf
        : RecordSource.guardian;
    _points += live.points;
    profile.goodHabitCount += 1;
    final DateTime time = DateTime.now();
    final PointRecord record = PointRecord(
      id: _newId('rec'),
      title: live.title,
      subtitle: recordSubtitle(time: time, source: source),
      points: live.points,
      time: time,
      category: RecordCategory.praise,
      // 修 D9：流水只带**图标名字**（与规则/习惯同源），渲染时才查表
      iconName: live.iconName,
      color: live.color,
      source: source,
      operatorRole: actor.role,
      habitId: live.id,
      // 修 C10：习惯由哪条规则派生，就把那条规则**当时的版本**钉在这一笔上 ——
      // 没有它，规则改成 +5 之后这笔 +3 就成了无法解释的数字。
      ruleId: live.ruleId,
      ruleVersion: _currentRuleVersion(live.ruleId),
      balanceAfter: _points,
    );
    records.insert(0, record);
    // 修 C11：写流水与记审计在**同一次操作**里、只 persist 一次
    _audit(
      AuditAction.pointRecordCheckIn,
      AuditTargetType.pointRecord,
      record.id,
      null,
      auditSnapshotOf(record.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  /// 撤销今天的打卡（长按习惯卡片）。成功返回 null，失败返回提示文案。
  ///
  /// **修 B7**：原先用 `removeWhere` 直接删掉今天的流水 —— 历史被物理抹掉
  /// （违背账本不可变原则），且按 `title` 匹配会**误删同名习惯**的记录。
  /// 现改为按 `habitId`（唯一）定位并写入**冲正记录**，原记录保留不动。
  /// 因此撤销后流水条数 **+1 而非 −1**。详见 docs/design/02 §5。
  String? undoCheckIn(
    Habit habit, {
    ActorContext actor = const ActorContext(),
  }) {
    // 修 A3：可撤销性同样按**当天流水**判定（checked 已不是可写字段）；
    // 真正决定“撤销哪一条”的仍是下面按 habitId 定位的 target。
    if (checkedCountToday(records, habit.id) == 0) {
      return '“${habit.title}”今天还没有打卡，不用撤销';
    }
    final Set<String?> reversedIds = records
        .where((PointRecord r) => r.reversesRecordId != null)
        .map((PointRecord r) => r.reversesRecordId)
        .toSet();
    PointRecord? target;
    for (final PointRecord r in records) {
      if (r.habitId == habit.id &&
          r.category == RecordCategory.praise &&
          r.source != RecordSource.correction &&
          !reversedIds.contains(r.id) &&
          isSameDay(r.time)) {
        target = r;
        break;
      }
    }
    if (target == null) {
      return '没有找到“${habit.title}”今天的打卡记录';
    }
    // 修 B6 同类保护：扣回不得超过当前余额（禁止静默截断，否则账本不平）
    if (target.points > _points) {
      return '积分不足，无法撤销（需扣回 ${target.points} 分，当前只有 $_points 分）';
    }
    // 修 A3：这里不再写 habit.checked = false —— 它是派生值，
    // 撤销通过「新增一条指向原记录的冲正记录」表达（见 habit.dart 的 checkedCountToday）
    _points -= target.points;
    if (profile.goodHabitCount > 0) profile.goodHabitCount -= 1;
    final DateTime time = DateTime.now();
    final PointRecord record = PointRecord(
      id: _newId('rec'),
      title: '撤销：${target.title}',
      subtitle: recordSubtitle(
        time: time,
        source: RecordSource.correction,
        note: target.title,
      ),
      points: -target.points,
      time: time,
      category: RecordCategory.adjust,
      iconName: IconNames.minus,
      color: AppColors.pointSpend,
      source: RecordSource.correction,
      operatorRole: actor.role,
      note: target.title,
      habitId: habit.id,
      // 修 C10：冲正记录**继承**原记录的规则与版本 ——
      // “哪一版规则产生了这笔分、又是谁撤销的”因此都留在账上
      ruleId: target.ruleId,
      ruleVersion: target.ruleVersion,
      reversesRecordId: target.id,
      balanceAfter: _points,
    );
    records.insert(0, record);
    _audit(
      AuditAction.pointRecordUndoCheckIn,
      AuditTargetType.pointRecord,
      record.id,
      null,
      auditSnapshotOf(record.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  // ------------------------------------------------------------ 记一笔

  /// “记一笔”：家长手动加/减分。[delta] 为负表示扣分。
  /// 成功返回 null，失败返回提示文案。
  ///
  /// **修 B6**：原先 `_points += delta; if (_points < 0) _points = 0;` 会**静默截断**余额，
  /// 而流水照记原始 delta —— 余额 124、delta=-9999 时余额变 0（实际变动 −124）却记 −9999，
  /// **Σ流水 ≠ 余额，账本无法对账**。现改为**拒绝超额扣分**。
  ///
  /// **修 A5**：原先 `if (isGain) profile.rewardCount += 1;` —— 手动加分被计成一次“奖励兑换”，
  /// 但 rewardCount 的语义是**累计兑换次数**，只应由 redeem 递增。
  String? addQuickNote({
    required int delta,
    required String reason,
    String note = '',
    ActorContext actor = const ActorContext(),
  }) {
    if (delta == 0) {
      return '调整金额不能为 0';
    }
    if (delta < 0 && delta.abs() > _points) {
      return '积分不足，当前只有 $_points 分，最多可扣 $_points 分';
    }
    final bool isGain = delta > 0;
    final RecordSource source = actor.role == MemberRole.child
        ? RecordSource.childSelf
        : RecordSource.guardian;
    _points += delta;
    final String title =
        reason.trim().isEmpty ? (isGain ? '额外奖励' : '扣除积分') : reason.trim();
    final DateTime time = DateTime.now();
    final PointRecord record = PointRecord(
      id: _newId('rec'),
      title: title,
      subtitle: recordSubtitle(time: time, source: source, note: note),
      points: delta,
      time: time,
      category: RecordCategory.adjust,
      iconName: isGain ? IconNames.plus : IconNames.minus,
      color: isGain ? AppColors.pointGain : AppColors.pointSpend,
      source: source,
      operatorRole: actor.role,
      note: note.trim(),
      // 手动“记一笔”不来自任何规则 —— 版本号因此为 null（不是“忘了写”）
      ruleId: null,
      ruleVersion: null,
      balanceAfter: _points,
    );
    records.insert(0, record);
    _audit(
      AuditAction.pointRecordQuickNote,
      AuditTargetType.pointRecord,
      record.id,
      null,
      auditSnapshotOf(record.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  // ------------------------------------------------------------ 心愿单

  /// 兑换心愿。成功返回 true，积分不足或已兑换返回 false。
  ///
  /// **修 B8**：原先 `'兑换：${_shortTitle(wish.title)}'` 把标题截断到 10 字符后
  /// **永久写进流水**，且没有 `wishId` 回指 —— 心愿删除后这笔扣分再也无法解释。
  /// 现改为**完整标题快照 + wishId 回指**，截断交给渲染层的 ellipsis。
  bool redeem(Wish wish, {ActorContext actor = const ActorContext()}) {
    if (!canRedeem(wish)) return false;
    final RecordSource source = actor.role == MemberRole.child
        ? RecordSource.childSelf
        : RecordSource.guardian;
    _points -= wish.cost;
    wish.redeemed = true;
    profile.rewardCount += 1;
    final DateTime time = DateTime.now();
    final PointRecord record = PointRecord(
      id: _newId('rec'),
      // 修 B8：完整标题，不截断
      title: '兑换：${wish.title}',
      subtitle: recordSubtitle(
        time: time,
        source: source,
        category: RecordCategory.exchange,
      ),
      points: -wish.cost,
      time: time,
      category: RecordCategory.exchange,
      iconName: IconNames.gift,
      color: AppColors.orange,
      source: source,
      operatorRole: actor.role,
      // 兑换与规则无关，版本号同样为 null
      ruleId: null,
      ruleVersion: null,
      // 修 B8：回指心愿，即使心愿被删除也能解释这笔支出
      wishId: wish.id,
      balanceAfter: _points,
    );
    records.insert(0, record);
    _audit(
      AuditAction.pointRecordRedeem,
      AuditTargetType.pointRecord,
      record.id,
      auditSnapshotOf(wish.snapshot()),
      auditSnapshotOf(record.snapshot()),
      actor,
    );
    _persist();
    return true;
  }

  void addWish({
    required String title,
    required int cost,
    required String emoji,
    ActorContext actor = const ActorContext(),
  }) {
    final String id = _newId('wish');
    final Wish wish = Wish(
      id: id,
      title: title.trim(),
      cost: cost,
      emoji: emoji,
      // 修 E16：配色只由「空档 + id」决定，与列表长度无关 —— 删项后既有心愿不再换色
      // （回收站里的心愿不参与选色：它们不在列表上，配色可以回收再利用）
      coverStyle: pickCoverStyle(
        wishes.map((Wish item) => item.coverStyle).toList(),
        id,
      ),
    );
    _wishList.insert(0, wish);
    _audit(
      AuditAction.wishCreate,
      AuditTargetType.wish,
      wish.id,
      null,
      auditSnapshotOf(wish.snapshot()),
      actor,
    );
    _persist();
  }

  /// 删除心愿 —— **软删**（进回收站，90 天内可恢复），修 C9。
  ///
  /// 原先 `wishes.remove(wish)`：误删不可恢复；且已发生的兑换流水再也找不到
  /// 它回指的心愿（`wishId` 指向空 —— “这笔扣分换的是什么”从此无解）。
  void removeWish(Wish wish, {ActorContext actor = const ActorContext()}) {
    final Wish? live = _findById(_wishList, wish.id);
    if (live == null) return;
    if (_softDelete(live, TrashKind.wish, actor)) _persist();
  }

  // ------------------------------------------------------------ 积分规则

  /// 新增规则。成功返回 null，失败返回提示文案。
  ///
  /// **修 E15 / A2**：参数由 `detail` 自由串改为 `condition` ＋ `dailyLimit` 结构字段
  /// （展示串交给 [ruleDetail] 派生）；`dailyLimit` 越界时**拒绝**而不是夹到边界 ——
  /// 静默改写会让家长以为约定已按他的意思生效。
  ///
  /// **修 D9**：图标入参是**名字**（`iconName`），且必须落在白名单里 —— 越界同样
  /// **拒绝**：落一个不存在的名字，界面只会画成「未知」占位，家长看不到自己选的那个图标
  /// （静默兜底能保证不崩，但不该被当成「存进去了」）。
  String? addRule({
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required String iconName,
    required Color color,
    ActorContext actor = const ActorContext(),
  }) {
    if (!isDailyLimitValid(dailyLimit)) {
      return '每天次数只能是 $dailyLimitMin–$dailyLimitMax 之间的整数';
    }
    if (!isKnownIconName(iconName)) {
      return '图标「$iconName」不在可选列表里';
    }
    final PointRule rule = PointRule(
      id: _newId('rule'),
      title: title.trim(),
      condition: condition.trim().isEmpty ? '家长约定' : condition.trim(),
      dailyLimit: dailyLimit,
      points: points,
      iconName: iconName,
      color: color,
      // 修 C10：新建即 version 1，并**同时**留下 version 1 的版本记录 ——
      // 于是 `currentVersion` 永远指向一条真实存在的版本（回放不留空档）。
      currentVersion: 1,
    );
    _ruleList.insert(0, rule);
    ruleVersions.add(
      RuleVersion(
        id: _newId('rv'),
        ruleId: rule.id,
        version: 1,
        title: rule.title,
        condition: rule.condition,
        dailyLimit: rule.dailyLimit,
        points: rule.points,
        changedByRole: actor.role,
        changedAt: DateTime.now(),
        changeNote: '新建规则',
      ),
    );
    _audit(
      AuditAction.pointRuleCreate,
      AuditTargetType.pointRule,
      rule.id,
      null,
      auditSnapshotOf(rule.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  /// 删除规则 —— **软删**（进回收站，90 天内可恢复），修 C9。
  ///
  /// 版本记录**不跟着删**：否则历史流水的 `(ruleId, ruleVersion)` 指向空
  /// （“这分按什么规则给的”永远无法回答，见 `02` §5.6）。
  void removeRule(PointRule rule, {ActorContext actor = const ActorContext()}) {
    final PointRule? live = _findById(_ruleList, rule.id);
    if (live == null) return;
    if (_softDelete(live, TrashKind.pointRule, actor)) _persist();
  }

  /// 按规则生成一个首页习惯（规则页“加入今天的习惯”用）。
  /// 成功返回 null，失败返回提示文案。
  ///
  /// **修 A1**：原先 `points: rule.points.abs()` 把扣分规则**静默转成加分习惯** ——
  /// 家长定「打人 −3 分」，孩子打人后打卡反而 **+3 分**。属产品性质级错误。
  /// 扣分规则不应生成可打卡习惯，直接拒绝并给出可读文案。
  String? addHabitFromRule(
    PointRule rule, {
    ActorContext actor = const ActorContext(),
  }) {
    if (habits.any((Habit h) => h.title == rule.title)) {
      return '“${rule.title}”已经在今天的习惯里了';
    }
    if (rule.points < 0) {
      return '“${rule.title}”是扣分规则，不能加入今天的习惯';
    }
    // 修 E15：条件与频次**直取结构字段** —— 原先这里 rule.detail.split(' · ')
    // 反解析：多一段就丢一段、没分隔符就静默落到默认值「每天 1 次」。
    final Habit habit = Habit(
      id: _newId('habit'),
      title: rule.title,
      points: rule.points,
      condition: rule.condition,
      dailyLimit: rule.dailyLimit,
      iconName: rule.iconName,
      color: rule.color,
      // 修 C10：记住“我是由哪条规则派生的” —— 有了这条链，打卡写出的流水
      // 才能同时写清 (ruleId, ruleVersion)；改规则时也才知道该同步谁。
      // 靠标题匹配是 E15 那类病（改个名就断链）。
      ruleId: rule.id,
    );
    _habitList.add(habit);
    _audit(
      AuditAction.habitCreate,
      AuditTargetType.habit,
      habit.id,
      null,
      auditSnapshotOf(habit.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  // ------------------------------------------------------------ 档案

  void renameChild(String name, {ActorContext actor = const ActorContext()}) {
    final String trimmed = name.trim();
    if (trimmed.isEmpty) return;
    final AuditSnapshot before = auditSnapshotOf(profile.snapshot());
    profile.name = trimmed;
    // 修 C11：改名是“成员”类变更 —— 用 `memberRename` 记一条，
    // 而不是混进流水（成员变更不是积分变更）。
    // 成员增删 / 角色切换 / 家长同意在本轮**未实现**（前端没有入口），
    // 因此 AuditAction 里也没有对应取值 —— 不假装覆盖。
    _audit(
      AuditAction.memberRename,
      AuditTargetType.member,
      profile.childId.isEmpty ? 'local-child' : profile.childId,
      before,
      auditSnapshotOf(profile.snapshot()),
      actor,
    );
    _persist();
  }

  // ============================================ 回收站（修 C9）＋ 审计（修 C11）

  /// 写入一条审计 —— **追加式**：只 `insert(0, …)`、永不 UPDATE、永不删除（修 C11）。
  ///
  /// [before] / [after] 一律由 [auditSnapshotOf] **深拷贝**而来。
  /// 存引用的话，写完之后原对象一改，“变更前后”会同时指向那批已变形的值 ——
  /// 审计就成了摆设，而这正是 C11 要防的“看起来在做安全”（docs/design/08 §6）。
  void _audit(
    AuditAction action,
    AuditTargetType targetType,
    String targetId,
    AuditSnapshot? before,
    AuditSnapshot? after,
    ActorContext actor,
  ) {
    auditLog.insert(
      0,
      AuditEntry(
        id: _newId('audit'),
        action: action,
        targetType: targetType,
        targetId: targetId,
        before: before,
        after: after,
        actorRole: actor.role,
        time: DateTime.now(),
      ),
    );
  }

  /// 按类型取**含回收站**的原始列表（只给 store 内部与回收站用）。
  List<SoftDeletable> _listOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return _ruleList;
      case TrashKind.wish:
        return _wishList;
      case TrashKind.habit:
        return _habitList;
    }
  }

  /// 按 id 找出**活着的和回收站里的**那一条（找不到返回 null）。
  static T? _findById<T extends SoftDeletable>(List<T> list, String id) {
    for (final T item in list) {
      if (item.id == id) return item;
    }
    return null;
  }

  // 类型 → 审计动作 / 对象类型。与 Taro 侧的 `${kind}.delete` 是**同一张表**：
  // 写成 switch 而不是拼字符串，枚举穷尽由编译器保证（拼错串只会在半夜才发现）。
  AuditAction _deleteActionOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return AuditAction.pointRuleDelete;
      case TrashKind.wish:
        return AuditAction.wishDelete;
      case TrashKind.habit:
        return AuditAction.habitDelete;
    }
  }

  AuditAction _restoreActionOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return AuditAction.pointRuleRestore;
      case TrashKind.wish:
        return AuditAction.wishRestore;
      case TrashKind.habit:
        return AuditAction.habitRestore;
    }
  }

  AuditAction _purgeActionOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return AuditAction.pointRulePurge;
      case TrashKind.wish:
        return AuditAction.wishPurge;
      case TrashKind.habit:
        return AuditAction.habitPurge;
    }
  }

  AuditTargetType _targetTypeOf(TrashKind kind) {
    switch (kind) {
      case TrashKind.pointRule:
        return AuditTargetType.pointRule;
      case TrashKind.wish:
        return AuditTargetType.wish;
      case TrashKind.habit:
        return AuditTargetType.habit;
    }
  }

  /// 软删除：**只改 `status` ＋ `deletedAt`，物理数据一律保留** —— 修 C9。
  ///
  /// 原先 `removeWish` / `removeRule` 直接 `remove` 掉对象：误删不可恢复；
  /// 且被删主体一消失，历史流水的回指（`ruleId` / `wishId`）就指向空，
  /// “这 +1 分按什么规则给的”再也无法回答。
  bool _softDelete(SoftDeletable item, TrashKind kind, ActorContext actor) {
    if (item.status == RecordStatus.deleted) return false;
    final AuditSnapshot before = auditSnapshotOf(item.snapshot());
    item.status = RecordStatus.deleted;
    item.deletedAt = DateTime.now();
    _audit(
      _deleteActionOf(kind),
      _targetTypeOf(kind),
      item.id,
      before,
      auditSnapshotOf(item.snapshot()),
      actor,
    );
    return true;
  }

  /// 从回收站恢复：回到 `active` 并清掉 `deletedAt` —— 修 C9。
  bool _restoreItem(SoftDeletable item, TrashKind kind, ActorContext actor) {
    if (item.status != RecordStatus.deleted) return false;
    final AuditSnapshot before = auditSnapshotOf(item.snapshot());
    item.status = RecordStatus.active;
    item.deletedAt = null;
    _audit(
      _restoreActionOf(kind),
      _targetTypeOf(kind),
      item.id,
      before,
      auditSnapshotOf(item.snapshot()),
      actor,
    );
    return true;
  }

  /// 回收站条目（规则 / 心愿 / 习惯三类汇总）—— 修 C9。
  ///
  /// [now] 由调用方传入，好让“90 天边界”可以被确定性地测试（见 [isTrashExpired]）。
  /// 是否**已过期**只是判定；真正清理要等 UI 调 [purgeExpiredTrash] ——
  /// **不做任何自动清理**（过期不等于必须删，产品决定）。
  List<TrashItem> trashItems({DateTime? now}) {
    final DateTime time = now ?? DateTime.now();
    final List<TrashItem> rows = <TrashItem>[];
    void collect(TrashKind kind) {
      for (final SoftDeletable item in trashOnly(_listOf(kind))) {
        rows.add(
          TrashItem(
            kind: kind,
            id: item.id,
            title: item.title,
            // 理论上 `deleted` 必有 `deletedAt`；兜底用 now 只为让展示层免于处理 null
            deletedAt: item.deletedAt ?? time,
            expired: isTrashExpired(item.deletedAt, now: time),
          ),
        );
      }
    }

    collect(TrashKind.pointRule);
    collect(TrashKind.wish);
    collect(TrashKind.habit);
    rows.sort((TrashItem a, TrashItem b) => b.deletedAt.compareTo(a.deletedAt));
    return rows;
  }

  /// 从回收站恢复某一条（按类型 + id 定位）。
  bool restoreTrash(
    TrashKind kind,
    String id, {
    ActorContext actor = const ActorContext(),
  }) {
    final SoftDeletable? item = _findById(_listOf(kind), id);
    if (item == null) return false;
    if (!_restoreItem(item, kind, actor)) return false;
    _persist();
    return true;
  }

  /// 从回收站恢复某条规则（规则页 / 回收站页用）—— 修 C9。
  bool restoreRule(PointRule rule,
          {ActorContext actor = const ActorContext()}) =>
      restoreTrash(TrashKind.pointRule, rule.id, actor: actor);

  /// 从回收站恢复某个心愿（心愿页 / 回收站页用）—— 修 C9。
  bool restoreWish(Wish wish, {ActorContext actor = const ActorContext()}) =>
      restoreTrash(TrashKind.wish, wish.id, actor: actor);

  /// **彻底**删除某条回收站内容 —— 修 C9。
  ///
  /// 只允许删除 `status == deleted` 的条目：列表里的东西想删必须先软删，
  /// 否则“彻底删除”就成了绕过回收站的物理删（C9 又回来了）。
  bool purgeTrash(
    TrashKind kind,
    String id, {
    ActorContext actor = const ActorContext(),
  }) {
    final List<SoftDeletable> list = _listOf(kind);
    final int index = list.indexWhere(
      (SoftDeletable row) => row.id == id && row.status == RecordStatus.deleted,
    );
    if (index < 0) return false;
    final SoftDeletable item = list[index];
    _audit(
      _purgeActionOf(kind),
      _targetTypeOf(kind),
      item.id,
      auditSnapshotOf(item.snapshot()),
      null,
      actor,
    );
    list.removeAt(index);
    _persist();
    return true;
  }

  /// 清理**已过期**（满 90 天）的回收站条目，返回清掉的条数 —— 修 C9。
  ///
  /// **只在 UI 显式调用时执行**（回收站页的“清理已过期”按钮）：
  /// 到期不等于必须删 —— 见 docs/design/08 §3.5（判定是纯函数，动作由产品决定）。
  int purgeExpiredTrash(
      {DateTime? now, ActorContext actor = const ActorContext()}) {
    final DateTime time = now ?? DateTime.now();
    int purged = 0;
    void sweep(List<SoftDeletable> list, TrashKind kind) {
      // 先摘出清单再删：边遍历边删会撞上并发修改异常（与 JS 同罪）
      final List<SoftDeletable> expired = list
          .where(
            (SoftDeletable item) =>
                item.status == RecordStatus.deleted &&
                isTrashExpired(item.deletedAt, now: time),
          )
          .toList();
      for (final SoftDeletable item in expired) {
        _audit(
          _purgeActionOf(kind),
          _targetTypeOf(kind),
          item.id,
          auditSnapshotOf(item.snapshot()),
          null,
          actor,
        );
        list.remove(item);
        purged += 1;
      }
    }

    sweep(_ruleList, TrashKind.pointRule);
    sweep(_wishList, TrashKind.wish);
    sweep(_habitList, TrashKind.habit);
    if (purged > 0) _persist();
    return purged;
  }

  /// 删除首页习惯 —— **软删**（进回收站，90 天内可恢复），修 C9。
  void removeHabit(Habit habit, {ActorContext actor = const ActorContext()}) {
    final Habit? live = _findById(_habitList, habit.id);
    if (live == null) return;
    if (_softDelete(live, TrashKind.habit, actor)) _persist();
  }

  /// 从回收站恢复某个习惯 —— 修 C9。
  bool restoreHabit(Habit habit, {ActorContext actor = const ActorContext()}) =>
      restoreTrash(TrashKind.habit, habit.id, actor: actor);

  // =================================================== 规则编辑（修 C10）

  /// 某条规则**当前**的版本号（规则不在体系里时 null）。
  int? _currentRuleVersion(String? ruleId) {
    if (ruleId == null) return null;
    for (final PointRule rule in _ruleList) {
      if (rule.id == ruleId) return rule.currentVersion;
    }
    return null;
  }

  /// 编辑规则 —— **四步一笔**（docs/design/02 §5.3：读版本 → 归档版本 →
  /// 更新规则 → 写审计），修 C10。
  ///
  /// 四件事在**一次调用里做完、只 `_persist()` 一次**：分成两次调用就会留下
  /// “改了但没记”的窗口 —— 那正是 C10 ＋ C11 要一起防的东西。
  ///
  /// 时间线语义（§3.2 / `02` §5.4）：**历史不可回溯、未来从新规**。
  /// 已发生流水的 `points` / `ruleVersion` **一字不动**；由这条规则派生的
  /// 首页习惯跟着新规走，于是“今日剩余额度”自然按新规重算（A3 的派生设计）。
  ///
  /// 成功返回 null，失败返回提示文案（与 [addRule] 同约定）。
  String? updateRule(
    PointRule rule, {
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    // 变更说明，写进版本记录（家长回看“为什么改”）
    String changeNote = '',
    ActorContext actor = const ActorContext(),
  }) {
    final PointRule? live = _findById(_ruleList, rule.id);
    if (live == null) return '这条规则已经不在了';
    if (live.status == RecordStatus.deleted) {
      return '“${live.title}”在回收站里，先恢复再改';
    }
    if (!isDailyLimitValid(dailyLimit)) {
      return '每天次数只能是 $dailyLimitMin–$dailyLimitMax 之间的整数';
    }
    final String nextTitle = title.trim().isEmpty ? live.title : title.trim();
    final String nextCondition =
        condition.trim().isEmpty ? '家长约定' : condition.trim();
    if (nextTitle == live.title &&
        nextCondition == live.condition &&
        dailyLimit == live.dailyLimit &&
        points == live.points) {
      return '没有改动，规则保持原样';
    }

    final DateTime time = DateTime.now();
    final AuditSnapshot changed = auditSnapshotOf(live.snapshot());
    final int version = live.currentVersion + 1;

    // ① 先归档新版本（装的**是**新值）—— 顺序不能反：先改 `PointRule` 再补版本，
    //    中间那一瞬 `currentVersion` 会指向一条不存在的版本记录（回放即见空档）。
    ruleVersions.add(
      RuleVersion(
        id: _newId('rv'),
        ruleId: live.id,
        version: version,
        title: nextTitle,
        condition: nextCondition,
        dailyLimit: dailyLimit,
        points: points,
        changedByRole: actor.role,
        changedAt: time,
        changeNote: changeNote.trim(),
      ),
    );

    // ② 原地更新规则本体 —— **`id` 不变**（改价不等于换对象，否则历史断裂）
    live.title = nextTitle;
    live.condition = nextCondition;
    live.dailyLimit = dailyLimit;
    live.points = points;
    live.currentVersion = version;

    // ③ 派生同步：由这条规则生成的首页习惯跟着新规走（§3.2「未来从新规」）。
    //    习惯是规则的**派生**，不单独记审计 —— 否则一次改动会产生两条审计，
    //    回放时会把“同步”误读成一次独立变更。
    for (final Habit habit in _habitList) {
      if (habit.ruleId != live.id) continue;
      habit.title = live.title;
      habit.condition = live.condition;
      habit.dailyLimit = live.dailyLimit;
      habit.points = live.points;
      habit.iconName = live.iconName;
      habit.color = live.color;
    }

    // ④ 记一条审计（`before` / `after` 是真快照）
    _audit(
      AuditAction.pointRuleUpdate,
      AuditTargetType.pointRule,
      live.id,
      changed,
      auditSnapshotOf(live.snapshot()),
      actor,
    );
    _persist();
    return null;
  }

  ///
  /// 今日“这条规则”已经产生几次表扬流水 —— 给 §3.3 的影响提示用（修 C10）。
  /// 直接复用 [checkedCountTodayByRule] 的同一口径，别在页面里另算一遍。
  int checkedCountTodayOfRule(PointRule rule, {DateTime? now}) =>
      checkedCountTodayByRule(records, rule.id, now: now);

  // ------------------------------------------------------------ 内部工具

  void _persist() => notifyListeners();

  String _newId(String prefix) =>
      '$prefix-${DateTime.now().microsecondsSinceEpoch}-${_seq++}';

  // （原先这里有个 _isToday()：现统一用 habit.dart 的 isSameDay()，
  //   与 Taro 侧同一个判据，避免“两端各自实现、各自漂移”）
}

import 'package:flutter/material.dart';

import '../models/child_profile.dart';
import '../models/habit.dart';
import '../models/point_record.dart';
import '../models/point_rule.dart';
import '../models/wish.dart';
import '../theme/app_colors.dart';
import 'seed_data.dart';

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
  AppStore() {
    _resetToEmpty();
  }

  int _points = 0;
  late ChildProfile profile;
  final List<Habit> habits = <Habit>[];
  final List<Wish> wishes = <Wish>[];
  final List<PointRecord> records = <PointRecord>[];
  final List<PointRule> rules = <PointRule>[];

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
    habits.clear();
    wishes.clear();
    records.clear();
    rules.clear();
  }

  /// 载入演示数据 —— 只由 [resetToSeed] 调用（调试构建 / 测试夹具）。
  void _applySeed() {
    final SeedBundle seed = buildSeedData();
    _points = seed.points;
    profile = seed.profile;
    habits
      ..clear()
      ..addAll(seed.habits);
    wishes
      ..clear()
      ..addAll(seed.wishes);
    records
      ..clear()
      ..addAll(seed.records);
    rules
      ..clear()
      ..addAll(seed.rules);
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
    records.insert(
      0,
      PointRecord(
        id: _newId('rec'),
        title: live.title,
        subtitle: recordSubtitle(time: time, source: source),
        points: live.points,
        time: time,
        category: RecordCategory.praise,
        icon: live.icon,
        color: live.color,
        source: source,
        operatorRole: actor.role,
        habitId: live.id,
        balanceAfter: _points,
      ),
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
    records.insert(
      0,
      PointRecord(
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
        icon: Icons.remove_rounded,
        color: AppColors.pointSpend,
        source: RecordSource.correction,
        operatorRole: actor.role,
        note: target.title,
        habitId: habit.id,
        ruleId: target.ruleId,
        reversesRecordId: target.id,
        balanceAfter: _points,
      ),
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
    records.insert(
      0,
      PointRecord(
        id: _newId('rec'),
        title: title,
        subtitle: recordSubtitle(time: time, source: source, note: note),
        points: delta,
        time: time,
        category: RecordCategory.adjust,
        icon: isGain ? Icons.add_rounded : Icons.remove_rounded,
        color: isGain ? AppColors.pointGain : AppColors.pointSpend,
        source: source,
        operatorRole: actor.role,
        note: note.trim(),
        balanceAfter: _points,
      ),
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
    records.insert(
      0,
      PointRecord(
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
        icon: Icons.redeem_rounded,
        color: AppColors.orange,
        source: source,
        operatorRole: actor.role,
        // 修 B8：回指心愿，即使心愿被删除也能解释这笔支出
        wishId: wish.id,
        balanceAfter: _points,
      ),
    );
    _persist();
    return true;
  }

  void addWish(
      {required String title, required int cost, required String emoji}) {
    wishes.insert(
      0,
      Wish(
        id: _newId('wish'),
        title: title.trim(),
        cost: cost,
        emoji: emoji,
        backgroundIndex: wishes.length % 4,
      ),
    );
    _persist();
  }

  void removeWish(Wish wish) {
    wishes.remove(wish);
    _persist();
  }

  // ------------------------------------------------------------ 积分规则

  /// 新增规则。成功返回 null，失败返回提示文案。
  ///
  /// **修 E15 / A2**：参数由 `detail` 自由串改为 `condition` ＋ `dailyLimit` 结构字段
  /// （展示串交给 [ruleDetail] 派生）；`dailyLimit` 越界时**拒绝**而不是夹到边界 ——
  /// 静默改写会让家长以为约定已按他的意思生效。
  String? addRule({
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required IconData icon,
    required Color color,
  }) {
    if (!isDailyLimitValid(dailyLimit)) {
      return '每天次数只能是 $dailyLimitMin–$dailyLimitMax 之间的整数';
    }
    rules.insert(
      0,
      PointRule(
        id: _newId('rule'),
        title: title.trim(),
        condition: condition.trim().isEmpty ? '家长约定' : condition.trim(),
        dailyLimit: dailyLimit,
        points: points,
        icon: icon,
        color: color,
      ),
    );
    _persist();
    return null;
  }

  void removeRule(PointRule rule) {
    rules.remove(rule);
    _persist();
  }

  /// 按规则生成一个首页习惯（规则页“加入今天的习惯”用）。
  /// 成功返回 null，失败返回提示文案。
  ///
  /// **修 A1**：原先 `points: rule.points.abs()` 把扣分规则**静默转成加分习惯** ——
  /// 家长定「打人 −3 分」，孩子打人后打卡反而 **+3 分**。属产品性质级错误。
  /// 扣分规则不应生成可打卡习惯，直接拒绝并给出可读文案。
  String? addHabitFromRule(PointRule rule) {
    if (habits.any((Habit h) => h.title == rule.title)) {
      return '“${rule.title}”已经在今天的习惯里了';
    }
    if (rule.points < 0) {
      return '“${rule.title}”是扣分规则，不能加入今天的习惯';
    }
    // 修 E15：条件与频次**直取结构字段** —— 原先这里 rule.detail.split(' · ')
    // 反解析：多一段就丢一段、没分隔符就静默落到默认值「每天 1 次」。
    habits.add(
      Habit(
        id: _newId('habit'),
        title: rule.title,
        points: rule.points,
        condition: rule.condition,
        dailyLimit: rule.dailyLimit,
        icon: rule.icon,
        color: rule.color,
      ),
    );
    _persist();
    return null;
  }

  // ------------------------------------------------------------ 档案

  void renameChild(String name) {
    final String trimmed = name.trim();
    if (trimmed.isEmpty) return;
    profile.name = trimmed;
    _persist();
  }

  // ------------------------------------------------------------ 内部工具

  void _persist() => notifyListeners();

  String _newId(String prefix) =>
      '$prefix-${DateTime.now().microsecondsSinceEpoch}-${_seq++}';

  // （原先这里有个 _isToday()：现统一用 habit.dart 的 isSameDay()，
  //   与 Taro 侧同一个判据，避免“两端各自实现、各自漂移”）
}

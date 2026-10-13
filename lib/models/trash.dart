/// 记录状态 —— **软删除**的落点（修 C9）。
///
/// 修 C9 之前：`wishes.remove(wish)` / `rules.remove(rule)` 是**物理删除** ——
/// 误删不可恢复；被删主体从数据里消失后，历史流水的回指（`ruleId` / `wishId`）
/// 指向空，"这 +1 分按什么规则给的"再也无法回答。
/// 现在删除**只改状态位**：主体留在数据里（只是从列表消失），回收站保留 90 天可恢复。
enum RecordStatus { active, deleted }

/// 回收站保留天数（Q12 结论：90 天）—— 修 C9。
const int trashRetentionDays = 90;

/// 一天的毫秒数（本文件内部使用）。
const int _msPerDay = 86400000;

/// 具备软删字段的配置项（规则 / 习惯 / 心愿）—— 修 C9。
///
/// 抽成接口是为了让 [activeOnly] / [trashOnly] **只有一处实现**：
/// 两端各写一遍 `status == active` 迟早漂移（那正是 E15 / E17 教过的）。
abstract class SoftDeletable {
  String get id;
  String get title;

  /// `active` 才出现在列表里；`deleted` 进回收站，90 天内可恢复
  RecordStatus get status;
  set status(RecordStatus value);

  /// 进入回收站的时间（`status == active` 时为 null）
  DateTime? get deletedAt;
  set deletedAt(DateTime? value);

  /// 审计快照的**结构字段**（由 [auditSnapshotOf] 深拷贝）—— 修 C11
  ///
  /// 放在接口上而不是各自实现：`softDelete` / `purge` 这类通用动作只认接口，
  /// 拿不到快照就写不出“变更前是什么”，审计就只剩一个 id。
  Map<String, Object?> snapshot();
}

/// 回收站里这条是否**已过期**（过了保留期，判定为可清理）—— 修 C9。
///
/// 刻意写成**纯函数**（`now` 由调用方传入）：89 / 90 / 91 天的边界因此可以
/// 被确定性地测试。**是否真的物理清理由 UI 决定**（`AppStore.purgeExpiredTrash`），
/// 本函数只负责判定 —— 见 docs/design/08 §3.5。
///
/// 口径：自 `deletedAt` 起**满 90 天**即算过期（`>=`）—— 第 89 天仍可恢复。
bool isTrashExpired(DateTime? deletedAt, {DateTime? now}) {
  if (deletedAt == null) return false;
  final DateTime time = now ?? DateTime.now();
  return time.difference(deletedAt).inMilliseconds >=
      trashRetentionDays * _msPerDay;
}

/// 列表的**唯一**过滤器：只留 `status == RecordStatus.active` 的项 —— 修 C9。
///
/// 硬约束（docs/design/08 §3.6）：排除 `deleted` 的写法**只能有这一处**。
List<T> activeOnly<T extends SoftDeletable>(List<T> items) =>
    items.where((T item) => item.status == RecordStatus.active).toList();

/// 回收站视图的**唯一**过滤器：只留 `status == RecordStatus.deleted` 的项 —— 修 C9。
List<T> trashOnly<T extends SoftDeletable>(List<T> items) =>
    items.where((T item) => item.status == RecordStatus.deleted).toList();

/// 回收站条目类型。
enum TrashKind { pointRule, wish, habit }

extension TrashKindLabel on TrashKind {
  String get label {
    switch (this) {
      case TrashKind.pointRule:
        return '规则';
      case TrashKind.wish:
        return '心愿';
      case TrashKind.habit:
        return '习惯';
    }
  }

  /// 与 Taro 侧同名的线值（日志 / 审计里可读）。
  String get wireName {
    switch (this) {
      case TrashKind.pointRule:
        return 'point_rule';
      case TrashKind.wish:
        return 'wish';
      case TrashKind.habit:
        return 'habit';
    }
  }
}

/// 回收站条目类型的展示文案（与 Taro 侧的 `trashKindLabelOf` 同源）。
String trashKindLabelOf(TrashKind kind) => kind.label;

/// 回收站条目的展示模型（三类配置汇总成一个列表）。
class TrashItem {
  const TrashItem({
    required this.kind,
    required this.id,
    required this.title,
    required this.deletedAt,
    required this.expired,
  });

  final TrashKind kind;
  final String id;
  final String title;
  final DateTime deletedAt;

  /// 已过 90 天保留期 → 可被清理（判定见 [isTrashExpired]）
  final bool expired;

  String get kindLabel => trashKindLabelOf(kind);

  /// 「还能恢复几天」—— 由 [trashRetentionText] 派生，界面不做日期运算
  String retentionText({DateTime? now}) =>
      trashRetentionText(deletedAt, now: now);
}

/// 回收站条目的「还能恢复几天」—— 由 `deletedAt` 派生的**唯一**展示串（C9）。
///
/// 与 [isTrashExpired] 同一口径（自 `deletedAt` 起满 90 天过期）：
/// 第 0 天删除 → 还能恢复 90 天；第 89 天 → 还能恢复 1 天；第 90 天起 → 已过保留期。
/// 刻意写成**纯函数**：天数边界可被确定性测试，界面里不出现第二处除法。
String trashRetentionText(DateTime deletedAt, {DateTime? now}) {
  final DateTime time = now ?? DateTime.now();
  final int days = time.difference(deletedAt).inDays;
  final int left = trashRetentionDays - days;
  if (left <= 0) return '已过保留期';
  return '还能恢复 $left 天';
}

/// 三类配置的软删字段默认值：新建即 `active`、`deletedAt` 为 null —— 修 C9。
///
/// 只作为构造函数的默认值使用，避免三处各写一遍 `'active'`。
const RecordStatus defaultStatus = RecordStatus.active;

import 'habit.dart' show isSameDay, limitTextOf;
import 'point_record.dart';

/// 规则版本 —— **只增不删，永久保留**（`02` §5.3 / §5.6）。
///
/// **修 C10**：原先只有 `addRule` / `removeRule`，家长想改分值只能"删了重建" →
/// `id` 变化 → 历史断裂（且因无 `ruleId`，连断裂都看不出来）。
///
/// 规则被软删时**版本不跟着删**：否则历史流水的 `(ruleId, ruleVersion)` 指向空，
/// "这分按什么规则给的"永远无法回答。
class RuleVersion {
  RuleVersion({
    required this.id,
    required this.ruleId,
    required this.version,
    required this.title,
    required this.condition,
    required this.dailyLimit,
    required this.points,
    required this.changedByRole,
    required this.changedAt,
    this.changeNote = '',
  });

  final String id;
  final String ruleId;

  /// 版本号：新建时为 1，每次 [AppStore.updateRule] **+1**
  final int version;

  final String title;
  final String condition;
  final int dailyLimit;
  final int points;
  final MemberRole changedByRole;
  final DateTime changedAt;

  /// 变更说明（家长回看"为什么改"）
  final String changeNote;

  /// 版本记录自己的展示串（条件 · 频次）—— 与 [ruleDetail] 同一口径
  String get detail => '$condition · ${limitTextOf(dailyLimit)}';
}

/// 改规则对"今天已打卡"的影响提示（`02` §5.5）—— **验收标准，不是可选项**。
///
/// 语义：**历史不可回溯、未来从新规** —— 已发生的流水不动（值 / 含义都不变）；
/// 今日剩余额度**按新规重算**；已得的分不补差、不追扣。
/// 若今日已打卡数 ≥ 新上限，家长**必须**被告知"今天不能再打卡了"，
/// 否则必然产生投诉（改完规则孩子打不了卡，却不知原因）。
///
/// 刻意做成**纯函数**并钉死断言：写在 Widget 里的文案**无法被测试** ——
/// 那正是 E17 的老病（展示串被外部写入、必然与真实状态脱节）。不需要提示时返回 null。
String? ruleChangeNotice({
  required String childName,
  required int checkedCountToday,
  required int newDailyLimit,
}) {
  if (checkedCountToday < newDailyLimit) return null;
  final String name = childName.trim().isEmpty ? '孩子' : childName.trim();
  final String limit = limitTextOf(newDailyLimit);
  return '改动后，$name今天已完成 $checkedCountToday 次，按新规则「$limit」，今天不能再打卡了。';
}

/// 今天某条规则已经产生几次表扬流水 —— 修 C10（配合 §5.5 的额度重算）。
///
/// 与 [checkedCountToday] **同一口径**（同一天 / 表扬类 / 非冲正 / 排除已被冲正的原记录），
/// 只是按 `ruleId` 而不是 `habitId` 匹配 —— 规则可以不在"今天的习惯"里，
/// 但已发生的流水仍然回指着它。
int checkedCountTodayByRule(
  List<PointRecord> records,
  String ruleId, {
  DateTime? now,
}) {
  final DateTime day = now ?? DateTime.now();
  final Set<String?> reversedIds = records
      .where((PointRecord record) => record.reversesRecordId != null)
      .map((PointRecord record) => record.reversesRecordId)
      .toSet();
  return records
      .where(
        (PointRecord record) =>
            record.ruleId == ruleId &&
            record.category == RecordCategory.praise &&
            record.source != RecordSource.correction &&
            !reversedIds.contains(record.id) &&
            isSameDay(record.time, day),
      )
      .length;
}

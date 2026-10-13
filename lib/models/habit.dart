import 'package:flutter/material.dart';

import 'point_record.dart';
import 'trash.dart';

/// 每日次数上限的允许区间 —— 与后端模板校验（`backend/prisma/seed/templates.data.ts`）同口径。
const int dailyLimitMin = 1;
const int dailyLimitMax = 5;

/// 频次是否合法：`dailyLimit` 必须是 1–5 的整数。
bool isDailyLimitValid(int dailyLimit) =>
    dailyLimit >= dailyLimitMin && dailyLimit <= dailyLimitMax;

/// 频次的展示串 —— 修 E17：由 `dailyLimit` 派生，禁止任何地方手工写死。
String limitTextOf(int dailyLimit) =>
    dailyLimit == 1 ? '每天 1 次' : '每天最多 $dailyLimit 次';

/// 今日完成次数的展示串 —— 修 E17。
String doneTextOf(int checkedCountToday) => '今日已完成 $checkedCountToday 次';

/// 两个时间是否同一天（本地时区）—— 与 Taro 侧 `isSameDay()` 同源。
bool isSameDay(DateTime time, [DateTime? other]) {
  final DateTime day = other ?? DateTime.now();
  return time.year == day.year && time.month == day.month && time.day == day.day;
}

/// 一个可以打卡的习惯（首页“今天的习惯”列表项）。
///
/// **修 A2 / A3 / E17**：原先 `limitText` / `doneText` / `checked` 都是**可写字段** ——
/// “每天最多 2 次”因此只是给人看的字符串（系统无法判断今天还能打几次）；
/// `checked` 与“每天最多 N 次”**直接矛盾**（打完 1 次就再也打不了第 2 次，
/// 规则承诺的次数永远不可达）；`doneText` 更是 seed 里手写的 `'今日已完成 1 次'`，
/// 与真实完成次数毫无关系。
///
/// 现在只保留结构字段 `condition` ＋ `dailyLimit`（与 `backend/prisma/schema.prisma`
/// 的 `Habit.condition` / `Habit.dailyLimit` 同构）；
/// 展示串与“是否已完成”一律由 [habitView] 从**当天流水**派生。
/// **修 C9 / C10 追加**：`status` / `deletedAt`（软删除位）与 `ruleId`（“我是由哪条规则
/// 派生的”派生链）。为了改规则时能**原地同步**（`id` 不变 —— 换 id 就等于伪造版本化），
/// `title` / `points` / `condition` / `dailyLimit` 不再是 final。
/// **修 D9 追加**：`icon` 由 `IconData` 改为**名字** `iconName`（与后端
/// `Habit.icon String` 同构）—— 数据层不认字形，只认跨端名字。
class Habit implements SoftDeletable {
  Habit({
    required this.id,
    required this.title,
    required this.points,
    required this.condition,
    required this.dailyLimit,
    required this.iconName,
    required this.color,
    this.ruleId,
    this.status = defaultStatus,
    this.deletedAt,
  });

  @override
  final String id;

  /// 习惯名称，例如“番茄钟写作业”
  @override
  String title;

  /// 完成一次获得的积分
  int points;

  /// 达成条件，例如“专注 25 分钟”
  String condition;

  /// 每天可完成的次数上限（1–5 的整数，可运算、可校验）—— 修 A2
  int dailyLimit;

  /// 图标**名字**（如 `'book'`），不是 `IconData` —— 修 **D9**。
  ///
  /// 与后端 `Habit.icon String`、小程序 `icon: IconName` 同构；
  /// 画到界面前才由 `iconDataFor(iconName)` 查表（`lib/theme/app_icons.dart`）。
  /// 直接存 `IconData` 会让「接 API 不改 UI」变成空话 —— 服务端给的是名字。
  String iconName;
  Color color;

  /// 由哪条规则派生（**规则 id**，不是标题）—— 修 C10
  ///
  /// 按标题匹配是 E15 那类病：规则改个名，派生链就断。手工新建的习惯写 null。
  final String? ruleId;

  /// `active` 才出现在“今天的习惯”里；`deleted` 进回收站 —— 修 C9
  @override
  RecordStatus status;

  /// 进入回收站的时间（`active` 时为 null）—— 修 C9
  @override
  DateTime? deletedAt;

  /// 审计快照的**结构字段**（由 `auditSnapshotOf` 深拷贝）—— 修 C11
  @override
  @override
  Map<String, Object?> snapshot() => <String, Object?>{
        'id': id,
        'title': title,
        'points': points,
        'condition': condition,
        'dailyLimit': dailyLimit,
        'ruleId': ruleId,
        'status': status.name,
        'deletedAt': deletedAt,
      };
}

/// 今天这个习惯已经完成几次 —— 修 A3。
///
/// 由**当天流水**统计，不存字段：布尔量根本无法表达“每天最多 2 次”。
/// 必须排除四类记录，缺一条派生态就会撒谎：
///   1. 非本习惯（按 `habitId` 唯一匹配，不是 title）；
///   2. 非表扬类（兑换 / 调整流水不算完成习惯）；
///   3. [RecordSource.correction] —— 冲正记录本身不是一次完成；
///   4. **已被冲正的原记录** —— 撤销后它仍留在账上（账本不可变），但不应再计入今日完成。
/// 第 4 条是 `03` §A3 公式里漏掉的（原文只写了“source≠correction”）：
/// 漏掉它 → **撤销打卡后界面仍显示“已打卡”**，撤销看起来没生效。
int checkedCountToday(
  List<PointRecord> records,
  String habitId, {
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
            record.habitId == habitId &&
            record.category == RecordCategory.praise &&
            record.source != RecordSource.correction &&
            !reversedIds.contains(record.id) &&
            isSameDay(record.time, day),
      )
      .length;
}

/// 习惯的**派生视图**：首页渲染与打卡判定都消费它。
///
/// 它是 E17 的落点 —— 页面拿不到任何“可被写入的展示串”，
/// 想改文案只能改派生函数（一处改、两端同步）。
class HabitView {
  HabitView(this.habit, this.checkedCountToday);

  final Habit habit;

  /// 今天已完成次数（由当天流水数出）
  final int checkedCountToday;

  String get id => habit.id;
  String get title => habit.title;
  int get points => habit.points;
  String get condition => habit.condition;
  int get dailyLimit => habit.dailyLimit;
  /// 图标**名字**（修 D9）—— 与 Taro 侧 `habitView().icon` 同名同义
  String get iconName => habit.iconName;
  Color get color => habit.color;

  /// 由 `dailyLimit` 派生的频次串
  String get limitText => limitTextOf(habit.dailyLimit);

  /// 由 `checkedCountToday` 派生的完成串
  String get doneText => doneTextOf(checkedCountToday);

  /// 是否已达今日上限 —— 修 A3
  bool get checked => checkedCountToday >= habit.dailyLimit;

  String get subtitle =>
      checked ? '$condition · $doneText' : '$condition · $limitText';

  String get amountText => '+$points';
}

/// 由结构字段 ＋ 当天流水派生习惯视图 —— 修 A2 / A3 / E17。
HabitView habitView(Habit habit, List<PointRecord> records, {DateTime? now}) =>
    HabitView(habit, checkedCountToday(records, habit.id, now: now));


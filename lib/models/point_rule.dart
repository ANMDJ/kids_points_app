import 'package:flutter/material.dart';

import 'habit.dart';
import 'trash.dart';

/// 积分规则：家长约定“做到什么 → 得多少分”。
///
/// **修 E15**：原先只有一个 `detail: String` —— 结构化信息（条件 / 频次）被塞进
/// 面向人的展示串，再靠 `detail.split(' · ')` **反解析**回来：多一段就丢一段
/// （`'连续 3 天 · 每天 1 次 · 需要家长确认'` 的第三段消失），没有分隔符就静默落到
/// 默认值 `'每天 1 次'`（与家长意图无关）。
///
/// 现在 `condition` / `dailyLimit` 是结构字段，[ruleDetail] 只负责拼展示串。
/// **修 C9 / C10 追加**：`currentVersion`（版本号，改规则时 +1）、
/// `status` / `deletedAt`（软删除位）。为了让 `updateRule` 能**原地**改规则
/// （`id` 保持不变，历史流水才能继续指得到它），结构字段不再是 final。
class PointRule implements SoftDeletable {
  PointRule({
    required this.id,
    required this.title,
    required this.condition,
    required this.dailyLimit,
    required this.points,
    required this.icon,
    required this.color,
    this.currentVersion = 1,
    this.status = defaultStatus,
    this.deletedAt,
  });

  @override
  final String id;

  @override
  String title;

  /// 达成条件，例如“专注 25 分钟”
  String condition;

  /// 每天可完成的次数上限（1–5 的整数）—— 修 A2
  int dailyLimit;

  /// 分值，可为负数（扣分规则）
  int points;

  IconData icon;
  Color color;

  /// 当前版本号：新建为 1，每次改规则 **+1** —— 修 C10
  int currentVersion;

  /// `active` 才出现在规则页；`deleted` 进回收站 —— 修 C9
  @override
  RecordStatus status;

  /// 进入回收站的时间（`active` 时为 null）—— 修 C9
  @override
  DateTime? deletedAt;

  bool get isGain => points >= 0;

  String get amountText => isGain ? '+$points' : '$points';

  /// 审计快照的**结构字段**（由 `auditSnapshotOf` 深拷贝）—— 修 C11
  @override
  Map<String, Object?> snapshot() => <String, Object?>{
        'id': id,
        'title': title,
        'condition': condition,
        'dailyLimit': dailyLimit,
        'points': points,
        'currentVersion': currentVersion,
        'status': status.name,
        'deletedAt': deletedAt,
      };
}

/// 规则的展示串 —— 修 E15：由结构字段拼出，不再存在自由的 `detail` 字符串。
String ruleDetail(PointRule rule) =>
    '${rule.condition} · ${limitTextOf(rule.dailyLimit)}';


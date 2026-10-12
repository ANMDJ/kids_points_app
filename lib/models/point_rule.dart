import 'package:flutter/material.dart';

import 'habit.dart';

/// 积分规则：家长约定“做到什么 → 得多少分”。
///
/// **修 E15**：原先只有一个 `detail: String` —— 结构化信息（条件 / 频次）被塞进
/// 面向人的展示串，再靠 `detail.split(' · ')` **反解析**回来：多一段就丢一段
/// （`'连续 3 天 · 每天 1 次 · 需要家长确认'` 的第三段消失），没有分隔符就静默落到
/// 默认值 `'每天 1 次'`（与家长意图无关）。
///
/// 现在 `condition` / `dailyLimit` 是结构字段，[ruleDetail] 只负责拼展示串。
class PointRule {
  PointRule({
    required this.id,
    required this.title,
    required this.condition,
    required this.dailyLimit,
    required this.points,
    required this.icon,
    required this.color,
  });

  final String id;
  final String title;

  /// 达成条件，例如“专注 25 分钟”
  final String condition;

  /// 每天可完成的次数上限（1–5 的整数）—— 修 A2
  final int dailyLimit;

  /// 分值，可为负数（扣分规则）
  final int points;

  final IconData icon;
  final Color color;

  bool get isGain => points >= 0;

  String get amountText => isGain ? '+$points' : '$points';
}

/// 规则的展示串 —— 修 E15：由结构字段拼出，不再存在自由的 `detail` 字符串。
String ruleDetail(PointRule rule) =>
    '${rule.condition} · ${limitTextOf(rule.dailyLimit)}';


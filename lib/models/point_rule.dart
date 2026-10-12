import 'package:flutter/material.dart';

/// 积分规则：家长约定“做到什么 → 得多少分”。
class PointRule {
  PointRule({
    required this.id,
    required this.title,
    required this.detail,
    required this.points,
    required this.icon,
    required this.color,
  });

  final String id;
  final String title;

  /// 例如“专注 25 分钟 · 每天最多 2 次”
  final String detail;

  /// 分值，可为负数（扣分规则）
  final int points;

  final IconData icon;
  final Color color;

  bool get isGain => points >= 0;

  String get amountText => isGain ? '+$points' : '$points';
}

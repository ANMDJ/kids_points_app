import 'package:flutter/material.dart';

/// 一个可以打卡的习惯（首页“今天的习惯”列表项）。
class Habit {
  Habit({
    required this.id,
    required this.title,
    required this.points,
    required this.condition,
    required this.limitText,
    this.doneText = '已完成',
    required this.icon,
    required this.color,
    this.checked = false,
  });

  final String id;

  /// 习惯名称，例如“番茄钟写作业”
  final String title;

  /// 完成一次获得的积分
  final int points;

  /// 达成条件，例如“专注 25 分钟”
  final String condition;

  /// 频次限制，例如“每天最多 2 次”
  final String limitText;

  /// 今日完成后的文案，例如“今日已完成 1 次”
  final String doneText;

  final IconData icon;
  final Color color;

  /// 今天是否已打卡（当前为内存态，同一会话内保持）
  bool checked;

  String get subtitle =>
      checked ? '$condition · $doneText' : '$condition · $limitText';

  String get amountText => '+$points';
}

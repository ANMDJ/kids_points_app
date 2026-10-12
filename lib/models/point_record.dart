import 'package:flutter/material.dart';

/// 积分记录的来源分类，对应记录页顶部的筛选标签。
enum RecordCategory { praise, exchange, adjust }

extension RecordCategoryLabel on RecordCategory {
  String get label {
    switch (this) {
      case RecordCategory.praise:
        return '表扬';
      case RecordCategory.exchange:
        return '兑换';
      case RecordCategory.adjust:
        return '调整';
    }
  }
}

/// 成员角色。对应后端 ChildMember.role（见 docs/design/02）。
enum MemberRole { guardian, child }

/// 积分记录的**操作来源**。
///
/// 修复 A4：原先所有流水都硬编码成“家长记录”，孩子自己打卡也写“家长记录”，
/// 流水在撒谎、责任链断裂。改为记录真实来源，subtitle 由其派生（见 E19）。
enum RecordSource { childSelf, guardian, agent, approval, system, correction }

/// 操作来源的展示文案（修 A4）。
const Map<RecordSource, String> recordSourceLabels = <RecordSource, String>{
  RecordSource.childSelf: '自己完成',
  RecordSource.guardian: '家长记录',
  RecordSource.agent: '积分小助手',
  RecordSource.approval: '家长审批通过',
  RecordSource.system: '系统',
  RecordSource.correction: '撤销',
};

/// 操作上下文：谁在操作。W2 起由服务端 ChildMember 提供。
class ActorContext {
  const ActorContext({this.role = MemberRole.guardian});

  final MemberRole role;
}

String _clockText(DateTime time) =>
    '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';

/// 由**结构化字段**派生 `subtitle` —— 修 A4 / E19。
///
/// 禁止在写入处手工拼接文案：那正是 A4“流水撒谎”的成因
/// （无论谁操作都写死“家长记录”）。所有写入方必须经由本函数。
String recordSubtitle({
  required DateTime time,
  required RecordSource source,
  RecordCategory? category,
  String note = '',
}) {
  final String head = category == RecordCategory.exchange
      ? '兑换奖励'
      : recordSourceLabels[source]!;
  final List<String> parts = <String>[_clockText(time), head];
  final String trimmed = note.trim();
  if (trimmed.isNotEmpty) parts.add(trimmed);
  return parts.join(' · ');
}

/// 一条积分流水（账本条目）。
///
/// **不可变原则**：流水一经写入不得修改或删除，撤销用**冲正**（`reversesRecordId`）。
/// 详见 docs/design/02 §5 与 docs/design/03 的 B6 / B7。
class PointRecord {
  PointRecord({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.points,
    required this.time,
    required this.category,
    required this.icon,
    required this.color,
    required this.source,
    required this.operatorRole,
    this.note = '',
    this.habitId,
    this.ruleId,
    this.wishId,
    this.reversesRecordId,
    required this.balanceAfter,
  });

  final String id;

  /// 当时标题的**完整快照**（不截断；截断只发生在渲染层）—— 修 B8
  final String title;

  /// 派生自 source + time + note，禁止手工拼接 —— 修 A4 / E19
  final String subtitle;

  /// 正数为加分，负数为扣分
  final int points;

  final DateTime time;
  final RecordCategory category;
  final IconData icon;
  final Color color;

  // ───────────────────────── 账本可追溯性（A4 / B6 / B7 / B8）
  /// 操作来源，决定 subtitle 文案与统计口径 —— 修 A4
  final RecordSource source;

  /// **真实操作人角色**（system / correction 时为 null）—— 修 A4
  final MemberRole? operatorRole;

  /// 补充说明，作为 subtitle 的**附加段**而非替换来源 —— 修 E19
  final String note;

  /// 回指习惯（用唯一 id 匹配，修掉按 title 匹配导致的同名误删）—— 修 B7
  final String? habitId;

  /// 回指的积分规则 id（W0 起配合 ruleVersion 定位 PointRuleVersion）
  final String? ruleId;

  /// 回指的心愿 id（心愿删除后仍能解释这笔扣分）—— 修 B8
  final String? wishId;

  /// 冲正：指向被冲正的记录 id —— 修 B7
  final String? reversesRecordId;

  /// **记完之后的余额**，账本对账基准 —— 修 B6
  final int balanceAfter;

  bool get isGain => points >= 0;

  String get amountText => isGain ? '+$points' : '$points';

  /// HH:mm
  String get timeText => _clockText(time);
}

import 'package:flutter/material.dart';

import '../models/habit.dart';
import '../models/point_record.dart';
import '../models/point_rule.dart';
import '../models/wish.dart';
import '../theme/app_colors.dart';
import '../theme/app_icons.dart';
import 'read_api_errors.dart';
import 'read_dto.dart';

/// 首页快照的**本地形态**：把线上 DTO 映射成 UI 已经在用的模型。
///
/// 为什么要这一层：页面（`HomeScreen` 等）现在消费的是 `Habit` / `PointRule` /
/// `Wish` / `PointRecord`。若让页面直接读 DTO，服务端字段一改就得改 UI；
/// 反过来，映射出错时错误也只会在这里**显式**抛出，不会变成界面上的空列表。
class HomeSnapshot {
  const HomeSnapshot({
    required this.childId,
    required this.childName,
    required this.pointsBalance,
    required this.goodHabitCount,
    required this.rewardCount,
    required this.habits,
    required this.rules,
    required this.wishes,
  });

  final String childId;
  final String childName;
  final int pointsBalance;
  final int goodHabitCount;
  final int rewardCount;
  final List<Habit> habits;
  final List<PointRule> rules;
  final List<Wish> wishes;
}

/// 一页流水 + 下一页游标。`nextCursor == null` ⇔ 没有更多。
class RecordsPage {
  const RecordsPage({
    required this.records,
    required this.limit,
    required this.hasMore,
    required this.nextCursor,
  });

  final List<PointRecord> records;
  final int limit;
  final bool hasMore;
  final String? nextCursor;
}

/// 线格式 → 本地模型。任何无法解释的枚举 / 颜色都抛 malformed，
/// 不做「猜一个默认值」—— 猜错会显示成一条看似正常的错误流水。
HomeSnapshot mapHome(HomeDto dto) {
  return HomeSnapshot(
    childId: dto.childId,
    childName: dto.childName,
    pointsBalance: dto.pointsBalance,
    goodHabitCount: dto.goodHabitCount,
    rewardCount: dto.rewardCount,
    habits: dto.habits
        .asMap()
        .entries
        .map((MapEntry<int, HabitDto> entry) =>
            mapHabit(entry.value, 'habits[${entry.key}]'))
        .toList(growable: false),
    rules: dto.rules
        .asMap()
        .entries
        .map((MapEntry<int, RuleDto> entry) =>
            mapRule(entry.value, 'rules[${entry.key}]'))
        .toList(growable: false),
    wishes: dto.wishes
        .asMap()
        .entries
        .map((MapEntry<int, WishDto> entry) =>
            _mapWish(entry.value, 'wishes[${entry.key}]'))
        .toList(growable: false),
  );
}

RecordsPage mapRecordsPage(RecordsPageDto dto) {
  return RecordsPage(
    records: dto.records
        .asMap()
        .entries
        .map((MapEntry<int, RecordDto> entry) =>
            mapRecord(entry.value, 'records[${entry.key}]'))
        .toList(growable: false),
    limit: dto.limit,
    hasMore: dto.hasMore,
    nextCursor: dto.nextCursor,
  );
}

/// 单条习惯 DTO → UI 模型（写端点回包也走这里，避免两套字段解释）。
Habit mapHabit(HabitDto dto, String path) {
  return Habit(
    id: dto.id,
    title: dto.title,
    points: dto.points,
    condition: dto.condition,
    dailyLimit: dto.dailyLimit,
    iconName: dto.icon,
    color: parseHexColor(dto.color, '$path.color'),
    ruleId: dto.ruleId,
  );
}

/// 单条规则 DTO → UI 模型（写端点回包也走这里）。
///
/// `direction` 只用来**校验**：DTO 的 `points` 已经带符号，这里不再取反。
PointRule mapRule(RuleDto dto, String path) {
  if (dto.direction != 'reward' && dto.direction != 'penalty') {
    throw ReadApiException.malformed(
      '$path.direction',
      detail: '未知规则方向：${dto.direction}',
    );
  }
  return PointRule(
    id: dto.id,
    title: dto.title,
    condition: dto.condition,
    dailyLimit: dto.dailyLimit,
    points: dto.points,
    iconName: dto.icon,
    color: parseHexColor(dto.color, '$path.color'),
    currentVersion: dto.currentVersion,
  );
}

Wish _mapWish(WishDto dto, String path) {
  return Wish(
    id: dto.id,
    title: dto.title,
    cost: dto.cost,
    emoji: dto.emoji,
    coverStyle: parseCoverStyle(dto.coverStyle, '$path.coverStyle'),
    redeemed: dto.redeemed,
  );
}

/// 单条线格式流水 → 本地模型。写端点返回的记录与 `GET /records` 同构，
/// 因此复用同一函数（避免“读取一条口径、写入另一条口径”）。
PointRecord mapRecord(RecordDto dto, [String path = 'record']) {
  final RecordCategory category = parseCategory(dto.category, '$path.category');
  final RecordSource source = parseSource(dto.source, '$path.source');
  final DateTime time = dto.createdAt.toLocal();
  final RecordIcon style = recordIconOf(category, source, dto.points);

  return PointRecord(
    id: dto.id,
    title: dto.title,
    subtitle: recordSubtitle(
      time: time,
      source: source,
      category: category,
      note: dto.note,
    ),
    points: dto.points,
    time: time,
    category: category,
    iconName: style.iconName,
    color: style.color,
    source: source,
    operatorRole: parseOperatorRole(dto.operatorRole, '$path.operatorRole'),
    note: dto.note,
    habitId: dto.habitId,
    ruleId: dto.ruleId,
    ruleVersion: dto.ruleVersion,
    wishId: dto.wishId,
    reversesRecordId: dto.reversesRecordId,
    balanceAfter: dto.balanceAfter,
  );
}

// ───────────────────────────── 线格式枚举 → 本地枚举 ─────────────────────────────

RecordCategory parseCategory(String raw, String path) {
  switch (raw) {
    case 'praise':
      return RecordCategory.praise;
    case 'exchange':
      return RecordCategory.exchange;
    case 'adjust':
      return RecordCategory.adjust;
  }
  throw ReadApiException.malformed(path, detail: '未知流水分类：$raw');
}

RecordSource parseSource(String raw, String path) {
  switch (raw) {
    case 'child_self':
      return RecordSource.childSelf;
    case 'guardian':
      return RecordSource.guardian;
    case 'agent':
      return RecordSource.agent;
    case 'approval':
      return RecordSource.approval;
    case 'system':
      return RecordSource.system;
    case 'correction':
      return RecordSource.correction;
  }
  throw ReadApiException.malformed(path, detail: '未知流水来源：$raw');
}

/// `null` = 系统 / 冲正记录，没有「操作人角色」。
MemberRole? parseOperatorRole(String? raw, String path) {
  if (raw == null) return null;
  switch (raw) {
    case 'guardian':
      return MemberRole.guardian;
    case 'child':
      return MemberRole.child;
    case 'viewer':
      return MemberRole.viewer;
  }
  throw ReadApiException.malformed(path, detail: '未知操作人角色：$raw');
}

WishCoverStyle parseCoverStyle(String raw, String path) {
  switch (raw.toUpperCase()) {
    case 'A':
      return WishCoverStyle.a;
    case 'B':
      return WishCoverStyle.b;
    case 'C':
      return WishCoverStyle.c;
    case 'D':
      return WishCoverStyle.d;
  }
  throw ReadApiException.malformed(path, detail: '未知心愿配色：$raw');
}

/// `#RRGGBB` → Color。只接受这一种写法：后端 `seed` / 写入口都按它存。
Color parseHexColor(String raw, String path) {
  final RegExpMatch? match =
      RegExp(r'^#([0-9a-fA-F]{6})$').firstMatch(raw.trim());
  if (match == null) {
    throw ReadApiException.malformed(path, detail: '颜色必须是 #RRGGBB：$raw');
  }
  return Color(0xFF000000 | int.parse(match.group(1)!, radix: 16));
}

/// `Color` → `#RRGGBB`（写入口只接受这一种写法）。
///
/// alpha 一律丢弃：规则 / 习惯的颜色本来就是不透明的，带上 `#AARRGGBB`
/// 只会被后端 400 拒掉。输出与 seed 数据同口径（小写）。
String hexColorOf(Color color) =>
    '#${(color.toARGB32() & 0xFFFFFF).toRadixString(16).padLeft(6, '0')}';

// ───────────────────────────── 流水的图标 / 颜色 ─────────────────────────────

class RecordIcon {
  const RecordIcon(this.iconName, this.color);

  final String iconName;
  final Color color;
}

/// 流水没有 `icon` / `color` 字段（账本是结构数据），图标由
/// **(category, source, 正负)** 派生 —— 与 seed 的观感一致，且只有这一处规则。
RecordIcon recordIconOf(
    RecordCategory category, RecordSource source, int points) {
  if (category == RecordCategory.exchange) {
    return const RecordIcon(IconNames.gift, AppColors.orange);
  }
  if (source == RecordSource.correction) {
    return const RecordIcon(IconNames.close, AppColors.pointSpend);
  }
  if (category == RecordCategory.adjust) {
    return points >= 0
        ? const RecordIcon(IconNames.plus, AppColors.pointGain)
        : const RecordIcon(IconNames.minus, AppColors.pointSpend);
  }
  if (source == RecordSource.childSelf) {
    return const RecordIcon(IconNames.check, AppColors.pointGain);
  }
  return const RecordIcon(IconNames.starFill, AppColors.starYellow);
}

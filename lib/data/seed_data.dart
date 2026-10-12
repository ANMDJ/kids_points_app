import 'package:flutter/material.dart';

import '../models/child_profile.dart';
import '../models/habit.dart';
import '../models/point_record.dart';
import '../models/point_rule.dart';
import '../models/wish.dart';
import '../theme/app_colors.dart';

/// 首次启动的演示数据，数值与设计稿一致（124 积分、324 好习惯、4 次奖励）。
class SeedBundle {
  SeedBundle({
    required this.points,
    required this.profile,
    required this.habits,
    required this.wishes,
    required this.records,
    required this.rules,
  });

  final int points;
  final ChildProfile profile;
  final List<Habit> habits;
  final List<Wish> wishes;
  final List<PointRecord> records;
  final List<PointRule> rules;
}

SeedBundle buildSeedData() {
  final DateTime now = DateTime.now();
  final DateTime today1930 = DateTime(now.year, now.month, now.day, 19, 30);
  final DateTime today1850 = DateTime(now.year, now.month, now.day, 18, 50);
  final DateTime yesterday2000 = DateTime(now.year, now.month, now.day, 20, 0)
      .subtract(const Duration(days: 1));
  final DateTime yesterday1910 = DateTime(now.year, now.month, now.day, 19, 10)
      .subtract(const Duration(days: 1));

  // 修 A2 / A3 / E17：这里只写**结构字段**，limitText / doneText / checked 全部删除。
  // 「今天完成几次」由 records 派生（habit.dart 的 habitView）：
  // 番茄钟 1/2（还能再打一次）、收书包 1/1（已达上限）、自主阅读 0/1（还没打）。
  final List<Habit> habits = <Habit>[
    Habit(
      id: 'habit-pomodoro',
      title: '番茄钟写作业',
      points: 1,
      condition: '专注 25 分钟',
      dailyLimit: 2,
      icon: Icons.menu_book_rounded,
      color: AppColors.primaryDeep,
    ),
    Habit(
      id: 'habit-backpack',
      title: '自己收书包',
      points: 2,
      condition: '睡前整理好',
      dailyLimit: 1,
      icon: Icons.luggage_rounded,
      color: AppColors.orange,
    ),
    Habit(
      id: 'habit-reading',
      title: '自主阅读',
      points: 2,
      condition: '阅读 20 分钟',
      dailyLimit: 1,
      icon: Icons.auto_stories_rounded,
      color: const Color(0xFF7BB0E8),
    ),
  ];

  final List<Wish> wishes = <Wish>[
    Wish(
      id: 'wish-1',
      title: '限定商品 30 元优惠券（满 300 减 100）',
      cost: 40,
      emoji: '🍖',
      backgroundIndex: 0,
    ),
    Wish(
      id: 'wish-2',
      title: '汪汪零食大礼包 · 周末加餐',
      cost: 40,
      emoji: '🐶',
      backgroundIndex: 1,
    ),
    Wish(
      id: 'wish-3',
      title: '一起去游乐园玩一整天（亲子票）',
      cost: 445,
      emoji: '🎡',
      backgroundIndex: 2,
    ),
    Wish(
      id: 'wish-4',
      title: '新款积木套装（1000+ 颗粒）',
      cost: 445,
      emoji: '🧩',
      backgroundIndex: 3,
    ),
  ];

  final List<PointRecord> records = <PointRecord>[
    PointRecord(
      id: 'rec-1',
      title: '番茄钟写作业',
      subtitle: recordSubtitle(
        time: today1930,
        source: RecordSource.childSelf,
      ),
      points: 1,
      time: today1930,
      category: RecordCategory.praise,
      icon: Icons.menu_book_rounded,
      color: AppColors.primaryDeep,
      source: RecordSource.childSelf,
      operatorRole: MemberRole.child,
      habitId: 'habit-pomodoro',
      ruleId: 'rule-1',
      balanceAfter: 124,
    ),
    PointRecord(
      id: 'rec-2',
      title: '自己收书包',
      subtitle: recordSubtitle(
        time: today1850,
        source: RecordSource.childSelf,
      ),
      points: 2,
      time: today1850,
      category: RecordCategory.praise,
      icon: Icons.luggage_rounded,
      color: AppColors.orange,
      source: RecordSource.childSelf,
      operatorRole: MemberRole.child,
      habitId: 'habit-backpack',
      ruleId: 'rule-2',
      balanceAfter: 123,
    ),
    PointRecord(
      id: 'rec-3',
      title: '围棋课后作业',
      subtitle: recordSubtitle(
        time: yesterday2000,
        source: RecordSource.guardian,
      ),
      points: 5,
      time: yesterday2000,
      category: RecordCategory.praise,
      icon: Icons.assignment_rounded,
      color: const Color(0xFF8FBF6A),
      source: RecordSource.guardian,
      operatorRole: MemberRole.guardian,
      ruleId: 'rule-3',
      balanceAfter: 121,
    ),
    PointRecord(
      id: 'rec-4',
      title: '兑换：小饼干',
      subtitle: recordSubtitle(
        time: yesterday1910,
        source: RecordSource.guardian,
        category: RecordCategory.exchange,
      ),
      points: -30,
      time: yesterday1910,
      category: RecordCategory.exchange,
      icon: Icons.redeem_rounded,
      color: AppColors.orange,
      source: RecordSource.guardian,
      operatorRole: MemberRole.guardian,
      balanceAfter: 116,
    ),
  ];

  // 修 E15：规则同样只存 condition ＋ dailyLimit（detail 由 ruleDetail 派生）。
  // ⚠️ 语义变更（**必须留档**）：rule-3 原为「完成并检查 · 每周 1 次」——
  // 权威 schema（backend/prisma/schema.prisma 的 PointRule/RuleTemplate）只有 dailyLimit，
  // **没有周期字段**，后端模板库同样把周意涵放在标题/条件里（如「周末大扫除」也是 dailyLimit=1）。
  // 因此这里改为 dailyLimit: 1，派生出来的展示串是「完成并检查 · 每天 1 次」——
  // 「每周」不再被表达，不是漏改，是当前模型表达不了（见 docs/design/03 §E15）。
  final List<PointRule> rules = <PointRule>[
    PointRule(
      id: 'rule-1',
      title: '番茄钟写作业',
      condition: '专注 25 分钟',
      dailyLimit: 2,
      points: 1,
      icon: Icons.menu_book_rounded,
      color: AppColors.starYellow,
    ),
    PointRule(
      id: 'rule-2',
      title: '自己收书包',
      condition: '睡前整理好',
      dailyLimit: 1,
      points: 2,
      icon: Icons.luggage_rounded,
      color: AppColors.pointSpend,
    ),
    PointRule(
      id: 'rule-3',
      title: '围棋课后作业',
      condition: '完成并检查',
      dailyLimit: 1,
      points: 5,
      icon: Icons.assignment_rounded,
      color: AppColors.primaryDeep,
    ),
    PointRule(
      id: 'rule-4',
      title: '自主阅读',
      condition: '阅读 20 分钟',
      dailyLimit: 1,
      points: 2,
      icon: Icons.auto_stories_rounded,
      color: AppColors.primaryDeep,
    ),
  ];

  return SeedBundle(
    points: 124,
    profile: ChildProfile(
      name: '萌新铲屎官的小可爱',
      childId: '38038532',
      goodHabitCount: 324,
      rewardCount: 4,
    ),
    habits: habits,
    wishes: wishes,
    records: records,
    rules: rules,
  );
}

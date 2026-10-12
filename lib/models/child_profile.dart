/// 孩子档案，对应“我的”页顶部信息与战绩。
class ChildProfile {
  ChildProfile({
    required this.name,
    required this.childId,
    required this.goodHabitCount,
    required this.rewardCount,
  });

  String name;
  final String childId;

  /// 累计达成的好习惯次数
  int goodHabitCount;

  /// 累计奖励（兑换）次数
  int rewardCount;
}

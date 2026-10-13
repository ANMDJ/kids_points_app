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

  /// 审计快照的**结构字段**（由 `auditSnapshotOf` 深拷贝）—— 修 C11
  ///
  /// 成员改名要能回答“改之前是什么”，因此档案也必须可快照。
  Map<String, Object?> snapshot() => <String, Object?>{
        'name': name,
        'childId': childId,
        'goodHabitCount': goodHabitCount,
        'rewardCount': rewardCount,
      };
}

/// 删除请求的状态（与后端 `FamilyDeletionStatus` 一一对应）。
///
/// ★ 这里**没有** `unknown`：未知线值由 DTO 抛 `malformed`，不会悄悄落成
///   `none`（那会把「后端新增了状态」显示成「从未申请删除」）。
enum FamilyDeletionStatus { none, pending, cancelled, executed }

/// 家庭数据删除的状态（`GET /family-deletion`，W7-D）。
///
/// ── 它回答的三个问题 ────────────────────────────────────────────────────────
///   ① **有没有一个待执行的删除**（[FamilyDeletionStatus.pending]）、还剩几天；
///   ② **能不能反悔**（[FamilyDeletion.canCancel]）—— 只有 pending 能撤销；
///   ③ **删完了到底发生了什么**（[summary]）—— 哪些字被抹掉、账本保留了多少。
///
/// ── 为什么把「已撤销」也当成一种状态 ────────────────────────────────────────
///   `cancelled` ≠ `none`：它说明「这个家庭申请过删除，又反悔了」。界面要能
///   回答「我上次是不是点过」，而不是把历史擦掉 —— 擦掉历史会让家长以为
///   自己记错了。同理，`executed` 的摘要**原样回放**，不在客户端重算。
class FamilyDeletion {
  const FamilyDeletion({
    required this.childId,
    required this.status,
    required this.requestedAt,
    required this.scheduledFor,
    required this.cancelledAt,
    required this.executedAt,
    required this.daysRemaining,
    required this.canCancel,
    required this.summary,
  });

  /// 冷却期天数 —— 与后端 `FAMILY_DELETION_COOLING_DAYS` 同口径。
  ///
  /// 只用于文案（「有 7 天可以反悔」），**不参与倒计时计算**：剩余天数由服务端
  /// 下发（`daysRemaining`），客户端不用本地时钟去猜 —— 设备时间可能不准。
  static const int coolingDays = 7;

  final String childId;
  final FamilyDeletionStatus status;

  final DateTime? requestedAt;
  final DateTime? scheduledFor;
  final DateTime? cancelledAt;
  final DateTime? executedAt;

  /// 距执行还有几天（服务端向上取整）；非 pending 时为 null。
  final int? daysRemaining;

  /// 现在还能不能撤销（= 状态为 pending）。
  final bool canCancel;

  /// 执行摘要（仅 executed）。
  final FamilyDeletionSummary? summary;

  String get statusLabel {
    switch (status) {
      case FamilyDeletionStatus.none:
        return '未申请删除';
      case FamilyDeletionStatus.pending:
        return '已申请删除';
      case FamilyDeletionStatus.cancelled:
        return '已撤销';
      case FamilyDeletionStatus.executed:
        return '已删除';
    }
  }

  /// 「将于 2026-11-03 删除」/「已于 2026-11-03 删除」。
  String get deadlineText {
    final DateTime? at = status == FamilyDeletionStatus.executed
        ? executedAt
        : scheduledFor;
    if (at == null) return '—';
    final DateTime local = at.toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    final String day =
        '${local.year}-${two(local.month)}-${two(local.day)}';
    return status == FamilyDeletionStatus.executed ? '已于 $day 删除' : '将于 $day 删除';
  }

  /// 剩余天数的中文说法（不读本地时钟）。
  String get remainingText {
    final int? days = daysRemaining;
    if (status != FamilyDeletionStatus.pending || days == null) return '—';
    if (days <= 0) return '即将执行（等待后台任务）';
    return '还有 $days 天可以撤销';
  }
}

/// 执行摘要（后端原样落库、原样下发）。
///
/// ★ 字段名与后端 `FamilyDeletionSummary` 一一对应；**不在客户端补零**：
///   后端说 0 就是 0，缺字段是契约问题（DTO 解析会抛 `malformed`）。
class FamilyDeletionSummary {
  const FamilyDeletionSummary({
    required this.coolingDays,
    required this.redacted,
    required this.keptRecords,
    required this.keptPointsBalance,
    required this.note,
  });

  final int coolingDays;

  /// 表名 → 被匿名化的行数（键集合固定，见 [redactedLabels]）。
  final Map<String, int> redacted;

  /// 保留的流水条数（账本 append-only，不抹数值）。
  final int keptRecords;

  /// 保留的余额。
  final int keptPointsBalance;

  /// 服务端说明（原样显示，不在客户端改写）。
  final String note;

  /// 段名 → 中文标签；顺序即面板显示顺序。
  static const Map<String, String> redactedLabels = <String, String>{
    'child': '孩子档案',
    'members': '家庭成员',
    'rules': '积分规则',
    'ruleVersions': '规则版本',
    'habits': '好习惯',
    'wishes': '心愿',
    'records': '流水里的文字',
    'approvals': '审批里的文字',
    'consents': '同意记录的 IP / UA',
    'notifications': '站内通知',
  };

  /// 只显示**真的动过**的行（0 行不占位置），但保留固定顺序。
  /// 若全都为 0，返回空列表 —— 界面据此说「没有可匿名化的内容」，
  /// 而不是画一排 0。
  List<MapEntry<String, int>> get changedRows {
    final List<MapEntry<String, int>> rows = <MapEntry<String, int>>[];
    for (final String key in redactedLabels.keys) {
      final int? value = redacted[key];
      if (value != null && value > 0) {
        rows.add(MapEntry<String, int>(key, value));
      }
    }
    return rows;
  }

  String labelFor(String key) => redactedLabels[key] ?? key;

  /// 「保留 4 条流水与余额 7 分」。
  String get keptText => '保留 $keptRecords 条流水与余额 $keptPointsBalance 分';
}

/// 线值 → 枚举。未知值返回 null（由 DTO 抛 `malformed`，调用方不猜）。
FamilyDeletionStatus? familyDeletionStatusFromWire(String value) {
  switch (value) {
    case 'none':
      return FamilyDeletionStatus.none;
    case 'pending':
      return FamilyDeletionStatus.pending;
    case 'cancelled':
      return FamilyDeletionStatus.cancelled;
    case 'executed':
      return FamilyDeletionStatus.executed;
  }
  return null;
}

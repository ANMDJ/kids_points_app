/// 家长审批收件箱（W5-D）的本地模型。
///
/// ── 为什么单独一个文件 ──────────────────────────────────────────────────────
///   `read_dto.dart` 只负责「线格式像不像」，本文件负责「怎么讲给用户听」：
///   状态名、剩余有效期、这一条现在能不能批。文案只有这一份 —— 页面不许
///   自己拼「待处理 / 已批准」之类的字符串，否则两端（Flutter / 小程序）
///   迟早会对同一个状态说两种话。
///
/// ── 为什么 `status` 不收成枚举 ──────────────────────────────────────────────
///   与 `ApprovalDto` 同一口径：后端将来加状态时，客户端要能**如实**显示
///   「状态未知（xxx）」并禁用操作，而不是在解析层崩掉（那时连提示都给不出）。
library;

/// 审批 payload 的结构化摘要（服务端 `summary`）。
///
/// ★ 服务端**不**下发展示串（`02` §4.3 / W5-D 的 `approval-inbox.mapper.ts`）：
///   文案要随客户端语言 / 排版变化，塞进响应就会两端口径漂移。
sealed class ApprovalSummary {
  const ApprovalSummary();

  /// 一行标题，例如「兑换心愿」。
  String get headline;

  /// 具体内容，例如「「乐高」 · 100 分」。
  String get detail;
}

/// 兑换 / 申请兑换：`{ kind: 'redeem', wishId, title, cost }`。
final class RedeemSummary extends ApprovalSummary {
  const RedeemSummary({
    required this.wishId,
    required this.title,
    required this.cost,
  });

  final String wishId;

  /// 建申请时快照下来的心愿名 —— 心愿后来被删也仍然说得清「申请的是什么」。
  final String title;
  final int cost;

  @override
  String get headline => '兑换心愿';

  @override
  String get detail => '「$title」 · $cost 分';
}

/// 加分申请：`{ kind: 'bonus', amount, reason, ruleId, habitId, basisTitle }`。
final class BonusSummary extends ApprovalSummary {
  const BonusSummary({
    required this.amount,
    required this.reason,
    this.ruleId,
    this.habitId,
    this.basisTitle,
  });

  final int amount;

  /// 孩子写的理由（可为空串 —— 服务端只保证是字符串）。
  final String reason;

  /// 至多一个依据：规则 **或** 习惯。
  final String? ruleId;
  final String? habitId;

  /// 依据的标题快照（`basisTitle`），没有依据时为 null。
  final String? basisTitle;

  @override
  String get headline => '加分申请';

  @override
  String get detail {
    final String base = '+$amount 分';
    final String why = reason.trim();
    final String? basis = basisTitle?.trim();
    if (basis != null && basis.isNotEmpty) {
      return why.isEmpty ? '$base · 依据「$basis」' : '$base · $why（依据「$basis」）';
    }
    return why.isEmpty ? base : '$base · $why';
  }
}

/// 新增心愿：`{ kind: 'add_wish', title, cost, emoji }`。
final class AddWishSummary extends ApprovalSummary {
  const AddWishSummary({
    required this.title,
    required this.cost,
    required this.emoji,
  });

  final String title;
  final int cost;
  final String emoji;

  @override
  String get headline => '新增心愿';

  @override
  String get detail => '$emoji「$title」 · $cost 分';
}

/// 收件箱里的一行（`GET /approvals` 的 `items[]`）。
class ApprovalInboxItem {
  const ApprovalInboxItem({
    required this.id,
    required this.action,
    required this.status,
    required this.requesterUserId,
    required this.decidedByUserId,
    required this.executedRecordId,
    required this.autoReason,
    required this.createdAt,
    required this.decidedAt,
    required this.expiresAt,
    required this.summary,
  });

  final String id;

  /// 线格式动作名（`redeem` / `request_points_bonus` / `add_wish` …）。
  final String action;

  /// `pending` / `approved` / `rejected` / `withdrawn` / `invalidated` / `expired`。
  final String status;
  final String requesterUserId;
  final String? decidedByUserId;
  final String? executedRecordId;

  /// 自动失效的原因（`WISH_DELETED` 等）；其余状态恒为 null。
  final String? autoReason;

  final DateTime createdAt;
  final DateTime? decidedAt;

  /// `pending` 的 TTL 截止时刻（`02` §4.3 的 72h）。客户端据此提前说「还剩 2 小时」，
  /// 而不是等家长点下去才收到 409 `APPROVAL_EXPIRED`。
  final DateTime expiresAt;

  /// `null` = payload 读不懂（库里的坏数据）。**必须**显示成「内容无法识别」并
  /// 禁用批准 —— 不是因为不能批，而是因为家长看不到自己在批什么。
  final ApprovalSummary? summary;

  bool get isPending => status == 'pending';

  /// 本地时间判断是否已过期（服务端会在下次读写时惰性落成 `expired`）。
  bool isExpiredAt(DateTime now) => isPending && !expiresAt.isAfter(now);

  /// 能不能批 / 拒。
  ///
  /// 三条都满足才行：`pending`、没过期、看得懂 payload。
  /// **拒绝**不需要读 payload（家长可以不看内容就驳回），因此单独给
  /// [canRejectAt] —— 坏数据那一行仍然可以被拒，不会永久卡在列表里。
  bool canApproveAt(DateTime now) =>
      isPending && !isExpiredAt(now) && summary != null;

  bool canRejectAt(DateTime now) => isPending && !isExpiredAt(now);

  /// 能不能撤回（W5-J）。
  ///
  /// 与「批准」不同，撤回**不需要**读懂 payload：申请人知道自己提了什么，
  /// 坏数据那一行也必须允许撤回，否则它会一直占着「我的申请」列表。
  bool canWithdrawAt(DateTime now) => isPending && !isExpiredAt(now);

  /// 不能批的原因（可展示中文）；能批时为 null。
  String? approveBlockedReasonAt(DateTime now) {
    if (!isPending) return '这条申请已经处理过了。';
    if (isExpiredAt(now)) return '已超过 72 小时有效期，请让孩子重新提交。';
    if (summary == null) return '内容无法识别（数据异常），不能批准；可以拒绝后让孩子重新提交。';
    return null;
  }

  /// 距离过期还剩多久（已过期 / 非 pending 时为 null）。
  Duration? remainingAt(DateTime now) {
    if (!isPending || isExpiredAt(now)) return null;
    return expiresAt.difference(now);
  }

  /// 剩余有效期的**可读**提示；不适用时为 null。
  String? remainingTextAt(DateTime now) {
    final Duration? left = remainingAt(now);
    if (left == null) return null;
    if (left.inHours >= 1) return '还剩 ${left.inHours} 小时';
    if (left.inMinutes >= 1) return '还剩 ${left.inMinutes} 分钟';
    return '不到 1 分钟';
  }

  /// 状态的可读名。未知状态**不猜** —— 直接把原值说出来。
  String get statusLabel {
    switch (status) {
      case 'pending':
        return '待处理';
      case 'approved':
        return '已通过';
      case 'rejected':
        return '已拒绝';
      case 'withdrawn':
        return '已撤回';
      case 'invalidated':
        return '已失效';
      case 'expired':
        return '已过期';
      default:
        return '状态未知（$status）';
    }
  }

  /// `invalidated` 的具体原因 → 一句人话（其余状态返回空串）。
  String get autoReasonLabel {
    switch (autoReason) {
      case 'WISH_DELETED':
        return '心愿已经被删除了';
      case 'INSUFFICIENT_POINTS':
        return '积分不够了';
      case 'MEMBER_REMOVED':
        return '成员已经被移出家庭';
      case null:
        return '';
      default:
        return '已有前提发生变化（$autoReason）';
    }
  }
}

/// 撤回前的确认文案。
///
/// 与批准不同，撤回**不执行**任何业务：不扣分、不加分、不建心愿，
/// 只是让这条申请失效。文案必须说清「需要时要重新提交」，
/// 否则用户会以为撤回之后还能一键恢复。
String approvalWithdrawConfirmText(ApprovalInboxItem item) {
  final ApprovalSummary? summary = item.summary;
  final String what;
  if (summary is RedeemSummary) {
    what = '兑换「${summary.title}」';
  } else if (summary is BonusSummary) {
    what = '加分 ${summary.amount} 分';
  } else if (summary is AddWishSummary) {
    what = '新增心愿「${summary.title}」';
  } else {
    what = '这条申请';
  }
  return '撤回后$what会立即失效，积分不会发生任何变化；需要时要重新提交。';
}

/// 一页收件箱 + 下一页游标。`nextCursor == null` ⇔ 没有更多。
class ApprovalsPage {
  const ApprovalsPage({
    required this.items,
    required this.hasMore,
    required this.nextCursor,
  });

  final List<ApprovalInboxItem> items;
  final bool hasMore;
  final String? nextCursor;
}

/// 批准 / 拒绝前的确认文案。
///
/// 放在模型层（纯函数）而不是页面里，是为了能被单测直接钉住 ——
/// 「批准后到底扣多少分 / 加多少分」这种句子写错，比按钮点不动更糟。
String approvalConfirmText({
  required bool approve,
  required ApprovalInboxItem item,
}) {
  if (!approve) return '拒绝后这次申请不会生效，积分与心愿都不会变化。';
  final ApprovalSummary? summary = item.summary;
  if (summary is RedeemSummary) {
    return '批准后会立即扣 ${summary.cost} 分，并把「${summary.title}」标记为已兑换。';
  }
  if (summary is BonusSummary) {
    return '批准后会立即给孩子加 ${summary.amount} 分。';
  }
  if (summary is AddWishSummary) {
    return '批准后「${summary.title}」（${summary.cost} 分）会加入心愿单。';
  }
  // 只可能是 summary == null（调用方已拦），但兜底也必须说实话。
  return '这条申请的内容无法识别，不能批准。';
}

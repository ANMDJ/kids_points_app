import 'read_api_errors.dart';

/// 后端只读端点的**线格式**（wire DTO）—— 只负责「像不像」，不负责「画成什么」。
///
/// 与 UI 模型（`Habit` / `PointRule` / `Wish` / `PointRecord`）刻意分开：
/// 前者跟 `backend/src/read/read.mapper.ts` 的 JSON 一一对应，后者是本地渲染用的。
/// 中间那层映射在 `read_mapper.dart` —— 服务端字段改名时只改这里和映射，UI 不动。
///
/// 所有读取都**严格**：缺字段 / 类型不对 ⇒ [ReadApiException.malformed]，
/// 不做 `as int? ?? 0` 那种「猜一个默认值」（那会让契约漂移静默通过）。
class HomeDto {
  HomeDto({
    required this.childId,
    required this.childName,
    required this.pointsBalance,
    required this.goodHabitCount,
    required this.rewardCount,
    required this.habits,
    required this.rules,
    required this.wishes,
  });

  factory HomeDto.fromJson(Object? raw) {
    final Map<String, Object?> json = readObject(raw, r'$');
    final Map<String, Object?> child = readObject(json['child'], 'child');

    return HomeDto(
      childId: readString(child, 'id', 'child.id'),
      childName: readString(child, 'name', 'child.name'),
      pointsBalance: readInt(child, 'pointsBalance', 'child.pointsBalance'),
      goodHabitCount: readInt(json, 'goodHabitCount', 'goodHabitCount'),
      rewardCount: readInt(json, 'rewardCount', 'rewardCount'),
      habits: readList(json, 'habits', 'habits')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) =>
              HabitDto.fromJson(entry.value, 'habits[${entry.key}]'))
          .toList(growable: false),
      rules: readList(json, 'rules', 'rules')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) =>
              RuleDto.fromJson(entry.value, 'rules[${entry.key}]'))
          .toList(growable: false),
      wishes: readList(json, 'wishes', 'wishes')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) =>
              WishDto.fromJson(entry.value, 'wishes[${entry.key}]'))
          .toList(growable: false),
    );
  }

  final String childId;
  final String childName;
  final int pointsBalance;
  final int goodHabitCount;
  final int rewardCount;
  final List<HabitDto> habits;
  final List<RuleDto> rules;
  final List<WishDto> wishes;
}

class HabitDto {
  HabitDto({
    required this.id,
    required this.title,
    required this.points,
    required this.icon,
    required this.color,
    required this.condition,
    required this.dailyLimit,
    required this.ruleId,
  });

  factory HabitDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    return HabitDto(
      id: readString(json, 'id', '$path.id'),
      title: readString(json, 'title', '$path.title'),
      points: readInt(json, 'points', '$path.points'),
      icon: readString(json, 'icon', '$path.icon'),
      color: readString(json, 'color', '$path.color'),
      condition: readString(json, 'condition', '$path.condition'),
      dailyLimit: readInt(json, 'dailyLimit', '$path.dailyLimit'),
      ruleId: readOptionalString(json, 'ruleId', '$path.ruleId'),
    );
  }

  final String id;
  final String title;
  final int points;
  final String icon;
  final String color;
  final String condition;
  final int dailyLimit;
  final String? ruleId;
}

class RuleDto {
  RuleDto({
    required this.id,
    required this.title,
    required this.points,
    required this.direction,
    required this.icon,
    required this.color,
    required this.condition,
    required this.dailyLimit,
    required this.currentVersion,
  });

  factory RuleDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    return RuleDto(
      id: readString(json, 'id', '$path.id'),
      title: readString(json, 'title', '$path.title'),
      points: readInt(json, 'points', '$path.points'),
      direction: readString(json, 'direction', '$path.direction'),
      icon: readString(json, 'icon', '$path.icon'),
      color: readString(json, 'color', '$path.color'),
      condition: readString(json, 'condition', '$path.condition'),
      dailyLimit: readInt(json, 'dailyLimit', '$path.dailyLimit'),
      currentVersion: readInt(json, 'currentVersion', '$path.currentVersion'),
    );
  }

  final String id;
  final String title;

  /// **带符号**的分值：奖励为正、扣分为负（后端已转换，客户端不再取反）。
  final int points;

  /// `reward` / `penalty` —— 区分「扣分」与「0 分」。
  final String direction;
  final String icon;
  final String color;
  final String condition;
  final int dailyLimit;
  final int currentVersion;
}

class WishDto {
  WishDto({
    required this.id,
    required this.title,
    required this.cost,
    required this.emoji,
    required this.coverStyle,
    required this.redeemed,
  });

  factory WishDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    return WishDto(
      id: readString(json, 'id', '$path.id'),
      title: readString(json, 'title', '$path.title'),
      cost: readInt(json, 'cost', '$path.cost'),
      emoji: readString(json, 'emoji', '$path.emoji'),
      coverStyle: readString(json, 'coverStyle', '$path.coverStyle'),
      redeemed: readBool(json, 'redeemed', '$path.redeemed'),
    );
  }

  final String id;
  final String title;
  final int cost;
  final String emoji;
  final String coverStyle;
  final bool redeemed;
}

class RecordDto {
  RecordDto({
    required this.id,
    required this.title,
    required this.points,
    required this.category,
    required this.source,
    required this.operatorRole,
    required this.note,
    required this.habitId,
    required this.ruleId,
    required this.ruleVersion,
    required this.wishId,
    required this.reversesRecordId,
    required this.reversedAt,
    required this.balanceAfter,
    required this.createdAt,
  });

  factory RecordDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    return RecordDto(
      id: readString(json, 'id', '$path.id'),
      title: readString(json, 'title', '$path.title'),
      points: readInt(json, 'points', '$path.points'),
      category: readString(json, 'category', '$path.category'),
      source: readString(json, 'source', '$path.source'),
      operatorRole:
          readOptionalString(json, 'operatorRole', '$path.operatorRole'),
      note: readString(json, 'note', '$path.note'),
      habitId: readOptionalString(json, 'habitId', '$path.habitId'),
      ruleId: readOptionalString(json, 'ruleId', '$path.ruleId'),
      ruleVersion: readOptionalInt(json, 'ruleVersion', '$path.ruleVersion'),
      wishId: readOptionalString(json, 'wishId', '$path.wishId'),
      reversesRecordId: readOptionalString(
          json, 'reversesRecordId', '$path.reversesRecordId'),
      reversedAt: readOptionalDate(json, 'reversedAt', '$path.reversedAt'),
      balanceAfter: readInt(json, 'balanceAfter', '$path.balanceAfter'),
      createdAt: readDate(json, 'createdAt', '$path.createdAt'),
    );
  }

  final String id;
  final String title;
  final int points;
  final String category;
  final String source;
  final String? operatorRole;
  final String note;
  final String? habitId;
  final String? ruleId;
  final int? ruleVersion;
  final String? wishId;
  final String? reversesRecordId;
  final DateTime? reversedAt;
  final int balanceAfter;
  final DateTime createdAt;
}

class RecordsPageDto {
  RecordsPageDto({
    required this.records,
    required this.limit,
    required this.hasMore,
    required this.nextCursor,
  });

  factory RecordsPageDto.fromJson(Object? raw) {
    final Map<String, Object?> json = readObject(raw, r'$');
    final List<RecordDto> records = readList(json, 'records', 'records')
        .asMap()
        .entries
        .map((MapEntry<int, Object?> entry) =>
            RecordDto.fromJson(entry.value, 'records[${entry.key}]'))
        .toList(growable: false);
    final bool hasMore = readBool(json, 'hasMore', 'hasMore');
    final String? nextCursor =
        readOptionalString(json, 'nextCursor', 'nextCursor');

    // 两个字段必须自洽：否则客户端要么提前停，要么对着 null 死循环。
    if (hasMore && (nextCursor == null || nextCursor.isEmpty)) {
      throw ReadApiException.malformed(
        'nextCursor',
        detail: 'hasMore=true 但没有游标，客户端无法取下一页',
      );
    }
    if (!hasMore && nextCursor != null) {
      throw ReadApiException.malformed(
        'nextCursor',
        detail: 'hasMore=false 却给了游标',
      );
    }

    return RecordsPageDto(
      records: records,
      limit: readInt(json, 'limit', 'limit'),
      hasMore: hasMore,
      nextCursor: nextCursor,
    );
  }

  final List<RecordDto> records;
  final int limit;
  final bool hasMore;

  /// 下一页游标；`hasMore == false` 时为 null。**必须原样回传**给服务端。
  final String? nextCursor;
}
// ─────────────────────── 家长审批收件箱（W5-D） ───────────────────────

/// `GET /approvals` 的一行。
///
/// ★ 与 `ApprovalDto`（写回包）**不合并**：写回包只带判定结果，列表行带
///   `summary` / `createdAt` / `expiresAt`。合并会让写路径被迫读一堆用不上的字段，
///   也会让「列表多读一个字段」变成对写端点的契约要求。
class ApprovalInboxItemDto {
  ApprovalInboxItemDto({
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

  factory ApprovalInboxItemDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    return ApprovalInboxItemDto(
      id: readString(json, 'id', '$path.id'),
      action: readString(json, 'action', '$path.action'),
      status: readString(json, 'status', '$path.status'),
      requesterUserId: readString(json, 'requesterUserId', '$path.requesterUserId'),
      decidedByUserId:
          readOptionalString(json, 'decidedByUserId', '$path.decidedByUserId'),
      executedRecordId:
          readOptionalString(json, 'executedRecordId', '$path.executedRecordId'),
      autoReason: readOptionalString(json, 'autoReason', '$path.autoReason'),
      createdAt: readDate(json, 'createdAt', '$path.createdAt'),
      decidedAt: readOptionalDate(json, 'decidedAt', '$path.decidedAt'),
      expiresAt: readDate(json, 'expiresAt', '$path.expiresAt'),
      summary: ApprovalSummaryDto.tryParse(json['summary'], '$path.summary'),
    );
  }

  final String id;
  final String action;
  final String status;
  final String requesterUserId;
  final String? decidedByUserId;
  final String? executedRecordId;
  final String? autoReason;
  final DateTime createdAt;
  final DateTime? decidedAt;
  final DateTime expiresAt;

  /// `null` 有两种来源：服务端明确给了 `summary: null`（payload 读不懂），
  /// 或 `kind` 是本客户端还不认识的**新**摘要。两种情况都必须显示成
  /// 「内容无法识别」并禁用批准 —— 看不到内容就不该点批。
  final ApprovalSummaryDto? summary;
}

/// 摘要的线格式联合：按 `kind` 分派，字段逐个严格校验。
///
/// ★ `tryParse` 为什么对 `null` / 未知 `kind` 返回 null，而不是抛 malformed：
///   服务端把「payload 读不懂」定义成 `summary: null`（见
///   `approval-inbox.mapper.ts`），那是一个**合法**响应；而未知 `kind` 是
///   服务端比客户端新的正常情况。这两种都不该让整页 500 —— 客户端仍然
///   能列出来、能拒绝，只是不能批。
///   已知 `kind` 的字段缺失 / 类型不对**仍然**抛 malformed（契约漂移必须响）。
sealed class ApprovalSummaryDto {
  const ApprovalSummaryDto();

  static ApprovalSummaryDto? tryParse(Object? raw, String path) {
    if (raw == null) return null;
    final Map<String, Object?> json = readObject(raw, path);
    final String kind = readString(json, 'kind', '$path.kind');
    switch (kind) {
      case 'redeem':
        return RedeemSummaryDto(
          wishId: readString(json, 'wishId', '$path.wishId'),
          title: readString(json, 'title', '$path.title'),
          cost: readInt(json, 'cost', '$path.cost'),
        );
      case 'bonus':
        return BonusSummaryDto(
          amount: readInt(json, 'amount', '$path.amount'),
          reason: readString(json, 'reason', '$path.reason'),
          ruleId: readOptionalString(json, 'ruleId', '$path.ruleId'),
          habitId: readOptionalString(json, 'habitId', '$path.habitId'),
          basisTitle: readOptionalString(json, 'basisTitle', '$path.basisTitle'),
        );
      case 'add_wish':
        return AddWishSummaryDto(
          title: readString(json, 'title', '$path.title'),
          cost: readInt(json, 'cost', '$path.cost'),
          emoji: readString(json, 'emoji', '$path.emoji'),
        );
      default:
        return null;
    }
  }
}

class RedeemSummaryDto extends ApprovalSummaryDto {
  RedeemSummaryDto({
    required this.wishId,
    required this.title,
    required this.cost,
  });

  final String wishId;
  final String title;
  final int cost;
}

class BonusSummaryDto extends ApprovalSummaryDto {
  BonusSummaryDto({
    required this.amount,
    required this.reason,
    required this.ruleId,
    required this.habitId,
    required this.basisTitle,
  });

  final int amount;
  final String reason;
  final String? ruleId;
  final String? habitId;
  final String? basisTitle;
}

class AddWishSummaryDto extends ApprovalSummaryDto {
  AddWishSummaryDto({
    required this.title,
    required this.cost,
    required this.emoji,
  });

  final String title;
  final int cost;
  final String emoji;
}

/// `GET /approvals` 的一页。
///
/// 与 [RecordsPageDto] 同一纪律：`hasMore` 与 `nextCursor` 必须自洽，
/// 否则客户端要么提前停、要么对着 null 死循环。
class ApprovalsPageDto {
  ApprovalsPageDto({
    required this.items,
    required this.hasMore,
    required this.nextCursor,
  });

  factory ApprovalsPageDto.fromJson(Object? raw) {
    final Map<String, Object?> json = readObject(raw, r'$');
    final List<ApprovalInboxItemDto> items =
        readList(json, 'items', 'items').asMap().entries.map(
              (MapEntry<int, Object?> entry) => ApprovalInboxItemDto.fromJson(
                entry.value,
                'items[${entry.key}]',
              ),
            ).toList(growable: false);
    final bool hasMore = readBool(json, 'hasMore', 'hasMore');
    final String? nextCursor =
        readOptionalString(json, 'nextCursor', 'nextCursor');

    if (hasMore && (nextCursor == null || nextCursor.isEmpty)) {
      throw ReadApiException.malformed(
        'nextCursor',
        detail: 'hasMore=true 但没有游标，客户端无法取下一页',
      );
    }
    if (!hasMore && nextCursor != null) {
      throw ReadApiException.malformed(
        'nextCursor',
        detail: 'hasMore=false 却给了游标',
      );
    }

    return ApprovalsPageDto(
      items: items,
      hasMore: hasMore,
      nextCursor: nextCursor,
    );
  }

  final List<ApprovalInboxItemDto> items;
  final bool hasMore;
  final String? nextCursor;
}
// ───────────────────────────── 通知中心（W5-L） ─────────────────────────────

/// `GET /notifications` 的一行（W5-L）。
///
/// ── 为什么只有 `readAt`、没有 `isUnread` ──────────────────────────────────
///   未读是**派生值**（`readAt == null`）。服务端再下发一个布尔就等于存了
///   两份事实，迟早出现「红点说未读、行却是灰的」。两端各算一次更安全
///   （与后端 `notifications.types.ts` 的取舍一致）。
///
/// ── 为什么 `payload` 允许为 null ───────────────────────────────────────────
///   它是服务端的裸 `Json` 列，可能被历史数据写成 `null` / 数组 / 标量。
///   客户端只用它取「点进去要跳到哪个 id」，读不懂就**原样展示标题与正文**、
///   不提供跳转 —— 这比让整页 500 好，也比假装能跳转诚实。
class NotificationDto {
  NotificationDto({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.payload,
    required this.readAt,
    required this.createdAt,
  });

  factory NotificationDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final String id = readString(json, 'id', '$path.id');
    if (id.trim().isEmpty) {
      throw ReadApiException.malformed('$path.id', detail: '通知 id 为空');
    }
    return NotificationDto(
      id: id,
      type: readString(json, 'type', '$path.type'),
      title: readString(json, 'title', '$path.title'),
      body: readString(json, 'body', '$path.body'),
      payload: _readPayload(json['payload']),
      readAt: readOptionalDate(json, 'readAt', '$path.readAt'),
      createdAt: readDate(json, 'createdAt', '$path.createdAt'),
    );
  }

  final String id;

  /// 类型标识（`approval.approved` / `approval.rejected` …）。
  /// **不要**用 `switch` 的 `default` 拒绝未知类型：服务端加新类型时，
  /// 老客户端仍应把这条列出来（标题 / 正文本来就可读）。
  final String type;
  final String title;
  final String body;

  /// 回到对应页面所需的 id（目前只有 `approvalId`）；读不懂就是 null。
  final Map<String, Object?>? payload;

  /// 未读 ⇒ null；已读 ⇒ 具体时间。界面据此渲染红点 / 灰化。
  final DateTime? readAt;
  final DateTime createdAt;

  /// 未读 = 服务端没给 `readAt`。**只**从这一个字段推导。
  bool get isUnread => readAt == null;

  /// 这是「有人提交了申请，等你处理」的提醒（W5-M），而不是审批结论。
  ///
  /// 两者都带 `approvalId`，但点进去要去的是**不同的地方**：结论去「我的申请」
  /// 看结果，待确认要去「审批」页给答复。只靠 `payload` 分不出来，必须看 `type`。
  bool get isApprovalSubmitted => type == 'approval.submitted';

  /// 点开这条通知要打开的审批 id；不是审批类 / payload 里没有 ⇒ null。
  String? get approvalId {
    final Object? value = payload?['approvalId'];
    if (value is String && value.trim().isNotEmpty) return value;
    return null;
  }

  /// 本地乐观更新用：把「已读」这件事写到内存里（服务端回包才是权威值）。
  NotificationDto markedRead(DateTime at) => NotificationDto(
        id: id,
        type: type,
        title: title,
        body: body,
        payload: payload,
        readAt: readAt ?? at,
        createdAt: createdAt,
      );

  /// payload 的宽松读取：对象 ⇒ 只读副本；其它（null / 数组 / 标量）⇒ null。
  static Map<String, Object?>? _readPayload(Object? raw) {
    if (raw is Map<String, Object?>) {
      return Map<String, Object?>.unmodifiable(raw);
    }
    if (raw is Map) {
      return Map<String, Object?>.unmodifiable(
        raw.map(
          (Object? key, Object? value) =>
              MapEntry<String, Object?>(key.toString(), value),
        ),
      );
    }
    return null;
  }
}

/// `GET /notifications` 的一页。
///
/// 与 [ApprovalsPageDto] 同一纪律：`hasMore` 与 `nextCursor` 必须自洽。
/// 多出来的 [unreadCount] 是**整份未读数**（不是本页），由服务端与列表
/// 同一次查询算出 —— 客户端拿它画红点，不要自己对 `items` 求和。
class NotificationsPageDto {
  NotificationsPageDto({
    required this.items,
    required this.hasMore,
    required this.nextCursor,
    required this.unreadCount,
  });

  factory NotificationsPageDto.fromJson(Object? raw) {
    final Map<String, Object?> json = readObject(raw, r'$');
    final List<NotificationDto> items =
        readList(json, 'items', 'items').asMap().entries.map(
              (MapEntry<int, Object?> entry) => NotificationDto.fromJson(
                entry.value,
                'items[${entry.key}]',
              ),
            ).toList(growable: false);
    final bool hasMore = readBool(json, 'hasMore', 'hasMore');
    final String? nextCursor =
        readOptionalString(json, 'nextCursor', 'nextCursor');
    final int unreadCount = readInt(json, 'unreadCount', 'unreadCount');

    if (hasMore && (nextCursor == null || nextCursor.isEmpty)) {
      throw ReadApiException.malformed(
        'nextCursor',
        detail: 'hasMore=true 但没有游标，客户端无法取下一页',
      );
    }
    if (!hasMore && nextCursor != null) {
      throw ReadApiException.malformed(
        'nextCursor',
        detail: 'hasMore=false 却给了游标',
      );
    }
    if (unreadCount < 0) {
      // 负数只可能是契约漂移；画成 0 会把「红点没了」说成正常。
      throw ReadApiException.malformed(
        'unreadCount',
        detail: '未读数不能为负：$unreadCount',
      );
    }

    return NotificationsPageDto(
      items: items,
      hasMore: hasMore,
      nextCursor: nextCursor,
      unreadCount: unreadCount,
    );
  }

  final List<NotificationDto> items;
  final bool hasMore;
  final String? nextCursor;

  /// **整份**未读数（不是本页未读数）。
  final int unreadCount;
}





// ───────────────────────────── 严格读取助手 ─────────────────────────────

Map<String, Object?> readObject(Object? value, String path) {
  if (value is Map<String, Object?>) return value;
  if (value is Map) {
    return value.map(
      (Object? key, Object? item) =>
          MapEntry<String, Object?>(key.toString(), item),
    );
  }
  throw ReadApiException.malformed(path,
      detail: '期望对象，实际 ${value.runtimeType}');
}

List<Object?> readList(Map<String, Object?> json, String key, String path) {
  final Object? value = json[key];
  if (value is List) return value;
  throw ReadApiException.malformed(path,
      detail: '期望数组，实际 ${value.runtimeType}');
}

String readString(Map<String, Object?> json, String key, String path) {
  final Object? value = json[key];
  if (value is String) return value;
  throw ReadApiException.malformed(path,
      detail: '期望字符串，实际 ${value.runtimeType}');
}

String? readOptionalString(Map<String, Object?> json, String key, String path) {
  final Object? value = json[key];
  if (value == null) return null;
  if (value is String) return value;
  throw ReadApiException.malformed(path,
      detail: '期望字符串或 null，实际 ${value.runtimeType}');
}

int readInt(Map<String, Object?> json, String key, String path) {
  final Object? value = json[key];
  if (value is int) return value;
  // JSON 里大整数可能被解成 double；只接受**无损**整数，避免悄悄取整。
  if (value is double && value == value.truncateToDouble())
    return value.toInt();
  throw ReadApiException.malformed(path,
      detail: '期望整数，实际 ${value.runtimeType}');
}

int? readOptionalInt(Map<String, Object?> json, String key, String path) {
  if (json[key] == null) return null;
  return readInt(json, key, path);
}

bool readBool(Map<String, Object?> json, String key, String path) {
  final Object? value = json[key];
  if (value is bool) return value;
  throw ReadApiException.malformed(path,
      detail: '期望布尔值，实际 ${value.runtimeType}');
}

DateTime readDate(Map<String, Object?> json, String key, String path) {
  final String raw = readString(json, key, path);
  final DateTime? parsed = DateTime.tryParse(raw);
  if (parsed == null) {
    throw ReadApiException.malformed(path, detail: '不是 ISO-8601 时间：$raw');
  }
  return parsed;
}

DateTime? readOptionalDate(Map<String, Object?> json, String key, String path) {
  if (json[key] == null) return null;
  return readDate(json, key, path);
}
// ───────────────────────────── 回收站（W5-F） ─────────────────────────────

/// `GET /trash` 的一行。
///
/// 服务端只下发**事实**（`deletedAt`）；`expired` / 「还能恢复几天」由
/// [isTrashExpired] / [trashRetentionText] 现算。线格式里再塞一个 `expiresAt`
/// 就等于多一份 90 天常量 —— 界面与接口迟早给出两个互相矛盾的答案。
class TrashItemDto {
  TrashItemDto({
    required this.kind,
    required this.id,
    required this.title,
    required this.deletedAt,
  });

  factory TrashItemDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    return TrashItemDto(
      kind: readString(json, 'kind', '$path.kind'),
      id: readString(json, 'id', '$path.id'),
      title: readString(json, 'title', '$path.title'),
      // 后端下发 ISO-8601 串；`readDate` 严格解析（不是「猜 now」）。
      deletedAt: readDate(json, 'deletedAt', '$path.deletedAt'),
    );
  }

  /// 线值：`point_rule` / `wish` / `habit`（由 `mapTrash` 严格转成 `TrashKind`）
  final String kind;
  final String id;
  final String title;
  final DateTime deletedAt;
}

/// `GET /trash` 的响应体。
///
/// 不分页：回收站是低频、小集合（用户主动删的东西不会多到需要游标）。
class TrashListDto {
  TrashListDto({required this.items});

  factory TrashListDto.fromJson(Object? raw) {
    final Map<String, Object?> json = readObject(raw, r'$');
    return TrashListDto(
      items: readList(json, 'items', 'items')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) =>
              TrashItemDto.fromJson(entry.value, 'items[${entry.key}]'))
          .toList(growable: false),
    );
  }

  final List<TrashItemDto> items;
}

// ───────────────────────────── 家庭成员（W5-H） ─────────────────────────────

/// `GET /members` 的一行。
///
/// 线格式**只下发事实**：`role` / `status` / `isSelf`，没有
/// `canChangeRole` / `canRemove` 之类的结论 —— 谁能对谁做什么由服务端屏障二
/// 判定；客户端按「我是家长 ⇒ 显示入口」渲染，被拒绝时再按 403 的 `code`
/// 解释原因（`25-w5h-handoff.md` §2.6）。
///
/// `role` / `status` 故意保留**线值字符串**：枚举校验集中在
/// [mapMember]（不认识的值显式抛错），DTO 层不替界面猜。
class MemberDto {
  MemberDto({
    required this.memberId,
    required this.userId,
    required this.displayName,
    required this.role,
    required this.status,
    required this.joinedAt,
    required this.removedAt,
    required this.isSelf,
  });

  factory MemberDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    return MemberDto(
      memberId: readString(json, 'memberId', '$path.memberId'),
      userId: readString(json, 'userId', '$path.userId'),
      displayName: readOptionalString(json, 'displayName', '$path.displayName'),
      // 线值：`guardian` / `child` / `viewer`（由 `mapMember` 严格转换）
      role: readString(json, 'role', '$path.role'),
      // 线值：`active` / `removed`
      status: readString(json, 'status', '$path.status'),
      joinedAt: readDate(json, 'joinedAt', '$path.joinedAt'),
      removedAt: readOptionalDate(json, 'removedAt', '$path.removedAt'),
      // 唯一一个「服务端算、客户端不该算」的字段：客户端不知道自己的 userId
      // （身份在服务端会话里），只能由服务端回答「这一行是不是我」。
      isSelf: readBool(json, 'isSelf', '$path.isSelf'),
    );
  }

  final String memberId;
  final String userId;
  final String? displayName;
  final String role;
  final String status;
  final DateTime joinedAt;
  final DateTime? removedAt;
  final bool isSelf;
}

/// `GET /members` 的响应体。
///
/// 不分页、也不含 `removed`：单孩子量小，被移出的人只能在审计里看到
/// （`25-w5h-handoff.md` §5）。
class MemberListDto {
  MemberListDto({required this.items});

  factory MemberListDto.fromJson(Object? raw) {
    final Map<String, Object?> json = readObject(raw, r'$');
    return MemberListDto(
      items: readList(json, 'items', 'items')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) =>
              MemberDto.fromJson(entry.value, 'items[${entry.key}]'))
          .toList(growable: false),
    );
  }

  final List<MemberDto> items;
}

// ───────────────────────────── 邀请码（W5-I） ─────────────────────────────

/// `GET /invites` 的一行 / `POST /invites` 的回包。
///
/// 线格式**只下发事实**：`usedCount` / `maxUses` / `expiresAt` / `revoked`，
/// 没有 `expired` 或 `status: 'usable'` —— 「还能不能用」由界面现算
/// （[InviteCode.statusAt]），服务端再算一遍就等于两份判据。
///
/// `role` 故意保留**线值字符串**：枚举校验集中在 [mapInvite]（`viewer`
/// 不是可邀请的角色），DTO 层不替界面猜。
class InviteDto {
  InviteDto({
    required this.id,
    required this.code,
    required this.role,
    required this.maxUses,
    required this.usedCount,
    required this.expiresAt,
    required this.revoked,
    required this.createdAt,
  });

  factory InviteDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    return InviteDto(
      id: readString(json, 'id', '$path.id'),
      code: readString(json, 'code', '$path.code'),
      // 线值：`child` / `guardian`（由 `mapInvite` 严格转换）
      role: readString(json, 'role', '$path.role'),
      maxUses: readInt(json, 'maxUses', '$path.maxUses'),
      usedCount: readInt(json, 'usedCount', '$path.usedCount'),
      expiresAt: readDate(json, 'expiresAt', '$path.expiresAt'),
      revoked: readBool(json, 'revoked', '$path.revoked'),
      createdAt: readDate(json, 'createdAt', '$path.createdAt'),
    );
  }

  final String id;
  final String code;
  final String role;
  final int maxUses;
  final int usedCount;
  final DateTime expiresAt;
  final bool revoked;
  final DateTime createdAt;
}

/// `GET /invites` 的响应体（`{ items: [...] }`）。
///
/// 不分页：一个孩子的邀请码是小集合，且列表里给的是**凭据**本身，
/// 翻页只会让「我刚才那个码在哪」更难找。
class InviteListDto {
  InviteListDto({required this.items});

  factory InviteListDto.fromJson(Object? raw) {
    final Map<String, Object?> json = readObject(raw, r'$');
    return InviteListDto(
      items: readList(json, 'items', 'items')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) =>
              InviteDto.fromJson(entry.value, 'items[${entry.key}]'))
          .toList(growable: false),
    );
  }

  final List<InviteDto> items;
}


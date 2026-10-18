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

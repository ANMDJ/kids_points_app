import '../models/onboarding.dart';
import 'read_api_errors.dart';
import 'read_dto.dart';

/// 首启引导三个端点的**线格式**（W8-B，2026-10-27 / `04` §2–§4）。
///
/// 与其它读 DTO 同一口径：缺字段 / 类型不对 / 形状自相矛盾一律
/// [ReadApiException.malformed]，不做 `as int? ?? 0` 那种「猜一个默认值」。
///
/// ── 这里判的三类「自相矛盾」 ────────────────────────────────────────────────
///   ① `onboarded` 与 `onboardedAt` 必须一致（服务端就是按 `!== null` 派生的）；
///   ② 模板 `slug` 必须非空且**不重复** —— 重复的 slug 意味着「采纳」会歧义；
///   ③ 模板的 `ageBand` / `focusAreas` 必须是已知取值 —— 陌生值会让第③④步的
///      排序解释不了，界面也画不出匹配的胶囊。
class RuleTemplateDto {
  RuleTemplateDto({
    required this.slug,
    required this.title,
    required this.condition,
    required this.dailyLimit,
    required this.points,
    required this.direction,
    required this.icon,
    required this.color,
    required this.ageBand,
    required this.focusAreas,
    required this.sortWeight,
  });

  factory RuleTemplateDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final RuleTemplateDto dto = RuleTemplateDto(
      slug: readString(json, 'slug', '$path.slug'),
      title: readString(json, 'title', '$path.title'),
      condition: readString(json, 'condition', '$path.condition'),
      dailyLimit: readInt(json, 'dailyLimit', '$path.dailyLimit'),
      points: readInt(json, 'points', '$path.points'),
      direction: readString(json, 'direction', '$path.direction'),
      icon: readString(json, 'icon', '$path.icon'),
      color: readString(json, 'color', '$path.color'),
      ageBand: readString(json, 'ageBand', '$path.ageBand'),
      focusAreas: readList(json, 'focusAreas', '$path.focusAreas')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) => readArea(
                entry.value,
                '$path.focusAreas[${entry.key}]',
              ))
          .toList(growable: false),
      sortWeight: readInt(json, 'sortWeight', '$path.sortWeight'),
    );
    dto._validateShape(path);
    return dto;
  }

  final String slug;
  final String title;
  final String condition;
  final int dailyLimit;
  final int points;

  /// `reward` / `penalty` —— 线值，映射到模型时变成 `isPenalty`。
  final String direction;
  final String icon;
  final String color;

  /// 学段线值（`preschool` / `primary_low` …）。
  final String ageBand;
  final List<String> focusAreas;
  final int sortWeight;

  bool get isPenalty => direction == 'penalty';

  void _validateShape(String path) {
    if (slug.trim().isEmpty) {
      throw ReadApiException.malformed('$path.slug', detail: 'slug 不能为空');
    }
    if (title.trim().isEmpty) {
      throw ReadApiException.malformed('$path.title', detail: 'title 不能为空');
    }
    if (condition.trim().isEmpty) {
      throw ReadApiException.malformed(
        '$path.condition',
        detail: 'condition 不能为空（模板必须给出可判定的条件）',
      );
    }
    if (dailyLimit < 1 || dailyLimit > 10) {
      throw ReadApiException.malformed(
        '$path.dailyLimit',
        detail: '每天次数必须在 1–10 之间：$dailyLimit',
      );
    }
    // 模板分值恒为正；0 分模板对产品无意义，负数说明服务端把方向揉进了分值。
    if (points < 1 || points > 10) {
      throw ReadApiException.malformed(
        '$path.points',
        detail: '模板分值必须在 1–10 之间（方向单独给）：$points',
      );
    }
    if (direction != 'reward' && direction != 'penalty') {
      throw ReadApiException.malformed(
        '$path.direction',
        detail: '未知分值方向：$direction',
      );
    }
    if (ageBandFromWire(ageBand) == null) {
      throw ReadApiException.malformed(
        '$path.ageBand',
        detail: '未知学段：$ageBand',
      );
    }
    if (icon.trim().isEmpty) {
      throw ReadApiException.malformed('$path.icon', detail: 'icon 不能为空');
    }
    // 图标名是否在跨端白名单里由渲染层兜底（`iconDataFor` 会落到 unknown）：
    // 这里只保证「有名字」，不在数据层引入对 theme 的依赖。
  }
}

/// 数组元素 → 关注点字符串（`isFocusArea` 的严格版）。
String readArea(Object? value, String path) {
  if (value is! String) {
    throw ReadApiException.malformed(
      path,
      detail: '期望关注点字符串，实际 ${value.runtimeType}',
    );
  }
  if (!isFocusArea(value)) {
    throw ReadApiException.malformed(path, detail: '未知关注点：$value');
  }
  return value;
}

/// 引导状态（`GET /onboarding` 的公共部分 / `PATCH profile` 的回包）。
class OnboardingStateDto {
  OnboardingStateDto({
    required this.childId,
    required this.onboarded,
    required this.onboardedAt,
    required this.ageBand,
    required this.focusAreas,
  });

  factory OnboardingStateDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final OnboardingStateDto dto = OnboardingStateDto(
      childId: readString(json, 'childId', '$path.childId'),
      onboarded: readBool(json, 'onboarded', '$path.onboarded'),
      onboardedAt: readOptionalDate(json, 'onboardedAt', '$path.onboardedAt'),
      ageBand: readOptionalString(json, 'ageBand', '$path.ageBand'),
      focusAreas: readList(json, 'focusAreas', '$path.focusAreas')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) => readArea(
                entry.value,
                '$path.focusAreas[${entry.key}]',
              ))
          .toList(growable: false),
    );
    dto._validateShape(path);
    return dto;
  }

  final String childId;
  final bool onboarded;
  final DateTime? onboardedAt;

  /// 学段线值；未选时为 null。
  final String? ageBand;
  final List<String> focusAreas;

  /// 学段转枚举（DTO 已验过合法性；这里再兜一层是防御纵深）。
  AgeBand? get ageBandValue =>
      ageBand == null ? null : ageBandFromWire(ageBand!);

  void _validateShape(String path) {
    if (childId.trim().isEmpty) {
      throw ReadApiException.malformed(
        '$path.childId',
        detail: 'childId 不能为空',
      );
    }
    if (onboarded != (onboardedAt != null)) {
      throw ReadApiException.malformed(
        '$path.onboarded',
        detail:
            'onboarded=$onboarded 与 onboardedAt=$onboardedAt 不自洽（服务端按 !== null 派生）',
      );
    }
    if (ageBand != null && ageBandFromWire(ageBand!) == null) {
      throw ReadApiException.malformed(
        '$path.ageBand',
        detail: '未知学段：$ageBand',
      );
    }
  }
}

/// `GET /onboarding`：状态 + 模板库。
class OnboardingViewDto extends OnboardingStateDto {
  OnboardingViewDto({
    required super.childId,
    required super.onboarded,
    required super.onboardedAt,
    required super.ageBand,
    required super.focusAreas,
    required this.templates,
  });

  factory OnboardingViewDto.fromJson(Object? raw) {
    const String path = r'$';
    final Map<String, Object?> json = readObject(raw, path);
    final List<RuleTemplateDto> templates =
        readList(json, 'templates', '$path.templates')
            .asMap()
            .entries
            .map((MapEntry<int, Object?> entry) => RuleTemplateDto.fromJson(
                  entry.value,
                  '$path.templates[${entry.key}]',
                ))
            .toList(growable: false);

    // 重复 slug ⇒ 「采纳这几条」会有歧义，宁可现在红。
    final Set<String> slugs = <String>{};
    for (final RuleTemplateDto template in templates) {
      if (!slugs.add(template.slug)) {
        throw ReadApiException.malformed(
          '$path.templates',
          detail: '模板 slug 重复：${template.slug}',
        );
      }
    }
    if (templates.isEmpty) {
      // 空模板库不是「没有可选项」，而是内容侧事故：第⑤步会无法继续。
      throw ReadApiException.malformed(
        '$path.templates',
        detail: '模板库为空 —— 引导无法完成（至少需要 1 条 active 模板）',
      );
    }

    final OnboardingViewDto dto = OnboardingViewDto(
      childId: readString(json, 'childId', '$path.childId'),
      onboarded: readBool(json, 'onboarded', '$path.onboarded'),
      onboardedAt: readOptionalDate(json, 'onboardedAt', '$path.onboardedAt'),
      ageBand: readOptionalString(json, 'ageBand', '$path.ageBand'),
      focusAreas: readList(json, 'focusAreas', '$path.focusAreas')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) => readArea(
                entry.value,
                '$path.focusAreas[${entry.key}]',
              ))
          .toList(growable: false),
      templates: templates,
    );
    dto._validateShape(path);
    return dto;
  }

  final List<RuleTemplateDto> templates;
}

/// `POST /onboarding/complete` 回包里的一条新规则。
///
/// 只解析界面要用的四个字段：`ruleId` / `title` / `points` / `direction`。
/// 其它字段（`condition` / `icon` / `color` / `dailyLimit` / `currentVersion`）
/// 由随后的 `GET /home` 快照提供 —— 那才是首页读的权威源，这里不造第二份。
class OnboardingCreatedRuleDto {
  OnboardingCreatedRuleDto({
    required this.ruleId,
    required this.title,
    required this.points,
    required this.direction,
  });

  factory OnboardingCreatedRuleDto.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final OnboardingCreatedRuleDto dto = OnboardingCreatedRuleDto(
      ruleId: readString(json, 'ruleId', '$path.ruleId'),
      title: readString(json, 'title', '$path.title'),
      points: readInt(json, 'points', '$path.points'),
      direction: readString(json, 'direction', '$path.direction'),
    );
    if (dto.ruleId.trim().isEmpty) {
      throw ReadApiException.malformed(
        '$path.ruleId',
        detail: 'ruleId 不能为空（否则首页刷新后点不到这条习惯）',
      );
    }
    if (dto.points < 1) {
      throw ReadApiException.malformed(
        '$path.points',
        detail: '规则分值必须为正（方向单独给）：${dto.points}',
      );
    }
    if (dto.direction != 'reward' && dto.direction != 'penalty') {
      throw ReadApiException.malformed(
        '$path.direction',
        detail: '未知分值方向：${dto.direction}',
      );
    }
    return dto;
  }

  final String ruleId;
  final String title;
  final int points;
  final String direction;

  bool get isPenalty => direction == 'penalty';
}

/// `POST /onboarding/complete` 的回包。
class OnboardingResultDto {
  OnboardingResultDto({
    required this.childId,
    required this.onboardedAt,
    required this.rules,
  });

  factory OnboardingResultDto.fromJson(Object? raw) {
    const String path = r'$';
    final Map<String, Object?> json = readObject(raw, path);
    final OnboardingResultDto dto = OnboardingResultDto(
      childId: readString(json, 'childId', '$path.childId'),
      onboardedAt: readDate(json, 'onboardedAt', '$path.onboardedAt'),
      rules: readList(json, 'rules', '$path.rules')
          .asMap()
          .entries
          .map((MapEntry<int, Object?> entry) => OnboardingCreatedRuleDto.fromJson(
                entry.value,
                '$path.rules[${entry.key}]',
              ))
          .toList(growable: false),
    );
    if (dto.rules.isEmpty) {
      // 「完成引导但一条规则都没建」正是 04 §3 要防的破损态：
      // 首页会是空的，家长会以为引导没生效。宁可在这里红。
      throw ReadApiException.malformed(
        '$path.rules',
        detail: '完成引导却没有建出任何规则 —— 拒绝显示「已完成」',
      );
    }
    return dto;
  }

  final String childId;
  final DateTime onboardedAt;
  final List<OnboardingCreatedRuleDto> rules;
}


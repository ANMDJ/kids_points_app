/// 首启引导的**界面模型与纯规则**（W8-B，2026-10-27 / `04` §2、§5、§6）。
///
/// ── 这个文件回答什么 ────────────────────────────────────────────────────────
///   ① 学段 / 关注点的**取值与中文标签**（与后端 `contracts/onboarding.ts` 同源）；
///   ② 模板卡片上要显示的三种文案（条件 / 频次 / 分值），全部**由结构字段派生**
///      （`condition` / `dailyLimit` / `points` + `direction`）—— 绝不把「每天最多
///      2 次」再拼回一个字符串里靠 `' · '` 反解析（那正是 E15 的病）；
///   ③ 第②⑥步的两个**校验**：昵称不能为空、PIN 要么跳过要么 4–6 位数字。
///
/// ── 为什么客户端也有一份学段 / 关注点常量 ────────────────────────────────────
///   第③④步要在**还没有选择模板**时就把选项画出来（此时 `GET /onboarding` 的
///   `templates` 只能告诉我们「有哪些模板」，不能保证 6 个关注点每个都有模板）。
///   两份手抄必然漂移，因此加了闸门 `npm run onboarding:check`
///   （`tools/onboarding-options-check.mjs`），逐字比对后端契约、Flutter 与小程序
///   三处的取值集合 —— 新增关注点必须同时改三处，否则 CI 红。
///
/// ── 为什么不在这里存「第几步」 ──────────────────────────────────────────────
///   步骤是 UI 的一次性状态（进程内），不是服务端事实。服务端只持
///   `onboardedAt` / `ageBand` / `focusAreas`（`04` §3 的权威定义）——
///   把「第几步」也落库会造出第二个真相，且退出重进时未必还成立。
library;

/// 学段：与后端 `prisma/schema.prisma` 的 `enum AgeBand` 逐字一致。
///
/// `wireName` 是唯一允许出现在请求体里的写法（`preschool` / `primary_low` …）；
/// 中文标签只用于展示，**绝不**回传 —— 后端 `@IsIn([...AGE_BANDS])` 会 400。
enum AgeBand { preschool, primaryLow, primaryHigh, juniorHigh }

extension AgeBandX on AgeBand {
  /// 请求体 / 响应体里的值（与 Prisma 枚举逐字一致）。
  String get wireName {
    switch (this) {
      case AgeBand.preschool:
        return 'preschool';
      case AgeBand.primaryLow:
        return 'primary_low';
      case AgeBand.primaryHigh:
        return 'primary_high';
      case AgeBand.juniorHigh:
        return 'junior_high';
    }
  }

  /// 卡片 / 胶囊上的主文案。
  String get label {
    switch (this) {
      case AgeBand.preschool:
        return '幼儿园';
      case AgeBand.primaryLow:
        return '小学低年级';
      case AgeBand.primaryHigh:
        return '小学高年级';
      case AgeBand.juniorHigh:
        return '初中';
    }
  }

  /// 辅助说明：让家长不用猜「低年级」是几年级。
  String get hint {
    switch (this) {
      case AgeBand.preschool:
        return '3–6 岁';
      case AgeBand.primaryLow:
        return '1–3 年级';
      case AgeBand.primaryHigh:
        return '4–6 年级';
      case AgeBand.juniorHigh:
        return '7–9 年级';
    }
  }
}

/// 线值 → 枚举。**不认识就返回 null**（由 DTO 决定这算不算契约漂移）。
///
/// 不在 DTO 里静默 `AgeBand.primaryLow` 兜底：那会把「后端新增了一个学段」
/// 画成「家长上次选的是小学低年级」，是能被家长看见的谎。
AgeBand? ageBandFromWire(String raw) {
  for (final AgeBand band in AgeBand.values) {
    if (band.wireName == raw) return band;
  }
  return null;
}

/// 6 个关注点（`04` §2 第④步）。
///
/// ★ 与后端 `FOCUS_AREAS` **逐字一致**，由 `npm run onboarding:check` 比对。
/// 它们是展示用中文标签，不是 slug：模板数据里存的就是这些字符串。
const List<String> kFocusAreas = <String>[
  '作业专注',
  '生活习惯',
  '阅读',
  '运动',
  '情绪管理',
  '家务',
];

/// 关注点是否合法 —— 用于「从服务端旧数据里恢复草稿」时丢弃不认识的标签。
bool isFocusArea(String value) => kFocusAreas.contains(value);

/// 一张模板卡片（`GET /onboarding` 的 `templates[i]`）。
///
/// `points` **恒为正**，方向由 `isPenalty` 表达（与后端 schema 一致）。
/// 界面要显示「+3 / −2」时用 [pointsText] 现算 —— 不要把它存成另一个字段，
/// 否则「改分值忘了改文案」这类漂移会重新出现。
class RuleTemplate {
  const RuleTemplate({
    required this.slug,
    required this.title,
    required this.condition,
    required this.dailyLimit,
    required this.points,
    required this.isPenalty,
    required this.icon,
    required this.color,
    required this.ageBand,
    required this.focusAreas,
    required this.sortWeight,
  });

  /// 模板的唯一标识（`RuleTemplate.slug`）—— 采纳时提交的就是它。
  final String slug;
  final String title;

  /// 可判定的条件（例：'专注 25 分钟'）。
  final String condition;

  /// 每天最多可做几次（结构字段，不再塞进 `condition`）。
  final int dailyLimit;

  /// 分值的**绝对值**。
  final int points;

  /// `true` = 扣分约定（`direction=penalty`）。
  final bool isPenalty;

  /// 图标**名字**（跨端契约，见 `theme/app_icons.dart`）。
  final String icon;
  final String color;

  /// 这条模板面向的学段（排序用，**不是**过滤条件）。
  final AgeBand ageBand;
  final List<String> focusAreas;

  /// 平台侧表达「这条更常用」的权重。
  final int sortWeight;

  /// 「+3」/「−2」—— 与卡片右边的分值胶囊一致。
  String get pointsText => '${isPenalty ? '−' : '+'}$points';

  /// 「每天最多 2 次」。
  String get frequencyText => '每天最多 $dailyLimit 次';

  /// 「作业专注 · 生活习惯」；没有关注点时返回「通用」。
  String get focusText => focusAreas.isEmpty ? '通用' : focusAreas.join(' · ');

  /// 展示用的学段标签（模板可能属于别的学段，仍要显示出来才讲得通）。
  String get ageBandLabel => ageBand.label;
}

/// `GET /onboarding` 的完整快照：状态 + **已由服务端排好序**的模板。
///
/// 客户端**不重排**：排序链（学段 → 关注点命中数 → `sortWeight` → `slug`）
/// 是业务规则，只有一份实现（`backend/src/onboarding/onboarding.policy.ts`）。
class OnboardingView {
  const OnboardingView({
    required this.childId,
    required this.onboarded,
    required this.onboardedAt,
    required this.ageBand,
    required this.focusAreas,
    required this.templates,
  });

  final String childId;

  /// 服务端派生的布尔值（`onboardedAt !== null`）—— 客户端不自己比日期。
  final bool onboarded;
  final DateTime? onboardedAt;
  final AgeBand? ageBand;
  final List<String> focusAreas;
  final List<RuleTemplate> templates;

  /// 采纳完模板后，用回包把本地快照推进到「已完成」。
  ///
  /// 刻意**不重拉** `GET /onboarding`：完成之后该端点返回的是「已完成」状态，
  /// 模板列表对界面已经没有意义；回包已经带上了新建的规则。
  OnboardingView markCompleted(DateTime at) => OnboardingView(
        childId: childId,
        onboarded: true,
        onboardedAt: at,
        ageBand: ageBand,
        focusAreas: focusAreas,
        templates: templates,
      );

  /// 草稿保存后，用新状态替换（模板列表不变）。
  ///
  /// `clearAgeBand: true` 才能把学段清回「未选择」—— 与 `saveProfile` 的
  /// `null` vs `undefined` 语义保持一致，避免「家长取消了学段，界面还显示旧学段」。
  OnboardingView withDraft({
    AgeBand? ageBand,
    bool clearAgeBand = false,
    List<String>? focusAreas,
  }) =>
      OnboardingView(
        childId: childId,
        onboarded: onboarded,
        onboardedAt: onboardedAt,
        ageBand: clearAgeBand ? null : (ageBand ?? this.ageBand),
        focusAreas: focusAreas ?? this.focusAreas,
        templates: templates,
      );
}

/// `POST /onboarding/complete` 回包里的一条新规则。
class OnboardingCreatedRule {
  const OnboardingCreatedRule({
    required this.ruleId,
    required this.title,
    required this.points,
    required this.isPenalty,
  });

  final String ruleId;
  final String title;
  final int points;
  final bool isPenalty;

  String get pointsText => '${isPenalty ? '−' : '+'}$points';
}

/// `POST /onboarding/complete` 的回包。
class OnboardingResult {
  const OnboardingResult({
    required this.childId,
    required this.onboardedAt,
    required this.rules,
  });

  final String childId;
  final DateTime onboardedAt;
  final List<OnboardingCreatedRule> rules;

  /// 「已采纳 3 条约定」。
  String get summaryText => '已采纳 ${rules.length} 条约定';
}

/// 第②步：孩子昵称（`PATCH /child` 的输入）。
///
/// 返回 null 表示通过，否则是**可以直接显示给家长**的原因。
/// 长度上限 20 与后端 `RenameChildDto` 同口径 —— 本地先拦，少一次必然 400 的往返。
String? validateChildName(String raw) {
  final String name = raw.trim();
  if (name.isEmpty) return '请先填一个昵称（孩子看到的就是这个名字）。';
  if (name.length > 20) return '昵称最多 20 个字（现在 ${name.length} 个字）。';
  return null;
}

/// 第⑥步：家长 PIN。
///
/// 三种输入三种结局：
///   · 空串 ⇒ **跳过**（`04` §2：可跳过，不是错误）；
///   · 4–6 位数字 ⇒ 通过；
///   · 其它 ⇒ 返回可显示的原因。
///
/// 与后端 `PIN_PATTERN = /^\d{4,6}$/` 同口径；空串在这里被当作「没填」，
/// 但**不会**被发成 `parentPin: ''` —— 后端 DTO 明确拒绝空串（那是客户端 bug）。
String? validateParentPin(String raw) {
  final String pin = raw.trim();
  if (pin.isEmpty) return null;
  if (!RegExp(r'^\d{4,6}$').hasMatch(pin)) {
    return '家长 PIN 必须是 4–6 位数字；不想设置就留空。';
  }
  return null;
}



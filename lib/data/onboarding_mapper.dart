import '../models/onboarding.dart';
import 'onboarding_dto.dart';

/// 引导 DTO → UI 模型的**唯一映射**（W8-B，2026-10-27）。
///
/// 与 `read_mapper.dart` 同一分工：DTO 只管「像不像」，这里只管「画成什么」。
/// 单独一个文件的理由与 `onboarding_api.dart` 相同 —— 引导是一次性流程，
/// 映射不该混进首页那份几百行的映射表里，否则删引导时会留下无法安全删除的死代码。
///
/// ★ 排序**不在这里做**：`templates` 已由服务端按「学段 → 关注点命中数 →
///   sortWeight → slug」排好（`04` §2 第⑤步）。客户端重排一次就等于有两份
///   排序规则，早晚会有一次只改了一边。
OnboardingView mapOnboardingView(OnboardingViewDto dto) => OnboardingView(
      childId: dto.childId,
      onboarded: dto.onboarded,
      onboardedAt: dto.onboardedAt,
      ageBand: dto.ageBandValue,
      focusAreas: List<String>.unmodifiable(dto.focusAreas),
      templates: dto.templates
          .map((RuleTemplateDto template) => RuleTemplate(
                slug: template.slug,
                title: template.title,
                condition: template.condition,
                dailyLimit: template.dailyLimit,
                points: template.points,
                isPenalty: template.isPenalty,
                icon: template.icon,
                color: template.color,
                // DTO 已验过 ageBand 合法；这里 `!` 是编译期收窄而不是「猜」。
                ageBand: ageBandFromWire(template.ageBand)!,
                focusAreas: List<String>.unmodifiable(template.focusAreas),
                sortWeight: template.sortWeight,
              ))
          .toList(growable: false),
    );

/// `PATCH /onboarding/profile` 的回包 → 状态模型。
///
/// ★ 刻意**不返回** `OnboardingView`：草稿端点不回模板库，凭空造一个空
///   `templates` 会让第⑤步突然「一条约定都没有」。调用方用
///   `OnboardingView.withDraft` 把新状态合并进已有快照。
OnboardingStateDraft mapOnboardingState(OnboardingStateDto dto) =>
    OnboardingStateDraft(
      childId: dto.childId,
      onboarded: dto.onboarded,
      onboardedAt: dto.onboardedAt,
      ageBand: dto.ageBandValue,
      focusAreas: List<String>.unmodifiable(dto.focusAreas),
    );

/// 草稿端点能提供的那部分状态（`withDraft` 的输入）。
class OnboardingStateDraft {
  const OnboardingStateDraft({
    required this.childId,
    required this.onboarded,
    required this.onboardedAt,
    required this.ageBand,
    required this.focusAreas,
  });

  final String childId;
  final bool onboarded;
  final DateTime? onboardedAt;
  final AgeBand? ageBand;
  final List<String> focusAreas;
}

/// `POST /onboarding/complete` 的回包 → 结果模型。
OnboardingResult mapOnboardingResult(OnboardingResultDto dto) => OnboardingResult(
      childId: dto.childId,
      onboardedAt: dto.onboardedAt,
      rules: dto.rules
          .map((OnboardingCreatedRuleDto rule) => OnboardingCreatedRule(
                ruleId: rule.ruleId,
                title: rule.title,
                points: rule.points,
                isPenalty: rule.isPenalty,
              ))
          .toList(growable: false),
    );

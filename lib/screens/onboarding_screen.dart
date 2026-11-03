import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../data/read_api_errors.dart';
import '../models/onboarding.dart';
import '../theme/app_colors.dart';
import '../theme/app_icons.dart';
import '../widgets/app_card.dart';
import '../widgets/form_fields.dart';
import '../widgets/gradient_page.dart';
import '../widgets/pills.dart';
import '../widgets/pin_pad.dart';
import '../widgets/soft_button.dart';

/// 首启引导（W8-B，2026-10-27 / `04` §2、§5、§6）。
///
/// ── 这一页负责的三件事 ──────────────────────────────────────────────────────
///   ① 把 7 个步骤的**状态机**放在一个页面里：①欢迎 + 同意 → ②昵称 → ③学段 →
///      ④关注点 → ⑤选约定 → ⑥PIN → ⑦完成。步骤只是界面状态，**不落库**
///      （服务端的权威状态只有 `onboardedAt` / `ageBand` / `focusAreas`）。
///   ② 每一步的**服务端写入点**必须与后端契约一一对应：
///      ①`POST /consent` ②`PATCH /child` ③④`PATCH /onboarding/profile`
///      ⑤⑥`POST /onboarding/complete`（一次提交，非幂等）。
///   ③ 失败**留在原地**并说清原因：把「没保存」画成「已保存」，家长会在第⑤步
///      看到一份与第③④步不一致的排序，却找不到是哪里错了。
///
/// ── 为什么第③④步「下一步」时各自落库 ──────────────────────────────────────
///   `04` §6 4.12 要求「中途退出再进入要接着走」。若只在完成时一次提交，
///   家长选完学段、退出、再进来会发现学段回到未选 —— 引导退化成「必须一口气走完」。
///   后端 `PATCH profile` 对「值未变」不写库不写审计，因此重复提交没有副作用。
///
/// ── 为什么第⑤步之后才提交模板 ──────────────────────────────────────────────
///   `POST /onboarding/complete` **不幂等**（重复 ⇒ 409，绝不悄悄再建一套规则）。
///   所以它只能被调用一次、且必须在家长确认选择之后；不能「每勾一条就提交一条」。
class OnboardingScreen extends StatefulWidget {
  const OnboardingScreen({super.key, this.onFinished});

  /// 第⑦步「开始打卡」：由闸门把界面切回首页（并刷新服务端快照）。
  final VoidCallback? onFinished;

  @override
  State<OnboardingScreen> createState() => _OnboardingScreenState();
}

class _OnboardingScreenState extends State<OnboardingScreen> {
  /// 0..6 对应 ①..⑦。
  int _step = 0;

  bool _bootstrapped = false;

  /// 有本地动作在途（拉同意状态 / 保存草稿 / 完成引导）。
  bool _busy = false;

  /// 当前步骤的错误文案（显示在正文顶部，不弹 SnackBar —— 全屏流程里后者会被忽略）。
  String? _error;

  // 第①步
  bool _consentChecked = false;

  // 第②步
  late final TextEditingController _nameController;
  bool _nameInitialized = false;

  // 第③步
  AgeBand? _ageBand;

  // 第④步
  final Set<String> _focusAreas = <String>{};

  // 第⑤步
  final Set<String> _selectedSlugs = <String>{};

  // 第⑥步：锁屏式数字键盘（2026-11-04，与锁屏 / 家长模式面板同一个组件）
  final PinInputController _pinController = PinInputController();

  /// 每一步的标题 / 副标题（与 `04` §2 的七个步骤逐条对应）。
  static const List<String> _titles = <String>[
    '把约定变成看得见的成长',
    '先给孩子起个名字',
    '选择孩子的学段',
    '最想先改善什么',
    '挑选第一批约定',
    '设置家长 PIN',
    '一切就绪',
  ];

  static const List<String> _subtitles = <String>[
    '每天的小事，攒成看得见的进步。开始前需要监护人同意。',
    '这本积分账本是给谁的？之后可以在「我的」里改。',
    '学段只影响约定卡片的排序，不会隐藏任何内容。',
    '可以多选；也可以跳过，约定卡片会按通用顺序排。',
    '至少选 1 条才能继续 —— 有约定，孩子才有可以做的事。',
    '用于「切到家长模式」；现在不设也可以，之后在设置里补。',
    '第一本账本已建好，点开卡片就能加分。',
  ];

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController();
    // 输入时清掉上一轮的错误提示（与旧 `TextField.onChanged` 同一行为）。
    _pinController.addListener(_clearPinError);
    // 必须在首帧之后再发请求：`refreshConsent` 一开始就 `_notify()`，
    // 在 initState 里同步调用等于 build 期间 setState。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _bootstrap();
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 昵称框的初值取自服务端快照（`GET /home` 的 `child.name`）：家长可能是
    // 中途退出后重新进入，重填一次会让人以为「上次没保存」。
    if (_nameInitialized) return;
    _nameInitialized = true;
    _nameController.text = AppScope.of(context).profile.name;
  }

  @override
  void dispose() {
    _nameController.dispose();
    _pinController.removeListener(_clearPinError);
    _pinController.dispose();
    super.dispose();
  }

  void _clearPinError() {
    if (_error == null) return;
    setState(() => _error = null);
  }

  /// 首帧之后：从服务端快照恢复草稿 + 补一次同意状态。
  ///
  /// 只拉同意（`GET /consent`）：`GET /onboarding` 已由闸门拉过，重复拉只会
  /// 让第⑤步的模板列表多跳一次。若快照不存在（理论上闸门不会进来），
  /// 就退回去拉一次完整状态。
  Future<void> _bootstrap() async {
    final AppStore store = AppScope.of(context);
    setState(() => _busy = true);
    try {
      if (store.onboarding == null) {
        await store.refreshOnboarding();
      }
      if (!mounted) return;
      final OnboardingView? snapshot = store.onboarding;
      if (snapshot != null) {
        _ageBand = snapshot.ageBand;
        _focusAreas
          ..clear()
          ..addAll(snapshot.focusAreas.where(isFocusArea));
        _nameController.text = store.profile.name;
      }
      if (store.isLiveMode) {
        // 无条件读一次同意状态：`canManageConsent` 依赖成员列表，而启动时
        // 成员列表**还没拉**（它是低频数据）。用一次 `GET /consent` 探测角色
        // 会更诚实：403 就是「不是家长」，200 就是「是家长，顺便拿到状态」。
        await store.refreshConsent();
      }
    } finally {
      if (mounted) setState(() => _busy = false);
      _bootstrapped = true;
    }
  }

  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    if (!_bootstrapped && store.onboarding == null) {
      // 还没拿到模板 / 状态：先给一个可解释的等待态，而不是画一张空卡片。
      return const Scaffold(
        backgroundColor: AppColors.pageTop,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      backgroundColor: AppColors.pageTop,
      body: GradientPage(
        child: SafeArea(
          child: Column(
            children: <Widget>[
              _buildHeader(store),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 4, 20, 24),
                  children: <Widget>[
                    if (_error != null) ...<Widget>[
                      _buildError(_error!),
                      const SizedBox(height: 12),
                    ],
                    _buildStepBody(store),
                  ],
                ),
              ),
              _buildFooter(store),
            ],
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- 步骤推进

  Future<void> _next(AppStore store) async {
    switch (_step) {
      case 0:
        return _grantAndContinue(store);
      case 1:
        return _saveNameAndContinue(store);
      case 2:
        return _saveAgeBandAndContinue(store);
      case 3:
        return _saveFocusAreasAndContinue(store);
      case 4:
        return _checkTemplatesAndContinue();
      case 5:
        return _complete(store);
      default:
        widget.onFinished?.call();
    }
  }

  /// 统一承载「在途 → 成功 / 失败」三段：失败留在原地并显示原因。
  Future<void> _run(
    Future<String?> Function() action, {
    required VoidCallback onSuccess,
  }) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    try {
      error = await action();
    } catch (unexpected) {
      error = '操作没有完成。请重试；若持续出现请反馈。';
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = error;
    });
    if (error == null) onSuccess();
  }

  /// 第①步：同意（`POST /consent`）。
  ///
  /// 已经同意过的家庭不重复提交（服务端虽然幂等），直接进下一步 ——
  /// 让家长在本该「开始设置」的按钮上再点一次「同意」是没有意义的。
  Future<void> _grantAndContinue(AppStore store) async {
    if (store.consent.isGranted) {
      setState(() {
        _error = null;
        _step = 1;
      });
      return;
    }
    if (store.consentReadStatus == ReadStatus.error) {
      final ReadApiException? error = store.consentError;
      if (error != null && error.kind == ReadFailureKind.forbidden) {
        setState(() {
          _error = '只有家长可以完成首次引导。请让家长在自己的设备上操作。';
        });
        return;
      }
      // 网络错误 / 501：重拉一次，再让家长决定要不要继续勾选。
      // 不把「没读到」当成「没同意」——那会在断网时强迫家长重复同意。
      setState(() {
        _busy = true;
        _error = null;
      });
      await store.refreshConsent();
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = store.consent.isGranted
            ? null
            : (store.consentError?.userMessage ??
                '还没确认监护人同意状态，请勾选后重试。');
      });
      if (store.consent.isGranted) setState(() => _step = 1);
      return;
    }
    if (!_consentChecked) {
      setState(() {
        _error = '请先勾选「我是该儿童的监护人，并同意为其创建积分账本」。';
      });
      return;
    }
    await _run(
      () => store.submitGrantConsent(),
      onSuccess: () => setState(() => _step = 1),
    );
  }

  /// 第②步：昵称（`PATCH /child`）。
  ///
  /// 与当前昵称相同就**不发请求**：`submitRenameChild` 会返回「昵称没有变化」，
  /// 那不该被当成错误显示在第②步。
  Future<void> _saveNameAndContinue(AppStore store) async {
    final String? invalid = validateChildName(_nameController.text);
    if (invalid != null) {
      setState(() => _error = invalid);
      return;
    }
    final String name = _nameController.text.trim();
    if (name == store.profile.name) {
      setState(() {
        _error = null;
        _step = 2;
      });
      return;
    }
    await _run(
      () => store.submitRenameChild(name),
      onSuccess: () => setState(() => _step = 2),
    );
  }

  /// 第③步：学段（`PATCH /onboarding/profile`，`null` = 显式清空）。
  Future<void> _saveAgeBandAndContinue(AppStore store) async {
    if (_ageBand == store.onboarding?.ageBand) {
      setState(() {
        _error = null;
        _step = 3;
      });
      return;
    }
    await _run(
      () => store.saveOnboardingDraft(
        ageBand: _ageBand,
        clearAgeBand: _ageBand == null,
      ),
      onSuccess: () => setState(() => _step = 3),
    );
  }

  /// 第④步：关注点（`PATCH /onboarding/profile`，`[]` = 一个都不选）。
  Future<void> _saveFocusAreasAndContinue(AppStore store) async {
    final List<String> selected =
        kFocusAreas.where(_focusAreas.contains).toList(growable: false);
    if (listEquals(selected, store.onboarding?.focusAreas ?? const <String>[])) {
      setState(() {
        _error = null;
        _step = 4;
      });
      return;
    }
    await _run(
      () => store.saveOnboardingDraft(focusAreas: selected),
      onSuccess: () => setState(() => _step = 4),
    );
  }

  /// 第⑤步：至少 1 条（`04` §6 4.2）。本地不满足时**不发请求**。
  Future<void> _checkTemplatesAndContinue() async {
    if (_selectedSlugs.isEmpty) {
      setState(() => _error = '至少选一条约定才能继续（之后可以在规则页里增删）。');
      return;
    }
    setState(() {
      _error = null;
      _step = 5;
    });
  }

  /// 第⑥步：完成引导（`POST /onboarding/complete`，非幂等，只调一次）。
  ///
  /// ★ PIN **必填**（2026-11-03，`43` §8 D7）：判据在
  ///   `validateRequiredParentPin()` 一处，本地不通过就**不发请求**。
  ///   放行空串等于让这个账号在 5 分钟后失去补设 PIN 的权限（见该函数注释）。
  Future<void> _complete(AppStore store) async {
    final String pin = _pinController.value.trim();
    final String? invalid = validateRequiredParentPin(pin);
    if (invalid != null) {
      setState(() => _error = invalid);
      return;
    }
    final List<String> selected =
        kFocusAreas.where(_focusAreas.contains).toList(growable: false);
    await _run(
      () => store.completeOnboarding(
        templateSlugs: _selectedSlugs.toList(growable: false),
        ageBand: _ageBand,
        focusAreas: selected,
        // 必填之后这里永远是 4–6 位数字；`null` 分支只留给旧版本客户端。
        parentPin: pin,
      ),
      onSuccess: () => setState(() {
        _step = 6;
      }),
    );
  }

  // ------------------------------------------------------------------ 各步正文

  Widget _buildStepBody(AppStore store) {
    switch (_step) {
      case 0:
        return _stepWelcome(store);
      case 1:
        return _stepName();
      case 2:
        return _stepAgeBand(store);
      case 3:
        return _stepFocusAreas();
      case 4:
        return _stepTemplates(store);
      case 5:
        return _stepPin();
      default:
        return _stepDone(store);
    }
  }

  /// 第①步：欢迎 + **监护人同意**（`04` §5）。
  ///
  /// 勾选前不允许继续 —— 后端 `ConsentGuard` 也会在 `complete` 时回
  /// `403 CONSENT_REQUIRED`，但那时家长已经填了昵称、选了 6 条约定，
  /// 才发现「同意没做」。同意必须在采集之前（第②步起就采集昵称）。
  Widget _stepWelcome(AppStore store) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const AppCard(
          color: AppColors.cream,
          border: false,
          padding: EdgeInsets.fromLTRB(18, 20, 18, 20),
          child: Column(
            children: <Widget>[
              Text('🌱', style: TextStyle(fontSize: 42)),
              const SizedBox(height: 10),
              const Text(
                '每天一点小进步',
                style: TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                '选好约定后，孩子点一下卡片就能加分；攒够积分可以兑换心愿。'
                '整个过程大约 1 分钟，之后随时可以改。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12.5,
                  height: 1.6,
                  color: AppColors.textSecondary,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        _buildConsentCard(store),
        const SizedBox(height: 12),
        const Text(
          '继续即表示您已阅读并同意《用户协议》与《儿童个人信息保护规则》。'
          '协议文本仍是占位版本，正式上线前会替换并重新征求同意。',
          style: TextStyle(
            fontSize: 11.5,
            height: 1.6,
            color: AppColors.textHint,
          ),
        ),
      ],
    );
  }

  Widget _buildConsentCard(AppStore store) {
    if (store.consentReadStatus == ReadStatus.loading) {
      return const AppCard(
        child: Row(
          children: <Widget>[
            SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            SizedBox(width: 10),
            Text(
              '正在确认监护人同意状态…',
              style: TextStyle(fontSize: 12.5, color: AppColors.textSecondary),
            ),
          ],
        ),
      );
    }

    if (store.consent.isGranted) {
      final String? grantedText = store.consent.grantedText;
      return AppCard(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Icon(Icons.verified_user_rounded,
                size: 20, color: AppColors.primaryDeep),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  const Text(
                    '监护人同意已记录',
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    <String>[
                      if (grantedText != null) grantedText,
                      '协议版本 ${store.consent.versionLabel}',
                    ].join(' · '),
                    style: const TextStyle(
                      fontSize: 11.5,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    // 未同意 / 已撤回 / 状态未知 —— 都要求家长亲自勾选。
    // 「状态未知」不预勾：把没确认过的同意画成已勾选，是这个页面最不该犯的错。
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (store.consent.isWithdrawn)
            const Padding(
              padding: EdgeInsets.only(bottom: 8),
              child: Text(
                '之前撤回过同意。继续前需要重新同意 —— 撤回不会删除已有数据。',
                style: TextStyle(
                  fontSize: 11.5,
                  height: 1.5,
                  color: AppColors.pointSpend,
                ),
              ),
            ),
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: _busy
                ? null
                : () => setState(() {
                      _consentChecked = !_consentChecked;
                      _error = null;
                    }),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                SizedBox(
                  width: 24,
                  height: 24,
                  child: Checkbox(
                    value: _consentChecked,
                    activeColor: AppColors.primaryDeep,
                    onChanged: _busy
                        ? null
                        : (bool? value) => setState(() {
                              _consentChecked = value ?? false;
                              _error = null;
                            }),
                  ),
                ),
                const SizedBox(width: 8),
                const Expanded(
                  child: Text(
                    '我是该儿童的监护人，并同意为其创建积分账本',
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.5,
                      fontWeight: FontWeight.w600,
                      color: AppColors.textPrimary,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }


  Widget _buildHeader(AppStore store) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Text(
                '第 ${_step + 1} / 7 步',
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w700,
                  color: AppColors.textSecondary,
                ),
              ),
              const Spacer(),
              // 圆点只是进度提示，不是可点击的步骤条 —— 不允许跳步：
              // 第⑤步之前没选学段 / 关注点，跳过去只会得到一份没排序的列表。
              Row(
                children: List<Widget>.generate(7, (int index) {
                  final bool active = index <= _step;
                  return Container(
                    width: index == _step ? 18 : 7,
                    height: 7,
                    margin: const EdgeInsets.only(left: 4),
                    decoration: BoxDecoration(
                      color: active ? AppColors.primaryDeep : AppColors.divider,
                      borderRadius: BorderRadius.circular(999),
                    ),
                  );
                }),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Text(
            _titles[_step],
            style: const TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w800,
              color: AppColors.textPrimary,
              height: 1.3,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            _subtitles[_step],
            style: const TextStyle(
              fontSize: 13,
              height: 1.55,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }

  /// 底部：上一步 / 主按钮。
  Widget _buildFooter(AppStore store) {
    final bool showBack = _step > 0 && _step < 6;
    final String label;
    switch (_step) {
      case 0:
        label = store.consent.isGranted ? '开始设置' : '同意并开始';
        break;
      case 4:
        label = '就是这几条（${_selectedSlugs.length}）';
        break;
      case 5:
        // PIN 必填（2026-11-03，`43` §8 D7）：没有「跳过并完成」这个状态 ——
        // 按钮文案不再随输入框变化，否则家长会以为留空是受支持的。
        label = '完成引导';
        break;
      case 6:
        label = '开始打卡';
        break;
      default:
        label = '下一步';
    }

    return Container(
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 16),
      decoration: const BoxDecoration(
        color: AppColors.pageTop,
        border: Border(top: BorderSide(color: AppColors.divider)),
      ),
      child: Row(
        children: <Widget>[
          if (showBack)
            TextButton(
              onPressed: _busy ? null : () => setState(() => _step--),
              child: const Text(
                '上一步',
                style: TextStyle(color: AppColors.textSecondary),
              ),
            ),
          Expanded(
            child: SoftButton(
              label: _busy ? '正在保存…' : label,
              enabled: !_busy,
              onTap: () => _next(store),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildError(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: BoxDecoration(
        color: const Color(0xFFFDF1E9),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.error_outline_rounded,
              size: 18, color: AppColors.pointSpend),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(
                fontSize: 12.5,
                height: 1.5,
                color: AppColors.textPrimary,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// 第②步：孩子昵称。
  ///
  /// 说明「孩子看到的就是这个名字」：家长容易填成「儿子」「大宝」，
  /// 而那会出现在孩子的首页与通知里。
  Widget _stepName() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const FieldLabel('孩子昵称'),
        SoftTextField(
          controller: _nameController,
          hint: '例如：小满',
          onChanged: (_) {
            if (_error != null) setState(() => _error = null);
          },
        ),
        const SizedBox(height: 10),
        const Text(
          '这个名字会出现在孩子的首页、打卡提示与通知里。之后可以在「我的」里修改。',
          style: TextStyle(
            fontSize: 11.5,
            height: 1.6,
            color: AppColors.textHint,
          ),
        ),
      ],
    );
  }

  /// 第③步：学段（可跳过）。
  Widget _stepAgeBand(AppStore store) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final AgeBand band in AgeBand.values)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: AppCard(
              onTap: _busy
                  ? null
                  : () => setState(() {
                        // 再点一次 = 取消选择（对应 `PATCH profile` 的 `null`）。
                        _ageBand = _ageBand == band ? null : band;
                        _error = null;
                      }),
              color: _ageBand == band ? AppColors.primarySoft : AppColors.surface,
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          band.label,
                          style: TextStyle(
                            fontSize: 14.5,
                            fontWeight: _ageBand == band
                                ? FontWeight.w800
                                : FontWeight.w600,
                            color: AppColors.textPrimary,
                          ),
                        ),
                        const SizedBox(height: 3),
                        Text(
                          band.hint,
                          style: const TextStyle(
                            fontSize: 11.5,
                            color: AppColors.textSecondary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (_ageBand == band)
                    const Icon(Icons.check_circle_rounded,
                        size: 20, color: AppColors.primaryDeep),
                ],
              ),
            ),
          ),
        const SizedBox(height: 2),
        Text(
          _ageBand == null
              ? '可以不选：不选时约定卡片按平台通用顺序排。'
              : '已选「${_ageBand!.label}」——只影响排序，不会隐藏任何约定。',
          style: const TextStyle(
            fontSize: 11.5,
            height: 1.6,
            color: AppColors.textHint,
          ),
        ),
        if (store.onboarding?.ageBand != null && _ageBand == null)
          const Padding(
            padding: EdgeInsets.only(top: 6),
            child: Text(
              '点「下一步」会清空服务端已保存的学段。',
              style: TextStyle(fontSize: 11.5, color: AppColors.pointSpend),
            ),
          ),
      ],
    );
  }

  /// 第④步：关注点（多选，可一个都不选）。
  Widget _stepFocusAreas() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: kFocusAreas
              .map((String area) => SoftChip(
                    label: area,
                    selected: _focusAreas.contains(area),
                    onTap: _busy
                        ? () {}
                        : () => setState(() {
                              if (!_focusAreas.remove(area)) {
                                _focusAreas.add(area);
                              }
                              _error = null;
                            }),
                  ))
              .toList(growable: false),
        ),
        const SizedBox(height: 12),
        Text(
          _focusAreas.isEmpty
              ? '一个都不选也可以：约定卡片会按学段与平台权重排序。'
              : '已选 ${_focusAreas.length} 项 —— 命中的约定会排在前面（不会隐藏其它的）。',
          style: const TextStyle(
            fontSize: 11.5,
            height: 1.6,
            color: AppColors.textHint,
          ),
        ),
      ],
    );
  }

  /// 第⑤步：模板卡片（**顺序就是服务端给的顺序**，客户端不重排）。
  Widget _stepTemplates(AppStore store) {
    final List<RuleTemplate> templates =
        store.onboarding?.templates ?? const <RuleTemplate>[];
    if (templates.isEmpty) {
      return const AppCard(
        child: Text(
          '模板库暂时是空的，引导无法继续。请联系管理员补充模板后重试。',
          style: TextStyle(
            fontSize: 12.5,
            height: 1.6,
            color: AppColors.textSecondary,
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (final RuleTemplate template in templates)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: _buildTemplateCard(template),
          ),
        const SizedBox(height: 2),
        const Text(
          '扣分约定也会被采纳，但不会加入「今天的习惯」—— 它用于家长记录，不是孩子主动打卡的项目。',
          style: TextStyle(
            fontSize: 11.5,
            height: 1.6,
            color: AppColors.textHint,
          ),
        ),
      ],
    );
  }

  Widget _buildTemplateCard(RuleTemplate template) {
    final bool selected = _selectedSlugs.contains(template.slug);
    final Color color = _templateColor(template.color);

    return AppCard(
      onTap: _busy
          ? null
          : () => setState(() {
                if (!_selectedSlugs.remove(template.slug)) {
                  _selectedSlugs.add(template.slug);
                }
                _error = null;
              }),
      color: selected ? AppColors.primarySoft : AppColors.surface,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: color.withAlpha(34),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(iconDataFor(template.icon), size: 21, color: color),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Expanded(
                      child: Text(
                        template.title,
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          color: AppColors.textPrimary,
                        ),
                      ),
                    ),
                    Text(
                      template.pointsText,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w800,
                        color: template.isPenalty
                            ? AppColors.pointSpend
                            : AppColors.pointGain,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 5),
                Text(
                  '${template.condition} · ${template.frequencyText}',
                  style: const TextStyle(
                    fontSize: 11.5,
                    color: AppColors.textSecondary,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  '${template.ageBandLabel} · ${template.focusText}',
                  style: const TextStyle(
                    fontSize: 11,
                    color: AppColors.textHint,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Icon(
            selected
                ? Icons.check_circle_rounded
                : Icons.radio_button_unchecked_rounded,
            size: 20,
            color: selected ? AppColors.primaryDeep : AppColors.textHint,
          ),
        ],
      ),
    );
  }

  /// 第⑥步：家长 PIN（**必填**，2026-11-03 / `43` §8 D7）。
  ///
  /// ★ 必须说清「为什么不能跳过」：`02` §7 的家长模式要凭 PIN 进入，而用网站码
  ///   注册 + 建孩子只发 **5 分钟**家长窗口（`POST /children` 写
  ///   `now + PARENT_MODE_TTL_MS`）。窗口一过就回落 `child`，那时既进不了家长模式，
  ///   也没有权限补设 PIN（`manage_parent_pin` 对孩子 DENY）—— 只剩「退出登录 →
  ///   用手机号/密码重新登录」一条路。把这件事写在输入框下面，家长才知道为什么
  ///   这一屏不能空着过。
  Widget _stepPin() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        const FieldLabel('家长 PIN（4–6 位数字）'),
        // 2026-11-04：与锁屏 / 家长模式面板同一个 `PinPad` —— 圆点 + 自绘数字
        // 键盘，不弹系统键盘。三处输入 PIN 的地方从此只有一种手感。
        PinPad(
          controller: _pinController,
          hintText: '4–6 位数字',
        ),
        const SizedBox(height: 10),
        const Text(
          '这一步必须设置。切到「家长模式」要用它确认身份；而引导期的家长权限只有 5 分钟，'
          '现在不设，之后再想补就得先退出登录、用手机号/密码重新登录。',
          style: TextStyle(
            fontSize: 11.5,
            height: 1.6,
            color: AppColors.textHint,
          ),
        ),
      ],
    );
  }


  /// 第⑦步：完成 —— 只说**服务端确认过的事实**。
  Widget _stepDone(AppStore store) {
    final OnboardingResult? result = store.lastOnboardingResult;
    final int habits = store.lastOnboardingHabitCount;
    final List<String> manual = store.lastOnboardingManualTitles;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        AppCard(
          color: AppColors.cream,
          border: false,
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 18),
          child: Column(
            children: <Widget>[
              const Text('🎉', style: TextStyle(fontSize: 40)),
              const SizedBox(height: 8),
              Text(
                result?.summaryText ?? '引导已完成',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                habits > 0
                    ? '其中 $habits 条已加入「今天的习惯」，回到首页点一下就能加分。'
                    : '回到首页即可开始记录；约定已保存到「积分规则」。',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 12.5,
                  height: 1.6,
                  color: AppColors.textSecondary,
                ),
              ),
            ],
          ),
        ),
        if (result != null && result.rules.isNotEmpty) ...<Widget>[
          const SizedBox(height: 16),
          const FieldLabel('本次采纳的约定'),
          AppCard(
            child: Column(
              children: <Widget>[
                for (int index = 0; index < result.rules.length; index++)
                  Padding(
                    padding: EdgeInsets.only(
                      bottom: index == result.rules.length - 1 ? 0 : 10,
                    ),
                    child: Row(
                      children: <Widget>[
                        Expanded(
                          child: Text(
                            result.rules[index].title,
                            style: const TextStyle(
                              fontSize: 13,
                              color: AppColors.textPrimary,
                            ),
                          ),
                        ),
                        Text(
                          result.rules[index].pointsText,
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w700,
                            color: result.rules[index].isPenalty
                                ? AppColors.pointSpend
                                : AppColors.pointGain,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
        if (manual.isNotEmpty) ...<Widget>[
          const SizedBox(height: 12),
          Text(
            '这些约定没有加入「今天的习惯」：${manual.join('、')}。'
            '扣分约定本来就不该作为孩子的打卡项；其余可在「积分规则」页手动加入。',
            style: const TextStyle(
              fontSize: 11.5,
              height: 1.6,
              color: AppColors.textHint,
            ),
          ),
        ],
      ],
    );
  }

  /// 模板配色（后端存 `#RRGGBB`）。非法值退回主色 —— 不因为一个颜色崩掉整页。
  Color _templateColor(String raw) {
    final String value = raw.trim();
    if (!RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(value)) {
      return AppColors.primaryDeep;
    }
    return Color(int.parse(value.substring(1), radix: 16) | 0xFF000000);
  }
}


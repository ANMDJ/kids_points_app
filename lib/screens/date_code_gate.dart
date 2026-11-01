import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/app_scope.dart';
import '../data/app_store.dart';
import '../theme/app_colors.dart';
import '../widgets/form_fields.dart';
import '../widgets/gradient_page.dart';
import '../widgets/soft_button.dart';

/// 启动闸门（W9-C，2026-10-29）：进 App 之前先要 6 位验证码。
///
/// ── 它是什么、不是什么（这一页的每个字都受这条约束）──────────────────────────
///   **是**：本机的入口软锁 —— 拿手机的人得知道今天的码才能把应用打开，
///          能挡住「小孩自己拿起手机就点进去」这类误触。
///   **不是**：登录 / 身份认证。`POST /auth/date-code` 只回 `{valid}`，
///          没有 token、没有 userId；服务端不知道是谁进来了，也不知道
///          这台设备被放行了。身份仍然只来自 `x-kp-child-id` 与会话。
///   因此界面必须自己说清这件事（底部那段说明不是免责声明，是事实），
///   否则家长会以为自己「登录」了，换台设备才发现根本没有账号。
///
/// ── 为什么它包在 `OnboardingGate` 外面 ──────────────────────────────────────
///   引导是家长做的事，验证码是「谁能用这台手机」：验证在前，引导在后。
///
/// ── 没注入客户端时直接放行 ──────────────────────────────────────────────────
///   预览模式 / 测试夹具没有 `DateCodeApi` ⇒ 没有「谁来判定对错」，本地
///   编一套规则等于把两条实现都留在仓库里。这与 `OnboardingGate` 的
///   「没注入就不启用」是同一条约定。
class DateCodeGate extends StatefulWidget {
  const DateCodeGate({super.key, required this.child});

  /// 放行后要显示的页面（引导闸门 → 首页外壳）。
  final Widget child;

  @override
  State<DateCodeGate> createState() => _DateCodeGateState();
}

class _DateCodeGateState extends State<DateCodeGate> {
  @override
  Widget build(BuildContext context) {
    final AppStore store = AppScope.of(context);
    if (!store.hasDateCodeGate) return widget.child;
    if (store.isDateCodeGateUnlocked) return widget.child;
    return _DateCodeLockScreen(store: store);
  }
}

/// 锁着时的整页界面：一个 6 位输入框 ＋ 「进入」。
class _DateCodeLockScreen extends StatefulWidget {
  const _DateCodeLockScreen({required this.store});

  final AppStore store;

  @override
  State<_DateCodeLockScreen> createState() => _DateCodeLockScreenState();
}

class _DateCodeLockScreenState extends State<_DateCodeLockScreen> {
  final TextEditingController _code = TextEditingController();

  /// 限流倒计时用的每秒回调。
  ///
  /// ★ 只在「被 429 限流中」才 `setState`：没有限流时每秒重建一次这一页会让
  ///   `pumpAndSettle` 永远等不到静止（既有用例几乎全都用它）。
  Timer? _ticker;

  /// 本组件自己的在途标记（store 里另有 `isDateCodeBusy`）。
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      if (widget.store.dateCodeRetrySecondsAt(DateTime.now()) <= 0) return;
      setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _code.dispose();
    super.dispose();
  }

  /// 还差几位（用于「还差 2 位」这类即时提示）。
  int get _remaining => 6 - _code.text.trim().length;

  /// 是否处于限流冷却期（429 给的绝对时刻现算）。
  bool get _coolingDown =>
      widget.store.dateCodeRetrySecondsAt(DateTime.now()) > 0;

  bool get _canSubmit =>
      _code.text.trim().length == 6 && !_busy && !_coolingDown;

  Future<void> _submit() async {
    if (!_canSubmit) return;
    setState(() => _busy = true);
    final String? failure =
        await widget.store.verifyDateCodeGate(_code.text.trim());
    if (!mounted) return;
    setState(() {
      _busy = false;
      // 成功后这一页马上被替换掉，清空只是让「进来的一瞬间」不留明文。
      if (failure == null) _code.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final AppStore store = widget.store;
    final String? error = store.dateCodeError;
    final int cooldown = store.dateCodeRetrySecondsAt(DateTime.now());

    return Scaffold(
      backgroundColor: AppColors.pageTop,
      body: GradientPage(
        safeTop: true,
        safeBottom: true,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 36, 24, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const Text('🌱', style: TextStyle(fontSize: 40)),
              const SizedBox(height: 14),
              const Text(
                '积分小管家',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w800,
                  color: AppColors.textPrimary,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                '请输入今天的验证码',
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: AppColors.textSecondary,
                ),
              ),
              const SizedBox(height: 20),
              const _RuleCard(),
              const SizedBox(height: 18),
              SoftTextField(
                controller: _code,
                hint: '6 位数字',
                keyboardType: TextInputType.number,
                textAlign: TextAlign.center,
                autofocus: true,
                enabled: !_busy,
                inputFormatters: <TextInputFormatter>[
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(6),
                ],
                style: const TextStyle(
                  fontSize: 24,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 8,
                  color: AppColors.textPrimary,
                ),
                onChanged: (_) => setState(() {}),
                onSubmitted: (_) => _submit(),
              ),
              if (_remaining > 0 && _remaining < 6)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    '还差 $_remaining 位',
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ),
              if (cooldown > 0)
                _Hint(
                  '试得太频繁了，请 ${_humanizeSeconds(cooldown)}后再试。',
                  danger: true,
                )
              else if (error != null)
                _Hint(error, danger: true),
              const SizedBox(height: 18),
              SoftButton(
                label: '进入',
                icon: Icons.lock_open_rounded,
                enabled: _canSubmit,
                onTap: _canSubmit ? _submit : null,
              ),
              const SizedBox(height: 22),
              const Text(
                '这是本机的入口校验，不是登录：它不会识别你是谁，也不会授予或'
                '收回任何账号权限。重启 App 需要重新输入。',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 11.5,
                  height: 1.6,
                  color: AppColors.textHint,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// 秒 → 「14 分 59 秒」。与家长 PIN 锁定文案同一口径（`ParentModeApiClient`
  /// 的同名函数），免得一处写「45 秒」、另一处写「0:45」。
  static String _humanizeSeconds(int seconds) {
    final int safe = seconds < 0 ? 0 : seconds;
    final int minutes = safe ~/ 60;
    final int rest = safe % 60;
    if (minutes == 0) return '$rest 秒';
    if (rest == 0) return '$minutes 分钟';
    return '$minutes 分 $rest 秒';
  }
}

/// 规则说明卡片。
///
/// ★ 规则**明写**在界面上（而不是「问管理员」）：码本来就可推导，藏起来只会
///   让家长在锁屏外面干着急；这道门真正的门槛是「知道今天是几号、星期几」。
class _RuleCard extends StatelessWidget {
  const _RuleCard();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: AppColors.chipBg,
        borderRadius: BorderRadius.circular(14),
      ),
      child: const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(
            '今天的码 = 月日 4 位 ＋ 星期 2 位',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          SizedBox(height: 6),
          Text(
            '星期按 ISO 编号：周一 01、周二 02 …… 周日 07。\n'
            '例：2026 年 10 月 29 日是周四 ⇒ 1029 ＋ 04 ⇒ 102904。\n'
            '跨零点前后一天（昨天 / 明天）的码同样有效。',
            style: TextStyle(
              fontSize: 12,
              height: 1.6,
              color: AppColors.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

/// 输入框下面的一行提示（错误 / 限流）。
class _Hint extends StatelessWidget {
  const _Hint(this.text, {this.danger = false});

  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 12,
          height: 1.5,
          color: danger ? AppColors.pointSpend : AppColors.textSecondary,
        ),
      ),
    );
  }
}

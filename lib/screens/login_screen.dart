import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../widgets/form_fields.dart';
import '../widgets/soft_button.dart';

/// 提交回调：返回 `null` 表示成功，返回字符串表示要显示的错误文案。
///
/// ★ 界面**不自己调网络**：它只知道"提交 → 成功/一句话"。
///   这样 widget 测试不需要伪造 HTTP，而"失败时该显示哪句话"仍由真实
///   后端文案决定（`identity.service.ts` 的 `message`）—— 不在客户端二次解释。
typedef LoginSubmit = Future<String?> Function(String identifier, String password);

/// App 登录页（W9-D，2026-10-30 / `docs/design/42-account-login-design.md` §7.2）。
///
/// ── 为什么只有一个输入框 ────────────────────────────────────────────────────
///   手机号和邮箱在**服务端**是同一个字段 `identifier`（含 `@` 即邮箱），
///   客户端不需要让用户先选"我要用手机还是邮箱" —— 那一步只会多一次点击，
///   而且选错时的提示会变成"格式不对"，用户不知道是选错了还是填错了。
///
/// ── 为什么没有"注册"与"忘记密码"按钮 ────────────────────────────────────────
///   首版**不开放注册**（`42` §5.1）；忘记密码的兜底是**回小程序重设**
///   （`42` §5.2）。两个按钮都不放，比放一个点了必然失败的按钮诚实。
///
/// ── 密码不回显在任何错误里 ─────────────────────────────────────────────────
///   所有错误分支都不拼接用户输入的密码（连长度都不提）—— 提示可能被截图、
///   被上报进日志。
class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.onSubmit,
    this.banner,
  });

  final LoginSubmit onSubmit;

  /// 顶部提示，例如「登录已过期，请重新输入密码」/「请先用小程序绑定账号」。
  final String? banner;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final TextEditingController _identifier = TextEditingController();
  final TextEditingController _password = TextEditingController();

  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _identifier.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final String who = _identifier.text.trim();
    final String password = _password.text;
    if (who.isEmpty) {
      setState(() => _error = '请填写手机号或邮箱。');
      return;
    }
    if (password.isEmpty) {
      setState(() => _error = '请填写密码。');
      return;
    }

    setState(() {
      _busy = true;
      _error = null;
    });
    final String? message = await widget.onSubmit(who, password);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _error = message;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.pageTop,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  const Icon(Icons.lock_outline, size: 40, color: AppColors.primary),
                  const SizedBox(height: 16),
                  const Text(
                    '登录积分小管家',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    '用在小程序里绑定过的手机号或邮箱登录。\n'
                    '还没绑定？打开小程序「我的 → App 登录账号」设置一次。',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12.5,
                      height: 1.6,
                      color: AppColors.textSecondary,
                    ),
                  ),
                  if (widget.banner != null) ...<Widget>[
                    const SizedBox(height: 16),
                    _Banner(text: widget.banner!),
                  ],
                  const SizedBox(height: 24),
                  const FieldLabel('手机号或邮箱'),
                  SoftTextField(
                    controller: _identifier,
                    hint: '13800138000 或 dad@example.com',
                    enabled: !_busy,
                    autofocus: true,
                    keyboardType: TextInputType.emailAddress,
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 14),
                  const FieldLabel('密码'),
                  SoftTextField(
                    controller: _password,
                    hint: '至少 8 位',
                    enabled: !_busy,
                    obscureText: _obscure,
                    onSubmitted: (_) => _submit(),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: _busy ? null : () => setState(() => _obscure = !_obscure),
                      child: Text(
                        _obscure ? '显示密码' : '隐藏密码',
                        style: const TextStyle(fontSize: 12, color: AppColors.textSecondary),
                      ),
                    ),
                  ),
                  if (_error != null) ...<Widget>[
                    _Banner(text: _error!, danger: true),
                    const SizedBox(height: 12),
                  ],
                  SoftButton(
                    label: _busy ? '正在登录…' : '登录',
                    icon: Icons.login,
                    enabled: !_busy,
                    onTap: _submit,
                  ),
                  const SizedBox(height: 22),
                  const Text(
                    '忘记密码：在小程序「我的 → App 登录账号」里重设，\n'
                    '再回来用新密码登录（不需要短信验证码）。',
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
        ),
      ),
    );
  }
}

/// 一条提示条（普通 / 危险两种）。与 `date_code_gate.dart` 的 `_Hint` 同形，
/// 但这里要能表达"错误"，故单独一份而不是强行复用。
class _Banner extends StatelessWidget {
  const _Banner({required this.text, this.danger = false});

  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final Color color = danger ? AppColors.pointSpend : AppColors.textSecondary;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      decoration: BoxDecoration(
        color: AppColors.chipBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: color.withValues(alpha: 0.25)),
      ),
      child: Text(
        text,
        style: TextStyle(fontSize: 12.5, height: 1.5, color: color),
      ),
    );
  }
}

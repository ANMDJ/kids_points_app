import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../widgets/form_fields.dart';
import '../widgets/soft_button.dart';

/// 注册提交回调：`null` = 成功，字符串 = 要显示的错误文案。
///
/// ★ 与 `LoginScreen` 同一条纪律：界面**不自己调网络**。它只负责收集
///   「邀请码 + 手机号/邮箱 + 密码 + 称呼」，成功/失败由 `AccountGate` 编排。
typedef RegisterSubmit = Future<String?> Function(
  String inviteCode,
  String identifier,
  String password,
  String? displayName,
);

/// 用**邀请码**注册（W11-A，2026-11-02 / `docs/design/45-invite-registration.md`）。
///
/// ── 为什么第一屏是邀请码，而不是「先填手机号」──────────────────────────────
///   邀请码是这条路由**唯一的授权凭据**：没有码就不能注册（`45` §0）。
///   把它放在最前面，用户在第一眼就知道「我需要先拿到一个码」——
///   而不是填完手机号和密码、点了注册才被 409 打回来。
///   W12 起码有两个来源：网站「邀请码获取」页（`GET /invite`）与
///   家庭里家长生成的家庭邀请码；两者走同一个端点，回包的 `membership`
///   分别是 `null`（网站码，随后建孩子档案）与具体成员位（家庭码）。
///
/// ── 为什么没有「用微信登录」/「获取验证码」─────────────────────────────────
///   前者要开放平台审核 + 300 元/年（`42` §1）；后者要短信服务商，而本项目
///   刻意零第三方通道（`42` §0）。忘记密码的兜底是回小程序重设，不在这里。
///
/// ── 密码不回显在任何错误里 ─────────────────────────────────────────────────
///   本地提示只说「请填写密码」，服务端文案由 `account-identifier.ts` 统一给出；
///   两处都不拼接用户输入（提示可能被截图 / 进日志）。
class RegisterScreen extends StatefulWidget {
  const RegisterScreen({
    super.key,
    required this.onSubmit,
    required this.onBack,
    this.banner,
  });

  final RegisterSubmit onSubmit;

  /// 返回登录页。**必须**提供：注册是可放弃的动作，不能把用户困在只有邀请码的屏幕上。
  final VoidCallback onBack;

  /// 顶部提示（例如「邀请码已过期，请向家长再要一个」）。
  final String? banner;

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final TextEditingController _inviteCode = TextEditingController();
  final TextEditingController _identifier = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _displayName = TextEditingController();

  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _inviteCode.dispose();
    _identifier.dispose();
    _password.dispose();
    _displayName.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_busy) return;
    final String code = _inviteCode.text.trim();
    final String who = _identifier.text.trim();
    final String password = _password.text;
    final String name = _displayName.text.trim();

    // 本地只拦**空**：码形状、标识形状、密码强度都只有服务端一份规则
    // （`invite-code.ts` / `account-identifier.ts`）。在客户端再抄一遍，
    // 两边迟早不一致，而用户会看到「本地说可以、服务端说不行」。
    if (code.isEmpty) {
      setState(() => _error = '请填写邀请码（向已经在用的家长要一个）。');
      return;
    }
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
    final String? message = await widget.onSubmit(
      code,
      who,
      password,
      name.isEmpty ? null : name,
    );
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
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: _busy ? null : widget.onBack,
                      icon: const Icon(Icons.arrow_back, size: 16),
                      label: const Text(
                        '返回登录',
                        style: TextStyle(fontSize: 12.5),
                      ),
                    ),
                  ),
                  const SizedBox(height: 4),
                  const Icon(Icons.card_giftcard_outlined,
                      size: 40, color: AppColors.primary),
                  const SizedBox(height: 14),
                  const Text(
                    '用邀请码注册',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 10),
                  const Text(
                    '邀请码有两个来源：\n'
                    '· 在网站「邀请码获取」页填手机号 + 邮箱领取（每天限量）；\n'
                    '· 或请家里已经在用的家长在小程序「我的 → 邀请码」生成。\n'
                    '用网站码注册会先建一个空账号，随后引导你建立孩子档案。',
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12.5,
                      height: 1.6,
                      color: AppColors.textSecondary,
                    ),
                  ),
                  if (widget.banner != null) ...<Widget>[
                    const SizedBox(height: 16),
                    _Notice(text: widget.banner!),
                  ],
                  const SizedBox(height: 20),
                  const FieldLabel('邀请码'),
                  SoftTextField(
                    controller: _inviteCode,
                    hint: '例如 ABCD-2345',
                    enabled: !_busy,
                    autofocus: true,
                    // 邀请码要人口头念、手动抄：键盘给大写字母 + 数字，
                    // 但**不**在这里强制大写（归一化只有服务端一份）。
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 14),
                  const FieldLabel('手机号或邮箱'),
                  SoftTextField(
                    controller: _identifier,
                    hint: '13800138000 或 dad@example.com',
                    enabled: !_busy,
                    keyboardType: TextInputType.emailAddress,
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 14),
                  const FieldLabel('设置密码'),
                  SoftTextField(
                    controller: _password,
                    hint: '至少 8 位，别用纯数字',
                    enabled: !_busy,
                    obscureText: _obscure,
                    onSubmitted: (_) => _submit(),
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed:
                          _busy ? null : () => setState(() => _obscure = !_obscure),
                      child: Text(
                        _obscure ? '显示密码' : '隐藏密码',
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.textSecondary),
                      ),
                    ),
                  ),
                  const FieldLabel('你的称呼（选填）'),
                  SoftTextField(
                    controller: _displayName,
                    hint: '例如：妈妈 / 爸爸',
                    enabled: !_busy,
                    onSubmitted: (_) => _submit(),
                  ),
                  if (_error != null) ...<Widget>[
                    const SizedBox(height: 14),
                    _Notice(text: _error!, danger: true),
                  ],
                  const SizedBox(height: 18),
                  SoftButton(
                    label: _busy ? '正在注册…' : '注册并登录',
                    icon: Icons.person_add_alt_1_outlined,
                    enabled: !_busy,
                    onTap: _submit,
                  ),
                  const SizedBox(height: 20),
                  const Text(
                    '注册即表示你已阅读并同意《用户协议》与《儿童个人信息保护规则》。\n'
                    '网站邀请码只能使用一次；家庭邀请码每注册一次会消耗一个名额。',
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

/// 一条提示条（普通 / 危险两种）。与 `login_screen.dart` 的 `_Banner` 同形，
/// 但那个是私有的 —— 复制一份（20 行）比把它改成公共 API 更小的代价。
class _Notice extends StatelessWidget {
  const _Notice({required this.text, this.danger = false});

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


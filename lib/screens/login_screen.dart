import 'dart:async';

import 'package:flutter/material.dart';

import '../app_version.dart';
import '../data/app_version_api.dart';
import '../theme/app_colors.dart';
import '../widgets/form_fields.dart';
import '../widgets/soft_button.dart';
import 'update_gate.dart';

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
/// ── 为什么默认先给「登录」，把「注册」藏在第二屏 ────────────────────────────
///   App 只支持**邀请码注册**（`45`）：注册必须有家长生成的码，否则就变成开放注册，
///   而开放注册会让「手机号打错一位」静默变成一个孤儿账号（`42` §5.1）。
///   所以主按钮是登录；「第一次用？用邀请码注册」是一个明确的次级入口 ——
///   比把两个同等大小的按钮并排更诚实（绝大多数打开 App 的人是回来登录的）。
///
/// ── 为什么没有「忘记密码」按钮 ──────────────────────────────────────────────
///   兜底是**回小程序重设**（`42` §5.2）：那里微信身份已证明，不需要短信 / 邮件。
///   放一个点了必然失败的按钮，比不放更糟。
///
/// ── 密码不回显在任何错误里 ─────────────────────────────────────────────────
///   所有错误分支都不拼接用户输入的密码（连长度都不提）—— 提示可能被截图、
///   被上报进日志。
class LoginScreen extends StatefulWidget {
  const LoginScreen({
    super.key,
    required this.onSubmit,
    this.banner,
    this.onOpenRegister,
  });

  final LoginSubmit onSubmit;

  /// 顶部提示，例如「登录已过期，请重新输入密码」/「请先用小程序绑定账号」。
  final String? banner;

  /// 「第一次用？用邀请码注册」的入口。`null` ⇒ **不显示**这个按钮
  /// （预览模式 / 未配置登录时，注册同样不可用，画一个点了没反应的按钮是撒谎）。
  final VoidCallback? onOpenRegister;

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

  /// 「忘记密码？」的 App 内说明（W11-B，2026-11-02）。
  ///
  /// ── 为什么把它做成可点入口，而不是继续写一行小字 ──────────────────────────
  ///   改密码要先证明「这个号是你的」，而本项目零短信 / 零邮件通道；
  ///   小程序里的微信登录本身就是那份证明（`42` §5.2、`45` §6.4）。
  ///   但「去哪里做」这件事必须由 App 自己讲清楚、并且**随时能再点开**，
  ///   而不是让用户在登录页读一句转述、关掉 App 后再也找不到。
  ///
  /// ★ 仍然不在 App 里直接改密码：那会绕开「证明你是号主」这一步，
  ///   等于任何拿到手机号的人都能改掉别人的密码。
  Future<void> _showForgotPassword(BuildContext context) async {
    await showDialog<void>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        backgroundColor: AppColors.surface,
        title: const Text(
          '忘记密码？',
          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
        ),
        content: const SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Text(
                'App 的登录密码要在微信小程序「积分小管家」里重设：',
                style: TextStyle(fontSize: 13, height: 1.6),
              ),
              SizedBox(height: 10),
              Text(
                '1. 打开微信小程序「积分小管家」\n'
                '2. 进入「我的 → App 登录账号」\n'
                '3. 设置新的登录密码\n'
                '4. 回到 App，用手机号/邮箱 + 新密码登录',
                style: TextStyle(fontSize: 13, height: 1.8),
              ),
              SizedBox(height: 12),
              Text(
                '微信登录已经证明是你本人，所以不需要短信或邮件验证码。',
                style: TextStyle(
                  fontSize: 12,
                  height: 1.6,
                  color: AppColors.textSecondary,
                ),
              ),
            ],
          ),
        ),
        actions: <Widget>[
          FilledButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('我知道了'),
          ),
        ],
      ),
    );
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
                    '用手机号或邮箱 + 密码登录。\n'
                    '第一次用？用邀请码注册，或先在小程序「我的 → App 登录账号」绑定一次。',
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
                  if (widget.onOpenRegister != null) ...<Widget>[
                    const SizedBox(height: 4),
                    TextButton(
                      onPressed: _busy ? null : widget.onOpenRegister,
                      child: const Text(
                        '第一次用？用邀请码注册',
                        style: TextStyle(
                          fontSize: 12.5,
                          color: AppColors.primaryDeep,
                        ),
                      ),
                    ),
                  ],
                  const SizedBox(height: 2),
                  // W11-B（2026-11-02）：忘记密码从「一行灰字」变成**可点的入口**。
                  // 以前用户读到的是「App 让我去别处」，关掉 App 后也没有任何地方
                  // 能再看到这句话；现在点开就是「在 App 里怎么完成这件事」的四步。
                  TextButton(
                    onPressed: _busy ? null : () => _showForgotPassword(context),
                    child: const Text(
                      '忘记密码？',
                      style: TextStyle(
                        fontSize: 12.5,
                        color: AppColors.textSecondary,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  const _VersionFooter(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 登录页底部的版本 / 更新入口（W11-B，2026-11-02）。
///
/// ── 为什么必须放在**登录页** ────────────────────────────────────────────────
///   原先手动检查只有「我的 → 检查更新」一个入口，而它藏在登录闸门**里面**：
///   版本太旧、登录不进去的人永远看不到它。更新检查本身已经装在闸门之外
///   （`UpdateGate`），这里只是把那个能力显示出来。
///
/// ── 有新版本时文案要变 ──────────────────────────────────────────────────────
///   「当前版本 vX · 检查更新」和「发现新版本 vY · 点此更新」是**两件事**：
///   前者是工具，后者是待办。把待办写成工具，就是用户说的「我看不到更新按钮」。
class _VersionFooter extends StatelessWidget {
  const _VersionFooter();

  @override
  Widget build(BuildContext context) {
    final AppUpdateScope? scope = AppUpdateScope.maybeOf(context);
    if (scope == null) {
      // 预览模式 / 未接版本服务：只报版本，不画一个点了没反应的按钮。
      return Text(
        '当前版本 $kAppVersionLabel',
        textAlign: TextAlign.center,
        style: const TextStyle(fontSize: 11, color: AppColors.textHint),
      );
    }

    return AnimatedBuilder(
      animation: scope.controller,
      builder: (BuildContext context, _) {
        final AppVersionInfo? latest = scope.controller.latest;
        final bool hasUpdate = scope.controller.hasUpdate && latest != null;
        return TextButton(
          onPressed: scope.controller.checking
              ? null
              : () => unawaited(scope.onCheckManually()),
          child: Text(
            hasUpdate
                ? '发现新版本 v${latest.latestVersion} · 点此更新'
                : '当前版本 $kAppVersionLabel · 检查更新',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 11.5,
              color: hasUpdate ? AppColors.primaryDeep : AppColors.textHint,
              fontWeight: hasUpdate ? FontWeight.w700 : FontWeight.w400,
            ),
          ),
        );
      },
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

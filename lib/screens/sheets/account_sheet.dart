import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/auth_api.dart';
import '../../data/auth_dto.dart';
import '../../data/password_rules.dart';
import '../../data/read_api_errors.dart';
import '../../data/write_api_errors.dart';
import '../../theme/app_colors.dart';
import '../../widgets/form_fields.dart';
import '../../widgets/sheet_frame.dart';
import '../../widgets/soft_button.dart';
import '../session_actions.dart';

/// 打开「登录账号」面板（P0-2b，2026-11-03）—— 入口固定在「我的」页。
///
/// ── 这一屏解决的是什么 ──────────────────────────────────────────────────────
///   `PUT /auth/account` 与 `GET /auth/account` 早就存在（W9-D），但 App 里
///   **没有任何界面调用它们**：想改密码、换手机号只能回小程序。
///   而小程序是「用微信登录之后才能进」的 —— 手机上没有小程序的家长
///   （或微信换了号的人）就完全是死路（`43` §0 P0-2b）。
///
/// ── 为什么先读再画 ──────────────────────────────────────────────────────────
///   不读，界面只能画空白框：用户会以为「我根本没绑过」，于是又绑一次；
///   而 `hasPassword` 决定按钮写「设置密码」还是「修改密码」—— 后者必须带
///   当前密码，猜错就是一次必然 400 的往返（与小程序 `AppAccountSheet` 同源）。
///
/// ── 明文密码的边界（与 `parent_mode_sheet.dart` 同一纪律）────────────────────
///   明文只活在两个 `TextEditingController` 里：不进 store、不进日志、
///   不进异常 detail；保存成功**立刻清空**，关掉面板即随组件卸载。
///   `auth_api.dart` 文件头的三条不变量照旧 —— 密码不落盘。
Future<void> showAccountSheet(BuildContext context) async {
  final SessionActions? actions = SessionActions.maybeOf(context);
  final AuthApi? api = actions?.authApi;
  // `null` ⇒ 预览模式 / 未接后端：「我的」页本来就不会画那一行，这里再兜一次
  // （深链 / 用例里直接调用时不至于弹出一个永远失败的空白面板）。
  if (api == null) return;
  final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);

  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (BuildContext sheetContext) =>
        AccountSheet(authApi: api, messenger: messenger),
  );
}

/// 「登录账号」面板：显示当前绑定 + 绑定手机号 / 邮箱 + 设置或修改密码。
class AccountSheet extends StatefulWidget {
  const AccountSheet({super.key, required this.authApi, this.messenger});

  final AuthApi authApi;

  /// 提交结果的 toast 载体。`null` ⇒ 用 `context` 里最近的那个
  /// （用例里只 pump 一个 `Scaffold` 就够，不需要先拿 messenger）。
  final ScaffoldMessengerState? messenger;

  @override
  State<AccountSheet> createState() => _AccountSheetState();
}

class _AccountSheetState extends State<AccountSheet> {
  final TextEditingController _phone = TextEditingController();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _password = TextEditingController();
  final TextEditingController _currentPassword = TextEditingController();

  /// `null` = 还没读到（**不是**「什么都没绑」）。两者在界面上是相反的结论。
  AccountInfo? _info;
  bool _loading = true;
  String? _loadError;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // 首帧之后再拉：`_load()` 里会 setState，在 initState 同步调用等于
    // build 期间 setState（与 `parent_mode_sheet.dart` 同款处理）。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_load());
    });
  }

  @override
  void dispose() {
    _phone.dispose();
    _email.dispose();
    _password.dispose();
    _currentPassword.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final AccountInfo info = await widget.authApi.fetchAccount();
      if (!mounted) return;
      setState(() {
        _info = info;
        _loading = false;
      });
    } on WriteApiException catch (error) {
      _failLoad(error.userMessage);
    } on ReadApiException catch (error) {
      _failLoad(error.userMessage);
    }
  }

  /// 读失败**不能**画成「还没绑」：那样用户会去绑一个已经绑过的号，
  /// 得到一句「这个手机号已经被另一个账号绑定了」（其实就是他自己）。
  void _failLoad(String message) {
    if (!mounted) return;
    setState(() {
      _info = null;
      _loading = false;
      _loadError = message;
    });
  }

  /// 状态行：把**服务端事实**摊开说 —— 绑了什么、还差什么、现在能不能登。
  String _statusLine(AccountInfo info) {
    final List<String> bound = <String>[
      if (info.maskedPhone != null) info.maskedPhone!,
      if (info.email != null) info.email!,
    ];
    if (bound.isEmpty) {
      // `AccountInfo.fromJson` 其实不允许「三者全空」的账号（会判 malformed），
      // 但真到了这里也必须说人话，而不是画一个空白状态行。
      return '还没有绑定手机号/邮箱：绑定一个并设置密码后，才能用这台手机登录。';
    }
    final String label = bound.join(' ／ ');
    return info.hasPassword
        ? '已绑定 $label，可以用手机号或邮箱 + 密码登录。'
        : '已绑定 $label，但还没有设置密码 —— 现在还不能在 App 里登录。';
  }

  Widget _form(AccountInfo info) {
    final bool hasPassword = info.hasPassword;
    final String? maskedPhone = info.maskedPhone;
    final String? email = info.email;
    final String? error = _error;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _Notice(text: _statusLine(info)),
        const SizedBox(height: 16),
        const FieldLabel('手机号'),
        SoftTextField(
          controller: _phone,
          hint: maskedPhone == null
              ? '11 位手机号，例如 13800138000'
              : '当前 $maskedPhone；换号请直接填新号',
          enabled: !_busy,
          keyboardType: TextInputType.phone,
        ),
        const SizedBox(height: 14),
        const FieldLabel('邮箱'),
        SoftTextField(
          controller: _email,
          hint: email == null ? '没有手机号也可以只绑邮箱' : '当前 $email；换邮箱请填新地址',
          enabled: !_busy,
          keyboardType: TextInputType.emailAddress,
        ),
        const SizedBox(height: 14),
        FieldLabel(hasPassword ? '新密码' : '设置密码'),
        SoftTextField(
          controller: _password,
          hint: '8–64 位，至少含一个字母',
          enabled: !_busy,
          // 遮住输入，并关掉输入法的联想 / 纠错（否则密码会被"记住"）。
          obscureText: true,
        ),
        // ★ 要求**常驻**：占位符在输入第一个字符时就消失，而密码要求恰恰是
        //   「输到一半才发现不合规」时最需要看到的那句话。
        const _HintLine(kPasswordRequirementHint),
        if (hasPassword) ...<Widget>[
          const SizedBox(height: 14),
          const FieldLabel('当前密码'),
          SoftTextField(
            controller: _currentPassword,
            hint: '修改密码必须先验证旧密码',
            enabled: !_busy,
            obscureText: true,
          ),
        ],
        if (error != null) ...<Widget>[
          const SizedBox(height: 14),
          _Notice(text: error, danger: true),
        ],
        const SizedBox(height: 16),
        SoftButton(
          label: _busy ? '正在保存…' : '保存',
          icon: Icons.check_rounded,
          enabled: !_busy,
          onTap: () => unawaited(_save()),
        ),
        const SizedBox(height: 14),
        const _Notice(
          text: '密码只用于 App 登录，不会改变小程序的微信登录状态；'
              'App 不保存密码原文，服务端存的是慢哈希。'
              '忘记密码时回到这里重设即可（App 没有短信验证码通道）。',
        ),
      ],
    );
  }

  /// 保存。**只提交改动过的字段**。
  ///
  /// ── 为什么不是「把几个框都发一遍」──────────────────────────────────────────
  ///   用户只想改密码时手机号框是空的；把空串也发出去，服务端会把它当成
  ///   「要改成空手机号」（400，或更糟：清掉绑定）。「空 = 不改」必须由客户端
  ///   保证，因为 JSON 里 `null` / 缺省 / 空串是三种意思，而服务端只认「字段在不在」。
  Future<void> _save() async {
    if (_busy) return;
    final AccountInfo? info = _info;
    if (info == null) return;

    final String nextPhone = _phone.text.trim();
    final String nextEmail = _email.text.trim();
    final String? phone =
        nextPhone.isEmpty || nextPhone == (info.phone ?? '') ? null : nextPhone;
    final String? email =
        nextEmail.isEmpty || nextEmail == (info.email ?? '') ? null : nextEmail;
    final String password = _password.text;
    final String currentPassword = _currentPassword.text;

    if (phone == null && email == null && password.isEmpty) {
      setState(() => _error = '没有要保存的改动。填手机号、邮箱或密码后再点保存。');
      return;
    }

    if (password.isNotEmpty) {
      // 与注册 / 小程序同一份规则镜像（`password_rules.dart`）。
      // 服务端仍然是唯一裁定者，本地这层只是「少一次必然失败的往返」。
      final PasswordCheck check = checkPasswordStrength(
        password,
        identifier: phone ?? email ?? info.phone ?? info.email,
      );
      if (!check.ok) {
        setState(() => _error = check.message);
        return;
      }
      // 服务端在「已有密码」时**强制**要求当前密码（`CURRENT_PASSWORD_REQUIRED`）。
      // 本地先拦一次：那是一次注定 400 的往返，而错误框出现在保存按钮下方，
      // 用户会以为是自己新密码写错了。
      if (info.hasPassword && currentPassword.isEmpty) {
        setState(() => _error = '修改密码前请先填写当前密码。');
        return;
      }
    }

    setState(() {
      _busy = true;
      _error = null;
    });

    try {
      final AccountInfo next = await widget.authApi.updateAccount(
        phone: phone,
        email: email,
        password: password.isEmpty ? null : password,
        // 没改密码时不带这个字段：服务端会把它当成「要验证旧密码」。
        currentPassword:
            password.isNotEmpty && info.hasPassword ? currentPassword : null,
      );
      if (!mounted) return;
      setState(() {
        _info = next;
        _busy = false;
        // 明文立刻消失；输入框清空，状态行会显示「已绑定 138****8000」。
        _phone.clear();
        _email.clear();
        _password.clear();
        _currentPassword.clear();
      });
      _toast('已保存');
    } on WriteApiException catch (error) {
      if (!mounted) return;
      // ★ `403 CURRENT_PASSWORD_INVALID` 是**已认证**的用户给错了旧密码，
      //   不是 401 —— `_send` 不会清 token，界面也不该跳登录页。
      //   文案取服务端原文（`write_api_errors.dart` 已经映射好）。
      setState(() {
        _busy = false;
        _error = error.userMessage;
      });
      // 失败后重读一次：手机号可能刚好被别人抢注（409），而界面上的
      // 「当前绑定」还是打开面板那一刻的旧事实。`_load()` 不动 `_error`，
      // 刚才那句原因会继续留在界面上。
      unawaited(_load());
    } on ReadApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = error.userMessage;
      });
    } on ArgumentError catch (error) {
      if (!mounted) return;
      // 本地参数拦截（例如「至少要填一个」）—— 不是网络失败，别让用户重试。
      setState(() {
        _busy = false;
        _error = error.message?.toString() ?? error.toString();
      });
    }
  }

  void _toast(String message) {
    final ScaffoldMessengerState? messenger =
        widget.messenger ?? ScaffoldMessenger.maybeOf(context);
    messenger?.hideCurrentSnackBar();
    messenger?.showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return SheetFrame(
      title: '登录账号',
      subtitle: '这个手机号/邮箱 + 密码，用来在 App 里登录',
      child: _loading
          ? const Padding(
              padding: EdgeInsets.symmetric(vertical: 28),
              child: Center(child: CircularProgressIndicator()),
            )
          : _body(),
    );
  }

  Widget _body() {
    final String? loadError = _loadError;
    if (loadError != null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          _Notice(text: loadError, danger: true),
          const SizedBox(height: 14),
          SoftButton(
            label: '重新读取',
            icon: Icons.refresh_rounded,
            onTap: () => unawaited(_load()),
          ),
        ],
      );
    }
    final AccountInfo info = _info!;
    return _form(info);
  }
}

/// 面板里的一行提示 / 一条错误（**常驻**，不是 SnackBar —— 错误要留在原地
/// 让用户照着改，SnackBar 三秒后就没了）。
class _Notice extends StatelessWidget {
  const _Notice({required this.text, this.danger = false});

  final String text;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: danger
            ? AppColors.pointSpend.withValues(alpha: 0.08)
            : AppColors.cream,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 12.5,
          height: 1.55,
          color: danger ? AppColors.pointSpend : AppColors.textSecondary,
        ),
      ),
    );
  }
}

/// 输入框下面的一行小字（要求 / 说明，**常驻**而不是占位符）。
class _HintLine extends StatelessWidget {
  const _HintLine(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 7, left: 2, right: 2),
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 11.5,
          height: 1.5,
          color: AppColors.textHint,
        ),
      ),
    );
  }
}

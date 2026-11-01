import 'package:flutter/material.dart';

import '../data/auth_api.dart';
import '../data/read_api.dart' show ReadApiConfig;
import '../data/token_store.dart' show AuthTokenHolder;
import '../data/write_api_errors.dart' show WriteApiException;
import 'login_screen.dart';

/// 启动闸门：**没有 token ⇒ 登录页**（W9-D，2026-10-30 / `42` §7.2）。
///
/// ── 它在三层闸门里的位置 ────────────────────────────────────────────────────
///   `AccountGate`（你是谁）→ `DateCodeGate`（谁能用这台手机）→
///   `OnboardingGate`（家长还要完成哪些事）→ `HomeShell`
///   登录在最外层：后面两层都建立在"已经有身份"之上。
///
/// ── ★ 与 `DateCodeGate` 相反的一条方向性约束 ────────────────────────────────
///   `DateCodeGate` 拿不到状态时**继续锁着**（那是门锁，失败要朝安全的方向倒）。
///   `AccountGate` 在**没配后端**时**直接放行**（预览模式）：本地预览根本没有
///   账号这回事，硬要登录会把"没配 `--dart-define` 的开发者"挡在自己 App 外面
///   —— 那正是 `40` §10.1 规矩三要避免的。
///   判据只有一条：`ReadApiConfig.isConfigured`（与读/写客户端**同一个**函数，
///   不另立一套"算不算配好"）。
///
/// ── 为什么监听 `holder.signedIn` ─────────────────────────────────────────────
///   `AuthApiClient` 收到 401 会清 token（那张凭据服务端已经不认）。
///   闸门若只在启动时判一次，用户会停在一个"每个请求都 401"的界面上。
///   监听 ⇒ 凭据一失效就切回登录页，且**不需要**每个页面各自处理 401。
class AccountGate extends StatefulWidget {
  const AccountGate({
    super.key,
    required this.child,
    this.holder,
    this.authApi,
    this.config,
  });

  final Widget child;

  /// `null` ⇒ 不做任何检查（用例里只关心内层组件时用）。
  final AuthTokenHolder? holder;

  /// `null` ⇒ 登录页会显示"这个版本没有配置账号登录"（不假装能登）。
  final AuthApi? authApi;

  /// 省略 ⇒ 读编译期常量（`--dart-define`）。
  final ReadApiConfig? config;

  @override
  State<AccountGate> createState() => _AccountGateState();
}

enum _Phase { checking, signedIn, needLogin }

class _AccountGateState extends State<AccountGate> {
  _Phase _phase = _Phase.checking;
  String? _banner;

  @override
  void initState() {
    super.initState();
    widget.holder?.signedIn.addListener(_onAuthChanged);
    _bootstrap();
  }

  @override
  void dispose() {
    widget.holder?.signedIn.removeListener(_onAuthChanged);
    super.dispose();
  }

  void _onAuthChanged() {
    if (!mounted) return;
    final bool signedIn = widget.holder?.hasToken ?? true;
    setState(() {
      if (signedIn) {
        _phase = _Phase.signedIn;
        _banner = null;
      } else {
        // token 被清 ⇒ 是**过期/被撤销**，不是"从没登录过"。文案要能区分，
        // 否则用户会以为自己第一次用这个 App。
        if (_phase == _Phase.signedIn) {
          _banner = '登录已过期（或已在别处退出），请重新输入密码。';
        }
        _phase = _Phase.needLogin;
      }
    });
  }

  Future<void> _bootstrap() async {
    final AuthTokenHolder? holder = widget.holder;
    final ReadApiConfig config = widget.config ?? ReadApiConfig.fromEnvironment();

    // 没配后端 ⇒ 预览模式：没有账号这回事，直接放行（见文件头）。
    if (holder == null || !config.isConfigured) {
      if (mounted) setState(() => _phase = _Phase.signedIn);
      return;
    }

    await holder.restore();
    if (!mounted) return;
    setState(() => _phase = holder.hasToken ? _Phase.signedIn : _Phase.needLogin);
  }

  Future<String?> _submit(String identifier, String password) async {
    final AuthApi? api = widget.authApi;
    if (api == null) {
      return '这个版本没有配置账号登录（缺 KP_API_BASE_URL）。';
    }
    try {
      await api.loginAccount(identifier: identifier, password: password);
      // ★ 这里**显式**切页，不依赖 `AuthApiClient` 恰好会推 `signedIn`：
      //   闸门不该把"必须通知我"变成 api 实现的隐藏义务（替身很容易漏掉，
      //   而漏掉的表现是"登录成功了却还停在登录页"）。
      //   监听器仍然保留 —— 它负责另一种情况：**已经进 App 之后**，某次请求
      //   401 把 token 清掉（那时栈上没有 `_submit`）。
      if (mounted) {
        setState(() {
          _phase = _Phase.signedIn;
          _banner = null;
        });
      }
      return null;
    } on WriteApiException catch (error) {
      return error.userMessage;
    } on ArgumentError catch (error) {
      return error.message?.toString() ?? '请检查输入。';
    }
  }

  @override
  Widget build(BuildContext context) {
    switch (_phase) {
      case _Phase.checking:
        return const Scaffold(
          body: Center(child: CircularProgressIndicator()),
        );
      case _Phase.signedIn:
        return widget.child;
      case _Phase.needLogin:
        return LoginScreen(onSubmit: _submit, banner: _banner);
    }
  }
}

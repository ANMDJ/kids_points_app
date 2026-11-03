import 'dart:async';

import 'package:flutter/material.dart';

import '../data/auth_api.dart';
import '../data/auth_dto.dart';
import '../data/identity_api.dart';
import '../data/read_api.dart' show ReadApiConfig;
import '../data/read_api_errors.dart' show ReadApiException;
import '../data/session_scope.dart';
import '../data/token_store.dart' show AuthTokenHolder;
import '../data/write_api_errors.dart' show WriteApiException, WriteFailureKind;
import 'create_child_screen.dart';
import 'login_screen.dart';
import 'register_screen.dart';
import 'session_actions.dart';

/// 启动闸门：**没有 token ⇒ 登录页；有 token 但没有孩子会话 ⇒ 先建立会话**
/// （W9-D 建立；W10-B / P0-1 补齐运行期身份，2026-11-02）。
///
/// ── 它在三层闸门里的位置 ────────────────────────────────────────────────────
///   `AccountGate`（你是谁 + 你在哪个孩子上）→ `DateCodeGate`（谁能用这台手机）
///   → `OnboardingGate`（家长还要完成哪些事）→ `HomeShell`
///
/// ── ★ 为什么需要中间态（P0-1 的核心）────────────────────────────────────────
///   后端 `DeviceSessionGuard` 要求 `(x-kp-device-id, x-kp-child-id)` 对应的
///   `DeviceSession` 行存在，且与 token 同源。登录只给了 token，**没有**给
///   会话行。以前 App 靠编译期常量"假装"有会话；现在必须真的调
///   `POST /auth/child-session`。如果不加中间态，用户会先看到首页、再被
///   一连串 401 打回登录页 —— 那是最难解释的体验。
///
/// ── 四个出口（每一个都对应一种可以继续的状态）──────────────────────────────
///   · `signedIn`  —— 有 token + 有 childId：放行到 App；
///   · `needLogin` —— 没 token / token 失效：登录页（带过期提示）；
///   · `needChild` —— 有 token 但一个孩子都没有：建孩子引导（可执行，不是死路）；
///   · `blocked`   —— 会话建立失败（断网 / 403）：可重试，也可重新登录。
///
/// ── ★ 与 `DateCodeGate` 相反的方向性约束 ────────────────────────────────────
///   `DateCodeGate` 拿不到状态时**继续锁着**（门锁要朝安全方向倒）。
///   `AccountGate` 在**没配后端**时**直接放行**（预览模式）：本地预览没有
///   账号这回事，硬要登录会把"没配 `--dart-define` 的开发者"挡在 App 外面。
///   判据只有一条：`ReadApiConfig.hasBaseUrl`。
class AccountGate extends StatefulWidget {
  const AccountGate({
    super.key,
    required this.child,
    this.holder,
    this.authApi,
    this.identityApi,
    this.session,
    this.config,
    this.onIdentityChanged,
  });

  final Widget child;

  /// `null` ⇒ 不做任何检查（用例里只关心内层组件时用）。
  final AuthTokenHolder? holder;

  /// `null` ⇒ 登录页会显示"这个版本没有配置账号登录"（不假装能登）。
  final AuthApi? authApi;

  /// `null` ⇒ 退化成 W9-D 的行为（登录成功即放行，不建立孩子会话）。
  final IdentityApi? identityApi;

  /// 运行期身份（设备 id / 孩子 id）。`null` ⇒ 用编译期配置（旧用例）。
  final SessionScope? session;

  /// 省略 ⇒ 读编译期常量（`--dart-define`）。
  final ReadApiConfig? config;

  /// 身份切换（登录 / 换账号 / 建孩子）后清空页面级缓存。
  final VoidCallback? onIdentityChanged;

  @override
  State<AccountGate> createState() => _AccountGateState();
}

enum _Phase {
  checking,
  preparing,
  signedIn,
  needLogin,
  /// 登录页的「第一次用？用邀请码注册」分支（W11-A）。
  needRegister,
  needChild,
  blocked,
}

class _AccountGateState extends State<AccountGate> {
  _Phase _phase = _Phase.checking;
  String? _banner;
  String? _blockedMessage;

  /// 登录 / 建孩子的提交过程中，不要被 `signedIn` 监听器打断
  /// （`AuthApiClient` 在登录成功那一刻就会推 `signedIn`）。
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    widget.holder?.signedIn.addListener(_onAuthChanged);
    unawaited(_bootstrap());
  }

  @override
  void dispose() {
    widget.holder?.signedIn.removeListener(_onAuthChanged);
    super.dispose();
  }

  void _onAuthChanged() {
    if (!mounted || _submitting) return;
    // 启动 / 建立会话期间 `holder.restore()` 本身会把 `signedIn` 置 true；
    // 那不是"外部登录完成"，重复走一遍 `_ensureChild` 会打两次 child-session。
    if (_phase == _Phase.checking || _phase == _Phase.preparing) return;
    if (widget.holder?.hasToken ?? true) {
      unawaited(_ensureChild());
    } else {
      // token 被清 ⇒ 是**过期/被撤销**，不是"从没登录过"。文案要能区分。
      final bool wasInside = _phase == _Phase.signedIn;
      unawaited(widget.session?.clearChild() ?? Future<void>.value());
      setState(() {
        if (wasInside) _banner = '登录已过期（或已在别处退出），请重新输入密码。';
        _phase = _Phase.needLogin;
      });
    }
  }

  Future<void> _bootstrap() async {
    final AuthTokenHolder? holder = widget.holder;
    final ReadApiConfig config =
        widget.config ?? ReadApiConfig.fromEnvironment(session: widget.session);

    // 没配后端 ⇒ 预览模式：没有账号这回事，直接放行（见文件头）。
    if (holder == null || !config.hasBaseUrl) {
      if (mounted) setState(() => _phase = _Phase.signedIn);
      return;
    }

    await holder.restore();
    if (!mounted) return;
    if (!holder.hasToken) {
      setState(() => _phase = _Phase.needLogin);
      return;
    }
    await _ensureChild();
  }

  /// 有 token 之后：确保 `SessionScope` 里有一个**服务端认可**的 childId。
  Future<void> _ensureChild() async {
    final SessionScope? scope = widget.session;
    final IdentityApi? identity = widget.identityApi;
    // 旧路径（用例 / 还没有本类）：登录成功即放行，行为逐字不变。
    if (scope == null || identity == null) {
      if (mounted) setState(() => _phase = _Phase.signedIn);
      return;
    }

    await scope.restore();
    if (!mounted) return;
    if (scope.hasChild) {
      setState(() => _phase = _Phase.signedIn);
      return;
    }

    setState(() {
      _phase = _Phase.preparing;
      _banner = null;
    });
    try {
      final List<ChildMembership> children = await identity.fetchMemberships();
      if (!mounted) return;
      if (children.isEmpty) {
        setState(() => _phase = _Phase.needChild);
        return;
      }
      // D1（`43` §8）：首版只支持一个孩子；多孩子时仍取第一个，
      // 但这是**明确的产品选择**，不是静默丢数据。
      final ChildSessionResult result =
          await identity.establishChildSession(children.first.childId);
      await scope.adoptChild(childId: result.childId, role: result.role);
      widget.onIdentityChanged?.call();
      if (!mounted) return;
      setState(() => _phase = _Phase.signedIn);
    } on WriteApiException catch (error) {
      _handleIdentityFailure(error);
    } on ReadApiException catch (error) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.blocked;
        _blockedMessage = error.userMessage;
      });
    }
  }

  void _handleIdentityFailure(WriteApiException error) {
    if (!mounted) return;
    if (error.kind == WriteFailureKind.unauthenticated) {
      setState(() {
        _phase = _Phase.needLogin;
        _banner = error.userMessage;
      });
      return;
    }
    setState(() {
      _phase = _Phase.blocked;
      _blockedMessage = error.userMessage;
    });
  }

  Future<String?> _submit(String identifier, String password) async {
    final AuthApi? api = widget.authApi;
    if (api == null) {
      return '这个版本没有配置账号登录（缺 KP_API_BASE_URL）。';
    }
    _submitting = true;
    // ★ 换账号：先清掉上一个账号的 childId，再登录。
    //   旧值留在配置里 ⇒ 新账号第一个请求会带着别人的孩子上下文。
    await widget.session?.beginAccount();
    try {
      final AuthLoginResult result = await api.loginAccount(
        identifier: identifier,
        password: password,
      );
      if (!mounted) return null;
      return await _enterWith(result);
    } on WriteApiException catch (error) {
      if (!mounted) return error.userMessage;
      // ★ 不清 `_banner`、也不设它：错误由登录页自己那一行显示。
      //   两边都写会看到同一句话出现两次（`account_login_test` 的回归）。
      setState(() => _phase = _Phase.needLogin);
      return error.userMessage;
    } on ArgumentError catch (error) {
      return error.message?.toString() ?? '请检查输入。';
    } finally {
      _submitting = false;
    }
  }

  /// 用**邀请码注册**（W11-A / `45`）。与 [_submit] 的差别只有一处：
  /// 失败时回到**注册页**（`needRegister`），而不是登录页 —— 因为用户还没账号，
  /// 把他弹回登录页等于把刚输入的邀请码和手机号全丢掉。
  ///
  /// ★ 一旦 `registerWithInvite` 成功（账号已建好、token 已收下），后续建立
  ///   child-session 的失败**不能**再退回注册页：再点一次会得到
  ///   409 `IDENTIFIER_TAKEN`，而用户会以为自己没注册成功。
  ///   那种情况走 [_handleIdentityFailure]（可重试 / 重新登录）。
  Future<String?> _register(
    String inviteCode,
    String identifier,
    String password,
    String? displayName,
  ) async {
    final AuthApi? api = widget.authApi;
    if (api == null) {
      return '这个版本没有配置账号登录（缺 KP_API_BASE_URL）。';
    }
    _submitting = true;
    // 与登录同一条：先清掉上一个账号的 childId，再拿新身份。
    await widget.session?.beginAccount();
    try {
      final AuthLoginResult result = await api.registerWithInvite(
        inviteCode: inviteCode,
        identifier: identifier,
        password: password,
        displayName: displayName,
      );
      if (!mounted) return null;
      try {
        return await _enterWith(result);
      } on WriteApiException catch (error) {
        if (!mounted) return error.userMessage;
        _handleIdentityFailure(error);
        return error.userMessage;
      } on ReadApiException catch (error) {
        if (!mounted) return error.userMessage;
        setState(() {
          _phase = _Phase.blocked;
          _blockedMessage = error.userMessage;
        });
        return error.userMessage;
      }
    } on WriteApiException catch (error) {
      if (!mounted) return error.userMessage;
      // 注册失败：留在注册页，且不让错误同时出现在顶部 banner 与表单下方。
      setState(() => _phase = _Phase.needRegister);
      return error.userMessage;
    } on ArgumentError catch (error) {
      return error.message?.toString() ?? '请检查输入。';
    } finally {
      _submitting = false;
    }
  }

  /// 拿到凭据之后的**共同编排**：把 token 落到「这台设备 + 这个孩子」上。
  ///
  /// 登录与注册的成功路径逐字相同，所以抽成一个方法 —— 两份手抄的下一步
  /// 就是「注册走了新路径、登录忘了改」。
  Future<String?> _enterWith(AuthLoginResult result) async {
    final IdentityApi? identity = widget.identityApi;
    final SessionScope? scope = widget.session;

    if (result.childId != null && identity != null && scope != null) {
      setState(() {
        _phase = _Phase.preparing;
        _banner = null;
      });
      final ChildSessionResult session =
          await identity.establishChildSession(result.childId!);
      await scope.adoptChild(childId: session.childId, role: session.role);
      widget.onIdentityChanged?.call();
      if (!mounted) return null;
      setState(() => _phase = _Phase.signedIn);
      return null;
    }

    if (identity != null && scope != null) {
      // 回包里的 `membership` 只是"我猜你只有一个孩子"；
      // 真正的权威来源是 `GET /auth/session`（可能刚被邀请进一个家庭）。
      await _ensureChild();
      return null;
    }

    // 旧路径（测试 / 未注入身份客户端）：拿到 token 即放行。
    setState(() {
      _phase = _Phase.signedIn;
      _banner = null;
    });
    return null;
  }

  Future<String?> _createChild(String name) async {
    final IdentityApi? identity = widget.identityApi;
    final SessionScope? scope = widget.session;
    if (identity == null || scope == null) {
      return '这个版本没有配置账号登录（缺 KP_API_BASE_URL）。';
    }
    setState(() => _phase = _Phase.preparing);
    try {
      // ① 先同意（请求体里没有昵称）→ ② 建立 child-session → ③ 再改名。
      final BootstrapChildResult boot = await identity.bootstrapChild();
      final ChildSessionResult session =
          await identity.establishChildSession(boot.childId);
      await scope.adoptChild(childId: session.childId, role: session.role);

      final String trimmed = name.trim();
      if (trimmed.isNotEmpty) {
        try {
          await identity.renameChild(trimmed);
        } on Exception catch (error) {
          // 改名失败不把家长困住：档案已经是「宝贝」，可以在「我的」里再改。
          debugPrint('[identity] 孩子昵称设置失败（可在「我的」里重试）：$error');
        }
      }

      widget.onIdentityChanged?.call();
      if (!mounted) return null;
      setState(() => _phase = _Phase.signedIn);
      return null;
    } on WriteApiException catch (error) {
      if (!mounted) return error.userMessage;
      setState(() => _phase = _Phase.needChild);
      return error.userMessage;
    } on ReadApiException catch (error) {
      if (!mounted) return error.userMessage;
      setState(() => _phase = _Phase.needChild);
      return error.userMessage;
    } on ArgumentError catch (error) {
      if (!mounted) return error.message?.toString();
      setState(() => _phase = _Phase.needChild);
      return error.message?.toString() ?? '请检查输入。';
    }
  }

  Future<void> _retryIdentity() async {
    setState(() {
      _phase = _Phase.preparing;
      _blockedMessage = null;
    });
    await _ensureChild();
  }

  Future<void> _signOut() async {
    await widget.session?.clearChild();
    await widget.authApi?.logout();
    // ★ 与「换账号」同一条：上一个孩子的读缓存不能留给下一个人看
    //   （`onIdentityChanged` 在 `main.dart` 绑到 `AppStore.resetForIdentity`）。
    widget.onIdentityChanged?.call();
    if (!mounted) return;
    setState(() {
      _phase = _Phase.needLogin;
      _banner = '已退出登录，请重新输入密码。';
    });
  }

  @override
  Widget build(BuildContext context) {
    switch (_phase) {
      case _Phase.checking:
        return const _StatusScaffold(text: '正在检查登录状态…');
      case _Phase.preparing:
        return const _StatusScaffold(text: '正在建立本机会话…');
      case _Phase.signedIn:
        // 换账号 / 换孩子时重建整棵子树：首页的本地状态（选中 tab、滚动）
        // 不应该跨身份复用。AppStore 的清理由 `onIdentityChanged` 负责。
        return KeyedSubtree(
          key: ValueKey<String>(
              'kp-session-${widget.session?.childId ?? 'static'}'),
          // P0-2：把「退出登录」交给下层页面（「我的」页），动作仍只有这一份
          // 实现（见 `session_actions.dart` 文件头）。
          child: SessionActions(
            signOut: _signOut,
            // P0-2b：账号绑定 / 改密走的必须是**同一个** holder（见
            // `session_actions.dart` 里 `authApi` 的说明）；`null` ⇒ 预览模式，
            // 「我的」页不会画「登录账号」。
            authApi: widget.authApi,
            child: widget.child,
          ),
        );
      case _Phase.needLogin:
        return LoginScreen(
          onSubmit: _submit,
          banner: _banner,
          // `authApi == null` ⇒ 预览模式：注册同样不可用，不画一个点了没反应的入口。
          onOpenRegister: widget.authApi == null
              ? null
              : () => setState(() {
                    _phase = _Phase.needRegister;
                    _banner = null;
                  }),
        );
      case _Phase.needRegister:
        // 注册是**可放弃的**：返回登录不需要清 token（此时本来就没有）。
        return RegisterScreen(
          onSubmit: _register,
          onBack: () => setState(() {
            _phase = _Phase.needLogin;
            _banner = null;
          }),
          banner: _banner,
        );
      case _Phase.needChild:
        return CreateChildScreen(onSubmit: _createChild);
      case _Phase.blocked:
        return _BlockedScreen(
          message: _blockedMessage ?? '建立本机会话失败。',
          onRetry: _retryIdentity,
          onSignOut: _signOut,
        );
    }
  }
}

/// 两句话 + 一个转圈：只在"正在检查 / 正在建立会话"时出现。
class _StatusScaffold extends StatelessWidget {
  const _StatusScaffold({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const CircularProgressIndicator(),
            const SizedBox(height: 16),
            Text(
              text,
              style: const TextStyle(fontSize: 13, color: Colors.black54),
            ),
          ],
        ),
      ),
    );
  }
}

/// 会话建立失败：**可重试**，也可以换账号（`43` §3 P0-1 验收判据）。
class _BlockedScreen extends StatelessWidget {
  const _BlockedScreen({
    required this.message,
    required this.onRetry,
    required this.onSignOut,
  });

  final String message;
  final Future<void> Function() onRetry;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              const Icon(Icons.cloud_off_outlined,
                  size: 40, color: Colors.black38),
              const SizedBox(height: 14),
              const Text(
                '暂时进不去',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 8),
              Text(
                message,
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 13, height: 1.6),
              ),
              const SizedBox(height: 20),
              Wrap(
                spacing: 12,
                children: <Widget>[
                  FilledButton(onPressed: onRetry, child: const Text('重试')),
                  TextButton(onPressed: onSignOut, child: const Text('重新登录')),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}


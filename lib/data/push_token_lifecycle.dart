import 'dart:async';

import 'package:flutter/widgets.dart';

import 'push_token_registration.dart';
import 'push_token_runtime.dart';

/// W6-F：把 [PushTokenRuntime] 接到 Flutter 生命周期上。
///
/// 这是**唯一一处 Flutter 绑定胶水**：数据层的策略（冷却窗口、单飞、注销停用）
/// 全在 runtime 里，单测不需要 `WidgetsBinding`；本类只负责三件事：
///   1. `start()` 时注册为 `WidgetsBindingObserver` 并立即上报一次；
///   2. 收到 [AppLifecycleState.resumed] 时调用 [PushTokenRuntime.reportIfDue]；
///   3. `dispose()` 时摘掉 observer 并释放 runtime。
///
/// 暂停 / 后台状态**不触发上报**：很多 SDK 在后台读 token 会直接失败，
/// 而且后台发网络请求在 iOS 上也不保证执行。回到前台再报既安全又够用。
class PushTokenLifecycle with WidgetsBindingObserver {
  PushTokenLifecycle({
    required this.runtime,
    PushLog? log,
    WidgetsBinding? binding,
  })  : _log = log,
        _binding = binding;

  final PushTokenRuntime runtime;
  final PushLog? _log;
  final WidgetsBinding? _binding;

  WidgetsBinding? _attached;
  bool _started = false;
  bool _disposed = false;

  bool get isAttached => _attached != null;

  /// 启动：接上生命周期并立即上报一次。重复调用无副作用。
  void start() {
    if (_disposed || _started) return;
    _started = true;

    final WidgetsBinding binding = _binding ?? WidgetsBinding.instance;
    binding.addObserver(this);
    _attached = binding;

    unawaited(runtime.start().then(_logResult));
  }

  /// 退出登录 / 切换账号时调用；注销完成后 runtime 不会再被 resume 自动重报。
  Future<PushTokenResult> revoke() async {
    final PushTokenResult result = await runtime.revoke();
    _logResult(result);
    return result;
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (_disposed || state != AppLifecycleState.resumed) return;
    unawaited(
      runtime.reportIfDue().then((PushTokenResult? result) {
        if (result != null) _logResult(result);
      }),
    );
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _attached?.removeObserver(this);
    _attached = null;
    runtime.dispose();
  }

  void _logResult(PushTokenResult result) {
    try {
      _log?.call('[push] ${result.status.name}：${result.message}');
    } catch (_) {
      // 日志出口自己抛错，不能影响生命周期回调。
    }
  }
}

import 'dart:async';

import 'push_token_registration.dart';

/// W6-F：推送 token 的**进程级运行时**（不依赖 Flutter 绑定，便于单测）。
///
/// ── 它解决什么 ────────────────────────────────────────────────────────────
/// W6-E 只在 `main()` 启动时上报一次，然后把 `PushTokenRegistrar` 关掉。
/// 但真实 SDK 的 token 会在运行中轮换、用户也可能在设置里刚授权通知；
/// 这些场景都发生在 App 从后台回到前台之后。本类负责：
///   · `start()`：启动时上报一次；
///   · `reportIfDue()`：生命周期恢复时调用，带**冷却窗口**，避免每次切前台都发请求；
///   · `revoke()`：退出登录 / 换账号时注销，并**停用后续自动重报**；
///   · `dispose()`：释放底层 HttpClient，且只释放一次。
///
/// ── 它仍然不做什么 ────────────────────────────────────────────────────────
///   · 不申请通知权限（厂商 SDK 适配器的事）；
///   · 不订阅 token refresh 流（等真实 SDK 落地后再接；当前靠 resume 重新读来源）；
///   · 不重试失败（客户端只在下次启动 / 下次 resume 再试，服务端重试队列与 token
///     登记是两件事）。
///
/// ── 为什么冷却窗口放在 runtime 而不是 registrar ───────────────────────────
/// registrar 的语义是「你让我报，我就按单飞 / 去重报一次」；它是纯执行器。
/// “多久允许再报一次”是生命周期策略，混进 registrar 会让启动路径也变得含糊。
class PushTokenRuntime {
  PushTokenRuntime({
    required PushTokenRegistrar registrar,
    DateTime Function()? clock,
    Duration minReportInterval = const Duration(minutes: 5),
    PushLog? log,
  })  : _registrar = registrar,
        _clock = clock ?? DateTime.now,
        _minReportInterval =
            minReportInterval.isNegative ? Duration.zero : minReportInterval,
        _log = log;

  final PushTokenRegistrar _registrar;
  final DateTime Function() _clock;
  final Duration _minReportInterval;
  final PushLog? _log;

  Future<PushTokenResult>? _inFlight;
  DateTime? _lastAttemptAt;
  bool _started = false;
  bool _stopped = false;
  bool _revoking = false;
  bool _disposed = false;

  /// 最近一次尝试上报的时刻（成功、失败、无 token 都会记录）。
  DateTime? get lastAttemptAt => _lastAttemptAt;

  /// 是否已经 `start()` 过。
  bool get isStarted => _started;

  /// 是否已被 `revoke()` 停用（退出登录后不应被 resume 自动重新登记）。
  bool get isStopped => _stopped;

  bool get isDisposed => _disposed;

  /// 透传 registrar 的最近状态。
  PushTokenStatus get status => _registrar.status;

  /// 启动时调用。返回**同一个**在途 Future；`start()` 也会解除 [revoke] 造成的停用。
  ///
  /// 与 [reportIfDue] 不同：`start()` **绕过冷却窗口**（启动时应该立刻报一次），
  /// 但 registrar 自己的「同 token 去重」仍然生效。
  Future<PushTokenResult> start() {
    if (_disposed)
      return Future<PushTokenResult>.value(_inactive('运行时已释放，未上报。'));
    if (_revoking) {
      return _inFlight ??
          Future<PushTokenResult>.value(_inactive('正在注销，未重新上报。'));
    }

    _stopped = false;
    _started = true;

    final Future<PushTokenResult>? result = _attempt(force: true);
    return result ?? Future<PushTokenResult>.value(_inactive('运行时不可用，未上报。'));
  }

  /// 生命周期恢复到前台时调用。冷却窗口内 / 未 `start()` / 已注销时返回 null
  /// （null 表示**什么都没做**，不是失败）。
  Future<PushTokenResult?> reportIfDue() {
    if (!_started) return Future<PushTokenResult?>.value(null);
    final Future<PushTokenResult>? result = _attempt(force: false);
    return result ?? Future<PushTokenResult?>.value(null);
  }

  /// 注销当前 token，并停用后续自动重报。
  ///
  /// 注销请求发出**之前**就置为停用：否则一次并发的 resume 可能在上报请求返回前
  /// 又把 token 登记回去，退出登录后仍然收推送。
  Future<PushTokenResult> revoke() {
    if (_disposed)
      return Future<PushTokenResult>.value(_inactive('运行时已释放，未注销。'));
    if (_revoking) {
      return _inFlight ?? Future<PushTokenResult>.value(_inactive('正在注销。'));
    }

    _revoking = true;
    _stopped = true;
    _started = true;

    final Future<PushTokenResult>? existing = _inFlight;
    final Future<PushTokenResult> future =
        existing == null ? _safeRevoke() : existing.then((_) => _safeRevoke());
    return _track(future).whenComplete(() {
      _revoking = false;
    });
  }

  /// 释放底层 API。可以重复调用；若有上报 / 注销在途，等它结束后再关。
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _stopped = true;

    final Future<PushTokenResult>? inFlight = _inFlight;
    if (inFlight == null) {
      _registrar.close();
      return;
    }
    unawaited(
      inFlight
          .then<void>((_) {}, onError: (Object _, StackTrace __) {})
          .whenComplete(_registrar.close),
    );
  }

  Future<PushTokenResult>? _attempt({required bool force}) {
    if (!_isActive) return null;

    final Future<PushTokenResult>? existing = _inFlight;
    if (existing != null) return existing;

    final DateTime now = _clock();
    final DateTime? last = _lastAttemptAt;
    if (!force && last != null) {
      final Duration elapsed = now.difference(last);
      // 时钟被回拨时 elapsed 为负：不把用户永久锁在冷却窗口里，允许本次上报。
      if (elapsed >= Duration.zero && elapsed < _minReportInterval) {
        return null;
      }
    }

    _lastAttemptAt = now;
    final Future<PushTokenResult> future = _safeReport();
    return _track(future);
  }

  Future<PushTokenResult> _safeReport() async {
    try {
      return await _registrar.report();
    } catch (error) {
      // registrar 的契约是永不抛错；这里再兜一层，防止未来适配器破坏契约后
      // 把生命周期回调 / 启动路径打崩。只记录异常类型，避免 SDK 把 token 带进日志。
      _logSafely('[push] 运行时捕获上报异常（${error.runtimeType}），已跳过');
      return const PushTokenResult(
        status: PushTokenStatus.failed,
        message: '上报推送 token 时发生未预期错误；本次跳过，不影响打卡。',
      );
    }
  }

  Future<PushTokenResult> _safeRevoke() async {
    try {
      return await _registrar.revoke();
    } catch (error) {
      _logSafely('[push] 运行时捕获注销异常（${error.runtimeType}），已跳过');
      return const PushTokenResult(
        status: PushTokenStatus.failed,
        message: '注销推送 token 时发生未预期错误；本次跳过，不影响使用。',
      );
    }
  }

  Future<PushTokenResult> _track(Future<PushTokenResult> future) {
    _inFlight = future;
    unawaited(
      future.whenComplete(() {
        if (identical(_inFlight, future)) _inFlight = null;
      }),
    );
    return future;
  }

  bool get _isActive => !_disposed && !_stopped;

  PushTokenResult _inactive(String message) => PushTokenResult(
        status: PushTokenStatus.idle,
        message: message,
      );

  void _logSafely(String message) {
    try {
      _log?.call(message);
    } catch (_) {
      // 日志出口自己抛错，不能影响推送流程。
    }
  }
}

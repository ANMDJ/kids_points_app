import 'dart:async';

import 'device_token_api.dart';
import 'operating_system.dart';
import 'write_api_errors.dart';

/// release / profile 构建的判定 —— 与 `app_store.dart` 中的私有常量同义。
///
/// 单独写一份而不是引用 `app_store.dart`：数据层组件不应为了一个编译期常量
/// 把整个 AppStore（连同模型 / UI 主题）拖进依赖图。
const bool _isReleaseBuild = bool.fromEnvironment('dart.vm.product') ||
    bool.fromEnvironment('dart.vm.profile');

/// 是否允许用 `--dart-define=KP_PUSH_TOKEN=...` 的方式提供 token。
///
/// **只允许调试构建**。原因不是“配置值不安全”，而是这个入口天生只能用来
/// 手工联调：真机上的 token 由 APNs / FCM / 厂商 SDK 在运行时下发，
/// 一旦发布包里带着某个写死的 token，所有安装都会抢着登记同一个地址
/// （后端会以 `DEVICE_TOKEN_OWNED_BY_OTHER` 拒绝，推送却永久不落到新用户）。
/// 真接入时请实现 [PushTokenSource]（从 SDK 取），不要放宽这个判据。
bool allowConfiguredPushToken({bool isRelease = _isReleaseBuild}) => !isRelease;

/// 操作系统 → 后端平台枚举。不认识的系统返回 null（**不猜**）。
///
/// 只做纯映射，操作系统名由调用方注入（默认取 [currentOperatingSystem]，
/// 它通过条件导入在 VM / Web 上各给一份实现），测试因此不需要
/// 真的跑在 Android / iOS 上。
String? pushPlatformForOperatingSystem(String operatingSystem) {
  switch (operatingSystem.trim().toLowerCase()) {
    case 'android':
      return kPushPlatformAndroid;
    case 'ios':
      return kPushPlatformIos;
    default:
      return null;
  }
}

/// 一次上报 / 注销的结果状态。
enum PushTokenStatus {
  /// 还没有开始（或上一次结果被主动清空）。
  idle,

  /// 正在读取 token 或请求服务端。
  registering,

  /// 服务端已登记（或这次相同 token 已在本次进程内登记过）。
  registered,

  /// 当前拿不到 token（未授权 / SDK 未就绪）。**不是错误**，下次启动再试。
  noToken,

  /// 409：这个 token 已绑定另一个账号。**重试没有意义**，必须换 token 或先注销。
  ownedByOther,

  /// 网络 / 超时 / 5xx / 401 / 403 / 解析失败。下次启动再试。
  failed,

  /// 已注销（包括“本来就不在本账号下”的 404，按已注销处理）。
  revoked,
}

/// 上报结果。`message` 永远是可直接写进日志（或将来写进设置页）的中文说明，
/// **不包含 token 本身**。
class PushTokenResult {
  const PushTokenResult({
    required this.status,
    required this.message,
    this.dto,
  });

  final PushTokenStatus status;
  final String message;

  /// 服务端回包（没有走到请求 / 请求失败时为 null）。同样不含 token。
  final DeviceTokenDto? dto;

  /// 只有 `registered` / `revoked` 是“这次的目标已达成”。
  /// `noToken` 刻意不算失败，也不算成功 —— 它只是“这次没东西可报”。
  bool get ok =>
      status == PushTokenStatus.registered || status == PushTokenStatus.revoked;
}

/// token 来源。真接入时由厂商 SDK 适配器实现；当前提供
/// [ConfiguredPushTokenSource]（调试构建 + `--dart-define`）用于打通链路。
///
/// `currentToken()` 允许返回 null：未授权、SDK 尚未初始化、用户关掉了通知，
/// 都是**正常状态**，不应抛错，更不应阻断任何业务页面。
abstract class PushTokenSource {
  String get platform;

  Future<String?> currentToken();
}

/// 从编译期配置读取固定 token 的来源。
class ConfiguredPushTokenSource implements PushTokenSource {
  const ConfiguredPushTokenSource({
    required this.platform,
    required this.token,
  });

  @override
  final String platform;

  final String token;

  @override
  Future<String?> currentToken() async => token;
}

/// 推送配置（token + 平台）。**未配置 ≠ 配置错误**：
///   · `enabled == false`：没有提供 token —— 正常状态，什么都不做；
///   · `enabled == true && validationError != null`：提供了 token 但不合法 /
///     发布构建不允许 —— 必须打日志，**绝不能**静默当成“没配置”。
class PushTokenConfig {
  const PushTokenConfig._({
    required this.token,
    required this.platform,
    required this.enabled,
    required this.validationError,
    required this.usesEnvironmentToken,
  });

  factory PushTokenConfig.fromEnvironment({
    String? token,
    String? platform,
    String? operatingSystem,
    bool? allowEnvironmentToken,
  }) {
    final String rawToken =
        (token ?? const String.fromEnvironment('KP_PUSH_TOKEN')).trim();
    final String rawPlatform =
        (platform ?? const String.fromEnvironment('KP_PUSH_PLATFORM')).trim();
    final String os = operatingSystem ?? currentOperatingSystem();
    final bool allowed = allowEnvironmentToken ?? allowConfiguredPushToken();

    if (rawToken.isEmpty) {
      return const PushTokenConfig._(
        token: '',
        platform: '',
        enabled: false,
        validationError: null,
        usesEnvironmentToken: false,
      );
    }

    String? error;
    if (!allowed) {
      error = '发布构建不接受 KP_PUSH_TOKEN：推送 token 必须在运行时由厂商 SDK 提供'
          '（见 lib/data/push_token_registration.dart 的 allowConfiguredPushToken）。';
    }

    final String resolvedPlatform = rawPlatform.isEmpty
        ? (pushPlatformForOperatingSystem(os) ?? '')
        : rawPlatform;
    if (error == null && !kDeviceTokenPlatforms.contains(resolvedPlatform)) {
      error = rawPlatform.isEmpty
          ? '无法从操作系统 `$os` 推断推送平台；请显式设置 KP_PUSH_PLATFORM'
              '（${kDeviceTokenPlatforms.join(' / ')}）。'
          : 'KP_PUSH_PLATFORM=`$rawPlatform` 不是受支持平台'
              '（${kDeviceTokenPlatforms.join(' / ')}）。';
    }
    if (error == null && (rawToken.length < 8 || rawToken.length > 512)) {
      error = 'KP_PUSH_TOKEN 长度必须在 8–512 之间（后端 DTO 同口径），'
          '当前 ${rawToken.length} 个字符。';
    }
    if (error == null && RegExp(r'\s').hasMatch(rawToken)) {
      error = 'KP_PUSH_TOKEN 不能包含空白字符（请先 trim 再配置）。';
    }

    return PushTokenConfig._(
      token: rawToken,
      platform: resolvedPlatform,
      enabled: true,
      validationError: error,
      usesEnvironmentToken: true,
    );
  }

  final String token;
  final String platform;
  final bool enabled;

  /// 配置有问题时的**可执行**说明；`enabled == false` 或配置合法时为 null。
  final String? validationError;

  /// 这个 token 是否来自编译期配置（而不是厂商 SDK）。
  /// 用于日志与文档，不影响请求行为。
  final bool usesEnvironmentToken;

  bool get isConfigured => enabled && validationError == null;

  /// 配置合法时返回来源；否则 null（调用方应先看 [validationError]）。
  PushTokenSource? toSource() => isConfigured
      ? ConfiguredPushTokenSource(platform: platform, token: token)
      : null;
}

/// 日志出口。默认由 `main()` 传 `debugPrint`；测试里传一个收集器。
/// 约定：**永远不打印 token**，只打印状态与原因。
typedef PushLog = void Function(String message);

/// 推送 token 上报器（W6-E）。
///
/// ── 它保证的四件事 ────────────────────────────────────────────────────────
///   ① **绝不抛错**：`report()` / `revoke()` 永远返回 [PushTokenResult]。
///      推送是附加能力，不能因为网络失败让启动、登录、打卡崩掉；
///   ② **单飞**：同一时刻只允许一个上报在途，重复调用拿到的是同一个 Future
///      （避免两个页面 / 两次生命周期回调各发一遍）；
///   ③ **同 token 去重**：本次进程内已成功登记过的 (platform, token) 不再发请求，
///      但仍返回 `registered`（幂等语义，不伪造“刚发过”）；
///   ④ **409 不重试**：token 已绑定另一个账号时重试一万次也是 409，
///      因此记住这个 token，本次进程内直接返回 `ownedByOther`，等换 token / 注销。
///
/// ── 它**不**负责什么 ───────────────────────────────────────────────────────
///   · 不申请系统通知权限（各平台 API 不同，属于厂商适配器）；
///   · 不做定时刷新 / 退避重试（`PushTokenRuntime` 会在启动与 resume 时再调用；
///     服务端 `PushRetryJob` 管的是消息发送，不是 token 登记）；
///   · 不在账号切换时自动注销（当前还没有登录链路；`PushTokenRuntime.revoke()`
///     已提供入口，见 W6-F 交接单）。
class PushTokenRegistrar {
  PushTokenRegistrar({
    required DeviceTokenApi api,
    required PushTokenSource source,
    PushLog? log,
  })  : _api = api,
        _source = source,
        _log = log;

  final DeviceTokenApi _api;
  final PushTokenSource _source;
  final PushLog? _log;

  PushTokenStatus _status = PushTokenStatus.idle;
  Future<PushTokenResult>? _inFlight;

  String? _lastToken;
  String? _lastPlatform;
  DeviceTokenDto? _lastDto;

  /// 已确认“属于另一个账号”的 token。换 token 后自动失效。
  String? _blockedToken;
  PushTokenResult? _blockedResult;

  PushTokenStatus get status => _status;

  /// 最近一次成功登记的响应（不含 token）；没有则为 null。
  DeviceTokenDto? get lastRegistered => _lastDto;

  /// 启动时调用一次。可以安全地重复调用（单飞 + 去重）。
  Future<PushTokenResult> report() {
    final Future<PushTokenResult>? existing = _inFlight;
    if (existing != null) return existing;

    final Future<PushTokenResult> future = _report();
    _inFlight = future;
    unawaited(
      future.whenComplete(() {
        if (identical(_inFlight, future)) _inFlight = null;
      }),
    );
    return future;
  }

  /// 注销当前 / 最近登记的 token。没有 token 时什么都不发。
  ///
  /// 404 `DEVICE_TOKEN_NOT_FOUND` 按**已注销**处理：目标状态已经达成，
  /// 把它报成失败只会让人去重试一个永远不会成功的请求。
  Future<PushTokenResult> revoke() async {
    final Future<PushTokenResult>? inFlight = _inFlight;
    if (inFlight != null) await inFlight;

    _status = PushTokenStatus.registering;
    final String? token = _lastToken ?? await _currentToken();
    if (token == null) {
      return _finish(
        PushTokenStatus.noToken,
        '没有可注销的推送 token（本机还没有上报过，或 SDK 尚未给出）。',
      );
    }

    try {
      final DeviceTokenDto dto = await _api.revoke(token: token);
      _clearCache();
      return _finish(
        PushTokenStatus.revoked,
        '推送 token 已注销（${dto.platform}）。',
        dto: dto,
      );
    } on WriteApiException catch (error) {
      if (error.code == 'DEVICE_TOKEN_NOT_FOUND') {
        _clearCache();
        return _finish(
          PushTokenStatus.revoked,
          '这个推送 token 本来就不在本账号下（可能已注销），无需再处理。',
        );
      }
      return _finish(PushTokenStatus.failed, error.userMessage);
    } catch (error) {
      _logSafely('[push] 注销 token 时发生未预期错误（${error.runtimeType}），已跳过');
      return _finish(
        PushTokenStatus.failed,
        '注销推送 token 时发生未预期错误；本次跳过，不影响使用。',
      );
    }
  }

  void close() => _api.close();

  Future<PushTokenResult> _report() async {
    _status = PushTokenStatus.registering;

    final String? token = await _currentToken();
    if (token == null) {
      return _finish(
        PushTokenStatus.noToken,
        '还没有可上报的推送 token（未授权或 SDK 未就绪），本次跳过；不影响打卡。',
      );
    }

    final String platform;
    try {
      platform = _source.platform.trim();
    } catch (error) {
      // 来源是外部适配器（厂商 SDK），其 getter 也可能抛错。这里必须兜住：
      // `report()` 承诺“永不抛错”，启动路径不能因为一个平台名崩掉。
      _logSafely('[push] 读取推送平台失败（${error.runtimeType}），已跳过');
      return _finish(
        PushTokenStatus.failed,
        '读取推送平台时发生未预期错误；本次跳过，不影响打卡。',
      );
    }
    if (!kDeviceTokenPlatforms.contains(platform)) {
      return _finish(
        PushTokenStatus.failed,
        '推送平台 `$platform` 不在后端支持范围内'
        '（${kDeviceTokenPlatforms.join(' / ')}），本次跳过。',
      );
    }

    if (_lastToken == token && _lastPlatform == platform && _lastDto != null) {
      _status = PushTokenStatus.registered;
      return PushTokenResult(
        status: PushTokenStatus.registered,
        message: '本次运行已登记过这个推送 token（${_lastDto!.platform}），未重复请求。',
        dto: _lastDto,
      );
    }

    final PushTokenResult? blocked = _blockedResult;
    if (_blockedToken == token && blocked != null) {
      _status = PushTokenStatus.ownedByOther;
      return blocked;
    }

    try {
      final DeviceTokenDto dto = await _api.register(
        platform: platform,
        token: token,
      );
      _lastToken = token;
      _lastPlatform = platform;
      _lastDto = dto;
      _blockedToken = null;
      _blockedResult = null;
      return _finish(
        PushTokenStatus.registered,
        '推送 token 已登记（${dto.platform}）。',
        dto: dto,
      );
    } on WriteApiException catch (error) {
      if (error.code == 'DEVICE_TOKEN_OWNED_BY_OTHER') {
        const PushTokenResult result = PushTokenResult(
          status: PushTokenStatus.ownedByOther,
          message: '这个推送 token 已绑定到另一个账号：请在原账号注销，或换一个 token。'
              '本次跳过，不影响使用。',
        );
        _blockedToken = token;
        _blockedResult = result;
        _status = PushTokenStatus.ownedByOther;
        _logSafely('[push] ${result.message}');
        return result;
      }
      return _finish(PushTokenStatus.failed, error.userMessage);
    } catch (error) {
      _logSafely('[push] 上报 token 时发生未预期错误（${error.runtimeType}），已跳过');
      return _finish(
        PushTokenStatus.failed,
        '上报推送 token 时发生未预期错误；本次跳过，不影响打卡。',
      );
    }
  }

  Future<String?> _currentToken() async {
    try {
      final String? value = await _source.currentToken();
      final String token = value?.trim() ?? '';
      return token.isEmpty ? null : token;
    } catch (error) {
      // 只记录异常类型：SDK 的异常串常常把 token 一起带出来，
      // 「日志不出现 token」是硬约束，不能靠运气。
      _logSafely('[push] 读取推送 token 失败（${error.runtimeType}）');
      return null;
    }
  }

  void _clearCache() {
    _lastToken = null;
    _lastPlatform = null;
    _lastDto = null;
    _blockedToken = null;
    _blockedResult = null;
  }

  PushTokenResult _finish(
    PushTokenStatus status,
    String message, {
    DeviceTokenDto? dto,
  }) {
    _status = status;
    if (status != PushTokenStatus.registered &&
        status != PushTokenStatus.noToken) {
      _logSafely('[push] $message');
    }
    return PushTokenResult(status: status, message: message, dto: dto);
  }

  void _logSafely(String message) {
    try {
      _log?.call(message);
    } catch (_) {
      // 日志实现（例如测试收集器）自己出错，也不能让上报流程失败。
    }
  }
}

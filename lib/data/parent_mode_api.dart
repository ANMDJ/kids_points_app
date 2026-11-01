import 'dart:async';
import 'dart:convert';

import '../models/onboarding.dart' show validateParentPin;
import 'http_transport.dart';
import 'parent_mode_dto.dart';
import 'read_api.dart' show ReadApiConfig, kChildIdHeader, kDeviceIdHeader;
import 'read_api_errors.dart';
import 'write_api_errors.dart';

/// 家长模式 ＋ 家长 PIN 的**客户端能力**（W8-C，2026-10-27 / `02` §7）。
///
/// ── 为什么又是独立客户端 ────────────────────────────────────────────────────
///   四条路由横跨三个方法（GET / POST / DELETE），而 `ReadApi` 只发 GET、
///   `WriteApi` 只发打卡 / 撤销那两类写；把它们塞进任何一边都会让那一侧
///   多出一批「不该由它负责」的方法。独立客户端的另一个好处是测试只注入
///   这一个接口，不必伪造整份 `ReadApi`。
///
/// ── 明文 PIN 的边界 ─────────────────────────────────────────────────────────
///   明文只出现在本文件的请求体里：不进 store、不进日志、不进 `detail`。
///   后端同理（只存 `scrypt$…` 哈希）。任何一个环节把 PIN 记进异常详情，
///   事后都能在崩溃报告里读到它。
abstract class ParentModeApi {
  /// `GET /auth/parent-mode`：我现在是不是家长模式、还剩多少秒。
  Future<ParentModeDto> fetch();

  /// `POST /auth/parent-mode`：用 PIN 换 5 分钟家长模式。
  ///
  /// 失败语义（与后端逐字对应，客户端不重新解释）：
  ///   · `400 PARENT_PIN_FORMAT_INVALID` ⇒ 格式错，**不计次**；
  ///   · `403 PARENT_PIN_INVALID`        ⇒ 值不对，`remainingAttempts` 已递减；
  ///   · `409 PARENT_PIN_NOT_SET`        ⇒ 还没设过 PIN；
  ///   · `429 PARENT_PIN_LOCKED`         ⇒ 锁定（[ParentPinLockException]）。
  Future<ParentModeDto> enter(String pin);

  /// `DELETE /auth/parent-mode`：主动退出（**不需要** PIN，幂等）。
  Future<ParentModeDto> exit();

  /// `POST /auth/parent-pin`：首次设置 / 修改家长 PIN。
  ///
  /// `currentPin` 只在**已有 PIN** 时必填 —— 少了后端回 `400`
  /// （不是 403：缺字段是请求形状问题，不是「猜错了」）。
  Future<ParentPinDto> setPin({required String pin, String? currentPin});

  void close() {}
}

/// PIN 锁定期（`429 PARENT_PIN_LOCKED`）。
///
/// 单独一个类型是因为界面要**把剩余秒数显示出来**（"请 14 分 32 秒后再试"），
/// 而 [WriteApiException] 只有 `detail` 字符串。它仍然是
/// [WriteFailureKind.conflict] 的一个特例：所有既有的 `on WriteApiException`
/// 分支都能接住它，只有想知道「还要等多久」的地方才需要 `is` 判断。
class ParentPinLockException extends WriteApiException {
  ParentPinLockException({
    required this.retryAfterSeconds,
    required String userMessage,
  }) : super(
          WriteFailureKind.conflict,
          userMessage,
          statusCode: 429,
          code: 'PARENT_PIN_LOCKED',
        );

  /// 还要等多少秒（后端 `lockRemainingSeconds()` 的同一份算术）。
  final int retryAfterSeconds;
}

/// 基于 `dart:io HttpClient` 的实现（复用写层的 [WriteTransport]）。
class ParentModeApiClient implements ParentModeApi {
  ParentModeApiClient({
    required this.config,
    WriteTransport? transport,
    this.timeout = const Duration(seconds: 15),
    this.tokenProvider,
  }) : _transport = transport ?? createWriteTransport();

  final ReadApiConfig config;
  final WriteTransport _transport;
  final Duration timeout;

  /// W9-D：Bearer token 的取值函数（`() => holder.token`）。
  /// 默认 `null` ⇒ 不发 `Authorization` 头，既有调用点行为不变。
  final String? Function()? tokenProvider;

  @override
  Future<ParentModeDto> fetch() async {
    final Object? decoded = await _send('GET', '/auth/parent-mode', null);
    return _parse(
      decoded,
      (Object? raw, String path) => ParentModeDto.fromJson(raw, path),
    );
  }

  @override
  Future<ParentModeDto> enter(String pin) async {
    final String normalized = _requirePin(pin);
    final Object? decoded = await _send(
      'POST',
      '/auth/parent-mode',
      <String, Object?>{'pin': normalized},
    );
    return _parse(
      decoded,
      (Object? raw, String path) => ParentModeDto.fromJson(raw, path),
    );
  }

  @override
  Future<ParentModeDto> exit() async {
    final Object? decoded = await _send('DELETE', '/auth/parent-mode', null);
    return _parse(
      decoded,
      (Object? raw, String path) => ParentModeDto.fromJson(raw, path),
    );
  }

  @override
  Future<ParentPinDto> setPin({required String pin, String? currentPin}) async {
    final String normalized = _requirePin(pin);
    // `currentPin` 三态：不传 = 「我没有旧 PIN」；空串 = 客户端 bug。
    String? normalizedCurrent;
    if (currentPin != null) {
      final String trimmed = currentPin.trim();
      if (trimmed.isEmpty) {
        throw ArgumentError('currentPin 不能是空串：没有旧 PIN 请传 null。');
      }
      normalizedCurrent = _requirePin(trimmed);
    }

    final Object? decoded = await _send(
      'POST',
      '/auth/parent-pin',
      <String, Object?>{
        'pin': normalized,
        if (normalizedCurrent != null) 'currentPin': normalizedCurrent,
      },
    );
    return _parse(
      decoded,
      (Object? raw, String path) => ParentPinDto.fromJson(raw, path),
    );
  }

  /// PIN 的本地预检：4–6 位数字（与后端 `PIN_PATTERN` 同口径）。
  ///
  /// ★ 这里**不发请求**就拒：格式错在后端是 `400`（不计次），但用户看到的
  ///   会是「请求失败」这种模糊说法。本地拒绝能直接说「必须是 4–6 位数字」。
  String _requirePin(String raw) {
    final String pin = raw.trim();
    if (pin.isEmpty) {
      throw ArgumentError('PIN 不能为空。');
    }
    final String? invalid = validateParentPin(pin);
    if (invalid != null) throw ArgumentError(invalid);
    return pin;
  }

  T _parse<T>(Object? decoded, T Function(Object?, String) parse) {
    try {
      return parse(decoded, r'$');
    } on ReadApiException catch (error) {
      throw WriteApiException.malformed(
        r'$',
        detail: error.detail ?? error.userMessage,
      );
    }
  }

  Future<Object?> _send(
    String method,
    String path,
    Map<String, Object?>? body,
  ) async {
    final String? configError = config.validationError;
    if (configError != null) {
      throw WriteApiException(
        WriteFailureKind.badRequest,
        configError,
        code: 'CLIENT_NOT_CONFIGURED',
      );
    }

    final Uri uri = config.uri(path);
    final String? bearer = tokenProvider?.call();
    final Map<String, String> headers = <String, String>{
      kAcceptHeader: 'application/json',
      if (body != null)
        kContentTypeHeader: 'application/json; charset=utf-8',
      kDeviceIdHeader: config.deviceId.trim(),
      kChildIdHeader: config.childId.trim(),
      // W9-D：有 token 才发（空值会让 `Authorization: Bearer ` 变成畸形头）。
      if (bearer != null && bearer.isNotEmpty)
        kAuthorizationHeader: 'Bearer $bearer',
    };
    final String encoded = body == null ? '' : jsonEncode(body);

    final WriteHttpResponse response;
    try {
      response = await _transport
          .send(uri, headers, encoded, method: method)
          .timeout(timeout);
    } on TimeoutException {
      throw WriteApiException.timeout(timeout);
    } on Exception catch (error) {
      // Web 上抛的是 `TransportException`（见 `http_transport_types.dart`），
      // VM 上是 `IOException` 子类 —— 两者都是 `Exception`，一处覆盖两套平台。
      throw WriteApiException.network(error);
    }

    Object? decoded;
    if (response.body.trim().isNotEmpty) {
      try {
        decoded = jsonDecode(response.body);
      } on FormatException {
        decoded = null;
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw _fromHttp(statusCode: response.statusCode, body: decoded);
    }
    if (decoded == null) {
      throw WriteApiException.malformed(
        r'$',
        detail: 'HTTP ${response.statusCode} 但响应体为空',
      );
    }
    return decoded;
  }

  /// `!2xx` → 异常。
  ///
  /// 只对 **429** 做特判：`WriteApiException.fromHttp` 不认识这个状态码（本
  /// 项目此前没有任何端点会回它），会落到「服务器开小差」那条通用文案上，
  /// 而家长真正需要知道的是「还要等多久、不是网络坏了」。
  WriteApiException _fromHttp({
    required int statusCode,
    required Object? body,
  }) {
    if (statusCode != 429) {
      return WriteApiException.fromHttp(statusCode: statusCode, body: body);
    }
    int seconds = 0;
    if (body is Map) {
      final Object? raw = body['retryAfterSeconds'];
      if (raw is num) seconds = raw.toInt();
    }
    if (seconds < 0) seconds = 0;
    final String message = seconds > 0
        ? '家长 PIN 已连续输错，暂时锁定。请 ${humanizeSeconds(seconds)}后再试。'
        : '家长 PIN 已连续输错，暂时锁定。请稍后再试（不是网络问题）。';
    return ParentPinLockException(
      retryAfterSeconds: seconds,
      userMessage: message,
    );
  }

  /// 秒 → 「14 分 59 秒」/「59 秒」/「15 分钟」。
  ///
  /// 界面上的两处倒计时（家长模式剩余时间、PIN 锁定剩余时间）共用它，
  /// 免得一个地方写「5:00」、另一个写「300 秒」。
  static String humanizeSeconds(int seconds) {
    final int safe = seconds < 0 ? 0 : seconds;
    final int minutes = safe ~/ 60;
    final int rest = safe % 60;
    if (minutes == 0) return '$rest 秒';
    if (rest == 0) return '$minutes 分钟';
    return '$minutes 分 $rest 秒';
  }

  @override
  void close() => _transport.close();
}

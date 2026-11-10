import 'dart:async';
import 'dart:convert';

import '../models/kid_mode.dart' show validateKidModeMinutes;
import '../models/onboarding.dart' show validateParentPin;
import '../models/parent_mode.dart' show PinVerifyResult;
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

  /// `POST /auth/kid-mode`：把手机交给孩子用 `durationMinutes` 分钟（W14，1–30）。
  ///
  /// 失败语义（服务端逐字对应）：
  ///   · `403 KID_MODE_REQUIRES_PARENT_MODE` ⇒ 当前不在家长模式，先输 PIN；
  ///   · `409 KID_MODE_REQUIRES_PIN`        ⇒ 还没设 PIN（到点收不回来）；
  ///   · `409 KID_MODE_ALREADY_ACTIVE`      ⇒ 已经开着，先结束这一次。
  Future<ParentModeDto> enterKidMode(int durationMinutes);

  /// `DELETE /auth/kid-mode`：用家长 PIN 收回孩子模式（W14）。
  ///
  /// **到期后也走这一条**（A 方案）：到点不会自动回家长模式，必须验 PIN。
  /// 失败语义与 [enter] 完全一致（400 不计次 / 403 计次 / 429 锁定）。
  Future<ParentModeDto> exitKidMode(String pin);

  /// `POST /auth/parent-pin/verify`：只校验 PIN，**不改变**角色 / TTL（2026-11-04）。
  ///
  /// App 的本机 PIN 锁用它。为什么不复用 [enter]：
  ///   以家长身份登录的设备（邀请码加入，会话 30 天）一旦走 [enter]，TTL 会被
  ///   压成 5 分钟 —— 解锁几次之后家长模式就没了。锁屏只是「谁拿着手机」。
  ///
  /// 失败语义与 [enter] 逐字一致（400 不计次 / 403 计次 / 409 没设过 PIN /
  /// 429 锁定）。**旧服务端**没有这条路由时会回 404，由调用方决定降级策略。
  Future<PinVerifyResult> verifyPin(String pin);

  /// `POST /auth/parent-pin`：首次设置 / 修改家长 PIN。
  ///
  /// `currentPin` 只在**已有 PIN** 时必填 —— 少了后端回 `400`
  /// （不是 403：缺字段是请求形状问题，不是「猜错了」）。
  Future<ParentPinDto> setPin({required String pin, String? currentPin});

  /// `POST /auth/parent-pin/reset`：忘记 PIN 时，用**账号密码**换一把新 PIN。
  ///
  /// ── 为什么要它（用户 2026-11-10：「忘记 PIN 码时，可以选择联网重置」）──────
  ///   孩子模式到期 / 忘记 PIN 的设备停在 `child`，而「改 PIN」（[setPin]）要
  ///   `manage_parent_pin`（孩子 DENY）—— 那一刻正好用不了。服务端为此单开了一条
  ///   只要求 `switch_role_mode` 的路由（`docs/design/53`），凭据是**登录密码**。
  ///
  /// 失败语义（服务端原文，客户端不重新解释）：
  ///   · `400 PARENT_PIN_FORMAT_INVALID` ⇒ 新 PIN 形状不对（不计次）；
  ///   · `403 PARENT_PIN_REQUIRES_GUARDIAN` ⇒ 成员位不是家长；
  ///   · `403 ACCOUNT_PASSWORD_NOT_SET` / `CURRENT_PASSWORD_INVALID` ⇒ 密码问题；
  ///   · `429 PIN_RESET_RATE_LIMITED` ⇒ 每分钟最多 5 次。
  Future<ParentPinResetDto> resetPin({
    required String password,
    required String pin,
  });

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
  Future<ParentModeDto> enterKidMode(int durationMinutes) async {
    // 本地只挡"注定 400"的输入；服务端仍会 `clampKidModeMinutes()` 再夹一次。
    final String? invalid = validateKidModeMinutes(durationMinutes);
    if (invalid != null) {
      throw WriteApiException(
        WriteFailureKind.badRequest,
        invalid,
        code: 'KID_MODE_DURATION_INVALID',
      );
    }
    final Object? decoded = await _send(
      'POST',
      '/auth/kid-mode',
      <String, Object?>{'durationMinutes': durationMinutes},
    );
    return _parse(
      decoded,
      (Object? raw, String path) => ParentModeDto.fromJson(raw, path),
    );
  }

  @override
  Future<ParentModeDto> exitKidMode(String pin) async {
    final String normalized = _requirePin(pin);
    final Object? decoded = await _send(
      'DELETE',
      '/auth/kid-mode',
      <String, Object?>{'pin': normalized},
    );
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

  @override
  Future<ParentPinResetDto> resetPin({
    required String password,
    required String pin,
  }) async {
    final String normalized = _requirePin(pin);
    final String secret = password.trim();
    if (secret.isEmpty) {
      throw WriteApiException(
        WriteFailureKind.badRequest,
        '请输入登录密码（这里要的是账号密码，不是家长 PIN）。',
        code: 'CLIENT_PASSWORD_REQUIRED',
      );
    }
    final Object? decoded = await _send(
      'POST',
      '/auth/parent-pin/reset',
      <String, Object?>{'password': secret, 'pin': normalized},
    );
    return _parse(
      decoded,
      (Object? raw, String path) => ParentPinResetDto.fromJson(raw, path),
    );
  }

  @override
  Future<PinVerifyResult> verifyPin(String pin) async {
    final String normalized = _requirePin(pin);
    final Object? decoded = await _send(
      'POST',
      '/auth/parent-pin/verify',
      <String, Object?>{'pin': normalized},
    );
    final ParentPinVerifyDto dto = _parse(
      decoded,
      (Object? raw, String path) => ParentPinVerifyDto.fromJson(raw, path),
    );
    return PinVerifyResult(remainingAttempts: dto.remainingAttempts);
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
      kChildIdHeader: config.childId ?? '',
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
    String? code;
    if (body is Map) {
      final Object? raw = body['retryAfterSeconds'];
      if (raw is num) seconds = raw.toInt();
      final Object? rawCode = body['code'];
      if (rawCode is String) code = rawCode;
    }
    if (seconds < 0) seconds = 0;
    // 重置 PIN 的 429 是「密码试太频繁」，与「PIN 连错被锁」不是一回事 ——
    // 两句话必须分开，否则家长会以为锁的是 PIN。
    final bool resetLimited = code == 'PIN_RESET_RATE_LIMITED';
    final String message = resetLimited
        ? (seconds > 0
            ? '密码尝试太频繁，请 ${humanizeSeconds(seconds)}后再试。'
            : '密码尝试太频繁，请稍后再试。')
        : seconds > 0
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

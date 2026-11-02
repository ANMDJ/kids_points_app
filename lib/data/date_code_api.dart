import 'dart:async';
import 'dart:convert';

import 'date_code_dto.dart';
import 'http_transport.dart';
import 'parent_mode_api.dart' show ParentModeApiClient;
import 'read_api.dart' show ReadApiConfig, kChildIdHeader, kDeviceIdHeader;
import 'read_api_errors.dart';
import 'write_api_errors.dart';

/// 6 位验证码（`MMDD` ＋ 两位 ISO 星期）的**客户端**（W9-C，2026-10-29）。
///
/// ── 与后端的分工（这条决定了本文件有多短）──────────────────────────────────
///   规则**只**在服务端有一份实现：客户端不重算「今天应该是哪个 6 位数」，
///   只把家长输入的 6 位数字发上去，由服务器按**服务器时钟**判定。客户端自己
///   算就会有两个后果：① 手机时间被改动 ⇒ 家长按手机算的码永远"错"；
///   ② 规则改了要改两处（本仓库最怕的那类漂移）。
///
/// ── 为什么另起一个客户端 ────────────────────────────────────────────────────
///   `ReadApi` 只发 GET、`WriteApi` 只发打卡 / 撤销、`ParentModeApi` 管的是
///   PIN 与角色 —— 把它们任何一个多塞一条方法，都会让那一侧的测试被迫伪造
///   无关能力。独立客户端 ⇒ 用例只注入这一个接口。
///
/// ── 它不是登录 ──────────────────────────────────────────────────────────────
///   响应里没有 token，也不会有：`MMDD + 星期` 公开可推导，拿它换凭据等于
///   把门钥匙印在日历上（后端 `date-verification-code.ts` 文件头有同一条标注）。
abstract class DateCodeApi {
  /// `POST /auth/date-code`。
  ///
  /// 失败语义（与后端逐字对应，客户端不重新解释）：
  ///   · `400` 形状错（不是 6 位数字）⇒ [WriteApiException] `badRequest`；
  ///     本客户端在**发请求之前**就会用 [DateCodeApiClient.codePattern] 拦掉，
  ///     所以正常路径看不到这个 400；
  ///   · `200 { valid:false }` ⇒ **不是异常**，正常返回 DTO（界面据此提示）；
  ///   · `429` ⇒ [DateCodeRateLimitedException]（带 `retryAfterSeconds`）；
  ///   · 网络 / 超时 / 回包形状坏 ⇒ 对应的 `WriteApiException`。
  Future<DateCodeVerdictDto> verify(String code);

  void close() {}
}

/// 验证码尝试过于频繁（`429 DATE_CODE_RATE_LIMITED`）。
///
/// 单独一个类型只为一件事：界面要把「还要等多久」显示出来，而
/// [WriteApiException] 只有一句话。它仍然是 [WriteFailureKind.conflict] 的
/// 一个特例 ⇒ 所有既有的 `on WriteApiException` 分支都能接住它。
class DateCodeRateLimitedException extends WriteApiException {
  DateCodeRateLimitedException({
    required this.retryAfterSeconds,
    required String userMessage,
  }) : super(
          WriteFailureKind.conflict,
          userMessage,
          statusCode: 429,
          code: 'DATE_CODE_RATE_LIMITED',
        );

  /// 还要等多少秒（后端 `retryAfterSeconds`，向上取整）。
  final int retryAfterSeconds;
}

/// 基于 `dart:io HttpClient` 的实现（复用写层的 [WriteTransport]）。
class DateCodeApiClient implements DateCodeApi {
  DateCodeApiClient({
    required this.config,
    WriteTransport? transport,
    this.timeout = const Duration(seconds: 15),
  }) : _transport = transport ?? createWriteTransport();

  final ReadApiConfig config;
  final WriteTransport _transport;
  final Duration timeout;

  /// 6 位数字 —— 与后端 `DATE_CODE_PATTERN` 同一口径。
  ///
  /// ★ 在**发请求之前**拦：形状错在后端是 400，但用户看到的会是「请求失败」
  ///   这种模糊说法；少打一位与「算错了」必须说成两句不同的话。
  static final RegExp codePattern = RegExp(r'^\d{6}$');

  @override
  Future<DateCodeVerdictDto> verify(String code) async {
    final String normalized = _requireCode(code);
    final Object? decoded = await _send(<String, Object?>{'code': normalized});
    try {
      return DateCodeVerdictDto.fromJson(decoded, r'$');
    } on ReadApiException catch (error) {
      throw WriteApiException.malformed(
        r'$',
        detail: error.detail ?? error.userMessage,
      );
    }
  }

  /// 本地预检：**不发请求**就拒掉空串与非 6 位数字。
  String _requireCode(String raw) {
    final String code = raw.trim();
    if (code.isEmpty) {
      throw ArgumentError('验证码不能为空。');
    }
    if (!codePattern.hasMatch(code)) {
      throw ArgumentError('验证码是 6 位数字：日期 4 位 ＋ 两位星期（周一 01 … 周日 07）。');
    }
    return code;
  }

  Future<Object?> _send(Map<String, Object?> body) async {
    // 复用 `ReadApiConfig` 的完整性闸门：**「算不算配好」只有这一个定义**。
    // （本端点本身只需要 baseUrl，但另立一套判断就会在"配了一半"时给出
    //   两种互相矛盾的提示 —— 那种不一致比多要求一个 childId 更贵。）
    // W10-B：日期码闸门在**登录之前**运行，那时还没有 childId ——
    // 所以这里只能要求 baseUrl + deviceId，不能复用业务请求的 `validationError`。
    final String? configError = config.transportValidationError;
    if (configError != null) {
      throw WriteApiException(
        WriteFailureKind.badRequest,
        configError,
        code: 'CLIENT_NOT_CONFIGURED',
      );
    }

    final Uri uri = config.uri('/auth/date-code');
    final Map<String, String> headers = <String, String>{
      kAcceptHeader: 'application/json',
      kContentTypeHeader: 'application/json; charset=utf-8',
      // 后端拿它做限流的**设备维度**（与登录共用 `LoginRateLimiter`），
      // 所以即使本端点不需要身份也要带上。
      kDeviceIdHeader: config.deviceId.trim(),
      if (config.childId != null) kChildIdHeader: config.childId!,
    };

    final WriteHttpResponse response;
    try {
      response = await _transport
          .send(uri, headers, jsonEncode(body), method: 'POST')
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

  /// `!2xx` → 异常。只对 **429** 特判（其余交给 [WriteApiException.fromHttp]）。
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
        ? '验证码试得太频繁了。请 ${ParentModeApiClient.humanizeSeconds(seconds)}后再试（不是网络问题）。'
        : '验证码试得太频繁了。请稍后再试（不是网络问题）。';
    return DateCodeRateLimitedException(
      retryAfterSeconds: seconds,
      userMessage: message,
    );
  }

  @override
  void close() => _transport.close();
}

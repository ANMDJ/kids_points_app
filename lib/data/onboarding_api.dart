import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../models/onboarding.dart';
import 'onboarding_dto.dart';
import 'read_api.dart' show ReadApiConfig, kChildIdHeader, kDeviceIdHeader;
import 'read_api_errors.dart';
import 'write_api.dart'
    show IoWriteTransport, WriteHttpResponse, WriteTransport;
import 'write_api_errors.dart';

/// 首启引导的**客户端能力**（W8-B，2026-10-27 / `04` §2–§6）。
///
/// ── 为什么单独一个客户端，而不是塞进 `ReadApi` / `WriteApi` ──────────────────
///   ① 引导是**一次性流程**：它既有读（`GET`）又有写（`PATCH` / `POST`），
///      而本项目的 `ReadApi` 只发 GET、`WriteApi` 只发 POST/PATCH/DELETE ——
///      硬塞进任何一边都会让那一边多出一种「不该由它负责」的方法；
///   ② 三端点会在引导结束后彻底不用，独立客户端让「首页刷新路径」不必知道
///      引导的存在（关掉引导相关代码不会影响打卡 / 审批 / 导出）；
///   ③ 测试可以只注入这一个接口，不必为了「引导没完成」去伪造整份
///      `ReadApi` 的十几个方法。
///
/// ── 错误口径 ────────────────────────────────────────────────────────────────
///   全部归一成 [WriteApiException]：界面只处理一种异常，且 `403 CONSENT_REQUIRED`
///   / `409 ONBOARDING_ALREADY_COMPLETED` / `501 …NOT_IMPLEMENTED` 的业务码
///   都能原样取到（`error.code`），不会把「没同意」说成「网络错误」。
abstract class OnboardingApi {
  /// `GET /onboarding`：状态 + 已排序的模板库。
  Future<OnboardingViewDto> fetch();

  /// `PATCH /onboarding/profile`：第③④步草稿。
  ///
  /// 三态语义（与后端 `SaveOnboardingProfileDto` 逐字对应）：
  ///   · 都不传 ⇒ 什么都不改（客户端会直接拒，不发请求）；
  ///   · `ageBand: null` + `clearAgeBand: true` ⇒ **显式清空**学段；
  ///   · `focusAreas: []` ⇒ 「一个都不选」，与「没传」不同。
  Future<OnboardingStateDto> saveProfile({
    AgeBand? ageBand,
    bool clearAgeBand = false,
    List<String>? focusAreas,
  });

  /// `POST /onboarding/complete`：采纳模板（至少 1 条）+ 可选 PIN。
  ///
  /// `parentPin` 为 null 表示**跳过**第⑥步；空串会被本地拒绝（后端也拒绝），
  /// 因为 `""` 不是「跳过」，是「输入框被清空但客户端仍提交了字段」。
  Future<OnboardingResultDto> complete({
    required List<String> templateSlugs,
    AgeBand? ageBand,
    List<String>? focusAreas,
    String? parentPin,
  });

  void close() {}
}

/// 基于 `dart:io HttpClient` 的实现。
///
/// 复用写层的 [WriteTransport]（它已经支持任意方法 + 可选 body）：
/// `GET` 用 `body: null`，不会带上 `Content-Type` —— 严格后端会拒绝
/// 「GET 带 JSON 空体」这种写法。
class OnboardingApiClient implements OnboardingApi {
  OnboardingApiClient({
    required this.config,
    WriteTransport? transport,
    this.timeout = const Duration(seconds: 15),
  }) : _transport = transport ?? IoWriteTransport();

  final ReadApiConfig config;
  final WriteTransport _transport;
  final Duration timeout;

  @override
  Future<OnboardingViewDto> fetch() async {
    final Object? decoded = await _send('GET', '/onboarding', null);
    return _parse(decoded, (Object? raw, String _) => OnboardingViewDto.fromJson(raw));
  }

  @override
  Future<OnboardingStateDto> saveProfile({
    AgeBand? ageBand,
    bool clearAgeBand = false,
    List<String>? focusAreas,
  }) async {
    if (ageBand == null && !clearAgeBand && focusAreas == null) {
      throw ArgumentError(
        'saveProfile 没有任何要保存的字段：学段与关注点都没传，等于一次无意义往返。',
      );
    }

    final Map<String, Object?> body = <String, Object?>{};
    if (ageBand != null) {
      body['ageBand'] = ageBand.wireName;
    } else if (clearAgeBand) {
      // `null` 是**显式清空**（家长从 primary_low 退回「未选择」），
      // 与「没传」（沿用库里已有的值）是两种意图，必须能区分。
      body['ageBand'] = null;
    }
    if (focusAreas != null) {
      body['focusAreas'] = _normalizeAreas(focusAreas);
    }

    final Object? decoded = await _send('PATCH', '/onboarding/profile', body);
    return _parse(
      decoded,
      (Object? raw, String path) => OnboardingStateDto.fromJson(raw, path),
    );
  }

  @override
  Future<OnboardingResultDto> complete({
    required List<String> templateSlugs,
    AgeBand? ageBand,
    List<String>? focusAreas,
    String? parentPin,
  }) async {
    final List<String> slugs = _normalizeSlugs(templateSlugs);
    if (slugs.isEmpty) {
      throw ArgumentError(
        '至少采纳 1 条约定才能完成引导（04 §6 4.2）—— 这次没有发请求。',
      );
    }
    if (slugs.length > 18) {
      throw ArgumentError('一次最多采纳 18 条约定（本次 ${slugs.length} 条）。');
    }

    final String? pin = parentPin?.trim();
    if (pin != null && pin.isEmpty) {
      // 空串是客户端 bug，不是「跳过」；跳过请传 null。
      throw ArgumentError('parentPin 不能是空串：不设 PIN 请传 null。');
    }
    if (pin != null) {
      final String? pinError = validateParentPin(pin);
      if (pinError != null) throw ArgumentError(pinError);
    }

    final Map<String, Object?> body = <String, Object?>{
      'templateSlugs': slugs,
      if (ageBand != null) 'ageBand': ageBand.wireName,
      if (focusAreas != null) 'focusAreas': _normalizeAreas(focusAreas),
      if (pin != null) 'parentPin': pin,
    };

    final Object? decoded = await _send('POST', '/onboarding/complete', body);
    return _parse(
      decoded,
      (Object? raw, String _) => OnboardingResultDto.fromJson(raw),
    );
  }

  /// 关注点保序去重 + 白名单校验。
  ///
  /// 不合法的值**在本地就拒**（`ArgumentError`）：后端 DTO 会用 `@IsIn(each)`
  /// 回 400，但那时第一次点击已经花掉了一个往返，而且错误文案是英文校验消息。
  List<String> _normalizeAreas(List<String> input) {
    final Set<String> seen = <String>{};
    final List<String> result = <String>[];
    for (final String raw in input) {
      final String value = raw.trim();
      if (!isFocusArea(value)) {
        throw ArgumentError.value(raw, 'focusAreas', '不是已知关注点');
      }
      if (!seen.add(value)) continue;
      result.add(value);
    }
    return result;
  }

  /// slug 保序去重（与后端 `normalizeTemplateSlugs` 同语义）。
  List<String> _normalizeSlugs(List<String> input) {
    final Set<String> seen = <String>{};
    final List<String> result = <String>[];
    for (final String raw in input) {
      final String value = raw.trim();
      if (value.isEmpty) continue;
      if (value.length > 64) {
        throw ArgumentError.value(raw, 'templateSlugs', 'slug 不能超过 64 字符');
      }
      if (!seen.add(value)) continue;
      result.add(value);
    }
    return result;
  }

  /// 严格解析失败（`ReadApiException`）也归一成写异常 —— 界面只处理一种错误类型。
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
    final Map<String, String> headers = <String, String>{
      HttpHeaders.acceptHeader: 'application/json',
      if (body != null)
        HttpHeaders.contentTypeHeader: 'application/json; charset=utf-8',
      kDeviceIdHeader: config.deviceId.trim(),
      kChildIdHeader: config.childId.trim(),
    };
    final String encoded = body == null ? '' : jsonEncode(body);

    final WriteHttpResponse response;
    try {
      response = await _transport
          .send(uri, headers, encoded, method: method)
          .timeout(timeout);
    } on TimeoutException {
      throw WriteApiException.timeout(timeout);
    } on IOException catch (error) {
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
      throw WriteApiException.fromHttp(
        statusCode: response.statusCode,
        body: decoded,
      );
    }
    if (decoded == null) {
      throw WriteApiException.malformed(
        r'$',
        detail: 'HTTP ${response.statusCode} 但响应体为空',
      );
    }
    return decoded;
  }

  @override
  void close() => _transport.close();
}




import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'read_api.dart' show ReadApiConfig, kChildIdHeader, kDeviceIdHeader;
import 'read_api_errors.dart';
import 'read_dto.dart';
import 'write_api_errors.dart';
import 'write_dto.dart';

/// 写传输层的一行响应 —— 测试替身只需要造这个。
class WriteHttpResponse {
  WriteHttpResponse({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
}

/// 写传输层接口。
///
/// 刻意与只读的 `ReadTransport` 分开：
///   · 写请求必须带 body / Content-Type，且**不允许**自动重试（重试要靠幂等键）；
///   · 让只读传输层保持极小面，不会因为加写入口而改到已经在跑的读路径。
///
/// [method] 默认 POST；规则编辑走 PATCH、删除走 DELETE。**不要**把方法塞进
/// body 或用 `_method` 覆盖 —— 后端是标准 REST 语义，幂等哈希也按真实方法计算。
abstract class WriteTransport {
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  });

  void close() {}
}

/// 基于 `dart:io HttpClient` 的最小实现。
class IoWriteTransport implements WriteTransport {
  IoWriteTransport({Duration connectionTimeout = const Duration(seconds: 10)})
      : _client = HttpClient()..connectionTimeout = connectionTimeout;

  final HttpClient _client;

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) async {
    final HttpClientRequest request = await _client.openUrl(method, uri);
    headers.forEach(request.headers.set);
    if (body.isNotEmpty) request.write(body);
    final HttpClientResponse response = await request.close();
    final String text = await utf8.decoder.bind(response).join();
    return WriteHttpResponse(statusCode: response.statusCode, body: text);
  }

  @override
  void close() => _client.close(force: true);
}

/// AppStore 依赖的写能力（测试可注入自己的实现，不必起 HTTP 服务）。
abstract class WriteApi {
  /// 打卡。返回服务端真正写入的流水。
  Future<WrittenRecordDto> checkIn(
    String habitId, {
    String? idempotencyKey,
  });

  /// 撤销一条打卡。返回**冲正记录**（不是原记录）。
  Future<WrittenRecordDto> reverse(
    String recordId, {
    String? idempotencyKey,
    String? note,
  });

  /// 新建规则。`points` 带符号（负 = 扣分），服务端落库时拆成
  /// 「正数分值 + direction」，回包仍是带符号的分值。
  Future<RuleDto> createRule({
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required String icon,
    required String color,
    String? idempotencyKey,
  });

  /// 更新规则。[expectedVersion] 是**客户端看到的版本号**：与服务端不一致
  /// ⇒ 409 `RULE_VERSION_CONFLICT`，绝不静默覆盖别人刚改的内容。
  Future<RuleDto> updateRule(
    String ruleId, {
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required int expectedVersion,
    String? idempotencyKey,
  });

  /// 软删规则（进回收站）。返回服务端确认删除的 `ruleId`。
  Future<String> deleteRule(
    String ruleId, {
    String? idempotencyKey,
  });

  /// 按规则生成首页习惯。返回与 `GET /home` 的 `habits[]` 同构的行。
  Future<HabitDto> addHabitFromRule(
    String ruleId, {
    String? idempotencyKey,
  });

  void close() {}
}

/// `POST /records/check-in` 与 `POST /records/:id/reverse` 的客户端。
///
/// 身份头与只读端完全一致（设备 id + 孩子 id）；`childId` 仍然只是
/// 「会话作用在哪个孩子上」，真正的授权由后端 Guard 判定。
class WriteApiClient implements WriteApi {
  WriteApiClient({
    required this.config,
    WriteTransport? transport,
    this.timeout = const Duration(seconds: 10),
  }) : _transport = transport ?? IoWriteTransport(connectionTimeout: timeout);

  final ReadApiConfig config;
  final Duration timeout;
  final WriteTransport _transport;

  @override
  Future<WrittenRecordDto> checkIn(
    String habitId, {
    String? idempotencyKey,
  }) async {
    if (habitId.trim().isEmpty) {
      throw ArgumentError.value(habitId, 'habitId', '不能为空');
    }
    final Object? decoded = await _send(
      'POST',
      '/records/check-in',
      <String, Object?>{'habitId': habitId.trim()},
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, WrittenRecordDto.fromJson);
  }

  @override
  Future<WrittenRecordDto> reverse(
    String recordId, {
    String? idempotencyKey,
    String? note,
  }) async {
    final String id = recordId.trim();
    if (id.isEmpty) {
      throw ArgumentError.value(recordId, 'recordId', '不能为空');
    }
    final String? trimmedNote = note?.trim();
    final Object? decoded = await _send(
      'POST',
      '/records/${Uri.encodeComponent(id)}/reverse',
      <String, Object?>{
        if (trimmedNote != null && trimmedNote.isNotEmpty) 'note': trimmedNote,
      },
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, WrittenRecordDto.fromJson);
  }

  @override
  Future<RuleDto> createRule({
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required String icon,
    required String color,
    String? idempotencyKey,
  }) async {
    final String trimmedTitle = title.trim();
    if (trimmedTitle.isEmpty) {
      throw ArgumentError.value(title, 'title', '不能为空');
    }
    final Object? decoded = await _send(
      'POST',
      '/point-rules',
      <String, Object?>{
        'title': trimmedTitle,
        'condition': condition.trim(),
        'dailyLimit': dailyLimit,
        'points': points,
        'icon': icon,
        'color': color,
      },
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, RuleDto.fromJson);
  }

  @override
  Future<RuleDto> updateRule(
    String ruleId, {
    required String title,
    required String condition,
    required int dailyLimit,
    required int points,
    required int expectedVersion,
    String? idempotencyKey,
  }) async {
    final String id = _requireId(ruleId, 'ruleId');
    final String trimmedTitle = title.trim();
    if (trimmedTitle.isEmpty) {
      throw ArgumentError.value(title, 'title', '不能为空');
    }
    if (expectedVersion < 1) {
      throw ArgumentError.value(expectedVersion, 'expectedVersion', '必须 ≥ 1');
    }
    final Object? decoded = await _send(
      'PATCH',
      '/point-rules/${Uri.encodeComponent(id)}',
      <String, Object?>{
        'title': trimmedTitle,
        'condition': condition.trim(),
        'dailyLimit': dailyLimit,
        'points': points,
        // 乐观锁：客户端只声明「我改的是第几版」，版本递增由服务端做。
        'expectedVersion': expectedVersion,
      },
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, RuleDto.fromJson);
  }

  @override
  Future<String> deleteRule(String ruleId, {String? idempotencyKey}) async {
    final String id = _requireId(ruleId, 'ruleId');
    final Object? decoded = await _send(
      'DELETE',
      '/point-rules/${Uri.encodeComponent(id)}',
      // DELETE 没有请求体：目标已经在路径里，幂等哈希也按 null body 计算。
      null,
      idempotencyKey: idempotencyKey,
    );
    final Object? returned = decoded is Map ? decoded['ruleId'] : null;
    if (returned != id) {
      // 回包确认的不是「我删的那条」⇒ 宁可报错，也不能让界面假装删对了。
      throw WriteApiException.malformed(
        r'$.ruleId',
        detail: '删除回包的 ruleId 与请求不一致：$returned != $id',
      );
    }
    return id;
  }

  @override
  Future<HabitDto> addHabitFromRule(
    String ruleId, {
    String? idempotencyKey,
  }) async {
    final String id = _requireId(ruleId, 'ruleId');
    final Object? decoded = await _send(
      'POST',
      '/point-rules/${Uri.encodeComponent(id)}/habits',
      null,
      idempotencyKey: idempotencyKey,
    );
    return _parse(decoded, HabitDto.fromJson);
  }

  String _requireId(String value, String name) {
    final String id = value.trim();
    if (id.isEmpty) throw ArgumentError.value(value, name, '不能为空');
    return id;
  }

  /// 严格解析失败（`ReadApiException`）也必须归一到写异常：
  /// 页面只处理一种错误类型，不必知道「这次是读 DTO 报的错」。
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
    Map<String, Object?>? body, {
    String? idempotencyKey,
  }) async {
    final String? configError = config.validationError;
    if (configError != null) {
      throw WriteApiException(
        WriteFailureKind.badRequest,
        configError,
        code: 'CLIENT_NOT_CONFIGURED',
      );
    }

    final String? key = idempotencyKey?.trim();
    if (key != null && key.length > 200) {
      throw ArgumentError.value(
        idempotencyKey,
        'idempotencyKey',
        '不能超过 200 字符（后端同口径）',
      );
    }

    final Uri uri = config.uri(path);
    final Map<String, String> headers = <String, String>{
      HttpHeaders.acceptHeader: 'application/json',
      if (body != null)
        HttpHeaders.contentTypeHeader: 'application/json; charset=utf-8',
      kDeviceIdHeader: config.deviceId.trim(),
      kChildIdHeader: config.childId.trim(),
      if (key != null && key.isNotEmpty) 'idempotency-key': key,
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
    if (decoded == null && body != null) {
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

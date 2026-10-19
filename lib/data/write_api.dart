import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'read_api.dart' show ReadApiConfig, kChildIdHeader, kDeviceIdHeader;
import 'write_api_errors.dart';
import 'write_dto.dart';

/// 写传输层的一行响应 —— 测试替身只需要造这个。
class WriteHttpResponse {
  WriteHttpResponse({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
}

/// 写传输层接口（当前只有 POST）。
///
/// 刻意与只读的 `ReadTransport` 分开：
///   · 写请求必须带 body / Content-Type，且**不允许**自动重试（重试要靠幂等键）；
///   · 让只读传输层保持极小面，不会因为加写入口而改到已经在跑的读路径。
abstract class WriteTransport {
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body,
  );

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
    String body,
  ) async {
    final HttpClientRequest request = await _client.postUrl(uri);
    headers.forEach(request.headers.set);
    request.write(body);
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
  }) {
    if (habitId.trim().isEmpty) {
      throw ArgumentError.value(habitId, 'habitId', '不能为空');
    }
    return _post(
      '/records/check-in',
      <String, Object?>{'habitId': habitId.trim()},
      idempotencyKey: idempotencyKey,
    );
  }

  @override
  Future<WrittenRecordDto> reverse(
    String recordId, {
    String? idempotencyKey,
    String? note,
  }) {
    final String id = recordId.trim();
    if (id.isEmpty) {
      throw ArgumentError.value(recordId, 'recordId', '不能为空');
    }
    final String? trimmedNote = note?.trim();
    return _post(
      '/records/${Uri.encodeComponent(id)}/reverse',
      <String, Object?>{
        if (trimmedNote != null && trimmedNote.isNotEmpty) 'note': trimmedNote,
      },
      idempotencyKey: idempotencyKey,
    );
  }

  Future<WrittenRecordDto> _post(
    String path,
    Map<String, Object?> body, {
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
      HttpHeaders.contentTypeHeader: 'application/json; charset=utf-8',
      kDeviceIdHeader: config.deviceId.trim(),
      kChildIdHeader: config.childId.trim(),
      if (key != null && key.isNotEmpty) 'idempotency-key': key,
    };
    final String encoded = jsonEncode(body);

    final WriteHttpResponse response;
    try {
      response = await _transport.send(uri, headers, encoded).timeout(timeout);
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
    return WrittenRecordDto.fromJson(decoded);
  }

  @override
  void close() => _transport.close();
}

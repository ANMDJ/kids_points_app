import 'dart:convert';
import 'dart:io';

import 'http_transport_types.dart';

/// **移动 / 桌面 / 测试**的传输层实现（`dart:io HttpClient`，零第三方依赖）。
///
/// ★ 本文件是全仓库**唯一**允许在 HTTP 链路上 `import 'dart:io'` 的地方之一
///   （另一个是 `token_store_io.dart`）。Web 构建不会编译到它 ——
///   `http_transport.dart` 用 `if (dart.library.js_interop)` 在浏览器里换成
///   `http_transport_web.dart`。

/// 基于 `dart:io HttpClient` 的只读实现：桌面 / 移动都能跑。
class IoReadTransport implements ReadTransport {
  IoReadTransport({Duration connectionTimeout = kDefaultConnectionTimeout})
      : _client = HttpClient()..connectionTimeout = connectionTimeout;

  final HttpClient _client;

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers) async {
    final HttpClientRequest request = await _client.getUrl(uri);
    headers.forEach(request.headers.set);
    final HttpClientResponse response = await request.close();
    final String body = await utf8.decoder.bind(response).join();
    return ReadHttpResponse(statusCode: response.statusCode, body: body);
  }

  @override
  void close() => _client.close(force: true);
}

/// 基于 `dart:io HttpClient` 的写实现。
class IoWriteTransport implements WriteTransport {
  IoWriteTransport({Duration connectionTimeout = kDefaultConnectionTimeout})
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

/// 默认只读传输层（VM 上就是 [IoReadTransport]）。
ReadTransport createReadTransport({
  Duration connectionTimeout = kDefaultConnectionTimeout,
}) =>
    IoReadTransport(connectionTimeout: connectionTimeout);

/// 默认写传输层（VM 上就是 [IoWriteTransport]）。
WriteTransport createWriteTransport({
  Duration connectionTimeout = kDefaultConnectionTimeout,
}) =>
    IoWriteTransport(connectionTimeout: connectionTimeout);

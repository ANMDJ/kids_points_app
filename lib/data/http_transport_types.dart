/// HTTP 传输层的**纯类型**（W10-A，2026-10-30 / 为 Flutter Web 拆出）。
///
/// ── 为什么要单独一个文件 ────────────────────────────────────────────────────
///   `ReadTransport` / `WriteTransport` 与两个响应类原来写在 `read_api.dart` /
///   `write_api.dart` 里，而这两个文件顶上有 `import 'dart:io'`（为了
///   `HttpClient` / `HttpHeaders` / `IOException`）。Web 编译时 `dart:io` **不可用**，
///   于是「只是想跑个预览界面」也会在编译期炸掉。
///   ⇒ 把**与平台无关的类型**搬到这里，平台实现分成两份：
///     · `http_transport_io.dart`  —— `dart:io HttpClient`（移动 / 桌面 / 测试）；
///     · `http_transport_web.dart` —— `XMLHttpRequest`（Chrome / Safari / Edge）。
///     上层 `read_api.dart` / `write_api.dart` 只依赖本文件与工厂函数，
///     于是**同一份业务代码在 VM 和浏览器上都能编译**。
///
/// ── 不要在这里 import `dart:io` ─────────────────────────────────────────────
///   一旦有人为了省事把 `HttpHeaders` / `SocketException` 加回来，Web 构建会
///   立刻退回「编译失败」。请求头常量见下方 `kAcceptHeader` 等三个。
library;

/// 传输层的一行响应 —— 测试替身只需要造这个，不必起真的 HTTP 服务。
class ReadHttpResponse {
  ReadHttpResponse({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
}

/// 传输层接口（GET 专用）。默认实现由 [createReadTransport] 给出。
abstract class ReadTransport {
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers);

  void close() {}
}

/// 写传输层的一行响应 —— 测试替身只需要造这个。
class WriteHttpResponse {
  WriteHttpResponse({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
}

/// 写传输层接口。
///
/// 刻意与只读的 [ReadTransport] 分开：
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

/// 传输层失败（Web 专用异常类型）。
///
/// 移动 / 桌面上 `dart:io` 抛的是 `SocketException` / `HttpException`；
/// 浏览器里没有这些类型，XHR 只会给一个 `onerror` 事件。两边都**必须**能让
/// 上层把它翻译成「网络错误」，所以 Web 侧统一抛本类型。
///
/// ★ 客户端捕获的是 `on Exception`（不是本类型）：`SocketException` 与
///   [TransportException] 都实现 `Exception`，一处 catch 覆盖两套平台，
///   不必为了「Web 没有 dart:io」在每个客户端里写两份 catch。
class TransportException implements Exception {
  const TransportException(this.message, {this.cause});

  /// 可直接展示 / 写日志的说明（**不含** token）。
  final String message;

  /// 底层原因（浏览器里通常是 `DOMException` / `ProgressEvent` 的字符串）。
  final Object? cause;

  @override
  String toString() => 'TransportException: $message';
}

/// 请求头名 —— 显式字面量，不再依赖 `dart:io` 的 `HttpHeaders`。
///
/// 这三个值与 `HttpHeaders.acceptHeader` / `contentTypeHeader` /
/// `authorizationHeader` **逐字一致**（HTTP/1.1 头名大小写不敏感，
/// 服务端读到的是小写形式）。
const String kAcceptHeader = 'accept';
const String kContentTypeHeader = 'content-type';
const String kAuthorizationHeader = 'authorization';

/// 传输层默认连接超时（与各客户端的 `timeout` 默认值同量级）。
const Duration kDefaultConnectionTimeout = Duration(seconds: 10);

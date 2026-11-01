import 'dart:async';
import 'dart:js_interop';

import 'http_transport_types.dart';

/// **浏览器**的传输层实现（`XMLHttpRequest` + `dart:js_interop`，零第三方依赖）。
///
/// ── 为什么不用 `package:http` / `package:web` ────────────────────────────────
///   `README.md:19` 把「零第三方依赖、`flutter pub get` 离线也能通过」写成硬约束。
///   浏览器里能用的只有两种零依赖方案：`dart:html`（已弃用）与 `dart:js_interop`
///   （Dart 官方推荐、dart2js / wasm 都支持）。这里选后者，手写一个 10 行的
///   XHR 互操作声明，换掉一个包依赖 + 一次联网 `pub get`。
///
/// ── 与 IO 版的行为对齐 ──────────────────────────────────────────────────────
///   · 超时：IO 版由外层 `.timeout()` + `HttpClient.connectionTimeout` 管；
///     这里额外给 XHR 设 `timeout`，抛的还是 `TimeoutException`，
///     上层 `on TimeoutException` 分支**两份平台同一套**；
///   · 失败：IO 抛 `SocketException`（`Exception` 子类），这里抛
///     [TransportException]（同样 `Exception`）⇒ 客户端只需 `on Exception`；
///   · `close()` 是空实现：XHR 是一次性的，浏览器没有可释放的客户端连接池。
///
/// ── 必须知道的浏览器限制（不是 bug，是规范）────────────────────────────────
///   1. **CORS**：从 `http://localhost:PORT` 请求 `http://127.0.0.1:3000` 属于
///      跨源。请求带了 `authorization` / `x-kp-device-id` / `content-type:
///      application/json`，浏览器会先发 `OPTIONS` 预检；服务端**没有**
///      `enableCors()` 时预检 404 ⇒ 页面会显示「网络错误」。
///      本地联调可以用 `flutter run -d chrome --web-browser-flag=
///      "--disable-web-security"` 绕过，但**不要**把它当成方案；
///   2. 浏览器不允许设置 `accept` 以外的受限头？—— 不，`accept` 是允许的，
///      真正被禁止的是 `host` / `content-length` / `user-agent` 这类，
///      本仓库只发 `accept` / `content-type` / `authorization` / `x-kp-*` /
///      `idempotency-key`，都在允许范围内（但都会触发预检）；
///   3. 页面是 `https://` 而接口是 `http://` ⇒ 混合内容被直接拦截，
///      与传输层无关，配置 `KP_API_BASE_URL` 时要么都 http，要么都 https。

@JS('XMLHttpRequest')
extension type _XmlHttpRequest._(JSObject _) implements JSObject {
  external factory _XmlHttpRequest();

  external void open(String method, String url, JSBoolean async);

  external void setRequestHeader(String name, String value);

  external void send([JSAny? body]);

  external void overrideMimeType(String mimeType);

  external int get status;

  external String get responseText;

  external set timeout(int milliseconds);

  external set onload(JSFunction handler);

  external set onerror(JSFunction handler);

  external set ontimeout(JSFunction handler);
}

/// 浏览器里**唯一**的发请求路径（读 / 写共用，差别只有 method 与 body）。
Future<WriteHttpResponse> _sendOverXhr(
  String method,
  Uri uri,
  Map<String, String> headers,
  String body,
  Duration timeout,
) {
  final Completer<WriteHttpResponse> completer = Completer<WriteHttpResponse>();
  final _XmlHttpRequest xhr = _XmlHttpRequest();

  void complete(WriteHttpResponse response) {
    if (!completer.isCompleted) completer.complete(response);
  }

  void fail(Object error) {
    if (!completer.isCompleted) completer.completeError(error);
  }

  // XHR 的 timeout 是毫秒，`0` 表示「不超时」—— 传 0 会把超时悄悄关掉，
  // 所以这里至少给 1ms（调用方默认 10s，不会碰到这个下界）。
  xhr.timeout = timeout.inMilliseconds.clamp(1, 0x7fffffff);
  xhr.onload = ((JSAny? _) {
    // 注意：HTTP 4xx / 5xx 也会走 onload —— 状态码交给上层解释，
    // 传输层不把「401」当成网络失败（否则登录页会显示成断网）。
    complete(WriteHttpResponse(
      statusCode: xhr.status,
      body: xhr.responseText,
    ));
  }).toJS;
  xhr.onerror = ((JSAny? event) {
    fail(TransportException(
      '浏览器拒绝了这次请求（服务器未启动 / 断网 / 被 CORS 拦截）。',
      cause: event,
    ));
  }).toJS;
  xhr.ontimeout = ((JSAny? _) {
    fail(TimeoutException('请求超时（${timeout.inSeconds} 秒）', timeout));
  }).toJS;

  try {
    xhr.open(method, uri.toString(), true.toJS);
    // 后端回的是 `application/json; charset=utf-8`；这里再钉一次，避免中间层
    // 把 charset 改写成 latin-1 之后中文昵称 / 规则名变成乱码。
    xhr.overrideMimeType('text/plain; charset=utf-8');
    headers.forEach((String name, String value) {
      // 不能写成 `headers.forEach(xhr.setRequestHeader)`：external extension type
      // 成员的 tear-off 是禁止的（`Tear-offs of external extension type interop
      // member are disallowed`），写出来 dart2js 直接编不过。
      xhr.setRequestHeader(name, value);
    });
    if (body.isEmpty) {
      xhr.send();
    } else {
      xhr.send(body.toJS);
    }
  } catch (error) {
    fail(TransportException('无法发起请求：$error', cause: error));
  }

  return completer.future;
}

/// 浏览器里的只读传输层。
class WebReadTransport implements ReadTransport {
  WebReadTransport({this.connectionTimeout = kDefaultConnectionTimeout});

  final Duration connectionTimeout;

  @override
  Future<ReadHttpResponse> send(Uri uri, Map<String, String> headers) async {
    final WriteHttpResponse response =
        await _sendOverXhr('GET', uri, headers, '', connectionTimeout);
    return ReadHttpResponse(
      statusCode: response.statusCode,
      body: response.body,
    );
  }

  /// XHR 没有连接池：每次 `send` 都是一个独立请求，没有可关闭的资源。
  @override
  void close() {}
}

/// 浏览器里的写传输层。
class WebWriteTransport implements WriteTransport {
  WebWriteTransport({this.connectionTimeout = kDefaultConnectionTimeout});

  final Duration connectionTimeout;

  @override
  Future<WriteHttpResponse> send(
    Uri uri,
    Map<String, String> headers,
    String body, {
    String method = 'POST',
  }) =>
      _sendOverXhr(method, uri, headers, body, connectionTimeout);

  @override
  void close() {}
}

/// 默认只读传输层（Web 上就是 [WebReadTransport]）。
ReadTransport createReadTransport({
  Duration connectionTimeout = kDefaultConnectionTimeout,
}) =>
    WebReadTransport(connectionTimeout: connectionTimeout);

/// 默认写传输层（Web 上就是 [WebWriteTransport]）。
WriteTransport createWriteTransport({
  Duration connectionTimeout = kDefaultConnectionTimeout,
}) =>
    WebWriteTransport(connectionTimeout: connectionTimeout);

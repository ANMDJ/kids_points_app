/// 传输层的**平台入口**：同一份业务代码在 VM 与 Web 上各用各的实现。
///
/// ```dart
/// import 'http_transport.dart';              // 类型 + 工厂，一次到位
/// final ReadTransport t = createReadTransport();
/// ```
///
/// ★ 条件用的是 `dart.library.js_interop` 而不是已弃用的 `dart.library.html`：
///   前者在 dart2js **和** dartwasm 下都为 true，后者在 wasm 下不可靠。
library;

export 'http_transport_io.dart'
    if (dart.library.js_interop) 'http_transport_web.dart';
export 'http_transport_types.dart';

/// token 存储的平台入口：同一份上层代码在 VM 与 Web 上各用各的存储。
///
/// ★ 条件用的是 `dart.library.js_interop`（dart2js / dartwasm 都为 true），
///   不是已弃用的 `dart.library.html`。
library;

export 'token_store_io.dart' if (dart.library.js_interop) 'token_store_web.dart';

/// 运行期身份存储的平台入口（与 `token_store_default.dart` 同一形状）。
library;

export 'session_store_io.dart'
    if (dart.library.js_interop) 'session_store_web.dart';

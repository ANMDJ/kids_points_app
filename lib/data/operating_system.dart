/// 当前操作系统的**平台入口**。
///
/// `push_token_registration.dart` 用它推断推送平台；它原来直接 `import 'dart:io'`，
/// 而 Web 上没有 `dart:io` ⇒ 整个 App 在浏览器里编译不过（W10-A 修的就是这个）。
library;

export 'operating_system_io.dart'
    if (dart.library.js_interop) 'operating_system_web.dart';

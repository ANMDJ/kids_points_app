/// 打开外部链接（更新下载页）的平台入口。
///
/// ── 为什么不用 `url_launcher` ────────────────────────────────────────────────
///   README 把「零第三方依赖」写成硬约束（`flutter pub get` 离线也要能过）。
///   打开一个 URL 在两端各只需要十几行平台代码：
///     · Android → `MethodChannel('kp/url_opener')` → `Intent.ACTION_VIEW`
///       （实现见 `android/app/src/main/kotlin/.../MainActivity.kt`）；
///     · 桌面   → `Process.start`（Windows `cmd /c start` / macOS `open` / Linux `xdg-open`）；
///     · Web    → `window.open(url, '_blank')`。
///   失败一律返回 `false`，由界面退回到「复制链接」——**不要**假装打开了。
library;

export 'url_opener_io.dart' if (dart.library.js_interop) 'url_opener_web.dart';

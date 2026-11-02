import 'dart:js_interop';

/// 浏览器端：新标签页打开（`window.open`）。
///
/// 与 IO 版同一契约：只在 http(s) 绝对地址上动作，失败返回 `false`。
/// `window.open` 被弹窗拦截时返回 `null`，这里按"没打开"处理。
Future<bool> openExternalUrl(String url) async {
  final Uri? uri = Uri.tryParse(url.trim());
  if (uri == null ||
      !(uri.scheme == 'http' || uri.scheme == 'https') ||
      uri.host.isEmpty) {
    return false;
  }
  try {
    final JSAny? opened = _openWindow(url, '_blank');
    return opened != null;
  } catch (_) {
    return false;
  }
}

@JS('window.open')
external JSAny? _openWindow(String url, String target);

import 'dart:io';

import 'package:flutter/services.dart';

const MethodChannel _channel = MethodChannel('kp/url_opener');

/// 用系统浏览器打开 [url]。返回是否**确实**发起了打开动作。
Future<bool> openExternalUrl(String url) async {
  if (!_isHttpUrl(url)) return false;
  try {
    if (Platform.isAndroid) {
      // Android 端由 MainActivity 的 channel 实现（ACTION_VIEW）。
      // 返回 false 可能是没有浏览器 / 系统拦了 intent —— 交给界面兜底。
      final bool? opened = await _channel.invokeMethod<bool>(
        'open',
        <String, String>{'url': url},
      );
      return opened ?? false;
    }
    if (Platform.isWindows) {
      await Process.start(
        'cmd',
        <String>['/c', 'start', '', url],
        runInShell: false,
        mode: ProcessStartMode.detached,
      );
      return true;
    }
    if (Platform.isMacOS) {
      await Process.start('open', <String>[url], mode: ProcessStartMode.detached);
      return true;
    }
    if (Platform.isLinux) {
      await Process.start('xdg-open', <String>[url], mode: ProcessStartMode.detached);
      return true;
    }
  } on Exception {
    // PlatformException / ProcessException 都走这里：调用方只需要知道"没打开"。
    return false;
  }
  return false;
}

bool _isHttpUrl(String url) {
  final Uri? uri = Uri.tryParse(url.trim());
  return uri != null &&
      (uri.scheme == 'http' || uri.scheme == 'https') &&
      uri.host.isNotEmpty;
}

import 'dart:io';

import 'token_store_base.dart';

/// **移动 / 桌面的** token 存储：`dart:io` 直接写缓存目录（零第三方依赖）。
///
/// ── 存放位置的诚实标注 ──────────────────────────────────────────────────────
///   [FileTokenStore] 落在 `Directory.systemTemp`（Android 上是应用缓存目录，
///   iOS 上是 `tmp`）。**系统清理缓存 / 用户清数据 ⇒ token 丢失 ⇒ 需要重新输入密码**。
///   这与「`AuthSession` 7 天绝对过期、不滑动」的既有口径同一量级
///   （`auth-session.gate.ts` 的 `AUTH_SESSION_TTL_MS`），所以不构成体验回归。
///
///   ★ 反过来说：**把密码也存下来**才是负收益 —— 那会把"7 天 token 泄露"
///     升级成"永久密码泄露"。本文件只存 token，且不提供"存密码"的入口。
///
/// ★ 浏览器里没有文件系统，`flutter build web` 不会编译到本文件 ——
///   `token_store_default.dart` 用 `if (dart.library.js_interop)` 换成
///   `token_store_web.dart` 的 `LocalStorageTokenStore`。
class FileTokenStore implements TokenStore {
  FileTokenStore({
    String? directory,
    this.fileName = 'kp_token',
  }) : _directory = directory ?? Directory.systemTemp.path;

  final String _directory;
  final String fileName;

  File get file => File('$_directory${Platform.pathSeparator}$fileName');

  @override
  Future<String?> read() async {
    try {
      final File target = file;
      if (!await target.exists()) return null;
      final String raw = await target.readAsString();
      final String token = raw.trim();
      // 形状不合法 ⇒ 当成"没有"。绝不把一个坏字符串送进 Authorization 头。
      return isValidToken(token) ? token : null;
    } on FileSystemException {
      return null;
    }
  }

  @override
  Future<void> write(String token) async {
    final String trimmed = token.trim();
    if (!isValidToken(trimmed)) {
      // 写进去也读不回来，不如当场响 —— 这一定是调用方的 bug（拿错了变量）。
      throw ArgumentError.value(token, 'token', '不是合法的 kp token（kps_ + 43 位 base64url）');
    }
    final Directory dir = Directory(_directory);
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    await file.writeAsString(trimmed, flush: true);
  }

  @override
  Future<void> clear() async {
    try {
      final File target = file;
      if (await target.exists()) await target.delete();
    } on FileSystemException {
      // 删不掉不是错误：最坏情况是下次启动读到一个**已过期**的 token，
      // 服务端会回 401 TOKEN_EXPIRED，客户端照常回登录页。
    }
  }
}

/// 默认存储（VM 上就是 [FileTokenStore]）。
TokenStore createDefaultTokenStore() => FileTokenStore();

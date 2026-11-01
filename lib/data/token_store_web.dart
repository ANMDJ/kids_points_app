import 'dart:js_interop';

import 'token_store_base.dart';

/// **浏览器**的 token 存储：`window.localStorage`（零第三方依赖）。
///
/// ── 为什么是 localStorage 而不是 IndexedDB ──────────────────────────────────
///   只存一个 47 字符的 token，不需要事务、不需要异步、不需要大容量。
///   IndexedDB 要多写几百行包装（还有版本迁移），收益为零。
///
/// ── 与 [FileTokenStore] 的差别（诚实标注）──────────────────────────────────
///   · **持久**：localStorage 不会因为关标签页消失，也不像 `/tmp` 会被系统清理；
///   · **同源可见**：同源下的其它页面 / 脚本能读到它。所以 Web 版不要在
///     共享域名的页面上跑（本地 `localhost:PORT` 联调没问题）；
///   · **可能直接抛**：隐私模式 / 禁用站点数据时，读 `localStorage` 会抛
///     `SecurityError`。`read()` 把它当成"没有 token"（回登录页），
///     `write()` 让它抛出去，由 `AuthTokenHolder.adopt()` 降级成内存。
class LocalStorageTokenStore implements TokenStore {
  LocalStorageTokenStore({this.key = 'kp_token'});

  /// 存储键名 —— 与 [FileTokenStore.fileName] 同义（同一台设备上不会串）。
  final String key;

  @override
  Future<String?> read() async {
    try {
      final String raw = _localStorage.getItem(key) ?? '';
      final String token = raw.trim();
      // 与文件版同一条规则：形状不合法 ⇒ 当成"没有"。
      return isValidToken(token) ? token : null;
    } catch (_) {
      // 隐私模式 / 禁用站点数据：读不了不是错误，最坏结果是重新登录。
      return null;
    }
  }

  @override
  Future<void> write(String token) async {
    final String trimmed = token.trim();
    if (!isValidToken(trimmed)) {
      throw ArgumentError.value(
        token,
        'token',
        '不是合法的 kp token（kps_ + 43 位 base64url）',
      );
    }
    // ★ 不吞异常：配额满 / 禁写时必须让 `AuthTokenHolder` 知道，
    //   由它降级成内存（"这次能用、重启要重新登录"），而不是装作已保存。
    _localStorage.setItem(key, trimmed);
  }

  @override
  Future<void> clear() async {
    try {
      _localStorage.removeItem(key);
    } catch (_) {
      // 删不掉不是错误：最坏情况是下次启动读到一条已过期的 token，
      // 服务端回 401 TOKEN_EXPIRED，界面照常回登录页。
    }
  }
}

@JS('window.localStorage')
external _Storage get _localStorage;

extension type _Storage._(JSObject _) implements JSObject {
  external String? getItem(String key);

  external void setItem(String key, String value);

  external void removeItem(String key);
}

/// 默认存储（Web 上就是 [LocalStorageTokenStore]）。
TokenStore createDefaultTokenStore() => LocalStorageTokenStore();

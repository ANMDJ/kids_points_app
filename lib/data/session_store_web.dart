import 'dart:convert';
import 'dart:js_interop';

import 'session_store_base.dart';

/// **浏览器**的运行期身份存储：`window.localStorage`（零第三方依赖）。
///
/// 与 IO 版同一契约；隐私模式 / 禁用站点数据时读不到 ⇒ `null`（重新生成设备 id），
/// 写入失败让异常抛给 [SessionScope] 决定降级成内存。
class LocalStorageSessionStore implements SessionStore {
  LocalStorageSessionStore({this.key = kSessionStorageKey});

  final String key;

  @override
  Future<SessionSnapshot?> read() async {
    try {
      final String? raw = _localStorage.getItem(key);
      if (raw == null || raw.trim().isEmpty) return null;
      return SessionSnapshot.fromJson(jsonDecode(raw));
    } catch (_) {
      return null;
    }
  }

  @override
  Future<void> write(SessionSnapshot snapshot) async {
    // ★ 不吞异常：配额满 / 禁写时必须让调用方知道（降级为内存）。
    _localStorage.setItem(key, jsonEncode(snapshot.toJson()));
  }

  @override
  Future<void> clear() async {
    try {
      _localStorage.removeItem(key);
    } catch (_) {
      // 删不掉不是错误：读侧还有形状校验。
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

/// 默认存储（Web 上就是 [LocalStorageSessionStore]）。
SessionStore createDefaultSessionStore() => LocalStorageSessionStore();

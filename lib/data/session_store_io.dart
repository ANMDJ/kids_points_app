import 'dart:convert';
import 'dart:io';

import 'session_store_base.dart';

/// **移动 / 桌面**的运行期身份存储：`dart:io` 写缓存目录（零第三方依赖）。
///
/// ── 存放位置的诚实标注 ──────────────────────────────────────────────────────
///   与 [FileTokenStore] 同一个目录（`Directory.systemTemp`，Android 上是应用
///   缓存目录）。**系统清缓存 ⇒ 设备 id 丢失** ⇒ 下次启动生成新的：
///   表现为\"这台设备的历史会话不见了\"，需要重新登录。
///   这与 token 的临时存储是同一个量级的取舍（`42` §7.2.1），
///   真要长期稳定应换 `shared_preferences`（需破例引入第三方依赖）。
class FileSessionStore implements SessionStore {
  FileSessionStore({
    String? directory,
    this.fileName = kSessionStorageKey,
  }) : _directory = directory ?? Directory.systemTemp.path;

  final String _directory;
  final String fileName;

  File get file => File('$_directory${Platform.pathSeparator}$fileName');

  @override
  Future<SessionSnapshot?> read() async {
    try {
      final File target = file;
      if (!await target.exists()) return null;
      return SessionSnapshot.fromJson(jsonDecode(await target.readAsString()));
    } on FileSystemException {
      return null;
    } on FormatException {
      // 文件被手工改坏 / 旧版本写了别的形状 ⇒ 当成\"没存过\"。
      return null;
    }
  }

  @override
  Future<void> write(SessionSnapshot snapshot) async {
    final Directory dir = Directory(_directory);
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    await file.writeAsString(jsonEncode(snapshot.toJson()), flush: true);
  }

  @override
  Future<void> clear() async {
    try {
      final File target = file;
      if (await target.exists()) await target.delete();
    } on FileSystemException {
      // 删不掉不是错误：下次读到的快照仍会经过形状校验。
    }
  }
}

/// 默认存储（VM 上就是 [FileSessionStore]）。
SessionStore createDefaultSessionStore() => FileSessionStore();

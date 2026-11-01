/// token 的**形状**与存储抽象（W10-A，2026-10-30 / 为 Flutter Web 拆出）。
///
/// ── 为什么拆成三个文件 ──────────────────────────────────────────────────────
///   与 `http_transport_types.dart` 同一个原因：Web 上没有 `dart:io`，
///   而旧版 `token_store.dart` 顶上就是 `import 'dart:io';`（为了写文件）
///   ⇒ 整个 App 在浏览器里**编译不过**。现在：
///     · 本文件：形状校验 ＋ [TokenStore] 接口 ＋ [MemoryTokenStore]（平台无关）；
///     · `token_store_io.dart`：`FileTokenStore`（`dart:io` 写缓存目录）；
///     · `token_store_web.dart`：`LocalStorageTokenStore`（浏览器 `localStorage`）。
///   上层只认 [TokenStore] 与 `createDefaultTokenStore()`，换存储不影响 `AuthTokenHolder`。
///
/// ── 为什么没有 `shared_preferences` ─────────────────────────────────────────
///   `README.md:19` 把「不引入第三方依赖、`flutter pub get` 在离线环境也能通过」
///   写成硬约束，并且明确点名了 `shared_preferences`。它是"换个目录"的便利，
///   代价却是联网 `pub get` + Android/iOS 两套平台配置。
///
/// ── 形状校验在读取侧，也在写入侧 ────────────────────────────────────────────
///   存储可能被别的东西写坏 / 被手工编辑。`read()` 只在形状合法时返回，
///   否则当成"没有 token" —— 而不是把一个 `kps_` 都不像的字符串塞进
///   `Authorization` 头，换来一个必然 401 且原因不明的请求。
library;

/// token 前缀与长度 —— 与后端 `auth-session.gate.ts` 的 `TOKEN_PREFIX` /
/// `TOKEN_BODY_LENGTH` **逐字一致**。改一处必须改两处。
const String kTokenPrefix = 'kps_';
const int kTokenBodyLength = 43;

/// `kps_` + 43 个 base64url 字符（32 字节无填充）。
bool isValidToken(String token) {
  if (!token.startsWith(kTokenPrefix)) return false;
  final String body = token.substring(kTokenPrefix.length);
  if (body.length != kTokenBodyLength) return false;
  return RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(body);
}

/// token 的读写抽象。
abstract class TokenStore {
  /// 没有 token / 存储里没有 / 形状坏 ⇒ `null`（**不抛异常**）。
  Future<String?> read();

  /// 覆盖写入。失败时抛存储层异常（IO 上是 `FileSystemException`，
  /// Web 上是 `DOMException`），由调用方决定要不要忽略。
  Future<void> write(String token);

  /// 删除（幂等：本来就没有也不报错）。
  Future<void> clear();
}

/// 纯内存实现 —— **只给测试与"存储不可用"的降级路径**用。
///
/// ★ 它在生产里有一个真实用途：真存储写失败时（只读文件系统、浏览器隐私模式）
///   退化成内存 ⇒ 本次进程内仍然能正常用，重启后重新登录。
///   比"因为存不下来就不让登录"友好得多。
class MemoryTokenStore implements TokenStore {
  MemoryTokenStore([this._token]);

  String? _token;

  @override
  Future<String?> read() async => _token;

  @override
  Future<void> write(String token) async {
    _token = token;
  }

  @override
  Future<void> clear() async {
    _token = null;
  }
}

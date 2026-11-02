/// 运行期身份（设备 id / 孩子 id / 角色）的持久化抽象（W10-B / P0-1）。
///
/// ── 它修的是什么 ────────────────────────────────────────────────────────────
///   以前 `deviceId` / `childId` 都是**编译期常量**（`--dart-define`）：
///   换一台手机、换一个家庭，都要重新打包。现在设备 id 首启生成并持久化，
///   孩子 id 由登录后的 `POST /auth/child-session` 签发，两者一起写在这里。
///
/// ── 与 [TokenStore] 的关系 ──────────────────────────────────────────────────
///   刻意**分成两份存储**（`kp_token` / `kp_session`）：
///     · token 失效（401 / 退出）要立刻清掉，但它不改变\"这台设备是谁\"；
///     · 设备 id 比 token 活得久 —— 登录态 7 天过期后重新登录，应当回到
///       **同一台设备**（后端 `DeviceSession` 的行键含 deviceId）。
///   合成一个文件会让\"清 token\"顺手把设备 id 也清掉，每次重登都像换了台手机。
///
/// ── ★ 设备 id 不是凭据 ──────────────────────────────────────────────────────
///   后端只把它当**行键 / 审计字段**（`40` §8.1）。伪造它换不到任何权限：
///   身份来自 Bearer token，角色来自成员位。因此这里不做防篡改，
///   只做\"格式合法 + 尽量稳定\"。
library;

import 'dart:math';

/// 存储键 / 文件名（与 `kp_token` 同一命名前缀）。
const String kSessionStorageKey = 'kp_session';

/// 生成值的前缀：一眼能看出\"这是客户端自己造的\"。
const String kGeneratedDeviceIdPrefix = 'kp-dev-';

/// 后端 `readDeviceId()` 的上界口径（128 = 微信 `js_code` 量级，够任何 uuid）。
const int kMaxDeviceIdLength = 128;

/// HTTP 头的值按 latin-1 传输，所以设备 id 只允许这组字符
/// （`kids_points_mp/src/data/device_identity.ts` 同一口径）。
final RegExp _deviceIdPattern = RegExp(r'^[A-Za-z0-9._:-]+$');

/// 设备 id 形状校验。
bool isValidDeviceId(String value) {
  final String trimmed = value.trim();
  if (trimmed.isEmpty || trimmed.length > kMaxDeviceIdLength) return false;
  return _deviceIdPattern.hasMatch(trimmed);
}

/// 生成 `kp-dev-` + 24 位十六进制（与小程序侧同一形状）。
///
/// 默认用 [Random.secure]：设备 id 会进审计，不希望两台新机撞同一个值
/// （24 位十六进制下本来也不可能，这里只是不省这一步）。
String generateDeviceId([Random? random]) {
  final Random source = random ?? Random.secure();
  final StringBuffer buffer = StringBuffer(kGeneratedDeviceIdPrefix);
  while (buffer.length < kGeneratedDeviceIdPrefix.length + 24) {
    buffer.write(source.nextInt(0x100000000).toRadixString(16).padLeft(8, '0'));
  }
  final String value = buffer.toString();
  return value.substring(0, kGeneratedDeviceIdPrefix.length + 24);
}

/// 一份运行期身份快照。
class SessionSnapshot {
  const SessionSnapshot({
    required this.deviceId,
    this.childId,
    this.role,
  });

  final String deviceId;
  final String? childId;
  final String? role;

  Map<String, Object?> toJson() => <String, Object?>{
        'deviceId': deviceId,
        if (childId != null) 'childId': childId,
        if (role != null) 'role': role,
      };

  /// 坏形状一律返回 `null`（当成\"没存过\"），只保留合法字段。
  static SessionSnapshot? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final Object? device = raw['deviceId'];
    if (device is! String || !isValidDeviceId(device)) return null;
    final Object? child = raw['childId'];
    final Object? role = raw['role'];
    return SessionSnapshot(
      deviceId: device.trim(),
      childId: child is String && child.trim().isNotEmpty ? child.trim() : null,
      role: role is String && role.trim().isNotEmpty ? role.trim() : null,
    );
  }
}

/// 运行期身份的读写抽象。
abstract class SessionStore {
  /// 没有 / 形状坏 ⇒ `null`（**不抛异常**）。
  Future<SessionSnapshot?> read();

  /// 覆盖写入。失败时抛存储层异常，由 [SessionScope] 决定降级方式。
  Future<void> write(SessionSnapshot snapshot);

  /// 删除（幂等）。
  Future<void> clear();
}

/// 纯内存实现 —— 测试与\"存储不可用\"的降级路径。
class MemorySessionStore implements SessionStore {
  MemorySessionStore([this._snapshot]);

  SessionSnapshot? _snapshot;

  @override
  Future<SessionSnapshot?> read() async => _snapshot;

  @override
  Future<void> write(SessionSnapshot snapshot) async {
    _snapshot = snapshot;
  }

  @override
  Future<void> clear() async {
    _snapshot = null;
  }
}

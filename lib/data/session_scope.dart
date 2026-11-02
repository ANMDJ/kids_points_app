import 'dart:math';

import 'package:flutter/foundation.dart';

import 'session_store_base.dart';
import 'session_store_default.dart';

export 'session_store_base.dart'
    show
        SessionSnapshot,
        SessionStore,
        MemorySessionStore,
        isValidDeviceId,
        generateDeviceId,
        kGeneratedDeviceIdPrefix;

/// **运行期身份**的唯一持有者（W10-B / P0-1，2026-11-02）。
///
/// ── 它解决的是哪一件事 ──────────────────────────────────────────────────────
///   登录成功 ≠ 能发业务请求。后端 `DeviceSessionGuard` 要求：
///     · `x-kp-device-id`（设备标识，现在由客户端**运行期生成**）；
///     · `x-kp-child-id`（要操作哪个孩子，由 `POST /auth/child-session` **签发**）；
///     · 该 `(deviceId, childId)` 会话行的 `userId` 与 token 的 `userId` 同源。
///   以前 deviceId / childId 来自 `--dart-define`，所以只有\"预置了演示会话的
///   安装包\"能用（`43` §3 P0-1）。本类把这两件事变成运行期状态：
///     ① 首启生成设备 id 并持久化（换账号不变）；
///     ② 登录后 / 冷启动恢复时，由 `AccountGate` 调 `child-session` 写入孩子 id。
///
/// ── 为什么不是 `ValueNotifier` ──────────────────────────────────────────────
///   读它的都是 API 客户端的**取值函数**（每次请求现取），UI 的状态
///   （\"会话建立中 / 需要建孩子\"）由 `AccountGate` 自己管。
///   两边都监听会让\"谁先 rebuild\"变成一个隐式契约 —— 那是 bug 的温床。
///
/// ── 持久化失败怎么办 ────────────────────────────────────────────────────────
///   **降级为内存**并打日志，不抛：只读文件系统 / 浏览器隐私模式下，
///   \"这次能用、重启后重新生成设备 id\" 比 \"App 起不来\" 友好得多。
class SessionScope {
  SessionScope({
    SessionStore? store,
    Random? random,
    String? initialDeviceId,
  })  : _store = store ?? createDefaultSessionStore(),
        _random = random,
        _deviceId = initialDeviceId != null && isValidDeviceId(initialDeviceId)
            ? initialDeviceId.trim()
            : null;

  final SessionStore _store;
  final Random? _random;

  String? _deviceId;
  String? _childId;
  String? _role;
  bool _restored = false;

  /// 当前设备标识；`restore()` 之前可能为 `null`（main 里会先 await）。
  String? get deviceId => _deviceId;

  /// 当前孩子；没有进入任何孩子时为 `null`。
  String? get childId => _childId;

  /// 当前角色（`guardian` / `child` / `viewer`），由 child-session 回包写入。
  String? get role => _role;

  bool get hasChild => _childId != null;

  bool get deviceReady => _deviceId != null;

  /// 从存储恢复（幂等）。
  ///
  /// 规则：
  ///   · 存储里有合法设备 id ⇒ 沿用（**换账号也不变**）；
  ///   · 没有 / 形状坏 ⇒ 生成一个新的并写回；
  ///   · 孩子 id 只接受非空字符串；角色同样。
  Future<void> restore() async {
    if (_restored) return;
    _restored = true;

    SessionSnapshot? stored;
    try {
      stored = await _store.read();
    } on Exception catch (error) {
      debugPrint('[session] 读取运行期身份失败，将重新生成设备 id：$error');
    }

    if (stored != null && isValidDeviceId(stored.deviceId)) {
      _deviceId = stored.deviceId;
      _childId = stored.childId;
      _role = stored.role;
      return;
    }

    _deviceId = generateDeviceId(_random);
    _childId = null;
    _role = null;
    await _persist();
  }

  /// 开始一次新的登录：**清掉上一个账号的孩子**，保留设备 id。
  ///
  /// ★ 这是\"换账号不串数据\"的关键一步：旧 childId 留在配置里，
  ///   换账号后的第一个请求会带着它打到后端 —— 结果要么 401，
  ///   要么（如果新账号也恰好是那个孩子的成员）读到上一个账号的上下文。
  Future<void> beginAccount() async {
    await restore();
    _childId = null;
    _role = null;
    await _persist();
  }

  /// 收下一条 `POST /auth/child-session` 的回包。
  Future<void> adoptChild({
    required String childId,
    required String role,
  }) async {
    await restore();
    final String trimmed = childId.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError.value(childId, 'childId', '不能为空');
    }
    _childId = trimmed;
    _role = role.trim().isEmpty ? null : role.trim();
    await _persist();
  }

  /// 退出 / 401 / 会话建立失败时清掉孩子上下文（设备 id 保留）。
  Future<void> clearChild() async {
    if (_childId == null && _role == null) return;
    _childId = null;
    _role = null;
    await _persist();
  }

  /// 当前快照（诊断 / 测试用）。
  SessionSnapshot? get snapshot {
    final String? device = _deviceId;
    if (device == null) return null;
    return SessionSnapshot(deviceId: device, childId: _childId, role: _role);
  }

  Future<void> _persist() async {
    final SessionSnapshot? current = snapshot;
    if (current == null) return;
    try {
      await _store.write(current);
    } on Exception catch (error) {
      // 存储不可用 ⇒ 仅本次进程可用。不抛，见类注释。
      debugPrint('[session] 运行期身份写入失败（本次运行仍可用）：$error');
    }
  }
}

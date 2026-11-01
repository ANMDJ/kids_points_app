import 'package:flutter/foundation.dart';

import 'token_store_base.dart';
import 'token_store_default.dart';

/// token 存储与持有者（W9-D，2026-10-30 / `docs/design/42-account-login-design.md` §7.2.1）。
///
/// ── 平台实现（W10-A 拆出）──────────────────────────────────────────────────
///   · 移动 / 桌面 → `FileTokenStore`（`dart:io` 写 `Directory.systemTemp`）；
///   · 浏览器      → `LocalStorageTokenStore`（`window.localStorage`）。
///   两者都由 `createDefaultTokenStore()` 通过条件导入（`token_store_default.dart`）
///   在编译期选定 —— 所以本文件**没有** `import 'dart:io'`，
///   `flutter build web` 才能过。
///
/// ── 形状校验在读取侧，也在写入侧 ────────────────────────────────────────────
///   存储可能被别的东西写坏 / 被手工编辑。`read()` 只在形状合法时返回，
///   否则当成"没有 token"；[AuthTokenHolder] 在抽象层还会再校验一次，
///   免得"坏 token 当成没有"变成某个实现的私有约定。
export 'token_store_base.dart';
export 'token_store_default.dart';

/// 进程内**唯一**的 token 持有者（W9-D，2026-10-30）。
///
/// ── 为什么要一个持有者，而不是"每个客户端自己读文件" ────────────────────────
///   四个 API 客户端（读 / 写 / 引导 / 家长模式）都要在请求头里带同一个 token。
///   各自读存储 ⇒ ① 每次请求一次 IO；② 登录/登出之后有些客户端已经更新、
///   有些还没更新 —— 那会表现为"有的页面能用、有的页面 401"，是最难查的一类。
///   ⇒ 内存里一份，四个客户端拿 `() => holder.token` 这个**取值函数**。
///
/// ── 为什么暴露的是 `String? Function()` 而不是 `String?` ────────────────────
///   客户端在构造时拿到的是"怎么取"，不是"取到的值"。token 会变（登录、登出、
///   过期后换新），构造时快照下来的值会立刻过期。
///
/// ── 空 token 与 null 的区别 ────────────────────────────────────────────────
///   两者都表示"没有"，`token == null` 统一处理。`String?` 而不是 `''` 是刻意的：
///   `Authorization: Bearer ` （带一个空格、没有值）是一个**畸形头**，
///   有些网关会直接 400。宁可不发这个头。
class AuthTokenHolder {
  AuthTokenHolder({TokenStore? store, String? initial})
      : _store = store ?? createDefaultTokenStore() {
    if (initial != null && initial.trim().isNotEmpty) {
      _token = initial.trim();
    }
    _signedIn = ValueNotifier<bool>(_token != null);
  }

  final TokenStore _store;
  String? _token;

  /// 「本地是否有 token」的**可监听**视图。
  ///
  /// ── 为什么需要它（而不是让界面自己轮询 `hasToken`）──────────────────────
  ///   `AuthApiClient` 在收到 401 时会 `clear()`（那张凭据服务端不认了）。
  ///   如果启动闸门只是 `if (hasToken) …` 地判一次，用户会**停在一个所有请求
  ///   都 401 的界面上**，而闸门永远不知道要把人送回登录页。
  ///   监听它 ⇒ 凭据一失效，闸门立刻切回登录页（`account_gate.dart`）。
  late final ValueNotifier<bool> _signedIn;

  ValueListenable<bool> get signedIn => _signedIn;

  /// 释放监听（测试里每条用例结束要调；生产里 holder 与进程同寿，不需要）。
  void dispose() => _signedIn.dispose();

  /// 当前 token；没有 ⇒ `null`。
  String? get token => _token;

  /// 是不是已登录（**只回答本地有没有 token**，不回答它还有效吗 ——
  /// 那要问服务端，见 `GET /auth/session`）。
  bool get hasToken => _token != null;

  /// 从存储里恢复（幂等：内存里已有就不再读盘）。
  Future<String?> restore() async {
    if (_token != null) return _token;
    final String? stored = await _store.read();
    // ★ 在**抽象层**再校验一次，而不是信任各实现的自觉：
    //   `FileTokenStore` / `LocalStorageTokenStore` 会校验，`MemoryTokenStore`
    //   不会 —— 若这里不查，"坏 token 当成没有"就变成某个实现的私有约定，
    //   换实现就静默失效。
    if (stored != null && isValidToken(stored)) _token = stored;
    _signedIn.value = _token != null;
    return _token;
  }

  /// 收下一张新凭据（登录成功后调用）。
  ///
  /// ★ 写盘 / 写 localStorage 失败**不抛**：存储不可用（只读文件系统、浏览器
  ///   隐私模式）时降级成"仅本次进程可用"，比"存不下来就不让登录"友好得多。
  ///   代价是重启后要重新输入密码 —— 与系统清缓存同一个后果。
  Future<void> adopt(String token) async {
    final String trimmed = token.trim();
    if (!isValidToken(trimmed)) {
      throw ArgumentError.value(token, 'token', '不是合法的 kp token（kps_ + 43 位 base64url）');
    }
    _token = trimmed;
    _signedIn.value = true;
    try {
      await _store.write(trimmed);
    } on Exception catch (error) {
      // 存储层异常（IO：`FileSystemException`；Web：`DOMException`）⇒ 降级为内存。
      // ★ 这里**不**捕获 `Error`：`ArgumentError`（形状错）是调用方 bug，必须响。
      debugPrint('[auth] token 存储写入失败，已降级为内存（重启需重新登录）：$error');
    }
  }

  /// 退出登录 / 凭据被拒时清空。
  Future<void> clear() async {
    _token = null;
    _signedIn.value = false;
    await _store.clear();
  }
}

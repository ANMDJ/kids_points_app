import 'read_api_errors.dart';
import 'read_dto.dart';
import 'token_store.dart' show isValidToken;

/// `POST /auth/login-account` 的回包（W9-D，2026-10-30 / `42` §3.1）。
///
/// ── 与其它 DTO 同一口径 ───────────────────────────────────────────────────
///   缺字段 / 类型不对 ⇒ [ReadApiException.malformed]，绝不 `as String? ?? ''`
///   猜一个默认值。这里猜错的后果特别具体：`token` 猜成空串 ⇒ 后续每个请求
///   都带一个 `Authorization: Bearer `（畸形头），401 的原因会指向"登录失效"，
///   而病在解析。
///
/// ── 为什么 `membership` 是**三个**状态而不是两个 ──────────────────────────
///   ① `null`（服务端明确说"这个人还没有孩子"）⇒ 客户端进建孩子引导；
///   ② `{childId, role}` ⇒ 客户端直接 `POST /auth/child-session`；
///   ③ **缺字段** ⇒ `malformed`。
///   把 ③ 混进 ① 会让"回包被截断"伪装成"你还没有孩子"，
///   用户会去建第二个家庭。
class AuthLoginResult {
  AuthLoginResult({
    required this.token,
    required this.expiresAt,
    required this.userId,
    required this.displayName,
    required this.childId,
    required this.role,
  });

  factory AuthLoginResult.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);

    final String token = readString(json, 'token', '$path.token');
    if (!isValidToken(token)) {
      throw ReadApiException.malformed(
        '$path.token',
        detail: '不是 kps_ + 43 位 base64url（后端 auth-session.gate.ts 的 TOKEN_PREFIX）',
      );
    }

    final Map<String, Object?> user = readObject(json['user'], '$path.user');

    String? childId;
    String? role;
    // ★ 必须区分「`membership: null`」与「压根没有这个字段」：
    //   Dart 的 `map['missing']` 与 `map['x'] = null` 都得到 `null`，
    //   所以只能靠 `containsKey`。前者是"这个人还没有孩子"（正常，进建孩子引导），
    //   后者是"回包被截断 / 版本不一致"（畸形）。混起来会让截断伪装成
    //   "你还没有孩子"，用户会去建第二个家庭（`42` §5.1）。
    if (!json.containsKey('membership')) {
      throw ReadApiException.malformed(
        '$path.membership',
        detail: '缺少该字段（`null` 表示"还没有孩子"，缺失表示回包不完整）',
      );
    }
    final Object? membership = json['membership'];
    if (membership != null) {
      final Map<String, Object?> map = readObject(membership, '$path.membership');
      childId = readString(map, 'childId', '$path.membership.childId');
      role = readString(map, 'role', '$path.membership.role');
    }

    return AuthLoginResult(
      token: token,
      expiresAt: readDate(json, 'expiresAt', '$path.expiresAt'),
      userId: readString(user, 'id', '$path.user.id'),
      displayName: readOptionalString(user, 'displayName', '$path.user.displayName'),
      childId: childId,
      role: role,
    );
  }

  /// 明文 token —— **只在这里出现一次**，交给 `AuthTokenHolder` 之后就只存在于内存/文件。
  final String token;

  /// 这条会话的**绝对**到期（UTC）。服务端不滑动（`40` §4.3）。
  final DateTime expiresAt;

  final String userId;
  final String? displayName;

  /// `null` = 这个人还没有任何孩子（客户端进 `POST /children` 引导）。
  final String? childId;
  final String? role;
}

/// `PUT /auth/account` 的回包（`42` §3.2）。
///
/// ★ **没有**密码长度、没有哈希、没有任何"密码长什么样"的信息 ——
///   只回答"设了没有"，客户端据此决定显示「设置密码」还是「修改密码」。
class AccountInfo {
  const AccountInfo({
    required this.phone,
    required this.email,
    required this.hasPassword,
  });

  factory AccountInfo.fromJson(Object? raw, String path) {
    final Map<String, Object?> json = readObject(raw, path);
    final AccountInfo info = AccountInfo(
      phone: readOptionalString(json, 'phone', '$path.phone'),
      email: readOptionalString(json, 'email', '$path.email'),
      hasPassword: readBool(json, 'hasPassword', '$path.hasPassword'),
    );

    // ★ 自相矛盾：既没有任何登录标识、也没有密码 ⇒ 这个账号**登不进来**。
    //   说"保存成功"会让用户以为可以在 App 上登录，然后被 401 打回来。
    if (info.phone == null && info.email == null && !info.hasPassword) {
      throw ReadApiException.malformed(
        path,
        detail: 'phone / email / hasPassword 全空：这个账号无法用于登录',
      );
    }
    return info;
  }

  final String? phone;
  final String? email;
  final bool hasPassword;

  /// 界面上展示的掩码手机号（`138****8000`）；没有就是 null。
  String? get maskedPhone {
    final String? raw = phone;
    if (raw == null || raw.length < 7) return raw;
    return '${raw.substring(0, 3)}****${raw.substring(raw.length - 4)}';
  }
}

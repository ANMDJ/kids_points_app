import 'dart:async';
import 'dart:convert';

import 'http_transport.dart';
import 'read_api.dart' show ReadApiConfig, kChildIdHeader, kDeviceIdHeader;
import 'read_api_errors.dart';
import 'read_dto.dart';
import 'token_store.dart' show AuthTokenHolder;
import 'write_api_errors.dart';

/// 一个孩子成员位（`GET /auth/session` 的 `children[]`）。
class ChildMembership {
  const ChildMembership({
    required this.childId,
    required this.name,
    required this.role,
  });

  final String childId;
  final String name;
  final String role;
}

/// `POST /auth/child-session` 的回包。
class ChildSessionResult {
  const ChildSessionResult({
    required this.childId,
    required this.role,
    required this.sessionExpiresAt,
  });

  final String childId;
  final String role;
  final DateTime sessionExpiresAt;
}

/// `POST /children` 的回包（新用户 bootstrap）。
class BootstrapChildResult {
  const BootstrapChildResult({required this.childId, required this.role});

  final String childId;
  final String role;
}

/// 运行期身份的**服务端交互**（W10-B / P0-1）。
///
/// 与 `AuthApi` 分成两个接口的理由：登录是"换一张凭据"，本类做的是
/// "把这张凭据落到这台设备 / 这个孩子上"。测试替身也可以分别替换，
/// 不必为了测闸门去实现整个登录协议。
abstract class IdentityApi {
  /// `GET /auth/session` —— 我在哪些孩子上有成员位。
  Future<List<ChildMembership>> fetchMemberships();

  /// `POST /auth/child-session` —— 在这台设备上建立 `(deviceId, childId)` 会话。
  Future<ChildSessionResult> establishChildSession(String childId);

  /// `POST /invites/accept` —— 用家长发的邀请码**加入一个已有家庭**（P0-3）。
  ///
  /// ── 为什么它挂在这里，而不是 `WriteApi` / `AuthApi` ────────────────────────
  ///   · 回包与 [establishChildSession] 同构（`childId` / `role` /
  ///     `sessionExpiresAt`）：它**签发一条本机会话**，属于"把身份落到这台
  ///     设备上"；服务端在同一个事务里写成员位 + `DeviceSession` + 审计。
  ///   · 它发生在"我还不是这个孩子的成员"的时刻，所以不能走
  ///     `MembershipGuard`，但**仍然要求我已经登录**（`AuthGuard`）且
  ///     本机有一个有效会话（`DeviceSessionGuard` 读 `x-kp-child-id`）。
  ///     ⇒ D3（`43` §8）走默认："先登录、再输码"。
  ///
  /// 失败码（`write_api_errors.dart` 逐条翻成中文，**不要**在界面另编文案）：
  ///   400 `INVITE_CODE_MALFORMED`（形状不对，不消耗名额）
  ///   409 `INVITE_CODE_UNAVAILABLE`（不存在 / 过期 / 用完 / 吊销，四种同形）
  ///   409 `ALREADY_MEMBER`（已经是成员，不消耗名额）
  ///   401（token 失效 / 本机会话不存在 ⇒ 重新登录）
  Future<ChildSessionResult> acceptInvite(String code);

  /// `POST /children` —— 还没有孩子的账号：接受同意 + 建占位档案。
  ///
  /// ★ 请求体里**没有昵称**："同意必须早于采集"（后端 `BootstrapChildDto`）。
  ///   真正的名字走 [renameChild]。
  Future<BootstrapChildResult> bootstrapChild({String relation = 'other'});

  /// `PATCH /child` —— 给占位档案改昵称（需要已建立 child-session）。
  Future<void> renameChild(String name);

  void close();
}

class IdentityApiClient implements IdentityApi {
  IdentityApiClient({
    required this.config,
    required this.holder,
    WriteTransport? transport,
    this.timeout = const Duration(seconds: 15),
  }) : _transport = transport ?? createWriteTransport();

  final ReadApiConfig config;
  final AuthTokenHolder holder;
  final WriteTransport _transport;
  final Duration timeout;

  @override
  Future<List<ChildMembership>> fetchMemberships() async {
    final Map<String, Object?> json = _asObject(
      await _send(method: 'GET', path: '/auth/session'),
      'GET /auth/session',
    );
    final Object? rawChildren = json['children'];
    if (rawChildren is! List) {
      throw ReadApiException.malformed(
        r'$.children',
        detail: '必须是数组（缺失说明这不是 /auth/session 的回包）',
      );
    }
    final List<ChildMembership> result = <ChildMembership>[];
    for (int index = 0; index < rawChildren.length; index += 1) {
      final Map<String, Object?> row =
          readObject(rawChildren[index], '\$.children[$index]');
      result.add(
        ChildMembership(
          childId: readString(row, 'childId', '\$.children[$index].childId'),
          name: readString(row, 'name', '\$.children[$index].name'),
          role: readString(row, 'role', '\$.children[$index].role'),
        ),
      );
    }
    return result;
  }

  @override
  Future<ChildSessionResult> establishChildSession(String childId) async {
    final String target = childId.trim();
    if (target.isEmpty) {
      throw ArgumentError.value(childId, 'childId', '不能为空');
    }
    final Map<String, Object?> json = _asObject(
      await _send(
        method: 'POST',
        path: '/auth/child-session',
        body: <String, Object?>{'childId': target},
      ),
      'POST /auth/child-session',
    );
    return ChildSessionResult(
      childId: readString(json, 'childId', r'$.childId'),
      role: readString(json, 'role', r'$.role'),
      sessionExpiresAt:
          readDate(json, 'sessionExpiresAt', r'$.sessionExpiresAt'),
    );
  }

  /// `POST /invites/accept`（P0-3）。
  ///
  /// ── 三个刻意的细节 ──────────────────────────────────────────────────────────
  ///   ① **原样上送用户输入**（去首尾空白）：`normalizeInviteCodeInput()` 由调用方
  ///      先做，这里不再改写一次 —— 两份归一化就会有两份边界（`ab-cd` vs `ab cd`）；
  ///   ② 不传 `role` / `childId`：后端 `forbidNonWhitelisted` 会 400，
  ///      而且角色**只能**来自邀请码行（客户端自报角色 = 提权）；
  ///   ③ 回包缺字段 ⇒ 严格 DTO 报错，**不**把"回包截断"当成"加入失败"。
  @override
  Future<ChildSessionResult> acceptInvite(String code) async {
    final String trimmed = code.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError.value(code, 'code', '不能为空');
    }
    // 长度粗上限与后端 `AcceptInviteDto` 的 `@MaxLength(32)` 同口径；
    // 真正的形状判定由调用方用 `isWellFormedInviteCode()` 在本地先做一次。
    if (trimmed.length > 32) {
      throw ArgumentError.value(code, 'code', '不能超过 32 字符（后端同口径）');
    }
    final Map<String, Object?> json = _asObject(
      await _send(
        method: 'POST',
        path: '/invites/accept',
        body: <String, Object?>{'code': trimmed},
      ),
      'POST /invites/accept',
    );
    return ChildSessionResult(
      childId: readString(json, 'childId', r'$.childId'),
      role: readString(json, 'role', r'$.role'),
      sessionExpiresAt:
          readDate(json, 'sessionExpiresAt', r'$.sessionExpiresAt'),
    );
  }

  @override
  Future<BootstrapChildResult> bootstrapChild(
      {String relation = 'other'}) async {
    final Map<String, Object?> json = _asObject(
      await _send(
        method: 'POST',
        path: '/children',
        body: <String, Object?>{
          'consent': <String, Object?>{'accepted': true},
          'relation': relation,
        },
      ),
      'POST /children',
    );
    return BootstrapChildResult(
      childId: readString(json, 'childId', r'$.childId'),
      role: readString(json, 'role', r'$.role'),
    );
  }

  @override
  Future<void> renameChild(String name) async {
    final String trimmed = name.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError('昵称不能为空。');
    }
    // 回包是完整档案；这里只需要确认写入成功（childId 仍按严格 DTO 读）。
    final Map<String, Object?> json = _asObject(
      await _send(
        method: 'PATCH',
        path: '/child',
        body: <String, Object?>{'name': trimmed},
      ),
      'PATCH /child',
    );
    readString(json, 'childId', r'$.childId');
  }

  /// 发一个请求（与 `AuthApiClient._send` 同一套头语义，但**不强制** childId）。
  Future<Object?> _send({
    required String method,
    required String path,
    Map<String, Object?>? body,
  }) async {
    final String? configError = config.transportValidationError;
    if (configError != null) {
      throw WriteApiException(
        WriteFailureKind.badRequest,
        configError,
        code: 'CLIENT_NOT_CONFIGURED',
      );
    }

    final String? token = holder.token;
    if (token == null) {
      throw WriteApiException(
        WriteFailureKind.unauthenticated,
        '这条操作需要先登录。',
        code: 'CLIENT_NO_TOKEN',
      );
    }

    final Uri uri = config.uri(path);
    final String? childId = config.childId;
    final Map<String, String> headers = <String, String>{
      kAcceptHeader: 'application/json',
      if (body != null)
        kContentTypeHeader: 'application/json; charset=utf-8',
      kDeviceIdHeader: config.deviceId.trim(),
      // 建立会话 / 建孩子时还没有 childId；有才发。
      if (childId != null) kChildIdHeader: childId,
      kAuthorizationHeader: 'Bearer $token',
    };
    final String encoded = body == null ? '' : jsonEncode(body);

    final WriteHttpResponse response;
    try {
      response = await _transport
          .send(uri, headers, encoded, method: method)
          .timeout(timeout);
    } on TimeoutException {
      throw WriteApiException.timeout(timeout);
    } on Exception catch (error) {
      throw WriteApiException.network(error);
    }

    Object? decoded;
    if (response.body.trim().isNotEmpty) {
      try {
        decoded = jsonDecode(response.body);
      } on FormatException {
        decoded = null;
      }
    }

    if (response.statusCode == 401) {
      // 凭据已失效 ⇒ 清掉；闸门监听 `signedIn` 会回到登录页。
      await holder.clear();
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw WriteApiException.fromHttp(
        statusCode: response.statusCode,
        body: decoded,
      );
    }
    if (decoded == null) {
      throw WriteApiException.malformed(
        r'$',
        detail: 'HTTP ${response.statusCode} 但响应体为空',
      );
    }
    return decoded;
  }

  Map<String, Object?> _asObject(Object? raw, String label) {
    if (raw is Map<String, Object?>) return raw;
    if (raw is Map) {
      return raw.map((Object? key, Object? value) =>
          MapEntry<String, Object?>('$key', value));
    }
    throw ReadApiException.malformed(label, detail: '响应不是 JSON 对象');
  }

  @override
  void close() => _transport.close();
}

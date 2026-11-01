import 'dart:async';
import 'dart:convert';

import 'auth_dto.dart';
import 'http_transport.dart';
import 'read_api.dart' show ReadApiConfig, kChildIdHeader, kDeviceIdHeader;
import 'token_store.dart' show AuthTokenHolder;
import 'write_api_errors.dart';

/// App **账号登录**的客户端（W9-D，2026-10-30 / `docs/design/42-account-login-design.md` §3）。
///
/// ── 它解决的是哪一件事 ─────────────────────────────────────────────────────
///   在这之前，Flutter 的身份完全来自 `--dart-define=KP_DEVICE_ID/KP_CHILD_ID`
///   这类**编译期常量** ⇒ 生产环境里后端一律 401（`40` §1.6）。本客户端是
///   "运行期拿到一张可撤销、可过期的凭据"的第一步。
///
/// ── 为什么另起一个客户端（而不塞进 `ReadApi` / `WriteApi`）─────────────────
///   登录发生在"还没有 token"的时刻，而且要**写到 token 持有者**里；
///   读 / 写客户端是"已经拿到 token 之后"的消费者。混在一起会让每个读请求
///   都带一条写能力（测试替身也被迫实现它）。
///
/// ── 三条不变量（写清，改代码前先看这三条）─────────────────────────────────
///   ① **密码不落盘**：`updateAccount` 收密码，用完即弃；本文件没有任何
///      "把密码存起来下次自动登录"的入口（理由见 `token_store.dart` 文件头）。
///   ② **登录必然换新 token**：不在请求里带旧 token（会话固定防护，
///      与后端 `identity.service.ts` 的 `issueToken()` 口径一致）。
///   ③ **成功即收下**：`loginAccount` 拿到 token 后立刻 `holder.adopt()`，
///      调用方不需要、也不应该再手工转存一次 —— 两处存就会有两份真相。
abstract class AuthApi {
  /// `POST /auth/login-account`。
  ///
  /// 失败语义（与后端逐字对应）：
  ///   · `400` 形状错（标识不像手机号也不像邮箱）⇒ `unauthenticated`? 否 ——
  ///     `badRequest`，`code: INVALID_IDENTIFIER`；
  ///   · `401` 密码错 / 账号不存在 / 从未设密码 ⇒ `unauthenticated`
  ///     `code: ACCOUNT_INVALID_CREDENTIALS`（**三者不可区分**，见 `42` §5.3）；
  ///   · `403` 账号被停用 ⇒ `forbidden` `code: USER_NOT_ACTIVE`；
  ///   · `429` ⇒ `conflict` `code: LOGIN_RATE_LIMITED`（等一会儿，**不要**自动重试）。
  Future<AuthLoginResult> loginAccount({
    required String identifier,
    required String password,
  });

  /// `PUT /auth/account` —— 绑定手机号/邮箱、设置或修改密码。
  ///
  /// ★ 需要已登录（小程序里绑定时用的是小程序侧的客户端，这里是 App 侧，
  ///   给"在 App 里改密码"用）。改密码成功后**当前这条会话仍然有效**
  ///   （后端只踢其它会话），所以不需要重新登录。
  Future<AccountInfo> updateAccount({
    String? phone,
    String? email,
    String? password,
    String? currentPassword,
  });

  /// `POST /auth/logout` —— 撤销**这一条**会话，并**无论成败**清掉本地 token。
  Future<void> logout();

  void close() {}
}

/// 基于 `dart:io HttpClient` 的实现（复用写层的 [WriteTransport]）。
class AuthApiClient implements AuthApi {
  AuthApiClient({
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
  Future<AuthLoginResult> loginAccount({
    required String identifier,
    required String password,
  }) async {
    final String who = identifier.trim();
    // 本地只拦**空**，不判"像不像手机号/邮箱"：那条规则在服务端只有一份
    // （`account-identifier.ts`），客户端再写一遍必然漂移。
    if (who.isEmpty) {
      throw ArgumentError('请填写手机号或邮箱。');
    }
    if (password.isEmpty) {
      throw ArgumentError('请填写密码。');
    }

    final Object? decoded = await _send(
      method: 'POST',
      path: '/auth/login-account',
      body: <String, Object?>{'identifier': who, 'password': password},
    );

    final AuthLoginResult result = AuthLoginResult.fromJson(decoded, r'$');
    // ★ 唯一一次转存。写盘失败会被 `adopt()` 吞掉并降级为内存（见 token_store.dart）。
    await holder.adopt(result.token);
    return result;
  }

  @override
  Future<AccountInfo> updateAccount({
    String? phone,
    String? email,
    String? password,
    String? currentPassword,
  }) async {
    final Map<String, Object?> body = <String, Object?>{
      if (phone != null) 'phone': phone,
      if (email != null) 'email': email,
      if (password != null) 'password': password,
      if (currentPassword != null) 'currentPassword': currentPassword,
    };
    // 与服务端同一条判定（`ACCOUNT_NOTHING_TO_UPDATE`），但**在本地先拦**：
    // 一次必然 400 的往返没有必要，而且用户会看到"请求失败"这种模糊说法。
    if (body.isEmpty) {
      throw ArgumentError('手机号、邮箱、密码至少要填一个。');
    }

    final Object? decoded = await _send(
      method: 'PUT',
      path: '/auth/account',
      body: body,
      authenticated: true,
    );

    return AccountInfo.fromJson(decoded, r'$');
  }

  @override
  Future<void> logout() async {
    try {
      if (holder.token != null) {
        await _send(method: 'POST', path: '/auth/logout', authenticated: true, expectEmptyBody: true);
      }
    } on WriteApiException {
      // ★ 有意的吞掉：撤销失败（断网 / 服务端 5xx）**不能**把用户困在已登录状态里。
      //   本地 token 必须清掉 —— 否则「我点了退出，重启又自己进去了」。
      //   没撤销成的那条会话会在 7 天后自然过期，而且用户在别处改密码会踢掉它
      //   （`AuthSessionPort.revokeOthers`）。
    } finally {
      await holder.clear();
    }
  }

  /// 发一个请求。
  ///
  /// ── `authenticated` 的两个动作（写清，否则很容易只做一半）──────────────
  ///   ① 没有 token ⇒ **本地就拒**，不发一个必然 401 的请求
  ///      （否则界面会显示「请求失败」，而真实原因是"你还没登录"）；
  ///   ② 服务端回 401 ⇒ **清掉本地 token**。不清的后果是每个后续请求都
  ///      白跑一趟，而且用户会在"已登录"界面上反复看到错误。
  Future<Object?> _send({
    required String method,
    required String path,
    Map<String, Object?>? body,
    bool authenticated = false,
    bool expectEmptyBody = false,
  }) async {
    final String? configError = config.validationError;
    if (configError != null) {
      throw WriteApiException(
        WriteFailureKind.badRequest,
        configError,
        code: 'CLIENT_NOT_CONFIGURED',
      );
    }

    final String? token = holder.token;
    if (authenticated && token == null) {
      throw WriteApiException(
        WriteFailureKind.unauthenticated,
        '这条操作需要先登录。请用手机号/邮箱 + 密码登录，或先在小程序「我的」里绑定 App 账号。',
        code: 'CLIENT_NO_TOKEN',
      );
    }

    final Uri uri = config.uri(path);
    final Map<String, String> headers = <String, String>{
      kAcceptHeader: 'application/json',
      if (body != null)
        kContentTypeHeader: 'application/json; charset=utf-8',
      kDeviceIdHeader: config.deviceId.trim(),
      kChildIdHeader: config.childId.trim(),
      // ★ `token == null` 时**不发**这个头：`Authorization: Bearer `（空值）
      //   是畸形头，有些网关会直接 400，而错误会指向"凭据非法"。
      if (token != null) kAuthorizationHeader: 'Bearer $token',
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
      // Web 上抛的是 `TransportException`（见 `http_transport_types.dart`），
      // VM 上是 `IOException` 子类 —— 两者都是 `Exception`，一处覆盖两套平台。
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

    if (response.statusCode == 401 && authenticated) {
      // 这张凭据服务端不认（过期 / 已撤销 / 被改密踢掉）⇒ 立刻清，见方法头 ②。
      // ★ 登录请求（`authenticated: false`）的 401 是"密码不对"，
      //   不能清 —— 那时本来也没有 token，清了只是白白多一次写盘。
      await holder.clear();
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw WriteApiException.fromHttp(statusCode: response.statusCode, body: decoded);
    }
    if (expectEmptyBody) return null;
    if (decoded == null) {
      throw WriteApiException.malformed(
        r'$',
        detail: 'HTTP ${response.statusCode} 但响应体为空',
      );
    }
    return decoded;
  }

  @override
  void close() => _transport.close();
}


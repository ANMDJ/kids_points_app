import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/auth_api.dart';
import 'package:kids_points_app/data/auth_dto.dart';
import 'package:kids_points_app/data/identity_api.dart';
import 'package:kids_points_app/data/password_rules.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/session_scope.dart';
import 'package:kids_points_app/data/token_store.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/screens/account_gate.dart';
import 'package:kids_points_app/screens/login_screen.dart';
import 'package:kids_points_app/screens/register_screen.dart';

/// W11-A：**邀请码注册**的客户端用例（2026-11-02 / `docs/design/45-invite-registration.md`）。
///
/// ── 这里钉的五件事（每一件都能失败）─────────────────────────────────────────
///   ① 登录页有「第一次用？用邀请码注册」，且能返回登录（注册是可放弃的）；
///   ② 空邀请码 ⇒ 本地拦下，**零请求**（不浪费一次限流额度，也不误导用户）；
///   ③ 注册成功 ⇒ token 写进 holder、child-session 真的建立、然后进首页；
///   ④ 码不可用（409）⇒ **留在注册页**并显示服务端那句话（不把输入全丢掉）；
///   ⑤ 弱密码 ⇒ 本地拦下并说清「差在哪」，同样**零请求**（2026-11-03）。
const String _token = 'kps_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

AuthTokenHolder _holderWithoutToken() =>
    AuthTokenHolder(store: MemoryTokenStore());

void main() {
  late SessionScope scope;

  setUp(() async {
    scope = SessionScope(store: MemorySessionStore(), random: Random(42));
    await scope.restore();
  });

  ReadApiConfig config() => ReadApiConfig(
        baseUrl: 'https://example.test/kids',
        session: scope,
      );

  Widget gate({
    required AuthTokenHolder holder,
    required AuthApi authApi,
    IdentityApi? identityApi,
  }) =>
      MaterialApp(
        home: AccountGate(
          holder: holder,
          authApi: authApi,
          identityApi: identityApi ?? _FakeIdentityApi(),
          session: scope,
          config: config(),
          child: const Scaffold(body: Text('HOME')),
        ),
      );

  testWidgets('★ 登录页 → 注册页 → 返回登录（注册可放弃）', (tester) async {
    final AuthTokenHolder holder = _holderWithoutToken();
    addTearDown(holder.dispose);
    final _FakeAuthApi api = _FakeAuthApi(holder: holder);

    await tester.pumpWidget(gate(holder: holder, authApi: api));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('第一次用？用邀请码注册'));
    await tester.tap(find.text('第一次用？用邀请码注册'));
    await tester.pumpAndSettle();
    expect(find.text('用邀请码注册'), findsOneWidget);

    await tester.tap(find.text('返回登录'));
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsOneWidget);
    expect(api.registerCalls, 0);
  });

  testWidgets('★ 空邀请码 ⇒ 本地提示，且**一个请求都不发**', (tester) async {
    final AuthTokenHolder holder = _holderWithoutToken();
    addTearDown(holder.dispose);
    final _FakeAuthApi api = _FakeAuthApi(holder: holder);

    await tester.pumpWidget(gate(holder: holder, authApi: api));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('第一次用？用邀请码注册'));
    await tester.tap(find.text('第一次用？用邀请码注册'));
    await tester.pumpAndSettle();

    // 只填手机号与密码，邀请码留空。
    await tester.enterText(find.byType(TextField).at(1), '13800138000');
    await tester.enterText(find.byType(TextField).at(2), 'jiazhang2026');
    await tester.ensureVisible(find.text('注册并登录'));
    await tester.tap(find.text('注册并登录'));
    await tester.pumpAndSettle();

    expect(find.byType(RegisterScreen), findsOneWidget);
    expect(find.textContaining('请填写邀请码'), findsOneWidget);
    expect(api.registerCalls, 0);
  });

  testWidgets('★ 注册成功 ⇒ token 写入 holder、建立 child-session、进首页', (tester) async {
    final AuthTokenHolder holder = _holderWithoutToken();
    addTearDown(holder.dispose);
    final _FakeAuthApi api = _FakeAuthApi(holder: holder);
    final _FakeIdentityApi identity = _FakeIdentityApi();

    await tester.pumpWidget(
        gate(holder: holder, authApi: api, identityApi: identity));
    await tester.pumpAndSettle();

    await tester.ensureVisible(find.text('第一次用？用邀请码注册'));
    await tester.tap(find.text('第一次用？用邀请码注册'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), '  MAMA-2345  ');
    await tester.enterText(find.byType(TextField).at(1), ' 13800138000 ');
    await tester.enterText(find.byType(TextField).at(2), 'jiazhang2026');
    await tester.enterText(find.byType(TextField).at(3), '  妈妈  ');
    await tester.ensureVisible(find.text('注册并登录'));
    await tester.tap(find.text('注册并登录'));
    await tester.pumpAndSettle();

    expect(find.text('HOME'), findsOneWidget);
    expect(holder.token, _token);
    // 送出去的是 trim 过的值（大小写/连字符的归一化在服务端，客户端不猜）
    expect(api.seenInviteCode, 'MAMA-2345');
    expect(api.seenIdentifier, '13800138000');
    expect(api.seenDisplayName, '妈妈');
    expect(identity.established, <String>['child-1']);
    expect(scope.childId, 'child-1');
    expect(scope.role, 'guardian');
  });

  testWidgets('★ 码不可用（409）⇒ 留在注册页并显示服务端那句话', (tester) async {
    final AuthTokenHolder holder = _holderWithoutToken();
    addTearDown(holder.dispose);
    const String message = '邀请码无效、已过期、已用完或已吊销（四种情况回答相同）。';
    final _FakeAuthApi api =
        _FakeAuthApi(holder: holder, failureMessage: message);

    await tester.pumpWidget(gate(holder: holder, authApi: api));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('第一次用？用邀请码注册'));
    await tester.tap(find.text('第一次用？用邀请码注册'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), 'MAMA2345');
    await tester.enterText(find.byType(TextField).at(1), '13800138000');
    await tester.enterText(find.byType(TextField).at(2), 'jiazhang2026');
    await tester.ensureVisible(find.text('注册并登录'));
    await tester.tap(find.text('注册并登录'));
    await tester.pumpAndSettle();

    expect(find.byType(RegisterScreen), findsOneWidget);
    expect(find.text(message), findsOneWidget);
    expect(holder.hasToken, isFalse);
    expect(find.text('HOME'), findsNothing);
  });

  testWidgets('★ 弱密码 ⇒ 本地就说清哪一条不合格，且**一个请求都不发**（2026-11-03）',
      (tester) async {
    final AuthTokenHolder holder = _holderWithoutToken();
    addTearDown(holder.dispose);
    final _FakeAuthApi api = _FakeAuthApi(holder: holder);

    await tester.pumpWidget(gate(holder: holder, authApi: api));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('第一次用？用邀请码注册'));
    await tester.tap(find.text('第一次用？用邀请码注册'));
    await tester.pumpAndSettle();

    // 密码要求必须**常驻**在密码框下面（不是输入就消失的占位符）。
    expect(find.text(kPasswordRequirementHint), findsOneWidget);

    await tester.enterText(find.byType(TextField).at(0), 'MAMA2345');
    await tester.enterText(find.byType(TextField).at(1), '13800138000');
    await tester.enterText(find.byType(TextField).at(2), '12345678');
    await tester.ensureVisible(find.text('注册并登录'));
    await tester.tap(find.text('注册并登录'));
    await tester.pumpAndSettle();

    // 用户报障的现场：以前只显示「HTTP 400」，他不知道要改什么。
    expect(find.text('密码不能全是数字，请至少带一个字母。'), findsOneWidget);
    expect(api.registerCalls, 0);
    expect(holder.hasToken, isFalse);
  });
}


/// `AuthApi` 替身：只实现注册（本文件不测登录），并记录入参。
///
/// ★ 成功时必须 `holder.adopt(_token)` —— 真实的 `AuthApiClient` 就是这么做的。
///   替身不照做，`holder.token` 那条断言测的只是替身的缺陷。
class _FakeAuthApi implements AuthApi {
  _FakeAuthApi({required this.holder, this.failureMessage});

  final AuthTokenHolder holder;

  /// 注册回包里的成员位。本文件固定用 `child-1`（要测「没有成员位」的分支
  /// 时另建一个替身，而不是给这个参数留一个永远不传的开关）。
  final String? childId = 'child-1';

  /// 非 null ⇒ 注册抛 409（模拟「邀请码不可用」）。
  final String? failureMessage;

  int registerCalls = 0;
  String? seenInviteCode;
  String? seenIdentifier;
  String? seenPassword;
  String? seenDisplayName;

  @override
  Future<AuthLoginResult> registerWithInvite({
    required String inviteCode,
    required String identifier,
    required String password,
    String? displayName,
  }) async {
    registerCalls += 1;
    seenInviteCode = inviteCode;
    seenIdentifier = identifier;
    seenPassword = password;
    seenDisplayName = displayName;

    final String? message = failureMessage;
    if (message != null) {
      throw WriteApiException(
        WriteFailureKind.conflict,
        message,
        statusCode: 409,
        code: 'INVITE_CODE_UNAVAILABLE',
      );
    }

    await holder.adopt(_token);
    return AuthLoginResult(
      token: _token,
      expiresAt: DateTime.now().add(const Duration(days: 7)),
      userId: 'u-new',
      displayName: displayName,
      childId: childId,
      role: childId == null ? null : 'guardian',
    );
  }

  @override
  Future<AuthLoginResult> loginAccount({
    required String identifier,
    required String password,
  }) async {
    throw UnimplementedError('本文件不测登录');
  }

  /// ★ P0-2b（2026-11-03）：`AuthApi` 多了 `fetchAccount()`；本文件不测账号读取。
  @override
  Future<AccountInfo> fetchAccount() async =>
      throw UnimplementedError('本文件不测账号读取');

  @override
  Future<AccountInfo> updateAccount({
    String? phone,
    String? email,
    String? password,
    String? currentPassword,
  }) async =>
      AccountInfo(
        phone: phone,
        email: email,
        hasPassword: password != null,
      );

  @override
  Future<void> logout() async {}

  @override
  void close() {}
}

/// `IdentityApi` 替身：记录建立了哪个孩子的会话（注册后必须走这条路）。
class _FakeIdentityApi implements IdentityApi {
  final List<String> established = <String>[];

  @override
  Future<List<ChildMembership>> fetchMemberships() async =>
      const <ChildMembership>[];

  @override
  Future<ChildSessionResult> establishChildSession(String childId) async {
    established.add(childId);
    return ChildSessionResult(
      childId: childId,
      role: 'guardian',
      sessionExpiresAt: DateTime.now().add(const Duration(days: 30)),
    );
  }

  @override
  Future<BootstrapChildResult> bootstrapChild({String relation = 'other'}) async =>
      const BootstrapChildResult(childId: 'child-new', role: 'guardian');

  @override
  Future<void> renameChild(String name) async {}

  @override
  void close() {}
}


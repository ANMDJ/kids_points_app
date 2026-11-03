import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kids_points_app/data/auth_api.dart';
import 'package:kids_points_app/data/auth_dto.dart';
import 'package:kids_points_app/data/identity_api.dart';
import 'package:kids_points_app/data/read_api.dart';
import 'package:kids_points_app/data/session_scope.dart';
import 'package:kids_points_app/data/token_store.dart';
import 'package:kids_points_app/data/write_api_errors.dart';
import 'package:kids_points_app/screens/account_gate.dart';
import 'package:kids_points_app/screens/create_child_screen.dart';
import 'package:kids_points_app/screens/login_screen.dart';

/// W10-B / P0-1：启动闸门的身份闭环（2026-11-02）。
///
/// ── 这里钉的五件事（正是 `43` §3 P0-1 的验收判据）──────────────────────────
///   ① 有 token 但没有孩子会话 ⇒ 自动 `child-session`，**然后**才进首页；
///   ② 一个孩子都没有 ⇒ 建孩子引导（可执行），不是一屏 401；
///   ③ 会话建立失败 ⇒ 可重试，重试成功即进入；
///   ④ 登录回包 `membership: null` ⇒ 仍以 `GET /auth/session` 为准；
///   ⑤ 换账号 ⇒ 旧 childId 被清掉、新账号重新建立会话（不串数据）。
const String _token = 'kps_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

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
    AuthApi? authApi,
    IdentityApi? identityApi,
    VoidCallback? onIdentityChanged,
  }) =>
      MaterialApp(
        home: AccountGate(
          holder: holder,
          authApi: authApi,
          identityApi: identityApi,
          session: scope,
          config: config(),
          onIdentityChanged: onIdentityChanged,
          child: const Scaffold(body: Text('HOME')),
        ),
      );

  testWidgets('★ 有 token 但没有 childId ⇒ 先建立 child-session 再进首页',
      (tester) async {
    final AuthTokenHolder holder =
        AuthTokenHolder(store: MemoryTokenStore(_token));
    addTearDown(holder.dispose);
    final _FakeIdentityApi identity = _FakeIdentityApi(
      children: const <ChildMembership>[
        ChildMembership(childId: 'child-1', name: '小明', role: 'guardian'),
      ],
    );
    int resets = 0;

    await tester.pumpWidget(gate(
      holder: holder,
      authApi: _FakeAuthApi(holder: holder),
      identityApi: identity,
      onIdentityChanged: () => resets += 1,
    ));
    await tester.pumpAndSettle();

    expect(find.text('HOME'), findsOneWidget);
    expect(scope.childId, 'child-1');
    expect(scope.role, 'guardian');
    expect(identity.established, <String>['child-1']);
    expect(resets, 1, reason: '身份变化后要清一次首页缓存');
  });

  testWidgets('★ 一个孩子都没有 ⇒ 建孩子引导（不是 401 首页）', (tester) async {
    final AuthTokenHolder holder =
        AuthTokenHolder(store: MemoryTokenStore(_token));
    addTearDown(holder.dispose);
    final _FakeIdentityApi identity = _FakeIdentityApi(
      children: const <ChildMembership>[],
      bootstrapChildId: 'child-new',
    );

    await tester.pumpWidget(gate(
      holder: holder,
      authApi: _FakeAuthApi(holder: holder),
      identityApi: identity,
    ));
    await tester.pumpAndSettle();

    expect(find.byType(CreateChildScreen), findsOneWidget);
    expect(find.text('先创建一个孩子'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '小红');
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    await tester.ensureVisible(find.text('创建并开始'));
    await tester.tap(find.text('创建并开始'));
    await tester.pumpAndSettle();

    expect(find.text('HOME'), findsOneWidget);
    expect(scope.childId, 'child-new');
    expect(identity.bootstrapCalls, 1);
    expect(identity.renamed, <String>['小红']);
  });

  testWidgets('★ 会话建立失败 ⇒ 可重试；重试成功进入首页', (tester) async {
    final AuthTokenHolder holder =
        AuthTokenHolder(store: MemoryTokenStore(_token));
    addTearDown(holder.dispose);
    final _FakeIdentityApi identity = _FakeIdentityApi(
      children: const <ChildMembership>[
        ChildMembership(childId: 'child-1', name: '小明', role: 'guardian'),
      ],
      failEstablishTimes: 1,
    );

    await tester.pumpWidget(gate(
      holder: holder,
      authApi: _FakeAuthApi(holder: holder),
      identityApi: identity,
    ));
    await tester.pumpAndSettle();

    expect(find.text('暂时进不去'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
    expect(scope.childId, isNull);

    await tester.tap(find.text('重试'));
    await tester.pumpAndSettle();
    expect(find.text('HOME'), findsOneWidget);
    expect(scope.childId, 'child-1');
  });

  testWidgets('★ 登录回包 membership=null ⇒ 仍查 /auth/session，没有孩子则建孩子',
      (tester) async {
    final AuthTokenHolder holder = AuthTokenHolder(store: MemoryTokenStore());
    addTearDown(holder.dispose);
    final _FakeAuthApi auth = _FakeAuthApi(holder: holder, childId: null);
    final _FakeIdentityApi identity =
        _FakeIdentityApi(children: const <ChildMembership>[]);

    await tester.pumpWidget(gate(
      holder: holder,
      authApi: auth,
      identityApi: identity,
    ));
    await tester.pumpAndSettle();
    expect(find.byType(LoginScreen), findsOneWidget);

    await tester.enterText(find.byType(TextField).at(0), '13800138000');
    await tester.enterText(find.byType(TextField).at(1), 'jiazhang2026');
    await tester.ensureVisible(find.text('登录'));
    await tester.tap(find.text('登录'));
    await tester.pumpAndSettle();

    expect(find.byType(CreateChildScreen), findsOneWidget);
    expect(identity.fetchCalls, 1);
  });

  testWidgets('★ 换账号：旧 childId 先被清掉，新账号重新建立会话', (tester) async {
    await scope.adoptChild(childId: 'child-old', role: 'guardian');
    final AuthTokenHolder holder = AuthTokenHolder(store: MemoryTokenStore());
    addTearDown(holder.dispose);
    final _FakeIdentityApi identity = _FakeIdentityApi(
      children: const <ChildMembership>[
        ChildMembership(childId: 'child-2', name: '小红', role: 'guardian'),
      ],
    );

    await tester.pumpWidget(gate(
      holder: holder,
      authApi: _FakeAuthApi(holder: holder, childId: 'child-2'),
      identityApi: identity,
    ));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).at(0), '13800138000');
    await tester.enterText(find.byType(TextField).at(1), 'jiazhang2026');
    await tester.ensureVisible(find.text('登录'));
    await tester.tap(find.text('登录'));
    await tester.pumpAndSettle();

    expect(find.text('HOME'), findsOneWidget);
    expect(scope.childId, 'child-2');
    expect(identity.established, <String>['child-2']);
  });
}


/// `AuthApi` 替身：登录成功时真的把 token 写进 holder（与真实客户端同一动作）。
class _FakeAuthApi implements AuthApi {
  _FakeAuthApi({required this.holder, this.childId = 'child-1'});

  final AuthTokenHolder holder;
  final String? childId;

  @override
  Future<AuthLoginResult> loginAccount({
    required String identifier,
    required String password,
  }) async {
    await holder.adopt(_token);
    return AuthLoginResult(
      token: _token,
      expiresAt: DateTime.now().add(const Duration(days: 7)),
      userId: 'u-1',
      displayName: '家长',
      childId: childId,
      role: childId == null ? null : 'guardian',
    );
  }

  @override
  Future<AuthLoginResult> registerWithInvite({
    required String inviteCode,
    required String identifier,
    required String password,
    String? displayName,
  }) async {
    // 注册与登录在客户端是**同一条**落点：拿 token 立刻 adopt。
    await holder.adopt(_token);
    return AuthLoginResult(
      token: _token,
      expiresAt: DateTime.now().add(const Duration(days: 7)),
      userId: 'u-1',
      displayName: displayName,
      childId: childId,
      role: childId == null ? null : 'guardian',
    );
  }

  /// ★ P0-2b（2026-11-03）：`AuthApi` 多了 `fetchAccount()`；本文件不测账号读取，
  /// 所以这里**响亮地**失败（而不是返回一个假账号，让漏测变成假绿）。
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
      AccountInfo(phone: phone, email: email, hasPassword: password != null);

  @override
  Future<void> logout() async {}

  @override
  void close() {}
}

/// `IdentityApi` 替身：可控的成员位 / 失败次数 / 调用记录。
class _FakeIdentityApi implements IdentityApi {
  _FakeIdentityApi({
    required this.children,
    this.bootstrapChildId = 'child-new',
    this.failEstablishTimes = 0,
  });

  final List<ChildMembership> children;
  final String bootstrapChildId;
  int failEstablishTimes;

  int fetchCalls = 0;
  int bootstrapCalls = 0;
  final List<String> established = <String>[];
  final List<String> renamed = <String>[];

  @override
  Future<List<ChildMembership>> fetchMemberships() async {
    fetchCalls += 1;
    return children;
  }

  @override
  Future<ChildSessionResult> establishChildSession(String childId) async {
    if (failEstablishTimes > 0) {
      failEstablishTimes -= 1;
      throw WriteApiException(
        WriteFailureKind.network,
        '连不上服务器。请检查网络。',
        code: 'NETWORK_ERROR',
      );
    }
    established.add(childId);
    return ChildSessionResult(
      childId: childId,
      role: 'guardian',
      sessionExpiresAt: DateTime.now().add(const Duration(days: 30)),
    );
  }

  @override
  Future<BootstrapChildResult> bootstrapChild({String relation = 'other'}) async {
    bootstrapCalls += 1;
    return BootstrapChildResult(childId: bootstrapChildId, role: 'guardian');
  }

  /// ★ P0-3（2026-11-03）：`IdentityApi` 多了 `acceptInvite()`；本文件不测加入家庭，
  /// 所以这里**响亮地**失败（而不是返回一个假会话，让漏测变成假绿）。
  @override
  Future<ChildSessionResult> acceptInvite(String code) async =>
      throw UnimplementedError('本文件不测加入家庭');

  @override
  Future<void> renameChild(String name) async {
    renamed.add(name);
  }

  @override
  void close() {}
}

